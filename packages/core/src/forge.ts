import { execFileSync } from 'node:child_process';
import { OctetError } from './errors.ts';
import { git, type Env } from './git.ts';
import { childEnv, ghToken, remoteSlug, type Identity } from './identity.ts';

export interface PrRequest {
  repo: string;
  remote: string;
  branch: string;
  base: string;
  title: string;
  body: string;
  identity: Identity;
}

export interface PrStatus {
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  reviewDecision: string;
  checks: 'passing' | 'failing' | 'pending' | 'none';
}

export const prNumber = (url: string): number | null => {
  const m = url.match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : null;
};

/** The only code that talks to a remote. Only the Courier flow may call it, after approval. */
export interface Forge {
  push(repo: string, branch: string, identity: Identity): void;
  createPr(req: PrRequest): string;
  /** Read-only: current state, review decision and checks of a PR. */
  prStatus(url: string, identity: Identity): PrStatus;
  comment(url: string, body: string, identity: Identity): void;
  /** Read-only: the unified diff of a PR. */
  prDiff(url: string, identity: Identity): string;
}

function gh(args: string[], identity: Identity, cwd?: string): string {
  const env: Env = { ...childEnv(identity), GH_TOKEN: ghToken(identity) };
  try {
    return execFileSync('gh', args, { ...(cwd ? { cwd } : {}), env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    throw new OctetError(`gh ${args.slice(0, 2).join(' ')} failed: ${String((e as { stderr?: unknown }).stderr ?? (e as Error).message).trim()}`);
  }
}

export function summarizeChecks(rollup: { status?: string; conclusion?: string; state?: string }[]): PrStatus['checks'] {
  if (!rollup.length) return 'none';
  const bad = ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ERROR', 'STARTUP_FAILURE', 'ACTION_REQUIRED'];
  if (rollup.some((c) => bad.includes(c.conclusion ?? '') || c.state === 'FAILURE' || c.state === 'ERROR')) return 'failing';
  if (rollup.some((c) => (c.status && c.status !== 'COMPLETED') || c.state === 'PENDING')) return 'pending';
  return 'passing';
}

export class GitHubForge implements Forge {
  prStatus(url: string, identity: Identity): PrStatus {
    const j = JSON.parse(gh(['pr', 'view', url, '--json', 'state,reviewDecision,statusCheckRollup'], identity)) as
      { state: PrStatus['state']; reviewDecision?: string; statusCheckRollup?: { status?: string; conclusion?: string; state?: string }[] };
    return { state: j.state, reviewDecision: j.reviewDecision ?? '', checks: summarizeChecks(j.statusCheckRollup ?? []) };
  }

  comment(url: string, body: string, identity: Identity): void {
    gh(['pr', 'comment', url, '--body', body], identity);
  }

  prDiff(url: string, identity: Identity): string {
    return gh(['pr', 'diff', url], identity);
  }

  push(repo: string, branch: string, identity: Identity): void {
    git(repo, ['push', '-u', 'origin', `${branch}:${branch}`], childEnv(identity));
  }

  createPr(req: PrRequest): string {
    const slug = remoteSlug(req.remote);
    if (!slug) throw new OctetError(`Cannot determine the GitHub repo from ${req.remote}`);
    const env: Env = { ...childEnv(req.identity), GH_TOKEN: ghToken(req.identity) };
    try {
      const out = execFileSync(
        'gh',
        ['pr', 'create', '--repo', slug, '--base', req.base, '--head', req.branch, '--title', req.title, '--body', req.body],
        { cwd: req.repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      return out.trim().split('\n').pop() ?? '';
    } catch (e) {
      throw new OctetError(`gh pr create failed: ${String((e as { stderr?: unknown }).stderr ?? (e as Error).message).trim()}`);
    }
  }
}

/** Records calls instead of touching a remote. For tests. */
export class FakeForge implements Forge {
  readonly pushes: { branch: string; identity: string }[] = [];
  readonly prs: PrRequest[] = [];
  push(_repo: string, branch: string, identity: Identity): void {
    this.pushes.push({ branch, identity: identity.id });
  }
  /** Tests set these to simulate GitHub. */
  status: PrStatus = { state: 'OPEN', reviewDecision: 'REVIEW_REQUIRED', checks: 'none' };
  readonly comments: { url: string; body: string; identity: string }[] = [];
  diff = 'diff --git a/x b/x\n+hello\n';
  prStatus(): PrStatus { return { ...this.status }; }
  comment(url: string, body: string, identity: Identity): void { this.comments.push({ url, body, identity: identity.id }); }
  prDiff(): string { return this.diff; }
  createPr(req: PrRequest): string {
    this.prs.push(req);
    return `https://github.com/${remoteSlug(req.remote) ?? 'x/y'}/pull/${this.prs.length}`;
  }
}
