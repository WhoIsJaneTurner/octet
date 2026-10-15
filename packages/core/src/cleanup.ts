import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { OctetError } from './errors.ts';
import { git, removeWorktree } from './git.ts';
import { childEnv, getIdentity } from './identity.ts';
import { cancelBead, cancelReview, reconcileRunning, type Ctx } from './orchestrate.ts';
import { getProject } from './project.ts';
import type { Bead, Goal, GoalStatus } from './store.ts';

/** Goals whose worktrees and branches are still in use. Everything else is finished with. */
const LIVE_GOAL: readonly GoalStatus[] = ['planning', 'plan_ready', 'active', 'delivered'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function envFor(ctx: Ctx, goal: Goal) {
  const project = getProject(ctx.projects, goal.project);
  return { project, env: childEnv(getIdentity(ctx.identities, project.identity)) };
}

/**
 * Removes one worktree: through git when it is registered, otherwise by deleting the directory, but only when it sits
 * under the project's `.octet/worktrees`. Branches are never touched. Returns whether anything was removed.
 */
function removeTree(projectPath: string, path: string, env: NodeJS.ProcessEnv): boolean {
  if (!existsSync(path)) return false;
  try {
    removeWorktree(projectPath, path, env);
  } catch {
    const root = resolve(projectPath, '.octet', 'worktrees') + sep;
    if (!resolve(path).startsWith(root)) throw new OctetError(`Refusing to delete ${path}: it is outside ${root}`);
    rmSync(path, { recursive: true, force: true });
  }
  return true;
}

function prune(projectPath: string, env: NodeJS.ProcessEnv): void {
  try { git(projectPath, ['worktree', 'prune'], env); } catch { /* not a repo any more */ }
}

/** Removes the worktrees of a goal's beads and then the goal's own. */
function removeGoalTrees(ctx: Ctx, goal: Goal, skip: ReadonlySet<string> = new Set()): string[] {
  const { project, env } = envFor(ctx, goal);
  const removed: string[] = [];
  for (const b of ctx.store.listBeads(goal.id)) {
    if (!skip.has(b.id) && removeTree(project.path, b.worktree, env)) removed.push(b.worktree);
  }
  if (!skip.size && removeTree(project.path, goal.worktree, env)) removed.push(goal.worktree);
  prune(project.path, env);
  return removed;
}

/**
 * Removes the worktrees of a goal that is finished (`done`) or abandoned. Branches stay. Safe to repeat.
 * A goal with an open pull request or work in flight is refused.
 */
export function cleanupGoal(ctx: Ctx, goalId: string): string[] {
  const goal = ctx.store.getGoal(goalId);
  if (!goal) throw new OctetError(`Unknown goal "${goalId}"`);
  if (goal.status !== 'done' && goal.status !== 'failed') throw new OctetError(`Goal ${goalId} is ${goal.status}; only done or abandoned goals are cleaned up`);
  const removed = removeGoalTrees(ctx, goal);
  if (removed.length) ctx.store.log({ kind: 'goal.cleaned', goalId, seat: 'marshal', data: { removed } });
  return removed;
}

export interface AbandonResult {
  goal: Goal;
  /** Beads whose agent was told to stop. */
  cancelled: string[];
  removed: string[];
  /** Beads whose agent had not stopped in time; their worktrees are kept for `octet gc`. */
  stillRunning: string[];
}

/**
 * Gives up on a goal: marks it `failed` (so the scheduler leaves it alone), stops any agent working on it, removes its
 * worktrees, withdraws anything waiting for your approval and closes its escalations. Branches are kept. A goal that
 * already has a pull request is refused: Octet never touches a delivered goal's PR, so close it on GitHub yourself.
 */
export async function abandonGoal(ctx: Ctx, goalId: string, opts: { reason?: string; waitMs?: number } = {}): Promise<AbandonResult> {
  const goal = ctx.store.getGoal(goalId);
  if (!goal) throw new OctetError(`Unknown goal "${goalId}"`);
  if (goal.status === 'delivered') {
    throw new OctetError(`Goal ${goalId} has a pull request open. Octet does not touch pull requests: close it on GitHub, or merge it and the goal finishes by itself.`);
  }
  if (goal.status === 'done') throw new OctetError(`Goal ${goalId} is already done`);
  const again = goal.status === 'failed';

  // First, so the scheduler stops starting work on it.
  if (!again) ctx.store.setGoalStatus(goalId, 'failed');
  for (const a of ctx.store.listApprovals().filter((x) => x.goalId === goalId && x.status === 'pending')) {
    ctx.store.decideApproval(a.id, 'denied');
    ctx.store.log({ kind: 'approval.withdrawn', goalId, seat: 'marshal', data: { approval: a.id, kind: a.kind, reason: 'goal abandoned' } });
  }
  for (const p of ctx.store.listPlans(goalId).filter((x) => x.status === 'awaiting_approval' || x.status === 'draft')) ctx.store.setPlanStatus(p.id, 'rejected');

  reconcileRunning(ctx.store);
  const beads = ctx.store.listBeads(goalId);
  const cancelled: string[] = [];
  for (const b of beads) {
    const open = ctx.store.openRuns().find((r) => r.beadId === b.id);
    if (!open) continue;
    try {
      if (open.kind === 'review') cancelReview(ctx, b.id); else cancelBead(ctx, b.id);
      cancelled.push(b.id);
    } catch { /* it ended on its own in the meantime */ }
  }
  const busy = () => beads.filter((b) => ctx.store.openRuns().some((r) => r.beadId === b.id)).map((b) => b.id);
  for (let waited = 0; busy().length && waited < (opts.waitMs ?? 15_000); waited += 50) await sleep(50);
  const stillRunning = busy();

  const removed = removeGoalTrees(ctx, goal, new Set(stillRunning));
  ctx.store.resolveEscalationsFor(goalId);
  ctx.store.log({
    kind: 'goal.abandoned', goalId, seat: 'marshal',
    data: { reason: opts.reason ?? 'abandoned by you', cancelled, removed, branches: 'kept', ...(stillRunning.length ? { stillRunning } : {}) },
  });
  return { goal: ctx.store.getGoal(goalId)!, cancelled, removed, stillRunning };
}

export interface Straggler { path: string; project: string; reason: string }

/** Worktrees under `.octet/worktrees` that belong to nothing alive: merged beads, finished or abandoned goals, or unknown directories. */
export function findStragglers(ctx: Ctx): Straggler[] {
  const owners = new Map<string, string | null>(); // path -> why it is a straggler, or null when it is in use
  for (const g of ctx.store.listGoals()) {
    const live = LIVE_GOAL.includes(g.status);
    owners.set(resolve(g.worktree), live ? null : `goal ${g.id} is ${g.status === 'failed' ? 'abandoned' : g.status}`);
    for (const b of ctx.store.listBeads(g.id)) {
      owners.set(resolve(b.worktree), !live ? `goal ${g.id} is ${g.status === 'failed' ? 'abandoned' : g.status}` : b.status === 'merged' ? `bead ${b.id} is merged` : null);
    }
  }
  const found: Straggler[] = [];
  for (const p of ctx.projects) {
    const dir = join(p.path, '.octet', 'worktrees');
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const path = resolve(dir, name);
      if (!statSync(path).isDirectory()) continue;
      const owner = owners.get(path);
      if (owner === null) continue;
      found.push({ path, project: p.name, reason: owner ?? 'not recorded in the database' });
    }
  }
  return found;
}

export interface GcResult { stragglers: Straggler[]; removed: string[]; failed: { path: string; message: string }[] }

/** Lists stragglers; with `apply` it removes them too. Branches are never deleted. */
export function gc(ctx: Ctx, opts: { apply?: boolean } = {}): GcResult {
  const stragglers = findStragglers(ctx);
  const removed: string[] = [];
  const failed: GcResult['failed'] = [];
  if (opts.apply) {
    const touched = new Set<string>();
    for (const s of stragglers) {
      const project = getProject(ctx.projects, s.project);
      try {
        const env = childEnv(getIdentity(ctx.identities, project.identity));
        if (removeTree(project.path, s.path, env)) removed.push(s.path);
        touched.add(project.name);
      } catch (e) {
        failed.push({ path: s.path, message: (e as Error).message });
      }
    }
    for (const name of touched) {
      const project = getProject(ctx.projects, name);
      prune(project.path, childEnv(getIdentity(ctx.identities, project.identity)));
    }
    if (removed.length || failed.length) ctx.store.log({ kind: 'gc.run', seat: 'marshal', data: { removed, failed: failed.length } });
  }
  return { stragglers, removed, failed };
}

const BRIEF_CAP = 20_000;

/** Changes a bead's title or brief before it has run (or after it failed). A bead that has started or finished keeps its record. */
export function editBead(ctx: Ctx, beadId: string, patch: { title?: string; brief?: string }): Bead {
  const bead = ctx.store.getBead(beadId);
  if (!bead) throw new OctetError(`Unknown bead "${beadId}"`);
  if (bead.status !== 'todo' && bead.status !== 'failed') throw new OctetError(`Bead ${beadId} is ${bead.status}; only a todo or failed bead can be edited`);
  if (ctx.store.getGoal(bead.goalId)?.status !== 'active') throw new OctetError(`Goal ${bead.goalId} is not active`);
  const title = patch.title?.trim();
  const brief = patch.brief?.trim();
  if (patch.title !== undefined && !title) throw new OctetError('The title cannot be empty');
  if (patch.brief !== undefined && !brief) throw new OctetError('The brief cannot be empty');
  if (brief && brief.length > BRIEF_CAP) throw new OctetError(`The brief is too long (${brief.length} characters; limit ${BRIEF_CAP})`);
  ctx.store.updateBead(beadId, { ...(title ? { title } : {}), ...(brief ? { brief } : {}) });
  ctx.store.log({
    kind: 'bead.edited', goalId: bead.goalId, beadId, seat: 'marshal',
    data: { fields: [title ? 'title' : '', brief ? 'brief' : ''].filter(Boolean), briefChars: (brief ?? bead.brief).length, ...(bead.planId ? { fromPlan: bead.planId } : {}) },
  });
  return ctx.store.getBead(beadId)!;
}

/** Deletes a bead that has never run and that no other bead waits on. */
export function deleteBead(ctx: Ctx, beadId: string): void {
  const bead = ctx.store.getBead(beadId);
  if (!bead) throw new OctetError(`Unknown bead "${beadId}"`);
  if (bead.status !== 'todo' || ctx.store.db.prepare('SELECT 1 FROM bead_runs WHERE bead_id = ?').get(beadId)) {
    throw new OctetError(`Bead ${beadId} has already started; only a bead that has not run can be deleted`);
  }
  const dependents = ctx.store.listBeads().filter((b) => b.dependsOn.includes(beadId));
  if (dependents.length) throw new OctetError(`Bead ${beadId} cannot be deleted: ${dependents.map((b) => `"${b.title}"`).join(', ')} wait${dependents.length === 1 ? 's' : ''} on it`);
  ctx.store.deleteBead(beadId);
  ctx.store.resolveEscalationsFor(bead.goalId, beadId);
  ctx.store.log({ kind: 'bead.deleted', goalId: bead.goalId, beadId, seat: 'marshal', data: { title: bead.title } });
}
