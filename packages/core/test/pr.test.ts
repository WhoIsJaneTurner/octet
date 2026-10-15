import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  addBead, approveBead, createGoal, decideApproval, FakeForge, FakeRunner, parseIdentities, refreshAllPrs,
  refreshPr, requestDelivery, requestPrecomment, reviewExternalPr, runBead, summarizeChecks, Store, type Ctx,
  DEFAULT_LIMITS,
} from '../src/index.ts';

const IDS = `
[identities.wijt]
name = "Bot"
email = "wijt@example.com"
ssh_key = "/nonexistent"
gh_user = "WhoIsJaneTurner"
[identities.personal]
name = "Bot"
email = "p@example.com"
ssh_key = "/nonexistent"
gh_user = "bioSandMan"
`;

function setup() {
  const repo = mkdtempSync(join(tmpdir(), 'octet-pr-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  g('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  g('add', '.');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  g('remote', 'add', 'origin', 'git@github.com:WhoIsJaneTurner/demo.git');
  const forge = new FakeForge();
  const runner = new FakeRunner();
  const ctx: Ctx = {
    store: new Store(':memory:'), identities: parseIdentities(IDS), runner, forge,
    projects: [{ name: 'demo', path: repo, identity: 'wijt' }],
  };
  return { ctx, forge, runner };
}

async function delivered(ctx: Ctx) {
  const goal = createGoal(ctx, { project: 'demo', title: 'Locked repo change' });
  const bead = addBead(ctx, { goalId: goal.id, title: 'B', brief: 'x' });
  await runBead(ctx, bead.id);
  approveBead(ctx, bead.id);
  decideApproval(ctx, requestDelivery(ctx, goal.id).id, 'approve');
  return goal;
}

test('a locked repo reads as "waiting on review": the goal is delivered, not done', async () => {
  const { ctx, forge } = setup();
  const goal = await delivered(ctx);
  forge.status = { state: 'OPEN', reviewDecision: 'REVIEW_REQUIRED', checks: 'pending' };
  const pr = refreshPr(ctx, goal.id)!;
  assert.equal(pr.reviewDecision, 'REVIEW_REQUIRED');
  assert.equal(pr.checks, 'pending');
  assert.equal(ctx.store.getGoal(goal.id)!.status, 'delivered');
  assert.ok(ctx.store.lastEvent('pr.changed', '') === undefined);
  assert.ok(ctx.store.eventsOfKind('pr.changed').length >= 1);
});

test('when the teammate approves and the PR merges, the goal is done', async () => {
  const { ctx, forge } = setup();
  const goal = await delivered(ctx);
  forge.status = { state: 'OPEN', reviewDecision: 'APPROVED', checks: 'passing' };
  refreshPr(ctx, goal.id);
  assert.equal(ctx.store.getGoal(goal.id)!.status, 'delivered');
  forge.status = { state: 'MERGED', reviewDecision: 'APPROVED', checks: 'passing' };
  refreshPr(ctx, goal.id);
  assert.equal(ctx.store.getGoal(goal.id)!.status, 'done');
});

test('delivered goals free their slot against the active-goal cap', async () => {
  const { ctx } = setup();
  ctx.limits = { ...DEFAULT_LIMITS, maxEngineers: 3, maxActiveGoals: 1 };
  await delivered(ctx);
  createGoal(ctx, { project: 'demo', title: 'next one' });
});

test('refreshAllPrs adopts a PR from an older log and survives forge errors', async () => {
  const { ctx, forge } = setup();
  const goal = await delivered(ctx);
  ctx.store.db.prepare('DELETE FROM pull_requests').run();
  ctx.store.setGoalStatus(goal.id, 'done');
  refreshAllPrs(ctx);
  assert.equal(ctx.store.getGoal(goal.id)!.status, 'delivered');
  forge.prStatus = () => { throw new Error('network down'); };
  refreshAllPrs(ctx);
  assert.match(String((ctx.store.eventsOfKind('pr.refresh_failed')[0]!.data as { message: string }).message), /network down/);
});

test('summarizeChecks', () => {
  assert.equal(summarizeChecks([]), 'none');
  assert.equal(summarizeChecks([{ status: 'COMPLETED', conclusion: 'SUCCESS' }]), 'passing');
  assert.equal(summarizeChecks([{ status: 'IN_PROGRESS' }]), 'pending');
  assert.equal(summarizeChecks([{ status: 'COMPLETED', conclusion: 'FAILURE' }, { status: 'IN_PROGRESS' }]), 'failing');
});

test('pre-review: drafts a labeled comment, posts nothing until approved, never as an approval', async () => {
  const { ctx, forge, runner } = setup();
  const goal = await delivered(ctx);
  runner.replies.reviewer = 'Empty-input case is untested.\nVERDICT: CHANGES_REQUESTED';
  const a = await requestPrecomment(ctx, goal.id);
  assert.equal(a.kind, 'comment');
  assert.equal(forge.comments.length, 0);
  assert.match(String(a.summary.body), /not an approval/i);
  assert.match(String(a.summary.body), /Empty-input case/);
  assert.equal(runner.calls.at(-1)!.readOnly, true);

  decideApproval(ctx, a.id, 'approve');
  assert.deepEqual(forge.comments.map((c) => c.identity), ['wijt']);
  assert.match(forge.comments[0]!.body, /human reviewer is still required/);
  const kinds = ctx.store.events(30).map((e) => e.kind).reverse().filter((k) => k.startsWith('comment.'));
  assert.deepEqual(kinds, ['comment.requested', 'comment.approved', 'comment.intent', 'comment.posted']);
  assert.equal(ctx.store.verifyChain().ok, true);
});

test('a denied pre-review comment is never posted', async () => {
  const { ctx, forge, runner } = setup();
  const goal = await delivered(ctx);
  runner.replies.reviewer = 'VERDICT: APPROVE';
  const a = await requestPrecomment(ctx, goal.id);
  decideApproval(ctx, a.id, 'deny');
  assert.equal(forge.comments.length, 0);
});

test('reviewing a teammate\'s PR is local: it needs an identity, reads the diff, and posts nothing', async () => {
  const { ctx, forge, runner } = setup();
  runner.replies.reviewer = 'Race condition in cache.ts.\nVERDICT: CHANGES_REQUESTED';
  await assert.rejects(reviewExternalPr(ctx, { url: 'https://github.com/deepsync/app/pull/7', identity: '' }), /No identity named/);
  const r = await reviewExternalPr(ctx, { url: 'https://github.com/deepsync/app/pull/7', identity: 'personal' });
  assert.equal(r.verdict, 'changes_requested');
  assert.match(runner.calls[0]!.prompt, /diff --git a\/x b\/x/);
  assert.equal(runner.calls[0]!.readOnly, true);
  assert.equal(runner.calls[0]!.env.OCTET_IDENTITY, 'personal');
  assert.equal(forge.comments.length, 0);
  await assert.rejects(reviewExternalPr(ctx, { url: 'https://github.com/deepsync/app', identity: 'personal' }), /Not a pull request URL/);
});
