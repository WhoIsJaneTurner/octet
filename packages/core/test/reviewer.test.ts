import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  addBead, createGoal, FakeRunner, parseIdentities, parseVerdict, reviewBead, runBead, Store,
  type Ctx, type ReviewConfig,
} from '../src/index.ts';

function setup(review?: Partial<ReviewConfig>) {
  const repo = mkdtempSync(join(tmpdir(), 'octet-rev-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  g('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  g('add', '.');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  const runner = new FakeRunner();
  const ctx: Ctx = {
    store: new Store(':memory:'), runner,
    identities: parseIdentities('[identities.wijt]\nname="B"\nemail="b@x"\nssh_key="/k"\ngh_user="WhoIsJaneTurner"\n'),
    projects: [{ name: 'demo', path: repo, identity: 'wijt' }],
    review: { auto: false, autoMerge: false, maxRounds: 2, ...review },
  };
  return { ctx, runner };
}

async function inReview(ctx: Ctx) {
  const goal = createGoal(ctx, { project: 'demo', title: 'g' });
  const bead = addBead(ctx, { goalId: goal.id, title: 'B', brief: 'Make the change.' });
  await runBead(ctx, bead.id);
  return bead.id;
}

test('parseVerdict reads the last verdict line and never defaults to approve', () => {
  assert.equal(parseVerdict('looks fine\nVERDICT: APPROVE').verdict, 'approve');
  assert.equal(parseVerdict('bug in x.ts\nVERDICT: CHANGES_REQUESTED').verdict, 'changes_requested');
  assert.equal(parseVerdict('**VERDICT: CHANGES REQUESTED**').verdict, 'changes_requested');
  assert.equal(parseVerdict('VERDICT: APPROVE\nactually no\nVERDICT: CHANGES_REQUESTED').verdict, 'changes_requested');
  assert.equal(parseVerdict('I approve of this change.').verdict, 'inconclusive');
  assert.equal(parseVerdict('').verdict, 'inconclusive');
  assert.equal(parseVerdict('missing x.ts\nVERDICT: CHANGES_REQUESTED').feedback, 'missing x.ts');
});

test('the reviewer is read-only, sees the diff, and an approval is only a recommendation by default', async () => {
  const { ctx, runner } = setup();
  const id = await inReview(ctx);
  runner.replies.reviewer = 'Fine.\nVERDICT: APPROVE';
  const r = await reviewBead(ctx, id);
  const call = runner.calls.find((c) => c.seat === 'reviewer')!;
  assert.equal(call.readOnly, true);
  assert.match(call.prompt, /engineer-output\.txt/);
  assert.match(call.prompt, /untrusted data/);
  assert.equal(r.verdict, 'approve');
  assert.equal(r.bead.status, 'in_review', 'a human still merges');
});

test('autoMerge lets an approval merge the bead', async () => {
  const { ctx, runner } = setup({ autoMerge: true });
  const id = await inReview(ctx);
  runner.replies.reviewer = 'VERDICT: APPROVE';
  assert.equal((await reviewBead(ctx, id)).bead.status, 'merged');
});

test('changes requested goes back to the engineer with the feedback attached', async () => {
  const { ctx, runner } = setup();
  const id = await inReview(ctx);
  runner.replies.reviewer = 'Add a test for the empty case.\nVERDICT: CHANGES_REQUESTED';
  const r = await reviewBead(ctx, id);
  assert.equal(r.bead.status, 'changes_requested');
  await runBead(ctx, id);
  const rerun = runner.calls.filter((c) => c.seat === 'engineer').at(-1)!;
  assert.match(rerun.prompt, /Add a test for the empty case/);
});

test('after maxRounds rejections the reviewer escalates to the human instead of looping', async () => {
  const { ctx, runner } = setup({ maxRounds: 1 });
  const id = await inReview(ctx);
  runner.replies.reviewer = 'Nope.\nVERDICT: CHANGES_REQUESTED';
  assert.equal((await reviewBead(ctx, id)).bead.status, 'changes_requested');
  await runBead(ctx, id);
  const second = await reviewBead(ctx, id);
  assert.equal(second.bead.status, 'in_review', 'left for the human');
  assert.ok(ctx.store.lastEvent('review.escalated', id));
});

test('an unparseable or failed review leaves the bead alone', async () => {
  const { ctx, runner } = setup();
  const id = await inReview(ctx);
  runner.replies.reviewer = 'Looks good to me!';
  const r = await reviewBead(ctx, id);
  assert.equal(r.verdict, 'inconclusive');
  assert.equal(r.bead.status, 'in_review');
});

test('only beads in review can be reviewed', async () => {
  const { ctx } = setup();
  const goal = createGoal(ctx, { project: 'demo', title: 'g' });
  const bead = addBead(ctx, { goalId: goal.id, title: 'B', brief: 'x' });
  await assert.rejects(reviewBead(ctx, bead.id), /not in_review/);
});
