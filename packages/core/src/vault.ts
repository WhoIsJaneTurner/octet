import { createHash } from 'node:crypto';
import {
  closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { OctetError } from './errors.ts';
import { parseFrontmatter, stringifyFrontmatter, type Frontmatter } from './frontmatter.ts';
import { commitAll, git, slugify, type Env } from './git.ts';
import { childEnv, type Identity } from './identity.ts';
import { renderPlan, renderScout, type Plan, type ScoutReport } from './plan.ts';
import type { Project } from './project.ts';
import { redact, redactDeep } from './redact.ts';
import type { PlanStatus, Request } from './store.ts';

export const MAX_PLAN_BYTES = 200 * 1024;

export const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

/** Write to a temp file in the same directory, then rename, so a reader never sees half a file. */
export function atomicWrite(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

export interface PlanMeta {
  planId: string;
  goalId: string;
  project: string;
  identity: string;
  version: number;
  status: PlanStatus;
  title: string;
  requestPath: string | null;
  beads?: string[];
  pr?: string | null;
}

export interface RelatedPlan { slug: string; title: string; status: string; files: string[]; approach: string; score: number }

const planFile = (slug: string, version: number, ext: 'json' | 'md'): string => `plans/${slug}/plan.v${version}.${ext}`;

/**
 * A directory of plain files holding plans, reports and outcomes (see docs/plan-vault.md).
 * The JSON file is the source of truth; Markdown is rendered from it by code. One writer at a time
 * (a lock file), every write atomic, and with `git` set every state change is one commit by the project's identity.
 */
export class Vault {
  readonly root: string;
  private readonly env: Env | undefined;

  /** `env`, when given, turns on git: the vault becomes its own repository, committed as that identity. */
  constructor(root: string, env?: Env) {
    this.root = root;
    this.env = env;
  }

  get gitEnabled(): boolean { return !!this.env; }
  path(rel: string): string { return join(this.root, rel); }
  has(rel: string): boolean { return existsSync(this.path(rel)); }
  read(rel: string): string { return readFileSync(this.path(rel), 'utf8'); }

  /** Creates the layout. Safe to call repeatedly. */
  init(): void {
    this.locked(() => {
      for (const d of ['requests', 'plans', 'lessons']) mkdirSync(this.path(d), { recursive: true });
      if (!this.has('README.md')) {
        atomicWrite(this.path('README.md'), [
          '# Octet vault', '',
          'Plans, scout reports, decisions and outcomes for one project, written by Octet.',
          'Plain files: read them in any editor. The `plan.vN.json` files are the source of truth; the Markdown is generated.',
          'Do not edit an approved plan in place: Octet will flag it as tampered. Propose a change as a new version instead.',
          'Files in `lessons/` are yours; set `pinned: true` in the front matter to include a note in every plan.', '',
        ].join('\n'));
      }
      if (this.gitEnabled) {
        if (!this.has('.git')) git(this.root, ['init', '-q', '-b', 'main'], this.env!);
        if (!this.has('.gitignore')) atomicWrite(this.path('.gitignore'), '.octet.lock\n*.tmp\n');
      }
      this.writeIndex();
      this.commit('vault: init');
    });
  }

  /** One writer at a time. A lock left by a dead process is taken over. */
  private locked<T>(fn: () => T): T {
    mkdirSync(this.root, { recursive: true });
    const lock = this.path('.octet.lock');
    for (let attempt = 0; ; attempt++) {
      try {
        const fd = openSync(lock, 'wx');
        writeFileSync(fd, String(process.pid));
        closeSync(fd);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const holder = Number(readFileSync(lock, 'utf8').trim());
        if (!holder || !pidAlive(holder) || holder === process.pid) { rmSync(lock, { force: true }); continue; }
        if (attempt > 20) throw new OctetError(`The vault is locked by process ${holder}. Wait for it to finish.`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
    try { return fn(); } finally { rmSync(lock, { force: true }); }
  }

  /** `YYYY-MM-DD-slug`, with a numeric suffix if that name is taken. */
  planSlug(title: string, date = new Date()): string {
    const base = `${date.toISOString().slice(0, 10)}-${slugify(title).slice(0, 40) || 'plan'}`;
    let slug = base;
    for (let n = 2; this.has(`plans/${slug}`); n++) slug = `${base}-${n}`;
    return slug;
  }

  /** Stores the request as received, apart from secret redaction. Returns the path relative to the vault. */
  saveRequest(slug: string, req: Request): { path: string; redacted: number } {
    const body = redact(req.body);
    const title = redact(req.title);
    const doc = stringifyFrontmatter({
      octet: 'request', id: req.id, source: req.source, external_ref: req.externalRef, requester: req.requester,
      project: req.project, created: req.createdAt,
    }) + `\n# ${title.text}\n\n${body.text}\n`;
    return this.locked(() => {
      atomicWrite(this.path(`requests/${slug}.md`), doc);
      atomicWrite(this.path(`plans/${slug}/request.md`), doc);
      return { path: `requests/${slug}.md`, redacted: body.count + title.count };
    });
  }

  saveScout(slug: string, report: ScoutReport, meta: { goalId: string; title: string }): { hash: string; redacted: number } {
    const r = redactDeep(report);
    const json = JSON.stringify(r.value, null, 2) + '\n';
    return this.locked(() => {
      atomicWrite(this.path(`plans/${slug}/scout.json`), json);
      atomicWrite(this.path(`plans/${slug}/scout.md`),
        stringifyFrontmatter({ octet: 'scout', goal: meta.goalId, created: new Date().toISOString() }) + '\n' + renderScout(r.value, meta.title));
      this.commit(`scout: ${slug}`);
      return { hash: sha256(json), redacted: r.count };
    });
  }

  /** Writes plan.vN.json (the truth) and plan.vN.md (rendered). Returns the hash of the JSON as written. */
  savePlan(slug: string, plan: Plan, meta: PlanMeta): { hash: string; redacted: number } {
    const r = redactDeep(plan);
    const json = JSON.stringify(r.value, null, 2) + '\n';
    if (Buffer.byteLength(json) > MAX_PLAN_BYTES) throw new OctetError(`The plan is ${Math.round(Buffer.byteLength(json) / 1024)} KB; the limit is ${MAX_PLAN_BYTES / 1024} KB`);
    const hash = sha256(json);
    const fm: Frontmatter = {
      octet: 'plan', id: meta.planId, goal: meta.goalId, project: meta.project, identity: meta.identity, version: meta.version,
      status: meta.status, title: meta.title, request: meta.requestPath, created: new Date().toISOString(),
      approved_at: null, content_hash: hash, beads: meta.beads ?? [], pr: meta.pr ?? null,
    };
    return this.locked(() => {
      atomicWrite(this.path(planFile(slug, meta.version, 'json')), json);
      atomicWrite(this.path(planFile(slug, meta.version, 'md')), stringifyFrontmatter(fm) + '\n' + renderPlan(r.value, meta.title));
      this.writeIndex();
      this.commit(`plan: saved v${meta.version} (${slug})`);
      return { hash, redacted: r.count };
    });
  }

  /** Updates the front matter of a rendered plan (status, approval time, beads, PR). Never touches the JSON, so the hash holds. */
  updatePlanMeta(slug: string, version: number, patch: Frontmatter, commitMessage?: string): void {
    this.locked(() => {
      const rel = planFile(slug, version, 'md');
      const { data, body } = parseFrontmatter(this.read(rel));
      atomicWrite(this.path(rel), stringifyFrontmatter({ ...data, ...patch }) + (body.startsWith('\n') ? '' : '\n') + body);
      this.writeIndex();
      if (commitMessage) this.commit(commitMessage);
    });
  }

  readPlan(slug: string, version: number): { plan: Plan; hash: string } {
    const rel = planFile(slug, version, 'json');
    if (!this.has(rel)) throw new OctetError(`Plan file ${rel} is missing from the vault`);
    const raw = readFileSync(this.path(rel));
    return { plan: JSON.parse(raw.toString('utf8')) as Plan, hash: sha256(raw) };
  }

  readJson<T>(rel: string): T {
    return JSON.parse(this.read(rel)) as T;
  }

  /** Hash of the plan JSON on disk now, or null if the file is gone. */
  currentHash(slug: string, version: number): string | null {
    const rel = planFile(slug, version, 'json');
    return this.has(rel) ? sha256(readFileSync(this.path(rel))) : null;
  }

  /** Append-only record of approvals, rejections, feedback and escalations. */
  appendDecision(slug: string, line: string, commitMessage?: string): void {
    this.locked(() => {
      const rel = `plans/${slug}/decisions.md`;
      const prior = this.has(rel) ? this.read(rel) : '# Decisions\n\n';
      atomicWrite(this.path(rel), `${prior}- ${new Date().toISOString()}: ${redact(line).text}\n`);
      if (commitMessage) this.commit(commitMessage);
    });
  }

  writeOutcome(slug: string, markdown: string): void {
    this.locked(() => {
      atomicWrite(this.path(`plans/${slug}/outcome.md`), markdown.endsWith('\n') ? markdown : markdown + '\n');
      this.writeIndex();
      this.commit(`outcome: ${slug}`);
    });
  }

  /** Commits whatever changed, as the project's identity. No-op without git or without changes. Never pushes. */
  commit(message: string): boolean {
    if (!this.env) return false;
    return commitAll(this.root, message, this.env);
  }

  /** Records the audit chain head in the vault's git history, an anchor outside the database. */
  anchorHead(head: string, reason: string): void {
    if (!this.env) return;
    this.locked(() => {
      atomicWrite(this.path('audit-head.txt'), `${head}\n`);
      this.commit(`audit: head ${head.slice(0, 12)} (${reason})`);
    });
  }

  private writeIndex(): void {
    const rows: { slug: string; fm: Frontmatter }[] = [];
    const dir = this.path('plans');
    if (existsSync(dir)) {
      for (const slug of readdirSync(dir)) {
        const versions = readdirSync(join(dir, slug)).map((f) => f.match(/^plan\.v(\d+)\.md$/)?.[1]).filter(Boolean).map(Number);
        if (!versions.length) continue;
        rows.push({ slug, fm: parseFrontmatter(this.read(planFile(slug, Math.max(...versions), 'md'))).data });
      }
    }
    rows.sort((a, b) => b.slug.localeCompare(a.slug));
    atomicWrite(this.path('index.md'), [
      '# Plans', '', '| Plan | Version | Status | Goal |', '|---|---|---|---|',
      ...rows.map((r) => `| [${String(r.fm.title ?? r.slug).replace(/\|/g, '/')}](plans/${r.slug}/plan.v${r.fm.version}.md) | ${r.fm.version} | ${r.fm.status} | ${r.fm.goal} |`),
      '',
    ].join('\n'));
  }

  /** Slugs of all plan directories. */
  slugs(): string[] {
    const dir = this.path('plans');
    return existsSync(dir) ? readdirSync(dir).filter((f) => statSync(join(dir, f)).isDirectory()) : [];
  }

  /**
   * Earlier plans worth showing the Scout and Architect, best first: files in common count most, then
   * title keywords. Plain text matching; passed to models as data only.
   */
  relatedPlans(q: { title: string; files?: string[] }, limit = 5, exclude?: string): RelatedPlan[] {
    const words = new Set(q.title.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
    const wanted = new Set(q.files ?? []);
    const out: RelatedPlan[] = [];
    for (const slug of this.slugs()) {
      if (slug === exclude) continue;
      const versions = readdirSync(this.path(`plans/${slug}`)).map((f) => f.match(/^plan\.v(\d+)\.json$/)?.[1]).filter(Boolean).map(Number);
      if (!versions.length) continue;
      const v = Math.max(...versions);
      let plan: Plan;
      let fm: Frontmatter;
      try {
        plan = JSON.parse(this.read(planFile(slug, v, 'json'))) as Plan;
        fm = parseFrontmatter(this.read(planFile(slug, v, 'md'))).data;
      } catch { continue; }
      if (fm.status === 'rejected') continue;
      const files = [...new Set(plan.beads.flatMap((b) => b.files))];
      const title = String(fm.title ?? slug);
      const fileHits = files.filter((f) => wanted.has(f)).length;
      const wordHits = title.toLowerCase().split(/[^a-z0-9]+/).filter((w) => words.has(w)).length;
      const score = fileHits * 3 + wordHits;
      if (score > 0) out.push({ slug, title, status: String(fm.status), files, approach: plan.approach.slice(0, 400), score });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** House rules: notes in lessons/ flagged `pinned: true`, included in every plan for the project. */
  pinnedLessons(): { name: string; text: string }[] {
    const dir = this.path('lessons');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith('.md')).flatMap((f) => {
      const { data, body } = parseFrontmatter(this.read(`lessons/${f}`));
      return data.pinned === true ? [{ name: f, text: body.trim().slice(0, 4000) }] : [];
    });
  }
}

/** Opens (and creates) the project's vault, or explains why planning is unavailable for it. */
export function openVault(project: Project, identity: Identity): Vault {
  if (!project.vault) {
    throw new OctetError(`Project "${project.name}" has no vault, so planning is off for it. Add vault = "~/vaults/${project.name}" to its entry in projects.toml.`);
  }
  const vault = new Vault(project.vault, project.vaultGit ? childEnv(identity) : undefined);
  vault.init();
  return vault;
}
