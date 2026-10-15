import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { OctetError } from './errors.ts';
import { remoteUrl } from './git.ts';
import { checkRemote, childEnv, getIdentity, ghToken, remoteSlug, type Identity } from './identity.ts';
import type { GithubIntakeConfig } from './intake-config.ts';
import type { IntakeAdapter, IntakeItem } from './intake-sources.ts';
import type { Project } from './project.ts';

/** Runs `gh` as one identity and returns stdout. Injected in tests so nothing touches GitHub. */
export type GhFn = (args: string[], identity: Identity) => Promise<string>;

const execFileP = promisify(execFile);

/** Mirrors forge.ts: the identity's own environment plus its token. Async, so a slow poll never blocks the daemon. */
export const realGh: GhFn = async (args, identity) => {
  const env = { ...childEnv(identity), GH_TOKEN: ghToken(identity), GH_PROMPT_DISABLED: '1' };
  try {
    const { stdout } = await execFileP('gh', args, { env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 60_000 });
    return stdout;
  } catch (e) {
    throw new OctetError(`gh ${args.slice(0, 2).join(' ')} failed: ${String((e as { stderr?: unknown }).stderr ?? (e as Error).message).trim()}`);
  }
};

interface GhIssue {
  number?: number;
  title?: string;
  body?: string;
  url?: string;
  updatedAt?: string;
  author?: { login?: string } | null;
  labels?: { name?: string }[];
}

const eq = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Read-only GitHub issue intake for one project's repo, under that project's identity. The label is the opt-in.
 * Nothing in an issue picks the project: the repo does (via config), and an `octet:<project>` label may only
 * choose among projects that live in that same repo.
 */
export class GithubIntake implements IntakeAdapter {
  readonly name: string;
  private readonly project: Project;
  private readonly cfg: GithubIntakeConfig;
  private readonly world: { identities: Identity[]; projects: () => Project[] };
  private readonly gh: GhFn;
  constructor(project: Project, cfg: GithubIntakeConfig, world: { identities: Identity[]; projects: () => Project[] }, gh: GhFn = realGh) {
    this.project = project;
    this.cfg = cfg;
    this.world = world;
    this.gh = gh;
    this.name = `github:${project.name}`;
  }

  /** A project's repo, only if its own identity passes the owner guard. */
  private slugOf(p: Project): string | null {
    try {
      const identity = getIdentity(this.world.identities, p.identity);
      const url = remoteUrl(p.path, childEnv(identity));
      return url && checkRemote(identity, url).ok ? remoteSlug(url) : null;
    } catch {
      return null;
    }
  }

  async fetchNew(): Promise<IntakeItem[]> {
    const identity = getIdentity(this.world.identities, this.project.identity);
    const url = remoteUrl(this.project.path, childEnv(identity));
    if (!url) throw new OctetError(`Project ${this.project.name} has no origin remote`);
    // The wrong-account guard, before any call is made as this identity.
    const guard = checkRemote(identity, url);
    if (!guard.ok) throw new OctetError(`Refusing to read issues for ${this.project.name}: ${guard.reason}`);
    const slug = remoteSlug(url);
    if (!slug) throw new OctetError(`Cannot determine the GitHub repo from ${url}`);

    // If visibility cannot be determined, assume public: the stricter rule.
    let isPublic = true;
    try {
      isPublic = (JSON.parse(await this.gh(['repo', 'view', slug, '--json', 'isPrivate'], identity)) as { isPrivate?: boolean }).isPrivate !== true;
    } catch { /* stays public */ }

    const raw = await this.gh(
      ['issue', 'list', '--repo', slug, '--label', this.cfg.label, '--state', 'open', '--limit', '100',
        '--json', 'number,title,body,author,url,updatedAt,labels'],
      identity,
    );
    let issues: GhIssue[];
    try {
      issues = JSON.parse(raw) as GhIssue[];
    } catch {
      throw new OctetError('gh issue list returned something that is not JSON');
    }
    if (!Array.isArray(issues)) throw new OctetError('gh issue list returned something unexpected');

    const siblings = this.world.projects().filter((p) => this.slugOf(p)?.toLowerCase() === slug.toLowerCase());
    const items: IntakeItem[] = [];
    for (const i of issues) {
      if (typeof i.url !== 'string' || typeof i.title !== 'string' || !i.url) continue;
      const author = i.author?.login || 'unknown';
      const allowed = this.cfg.allowedAuthors.some((a) => eq(a, author));
      let held: string | undefined;
      if (isPublic && this.cfg.allowedAuthors.length === 0) held = 'public repo and intake.github.allowed_authors is empty';
      else if ((isPublic || this.cfg.allowedAuthors.length > 0) && !allowed) held = `author "${author}" is not in intake.github.allowed_authors`;
      const item: IntakeItem = {
        source: 'github', externalRef: i.url, title: i.title, body: `${i.url}\n\n${i.body ?? ''}`, requester: author,
        project: held ? null : this.routeTo(i.labels ?? [], siblings),
      };
      if (held) item.held = held;
      items.push(item);
    }
    return items;
  }

  /** `octet:<project>` among this repo's projects, else the repo's only project, else nobody (the inbox asks you). */
  private routeTo(labels: { name?: string }[], siblings: Project[]): string | null {
    const prefix = `${this.cfg.label}:`.toLowerCase();
    const named = labels.map((l) => l.name ?? '').filter((n) => n.toLowerCase().startsWith(prefix)).map((n) => n.slice(prefix.length));
    if (named.length > 1) return null;
    if (named.length === 1) return siblings.find((p) => eq(p.name, named[0]!))?.name ?? null;
    return siblings.length === 1 ? siblings[0]!.name : null;
  }
}

/** One adapter per polled project. Rebuilt on every poll so a project added in the UI is picked up. */
export function githubAdapters(
  cfg: GithubIntakeConfig,
  world: { identities: Identity[]; projects: () => Project[] },
  gh?: GhFn,
): IntakeAdapter[] {
  const names = cfg.projects;
  return world.projects()
    .filter((p) => !names || names.includes(p.name))
    .map((p) => new GithubIntake(p, cfg, world, gh));
}
