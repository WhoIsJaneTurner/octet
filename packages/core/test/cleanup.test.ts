import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  abandonGoal, addBead, approveBead, cleanupGoal, createGoal, decideApproval, deleteBead, editBead, FakeForge, findStragglers, gc,
  refreshPr, requestDelivery, runBead,
} from '../src/index.ts';
import { setup } from './helpers.ts';

const until = async (fn: () => boolean) => {
  for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(fn(), 'condition not met in time');
};

const hasBranch = (repo: string, branch: string) => {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
    return true;
  } catch { return false; }
};

function withGoal() {
  const s = setup({}, { forge: new FakeForge() });
  const goal = createGoal(s.ctx, { project: 'demo', title: 'cleanup me' });
  const mk = (title: string, dependsOn: string[] = []) => addBead(s.ctx, { goalId: goal.id, title, brief: title, dependsOn });
  return { ...s, goal, mk };
}

test('abandoning a goal stops its running bead, removes the worktrees, keeps the branches and closes escalations', async () => {
  const { ctx, runner, repo, goal, mk } = withGoal();
  const done = mk('merged one');
  await runBead(ctx, done.id);
  approveBead(ctx, done.id);
  const busy = mk('stuck');
  const waiting = mk('never started');
  runner.hang.add('engineer');
  const running = runBead(ctx, busy.id);
  await until(() => ctx.store.getBead(busy.id)!.status === 'running');
  ctx.store.escalate({ goalId: goal.id, beadId: busy.id, reason: 'bead_failed', message: 'x' });

  const res = await abandonGoal(ctx, goal.id, { waitMs: 3000 });
  await running;

  assert.equal(res.goal.status, 'failed');
  assert.deepEqual(res.cancelled, [busy.id]);
  assert.deepEqual(res.stillRunning, []);
  assert.ok(res.removed.includes(busy.worktree) && res.removed.includes(goal.worktree));
  assert.equal(existsSync(busy.worktree), false);
  assert.equal(existsSync(goal.worktree), false);
  assert.ok(hasBranch(repo, goal.branch), 'the goal branch is kept');
  assert.ok(hasBranch(repo, busy.branch), 'the bead branch is kept');
  assert.equal(ctx.store.getBead(busy.id)!.status, 'failed');
  assert.equal(ctx.store.listEscalations(true).length, 0);
  assert.equal(ctx.store.openRuns().length, 0);
  assert.equal(ctx.store.eventsOfKind('goal.abandoned')[0]!.goalId, goal.id);
  assert.equal(ctx.store.verifyChain().ok, true);

  await assert.rejects(() => runBead(ctx, waiting.id), /abandoned/);
  // Repeating it is harmless.
  assert.deepEqual((await abandonGoal(ctx, goal.id)).removed, []);
});

test('abandoning withdraws a delivery that is waiting for approval, so it can never be approved later', async () => {
  const { ctx, goal, mk } = withGoal();
  const b = mk('only');
  await runBead(ctx, b.id);
  approveBead(ctx, b.id);
  const approval = requestDelivery(ctx, goal.id);
  await abandonGoal(ctx, goal.id);
  assert.equal(ctx.store.getApproval(approval.id)!.status, 'denied');
  assert.throws(() => decideApproval(ctx, approval.id, 'approve'), /already decided/);
  assert.equal(ctx.store.eventsOfKind('delivery.pushed').length, 0);
});

test('a delivered goal is never abandoned (its PR is not ours to touch), and a done goal has nothing to abandon', async () => {
  const { ctx, goal, mk } = withGoal();
  const b = mk('only');
  await runBead(ctx, b.id);
  approveBead(ctx, b.id);
  decideApproval(ctx, requestDelivery(ctx, goal.id).id, 'approve');
  assert.equal(ctx.store.getGoal(goal.id)!.status, 'delivered');
  await assert.rejects(() => abandonGoal(ctx, goal.id), /pull request open/);
  assert.equal(ctx.store.getGoal(goal.id)!.status, 'delivered');
  assert.ok(existsSync(goal.worktree));
  assert.equal(ctx.store.getPr(goal.id)!.state, 'OPEN');

  (ctx.forge as FakeForge).status = { state: 'MERGED', reviewDecision: 'APPROVED', checks: 'passing' };
  refreshPr(ctx, goal.id);
  await assert.rejects(() => abandonGoal(ctx, goal.id), /already done/);
});

test('when the PR merges the goal is done and its worktrees go; the branch stays until you delete it', async () => {
  const { ctx, repo, goal, mk } = withGoal();
  const b = mk('only');
  await runBead(ctx, b.id);
  approveBead(ctx, b.id);
  decideApproval(ctx, requestDelivery(ctx, goal.id).id, 'approve');
  assert.ok(existsSync(goal.worktree));
  assert.throws(() => cleanupGoal(ctx, goal.id), /only done or abandoned/);

  (ctx.forge as FakeForge).status = { state: 'MERGED', reviewDecision: 'APPROVED', checks: 'passing' };
  refreshPr(ctx, goal.id);
  assert.equal(ctx.store.getGoal(goal.id)!.status, 'done');
  assert.equal(existsSync(goal.worktree), false);
  assert.ok(hasBranch(repo, goal.branch));
  assert.ok(ctx.store.eventsOfKind('goal.cleaned').length === 1);
  assert.deepEqual(cleanupGoal(ctx, goal.id), []); // idempotent
});

test('gc lists stragglers by default and only deletes with apply; live worktrees are never touched', async () => {
  const { ctx, repo, goal, mk } = withGoal();
  const live = mk('live');
  await runBead(ctx, live.id); // in_review: its worktree is in use
  const merged = mk('merged');
  await runBead(ctx, merged.id);
  approveBead(ctx, merged.id); // approveBead already removed the worktree...
  mkdirSync(merged.worktree, { recursive: true }); // ...so recreate a leftover
  writeFileSync(join(merged.worktree, 'junk.txt'), 'x');
  const unknown = join(repo, '.octet', 'worktrees', 'bead-from-another-database');
  mkdirSync(unknown, { recursive: true });

  const dry = gc(ctx);
  assert.deepEqual(dry.stragglers.map((s) => s.path).sort(), [merged.worktree, unknown].sort());
  assert.match(dry.stragglers.find((s) => s.path === merged.worktree)!.reason, /merged/);
  assert.match(dry.stragglers.find((s) => s.path === unknown)!.reason, /not recorded/);
  assert.deepEqual(dry.removed, []);
  assert.ok(existsSync(merged.worktree) && existsSync(unknown));

  const applied = gc(ctx, { apply: true });
  assert.deepEqual(applied.removed.sort(), [merged.worktree, unknown].sort());
  assert.deepEqual(applied.failed, []);
  assert.equal(existsSync(merged.worktree), false);
  assert.equal(existsSync(unknown), false);
  assert.ok(existsSync(live.worktree) && existsSync(goal.worktree));
  assert.deepEqual(findStragglers(ctx), []);
  assert.equal(ctx.store.verifyChain().ok, true);
});

test('gc also finds the leftovers of an abandoned goal whose agent had not stopped', async () => {
  const { ctx, goal, mk } = withGoal();
  const b = mk('x');
  await runBead(ctx, b.id);
  ctx.store.setGoalStatus(goal.id, 'failed'); // abandoned some other way
  const found = findStragglers(ctx).map((s) => s.path).sort();
  assert.deepEqual(found, [b.worktree, goal.worktree].sort());
  assert.equal(gc(ctx, { apply: true }).removed.length, 2);
});

test('editing a bead: allowed before it runs (and after a failure), validated, logged, and refused once it has started', async () => {
  const { ctx, runner, goal, mk } = withGoal();
  const b = mk('first');
  const edited = editBead(ctx, b.id, { brief: '  a better brief  ', title: 'First, renamed' });
  assert.equal(edited.brief, 'a better brief');
  assert.equal(edited.title, 'First, renamed');
  assert.deepEqual((ctx.store.lastEvent('bead.edited', b.id)!.data as { fields: string[] }).fields, ['title', 'brief']);
  assert.throws(() => editBead(ctx, b.id, { brief: '   ' }), /cannot be empty/);
  assert.throws(() => editBead(ctx, b.id, { brief: 'x'.repeat(20_001) }), /too long/);
  assert.throws(() => editBead(ctx, 'nope', { brief: 'x' }), /Unknown bead/);

  runner.exit.set('engineer', 1);
  await runBead(ctx, b.id);
  assert.equal(ctx.store.getBead(b.id)!.status, 'failed');
  assert.equal(editBead(ctx, b.id, { brief: 'try this instead' }).brief, 'try this instead');

  runner.exit.delete('engineer');
  await runBead(ctx, b.id);
  assert.equal(ctx.store.getBead(b.id)!.status, 'in_review');
  assert.throws(() => editBead(ctx, b.id, { brief: 'too late' }), /only a todo or failed bead/);

  ctx.store.setGoalStatus(goal.id, 'failed');
  const c = ctx.store.insertBead({ id: 'bead-late', goalId: goal.id, title: 't', brief: 'b', dependsOn: [], branch: 'x', worktree: 'y' });
  assert.throws(() => editBead(ctx, c.id, { brief: 'z' }), /not active/);
});

test('deleting a bead: only one that has not started and that nothing waits on', async () => {
  const { ctx, goal, mk } = withGoal();
  const first = mk('first');
  const second = mk('second', [first.id]);
  assert.throws(() => deleteBead(ctx, first.id), /"second" waits on it/);
  deleteBead(ctx, second.id);
  assert.equal(ctx.store.getBead(second.id), undefined);
  assert.ok(ctx.store.lastEvent('bead.deleted', second.id));
  deleteBead(ctx, first.id); // nothing waits on it any more
  assert.equal(ctx.store.listBeads(goal.id).length, 0);
  assert.throws(() => deleteBead(ctx, first.id), /Unknown bead/);

  const started = mk('started');
  await runBead(ctx, started.id);
  assert.throws(() => deleteBead(ctx, started.id), /already started/);
  assert.equal(ctx.store.verifyChain().ok, true);
});
