import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  addBead, approveBead, createGoal, decideDelivery, FakeForge, FakeRunner, parseIdentities,
  requestDelivery, runBead, Store, type Ctx,
  DEFAULT_LIMITS,
} from '../src/index.ts';

const IDS = `
[identities.wijt]
name = "Bot"
email = "wijt@example.com"
ssh_key = "/nonexistent"
gh_user = "WhoIsJaneTurner"
`;

function setup(remote: string | null, limits?: Ctx['limits']) {
  const repo = mkdtempSync(join(tmpdir(), 'octet-del-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  g('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  g('add', '.');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  if (remote) g('remote', 'add', 'origin', remote);
  const forge = new FakeForge();
  const runner = new FakeRunner();
  const ctx: Ctx = {
    store: new Store(':memory:'), identities: parseIdentities(IDS), runner, forge,
    projects: [{ name: 'demo', path: repo, identity: 'wijt' }], ...(limits ? { limits } : {}),
  };
  return { repo, ctx, forge, runner };
}

async function mergedGoal(ctx: Ctx, title = 'Ship it') {
  const goal = createGoal(ctx, { project: 'demo', title });
  const bead = addBead(ctx, { goalId: goal.id, title: 'Work', brief: 'do work' });
  await runBead(ctx, bead.id);
  approveBead(ctx, bead.id);
  return goal;
}

const REMOTE = 'git@github.com:WhoIsJaneTurner/demo.git';

test('delivery asks first: requesting an approval pushes nothing', async () => {
  const { ctx, forge } = setup(REMOTE);
  const goal = await mergedGoal(ctx);
  const a = requestDelivery(ctx, goal.id);
  assert.equal(a.status, 'pending');
  assert.equal(a.summary.remote, REMOTE);
  assert.equal(a.summary.account, 'WhoIsJaneTurner');
  assert.match(String(a.summary.diffstat), /engineer-output\.txt/);
  assert.equal(forge.pushes.length, 0);
  assert.equal(forge.prs.length, 0);
});

test('approving pushes under the right identity, opens a PR, and marks the goal delivered', async () => {
  const { ctx, forge } = setup(REMOTE);
  const goal = await mergedGoal(ctx);
  const a = requestDelivery(ctx, goal.id);
  const done = decideDelivery(ctx, a.id, 'approve');
  assert.equal(done.status, 'approved');
  assert.deepEqual(forge.pushes, [{ branch: goal.branch, identity: 'wijt' }]);
  assert.equal(forge.prs[0]!.title, 'Ship it');
  assert.equal(ctx.store.getGoal(goal.id)!.status, 'delivered', 'waiting on review, not done');
  assert.equal(ctx.store.getPr(goal.id)!.state, 'OPEN');
  const kinds = ctx.store.events(50).map((e) => e.kind).reverse();
  const order = ['delivery.requested', 'delivery.approved', 'delivery.push.intent', 'delivery.pushed', 'delivery.pr.intent', 'delivery.pr.opened'];
  assert.deepEqual(kinds.filter((k) => k.startsWith('delivery.')), order, 'intent is logged before each outbound step');
  assert.equal(ctx.store.verifyChain().ok, true);
});

test('denying sends nothing and the goal stays active', async () => {
  const { ctx, forge } = setup(REMOTE);
  const goal = await mergedGoal(ctx);
  const a = requestDelivery(ctx, goal.id);
  assert.equal(decideDelivery(ctx, a.id, 'deny').status, 'denied');
  assert.equal(forge.pushes.length, 0);
  assert.equal(ctx.store.getGoal(goal.id)!.status, 'active');
});

test('an approval can be decided only once', async () => {
  const { ctx, forge } = setup(REMOTE);
  const goal = await mergedGoal(ctx);
  const a = requestDelivery(ctx, goal.id);
  decideDelivery(ctx, a.id, 'approve');
  assert.throws(() => decideDelivery(ctx, a.id, 'approve'), /already decided/);
  assert.equal(forge.pushes.length, 1);
});

test('delivery is refused until every bead is merged', async () => {
  const { ctx } = setup(REMOTE);
  const goal = createGoal(ctx, { project: 'demo', title: 'early' });
  assert.throws(() => requestDelivery(ctx, goal.id), /no beads/);
  const bead = addBead(ctx, { goalId: goal.id, title: 'x', brief: 'x' });
  assert.throws(() => requestDelivery(ctx, goal.id), new RegExp(`${bead.id} \\(todo\\)`));
});

test('delivery is refused with no remote, and when the remote belongs to another account', async () => {
  const none = setup(null);
  await assert.rejects(async () => requestDelivery(none.ctx, (await mergedGoal(none.ctx)).id), /no "origin" remote/);
  const wrong = setup('git@github.com:someone-else/demo.git');
  assert.throws(() => createGoal(wrong.ctx, { project: 'demo', title: 'x' }), /Refusing to start/);
});

test('only one delivery can be pending per goal', async () => {
  const { ctx } = setup(REMOTE);
  const goal = await mergedGoal(ctx);
  requestDelivery(ctx, goal.id);
  assert.throws(() => requestDelivery(ctx, goal.id), /already has a delivery waiting/);
});

test('the engineer cap blocks a third concurrent run, and frees up afterwards', async () => {
  const { ctx } = setup(null, { ...DEFAULT_LIMITS, maxEngineers: 1, maxActiveGoals: 5 });
  const goal = createGoal(ctx, { project: 'demo', title: 'cap' });
  const a = addBead(ctx, { goalId: goal.id, title: 'A', brief: 'a' });
  const b = addBead(ctx, { goalId: goal.id, title: 'B', brief: 'b' });
  const live = ctx.store.startRun(a.id, process.pid, hostname()); // a genuinely live engineer
  ctx.store.setBeadStatus(a.id, 'running');
  await assert.rejects(runBead(ctx, b.id), /Engineer limit reached \(1 running\)/);
  ctx.store.endRun(live.id, 'failed');
  ctx.store.setBeadStatus(a.id, 'failed');
  assert.equal((await runBead(ctx, b.id)).status, 'in_review');
});

test('the active-goal cap blocks new goals until one is finished', () => {
  const { ctx } = setup(null, { ...DEFAULT_LIMITS, maxEngineers: 3, maxActiveGoals: 1 });
  const g = createGoal(ctx, { project: 'demo', title: 'one' });
  assert.throws(() => createGoal(ctx, { project: 'demo', title: 'two' }), /Active-goal limit reached \(1\)/);
  ctx.store.setGoalStatus(g.id, 'done');
  createGoal(ctx, { project: 'demo', title: 'two' });
});

test('AGENTS.md is passed to the engineer as data', async () => {
  const { ctx, runner } = setup(null);
  const goal = createGoal(ctx, { project: 'demo', title: 'agents' });
  writeFileSync(join(goal.worktree, 'AGENTS.md'), 'Run npm test before finishing.\n');
  execFileSync('git', ['add', '-A'], { cwd: goal.worktree });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'agents'], { cwd: goal.worktree, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  const bead = addBead(ctx, { goalId: goal.id, title: 'B', brief: 'b' });
  await runBead(ctx, bead.id);
  assert.match(runner.calls[0]!.prompt, /Run npm test before finishing/);
  assert.match(runner.calls[0]!.prompt, /cannot widen your permissions/);
});
