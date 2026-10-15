import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  ClarificationNeeded, DEFAULT_LIMITS, parseIdentities, planRequest, Store, submitRequest, type AgentRunner, type Ctx,
} from '../../src/index.ts';
import type { Check, EvalTask, Outcome } from './tasks.ts';

const IDS = '[identities.eval]\nname = "Eval"\nemail = "eval@example.com"\nssh_key = "/nonexistent"\ngh_user = "eval-user"\n';

export interface EvalResult {
  task: string;
  ok: boolean;
  checks: Check[];
  outcome: Pick<Outcome, 'chairSize' | 'retries' | 'error'> & { beads?: number; questions?: number };
  ms: number;
}

/** Builds a throwaway repo from the task's files, plus a fresh vault. */
export function buildRepo(task: EvalTask): { repo: string; vault: string } {
  const repo = mkdtempSync(join(tmpdir(), 'octet-eval-repo-'));
  const vault = mkdtempSync(join(tmpdir(), 'octet-eval-vault-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  for (const [f, text] of Object.entries(task.files)) {
    mkdirSync(dirname(join(repo, f)), { recursive: true });
    writeFileSync(join(repo, f), text);
  }
  g('add', '.');
  g('-c', 'user.name=eval', '-c', 'user.email=eval@example.com', 'commit', '-q', '-m', 'init');
  return { repo, vault };
}

/** Runs the planning flow for one task with the given runner and scores it. Never touches real config. */
export async function runTask(task: EvalTask, runner: AgentRunner): Promise<EvalResult> {
  const started = Date.now();
  const { repo, vault } = buildRepo(task);
  const ctx: Ctx = {
    store: new Store(':memory:'), identities: parseIdentities(IDS), runner,
    projects: [{ name: 'eval', path: repo, identity: 'eval', vault }],
    limits: { ...DEFAULT_LIMITS, maxActiveGoals: 5, runTimeoutMs: 10 * 60_000 },
  };
  const req = submitRequest(ctx, { source: 'cli', project: 'eval', title: task.request.title, body: task.request.body, requester: 'eval' }).request;
  const o: Outcome = { goals: 0, pendingPlanApprovals: 0, otherApprovals: 0, changedFiles: [], retries: 0 };
  try {
    const rec = await planRequest(ctx, req.id);
    const approval = ctx.store.listApprovals().find((a) => a.kind === 'plan' && (a.summary as { planId: string }).planId === rec.id);
    if (approval) o.plan = JSON.parse(readFileSync(join(vault, rec.vaultPath, `plan.v${rec.version}.json`), 'utf8'));
  } catch (e) {
    if (e instanceof ClarificationNeeded) o.questions = e.clarification.questions;
    else o.error = (e as Error).message;
  }
  o.goals = ctx.store.listGoals().length;
  o.pendingPlanApprovals = ctx.store.listApprovals().filter((a) => a.kind === 'plan' && a.status === 'pending').length;
  o.otherApprovals = ctx.store.listApprovals().filter((a) => a.kind !== 'plan').length;
  o.retries = ctx.store.eventsOfKind('planning.retry').length;
  o.chairSize = (ctx.store.eventsOfKind('chair.assessed')[0]?.data as { effectiveSize?: string } | undefined)?.effectiveSize;
  // Planning is read-only: the main checkout must be exactly as built.
  o.changedFiles = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).split('\n').filter((l) => l && !l.includes('.octet'));
  const checks = task.check(o);
  return {
    task: task.name, ok: checks.every((c) => c.ok), checks, ms: Date.now() - started,
    outcome: { chairSize: o.chairSize, retries: o.retries, ...(o.error ? { error: o.error } : {}), ...(o.plan ? { beads: o.plan.beads.length } : {}), ...(o.questions ? { questions: o.questions.length } : {}) },
  };
}

/** Hash of every persona prompt, so a prompt change is visible when comparing runs over time. */
export function promptHash(): string {
  const dir = new URL('../../../../personas/', import.meta.url);
  const h = createHash('sha256');
  for (const f of readdirSync(dir).sort()) h.update(f).update(readFileSync(new URL(f, dir)));
  return h.digest('hex').slice(0, 12);
}

/** Appends one line per task so results can be compared across prompt and model changes. */
export function record(results: EvalResult[], file: string, meta: { model: string; live: boolean }): void {
  mkdirSync(dirname(file), { recursive: true });
  const at = new Date().toISOString();
  const ph = promptHash();
  for (const r of results) appendFileSync(file, JSON.stringify({ at, promptHash: ph, ...meta, ...r }) + '\n');
}
