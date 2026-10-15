import { DEFAULT_LIMITS, DEFAULT_PLANNING, DEFAULT_REVIEW } from './config.ts';
import { approveBead, requestDelivery, type Ctx } from './orchestrate.ts';
import { autonomyOf } from './project.ts';
import type { Bead, Escalation, Goal } from './store.ts';

/** What the scheduler wants done. Pure data, so the decision logic can be tested without running anything. */
export type SchedAction =
  | { type: 'run'; beadId: string }
  | { type: 'review'; beadId: string }
  | { type: 'merge'; beadId: string }
  | { type: 'deliver'; goalId: string }
  | { type: 'escalate'; goalId: string; beadId?: string; reason: string; message: string };

/** The in-memory facts only the daemon knows; everything else is read from the database. */
export interface SchedHooks {
  isRunning(beadId: string): boolean;
  isReviewing(beadId: string): boolean;
}

/** Bead-scoped escalations clear themselves once the bead leaves the state that caused them. */
const CLEARS_WHEN_NOT: Record<string, Bead['status'][]> = {
  bead_failed: ['failed'], cancelled: ['failed'], review_inconclusive: ['in_review'], review_rounds: ['in_review'],
  review_error: ['in_review'], action_failed: ['todo', 'changes_requested', 'failed', 'in_review'], cap_wait: ['todo', 'changes_requested', 'failed'], merge_conflict: ['in_review'],
};

const eventId = (ctx: Ctx, kind: string, beadId: string): number => ctx.store.lastEvent(kind, beadId)?.id ?? 0;

/**
 * Reads durable state and decides what to do next. Goals the scheduler manages are `active`, not paused, and
 * created from an approved plan in a project whose autonomy is above `manual`. Goals you built by hand
 * are never touched. Work starts oldest first and never past the engineer cap.
 */
export function decide(ctx: Ctx, hooks: SchedHooks, now = Date.now()): SchedAction[] {
  const limits = ctx.limits ?? DEFAULT_LIMITS;
  const cfg = ctx.planning ?? DEFAULT_PLANNING;
  const review = ctx.review ?? DEFAULT_REVIEW;
  const actions: SchedAction[] = [];
  const allBeads = ctx.store.listBeads();
  let slots = limits.maxEngineers - allBeads.filter((b) => b.status === 'running' || hooks.isRunning(b.id)).length;
  let reviewSlots = limits.maxEngineers - allBeads.filter((b) => hooks.isReviewing(b.id)).length;

  const goals = ctx.store.listGoals().filter((g) => managed(ctx, g));
  const queue: { bead: Bead; goal: Goal }[] = [];

  for (const goal of goals) {
    const beads = allBeads.filter((b) => b.goalId === goal.id);
    const project = ctx.projects.find((p) => p.name === goal.project)!;
    const level = autonomyOf(project);
    const escalate = (reason: string, message: string, bead?: Bead) =>
      actions.push({ type: 'escalate', goalId: goal.id, ...(bead ? { beadId: bead.id } : {}), reason, message });
    const budget = cfg.maxRunsFactor * beads.length;
    const overBudget = ctx.store.countRunsForGoal(goal.id) >= budget;
    let progressing = false;
    let waitingOnHuman = false;

    for (const b of beads) {
      const depsMerged = b.dependsOn.every((d) => allBeads.find((x) => x.id === d)?.status === 'merged');
      if (hooks.isRunning(b.id) || b.status === 'running') { progressing = true; continue; }
      if (hooks.isReviewing(b.id)) { progressing = true; continue; }

      if (b.status === 'todo' || b.status === 'changes_requested') {
        if (depsMerged) { queue.push({ bead: b, goal }); progressing = true; }
        continue;
      }
      if (b.status === 'failed') {
        const cancelled = eventId(ctx, 'bead.cancelled', b.id) > eventId(ctx, 'bead.started', b.id);
        const attempts = ctx.store.countEvents('bead.failed', b.id) + ctx.store.countEvents('bead.recovered', b.id);
        if (cancelled) { escalate('cancelled', `You cancelled "${b.title}". Re-run it, or leave it.`, b); waitingOnHuman = true; }
        else if (attempts > cfg.maxRetries) { escalate('bead_failed', `"${b.title}" failed ${attempts} times (limit ${cfg.maxRetries} retries). It needs a human look.`, b); waitingOnHuman = true; }
        else if (depsMerged) { queue.push({ bead: b, goal }); progressing = true; }
        else waitingOnHuman = true;
        continue;
      }
      if (b.status === 'in_review') {
        const ready = eventId(ctx, 'bead.ready_for_review', b.id);
        const verdict = ctx.store.lastEvent('review.verdict', b.id);
        const reviewed = !!verdict && verdict.id > ready;
        if (!reviewed) {
          const errors = ctx.store.db
            .prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'review.error' AND bead_id = ? AND id > ?").get(b.id, ready) as { n: number };
          if (errors.n >= 2) { escalate('review_error', `The Reviewer failed twice on "${b.title}".`, b); waitingOnHuman = true; }
          else if (reviewSlots > 0) { actions.push({ type: 'review', beadId: b.id }); reviewSlots--; progressing = true; }
          else progressing = true;
          continue;
        }
        const v = (verdict.data as { verdict: string }).verdict;
        if (eventId(ctx, 'review.escalated', b.id) > ready) {
          escalate('review_rounds', `"${b.title}" was sent back ${review.maxRounds} times and is still not approved.`, b);
          waitingOnHuman = true;
        } else if (v === 'inconclusive') {
          escalate('review_inconclusive', `The Reviewer could not decide on "${b.title}".`, b);
          waitingOnHuman = true;
        } else if (v === 'approve') {
          if (level === 'auto-to-pr') { actions.push({ type: 'merge', beadId: b.id }); progressing = true; }
          else waitingOnHuman = true; // plan-gated: you merge each bead
        } else waitingOnHuman = true;
      }
    }

    const unmerged = beads.filter((b) => b.status !== 'merged');
    if (beads.length && !unmerged.length) {
      const hasDelivery = ctx.store.listApprovals().some((a) => a.kind === 'deliver' && a.goalId === goal.id);
      const blocked = ctx.store.listEscalations(true).some((e) => e.goalId === goal.id && e.reason === 'deliver_failed');
      if (!hasDelivery && !blocked && !ctx.store.getPr(goal.id)) actions.push({ type: 'deliver', goalId: goal.id });
    } else if (unmerged.length && !progressing && !waitingOnHuman && !ctx.store.listEscalations(true).some((e) => e.goalId === goal.id)) {
      escalate('idle', 'Nothing can run: the remaining beads are blocked and nothing is waiting on a person.');
    }
    if (overBudget && unmerged.length) {
      escalate('run_ceiling', `This goal has used its budget of ${budget} agent runs (${cfg.maxRunsFactor} per bead). Raise the limit or step in.`);
      // No new engineer runs for this goal while over budget.
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i]!.goal.id === goal.id) queue.splice(i, 1);
    }
  }

  // Oldest bead first, within the engineer cap.
  queue.sort((a, b) => a.bead.createdAt.localeCompare(b.bead.createdAt)); // stable: ties keep creation order
  for (const { bead, goal } of queue) {
    if (slots > 0) { actions.push({ type: 'run', beadId: bead.id }); slots--; continue; }
    const waited = now - Date.parse(bead.updatedAt);
    if (waited > cfg.capWaitMinutes * 60_000) {
      actions.push({ type: 'escalate', goalId: goal.id, beadId: bead.id, reason: 'cap_wait', message: `"${bead.title}" has waited over ${cfg.capWaitMinutes} minutes for a free engineer slot.` });
    }
  }
  return actions;
}

function managed(ctx: Ctx, g: Goal): boolean {
  if (g.status !== 'active' || g.paused) return false;
  const project = ctx.projects.find((p) => p.name === g.project);
  if (!project || autonomyOf(project) === 'manual') return false;
  return ctx.store.listBeads(g.id).some((b) => b.planId !== null);
}

export interface TickExec {
  run(beadId: string): void;
  review(beadId: string): void;
}

/** Closes escalations whose cause is gone. */
function clearResolved(ctx: Ctx): void {
  for (const e of ctx.store.listEscalations(true)) {
    const goal = ctx.store.getGoal(e.goalId);
    if (!goal || goal.status === 'delivered' || goal.status === 'done' || goal.status === 'failed') { ctx.store.resolveEscalation(e.id); continue; }
    const need = CLEARS_WHEN_NOT[e.reason];
    const bead = e.beadId ? ctx.store.getBead(e.beadId) : undefined;
    if (need && bead && !need.includes(bead.status)) ctx.store.resolveEscalation(e.id);
    if (e.reason === 'idle' && ctx.store.listBeads(goal.id).some((b) => b.status === 'running' || b.status === 'in_review')) ctx.store.resolveEscalation(e.id);
  }
}

/** One scheduler pass: decide, then act. Safe to call as often as you like; it only reads durable state. */
export function tick(ctx: Ctx, hooks: SchedHooks, exec: TickExec): SchedAction[] {
  clearResolved(ctx);
  const actions = decide(ctx, hooks);
  for (const a of actions) {
    try {
      if (a.type === 'run') exec.run(a.beadId);
      else if (a.type === 'review') exec.review(a.beadId);
      else if (a.type === 'merge') approveBead(ctx, a.beadId);
      else if (a.type === 'deliver') {
        requestDelivery(ctx, a.goalId);
        ctx.store.log({ kind: 'scheduler.delivery_requested', goalId: a.goalId, seat: 'marshal' });
      } else {
        const esc: Escalation | undefined = ctx.store.escalate({ goalId: a.goalId, ...(a.beadId ? { beadId: a.beadId } : {}), reason: a.reason, message: a.message });
        if (esc) ctx.store.log({ kind: 'goal.escalated', goalId: a.goalId, ...(a.beadId ? { beadId: a.beadId } : {}), seat: 'marshal', data: { reason: a.reason, message: a.message } });
      }
    } catch (e) {
      // Races (cap reached, bead already moved) are expected and retried next tick. Anything else becomes one
      // escalation (deduplicated), so a stuck action asks you once instead of logging forever.
      const message = (e as Error).message;
      if (/limit reached|already|is (running|reviewing)|not in_review|only todo/i.test(message)) continue;
      const goalId = 'goalId' in a ? a.goalId : ctx.store.getBead(a.beadId)?.goalId;
      if (!goalId) continue;
      const beadId = 'beadId' in a ? a.beadId : undefined;
      const reason = a.type === 'merge' ? 'merge_conflict' : a.type === 'deliver' ? 'deliver_failed' : 'action_failed';
      const esc = ctx.store.escalate({ goalId, ...(beadId ? { beadId } : {}), reason, message: `${a.type} failed: ${message}` });
      if (esc) ctx.store.log({ kind: 'goal.escalated', goalId, ...(beadId ? { beadId } : {}), seat: 'marshal', data: { reason, message } });
    }
  }
  return actions;
}
