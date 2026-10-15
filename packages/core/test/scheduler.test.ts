import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  approveBead, cancelBead, decideApproval, decide, planRequest, reviewBead, runBead, tick, type Ctx, type SchedHooks,
} from '../src/index.ts';
import { bead, planJson, routed, setup } from './helpers.ts';

/** Runs scheduler ticks to quiescence, awaiting whatever each tick starts. */
function driver(ctx: Ctx) {
  const running = new Set<string>();
  const reviewing = new Set<string>();
  const pending: Promise<unknown>[] = [];
  const hooks: SchedHooks = { isRunning: (id) => running.has(id), isReviewing: (id) => reviewing.has(id) };
  const exec = {
    run: (id: string) => { running.add(id); pending.push(runBead(ctx, id).catch(() => {}).finally(() => running.delete(id))); },
    review: (id: string) => { reviewing.add(id); pending.push(reviewBead(ctx, id).catch(() => {}).finally(() => reviewing.delete(id))); },
  };
  return {
    hooks,
    async settle(maxRounds = 30) {
      for (let i = 0; i < maxRounds; i++) {
        const acts = tick(ctx, hooks, exec);
        if (process.env.DBG) console.log(i, JSON.stringify(acts.map((a) => `${a.type}:${'beadId' in a ? a.beadId : ''}`)), ctx.store.listBeads().map((b) => `${b.planItem}=${b.status}`).join(','));
        const waits = pending.splice(0);
        await Promise.all(waits);
        if (!waits.length && !acts.some((a) => a.type === 'merge' || a.type === 'deliver')) return;
      }
      throw new Error('scheduler did not settle');
    },
  };
}

async function approvedGoal(opts: { autonomy?: 'manual' | 'plan-gated' | 'auto-to-pr'; limits?: Ctx['limits']; planning?: Ctx['planning']; beads?: unknown[] } = {}) {
  const s = setup(opts.autonomy ? { autonomy: opts.autonomy } : {}, { ...(opts.limits ? { limits: opts.limits } : {}), ...(opts.planning ? { planning: opts.planning } : {}) });
  s.runner.replies.reviewer = 'Looks right.\nVERDICT: APPROVE';
  s.runner.script('architect', [planJson(opts.beads ?? [bead('b1'), bead('b2', { depends_on: ['b1'] })])]);
  const rec = await planRequest(s.ctx, routed(s.ctx).id);
  decideApproval(s.ctx, s.ctx.store.listApprovals().find((a) => a.kind === 'plan')!.id, 'approve');
  const byItem = (i: string) => s.ctx.store.listBeads(rec.goalId).find((b) => b.planItem === i)!;
  return { ...s, rec, byItem, d: driver(s.ctx) };
}

test('plan-gated: runs and reviews on its own in dependency order, you merge each bead, delivery stops at an approval', async () => {
  const { ctx, byItem, d, rec, forge } = Object.assign(await approvedGoal(), { forge: undefined });
  await d.settle();
  assert.equal(byItem('b1').status, 'in_review'); // built and reviewed...
  assert.equal(byItem('b2').status, 'todo'); // ...but b2 waits for b1 to merge
  assert.equal(ctx.store.lastEvent('review.verdict', byItem('b1').id) !== undefined, true);
  approveBead(ctx, byItem('b1').id); // the human merge
  await d.settle();
  assert.equal(byItem('b2').status, 'in_review');
  assert.equal(ctx.store.listApprovals().filter((a) => a.kind === 'deliver').length, 0);
  approveBead(ctx, byItem('b2').id);
  await d.settle();
  const delivery = ctx.store.listApprovals().filter((a) => a.kind === 'deliver');
  assert.equal(delivery.length, 1);
  assert.equal(delivery[0]!.status, 'pending'); // never auto-approved
  await d.settle(); // more ticks do not duplicate it
  assert.equal(ctx.store.listApprovals().filter((a) => a.kind === 'deliver').length, 1);
  assert.equal(ctx.store.getPr(rec.goalId), undefined);
  assert.equal(ctx.store.verifyChain().ok, true);
  assert.ok(forge === undefined);
});

test('auto-to-pr: merges approved beads itself and stops at the delivery approval', async () => {
  const { ctx, byItem, d, rec } = await approvedGoal({ autonomy: 'auto-to-pr' });
  await d.settle();
  assert.equal(byItem('b1').status, 'merged');
  assert.equal(byItem('b2').status, 'merged');
  const delivery = ctx.store.listApprovals().filter((a) => a.kind === 'deliver');
  assert.deepEqual(delivery.map((a) => a.status), ['pending']);
  assert.equal(ctx.store.getGoal(rec.goalId)!.status, 'active'); // not delivered until you approve
});

test('a denied delivery is not asked for again', async () => {
  const { ctx, d } = await approvedGoal({ autonomy: 'auto-to-pr' });
  await d.settle();
  decideApproval(ctx, ctx.store.listApprovals().find((a) => a.kind === 'deliver')!.id, 'deny');
  await d.settle();
  assert.equal(ctx.store.listApprovals().filter((a) => a.kind === 'deliver').length, 1);
});

test('manual projects and hand-made goals are never touched by the scheduler', async () => {
  const m = await approvedGoal({ autonomy: 'manual' });
  assert.deepEqual(decide(m.ctx, m.d.hooks), []);

  const h = setup();
  const { createGoal, addBead } = await import('../src/index.ts');
  const g = createGoal(h.ctx, { project: 'demo', title: 'by hand' });
  addBead(h.ctx, { goalId: g.id, title: 'x', brief: 'x' });
  assert.deepEqual(decide(h.ctx, driver(h.ctx).hooks), []);
});

test('a paused goal is skipped; resuming picks it up', async () => {
  const { ctx, rec, d, byItem } = await approvedGoal();
  ctx.store.setGoalPaused(rec.goalId, true);
  await d.settle();
  assert.equal(byItem('b1').status, 'todo');
  ctx.store.setGoalPaused(rec.goalId, false);
  await d.settle();
  assert.equal(byItem('b1').status, 'in_review');
});

test('the engineer cap holds: independent beads start one at a time, oldest first', async () => {
  const { ctx, d, byItem } = await approvedGoal({
    limits: { maxEngineers: 1, maxActiveGoals: 3, runTimeoutMs: 60_000 },
    beads: [bead('b1'), bead('b2'), bead('b3')],
  });
  const first = decide(ctx, d.hooks).filter((a) => a.type === 'run');
  assert.deepEqual(first, [{ type: 'run', beadId: byItem('b1').id }]);
  ctx.store.setBeadStatus(byItem('b1').id, 'running');
  ctx.store.startRun(byItem('b1').id, process.pid, (await import('node:os')).hostname());
  assert.deepEqual(decide(ctx, d.hooks).filter((a) => a.type === 'run'), []); // cap full
});

test('a failing bead is retried up to the limit, then escalates once and stops', async () => {
  const { ctx, runner, d, byItem, rec } = await approvedGoal({ beads: [bead('b1')], planning: { maxBeads: 12, maxPoints: 36, maxRunsFactor: 10, maxRetries: 2, capWaitMinutes: 30 } });
  runner.exit.set('engineer', 1);
  await d.settle();
  assert.equal(ctx.store.countEvents('bead.failed', byItem('b1').id), 3); // first try + 2 retries
  const esc = ctx.store.listEscalations(true);
  assert.deepEqual(esc.map((e) => e.reason), ['bead_failed']);
  assert.equal(ctx.store.eventsOfKind('goal.escalated').length, 1);
  await d.settle();
  assert.equal(ctx.store.listEscalations(true).length, 1); // no duplicates
  // Fixing the cause and re-running clears it.
  runner.exit.clear();
  await runBead(ctx, byItem('b1').id);
  await d.settle();
  assert.equal(ctx.store.listEscalations(true).filter((e) => e.reason === 'bead_failed').length, 0);
  assert.ok(rec);
});

test('the per-goal run ceiling stops new engineer runs and escalates', async () => {
  const { ctx, runner, d, byItem } = await approvedGoal({ beads: [bead('b1')], planning: { maxBeads: 12, maxPoints: 36, maxRunsFactor: 2, maxRetries: 9, capWaitMinutes: 30 } });
  runner.exit.set('engineer', 1);
  await d.settle();
  assert.equal(ctx.store.lastRun(byItem('b1').id)!.n, 2); // 2 runs = 2 x 1 bead
  assert.ok(ctx.store.listEscalations(true).some((e) => e.reason === 'run_ceiling'));
});

test('a rejected bead goes back to the engineer; after max rounds it escalates to you', async () => {
  const { ctx, runner, d, byItem } = await approvedGoal({ beads: [bead('b1')] });
  ctx.review = { auto: false, autoMerge: false, maxRounds: 1 };
  runner.replies.reviewer = 'Wrong.\nVERDICT: CHANGES_REQUESTED';
  await d.settle();
  const b = byItem('b1');
  assert.equal(b.status, 'in_review');
  assert.equal(ctx.store.countEvents('review.rejected', b.id), 1);
  assert.deepEqual(ctx.store.listEscalations(true).map((e) => e.reason), ['review_rounds']);
  assert.equal(runner.calls.filter((c) => c.seat === 'reviewer').length, 2);
});

test('an inconclusive review escalates instead of looping', async () => {
  const { ctx, runner, d } = await approvedGoal({ beads: [bead('b1')] });
  runner.replies.reviewer = 'I cannot tell.';
  await d.settle();
  assert.deepEqual(ctx.store.listEscalations(true).map((e) => e.reason), ['review_inconclusive']);
  assert.equal(runner.calls.filter((c) => c.seat === 'reviewer').length, 1);
});

test('a bead you cancelled is not retried behind your back', async () => {
  const { ctx, runner, d, byItem } = await approvedGoal({ beads: [bead('b1')] });
  runner.hang.add('engineer');
  const id = byItem('b1').id;
  const run = runBead(ctx, id);
  while (ctx.store.getBead(id)!.status !== 'running') await new Promise((r) => setTimeout(r, 10));
  cancelBead(ctx, id);
  await run;
  runner.hang.clear();
  await d.settle();
  assert.equal(ctx.store.getBead(id)!.status, 'failed');
  assert.deepEqual(ctx.store.listEscalations(true).map((e) => e.reason), ['cancelled']);
  assert.equal(ctx.store.lastRun(id)!.n, 1);
});

test('the scheduler never merges unless the Reviewer approved this version of the bead', async () => {
  const { ctx, runner, d, byItem } = await approvedGoal({ autonomy: 'auto-to-pr', beads: [bead('b1')] });
  runner.replies.reviewer = 'VERDICT: CHANGES_REQUESTED\nnope';
  ctx.review = { auto: false, autoMerge: false, maxRounds: 0 };
  await d.settle();
  assert.notEqual(byItem('b1').status, 'merged');
});
