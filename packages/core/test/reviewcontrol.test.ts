import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  addBead, cancelBead, cancelReview, createGoal, decideApproval, FakeForge, friendlyGhError, GitHubForge, parseIdentities, planRequest,
  reviewBead, reviewExternalPr, runBead, tick, type AgentRunner, type RunRequest, type RunResult, type SchedHooks,
} from '../src/index.ts';
import { bead, IDS, planJson, routed, setup } from './helpers.ts';

const until = async (fn: () => boolean) => {
  for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(fn(), 'condition not met in time');
};

async function inReview() {
  const s = setup();
  const goal = createGoal(s.ctx, { project: 'demo', title: 'rev' });
  const b = addBead(s.ctx, { goalId: goal.id, title: 'A', brief: 'a' });
  await runBead(s.ctx, b.id);
  assert.equal(s.ctx.store.getBead(b.id)!.status, 'in_review');
  return { ...s, goal, b };
}

test('cancelling a Reviewer run (cancelBead on an in_review bead) stops it, leaves the bead in_review and logs the event', async () => {
  const { ctx, runner, b } = await inReview();
  runner.hang.add('reviewer');
  const review = reviewBead(ctx, b.id);
  await until(() => ctx.store.openRuns().some((r) => r.kind === 'review'));
  assert.equal(cancelBead(ctx, b.id), true);
  const out = await review;

  assert.equal(out.cancelled, true);
  assert.equal(out.verdict, 'inconclusive');
  assert.equal(out.bead.status, 'in_review');
  assert.equal(ctx.store.openRuns().length, 0);
  assert.ok(ctx.store.lastEvent('review.cancel_requested', b.id));
  const ev = ctx.store.lastEvent('review.cancelled', b.id)!;
  assert.equal((ev.data as { reason: string }).reason, 'cancelled');
  assert.equal(ctx.store.lastEvent('review.verdict', b.id), undefined);
  assert.equal(ctx.store.countEvents('review.rejected', b.id), 0);
  assert.equal(ctx.store.lastRun(b.id)!.kind, 'engineer'); // the engineer run is still "the last run" for output
  assert.equal(ctx.store.verifyChain().ok, true);

  // The bead can be reviewed again afterwards.
  runner.hang.delete('reviewer');
  runner.replies.reviewer = 'ok\nVERDICT: APPROVE';
  assert.equal((await reviewBead(ctx, b.id)).verdict, 'approve');
});

test('a review cancel recorded in the database by another process is honoured at the next heartbeat', async () => {
  const { ctx, runner, b } = await inReview();
  runner.hang.add('reviewer');
  const review = reviewBead(ctx, b.id);
  await until(() => ctx.store.openRuns().some((r) => r.kind === 'review'));
  ctx.store.requestCancel(b.id, 'review'); // what a CLI in another process does
  assert.equal((await review).cancelled, true);
  assert.equal(ctx.store.eventsOfKind('review.cancelled').length, 1);
});

test('cancel errors are clear: nothing running to cancel, and only one review at a time', async () => {
  const { ctx, runner, b } = await inReview();
  assert.throws(() => cancelReview(ctx, b.id), /no review running/);
  assert.throws(() => cancelBead(ctx, 'nope'), /Unknown bead/);
  runner.hang.add('reviewer');
  const review = reviewBead(ctx, b.id);
  await until(() => ctx.store.openRuns().some((r) => r.kind === 'review'));
  await assert.rejects(() => reviewBead(ctx, b.id), /already being reviewed/);
  cancelReview(ctx, b.id);
  await review;
});

test('a finished review closes its run row and records usage; a crashed reviewer closes it as an error', async () => {
  const { ctx, runner, b } = await inReview();
  runner.replies.reviewer = 'fine\nVERDICT: APPROVE';
  runner.usage.set('reviewer', { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.02 });
  await reviewBead(ctx, b.id);
  assert.equal(ctx.store.openRuns().length, 0);
  assert.equal(ctx.store.usageSummary().byBead[b.id]!.costUsd, 0.02);

  const boom: AgentRunner = { run: () => Promise.reject(new Error('runner exploded')) };
  await assert.rejects(() => reviewBead({ ...ctx, runner: boom }, b.id), /exploded/);
  assert.equal(ctx.store.openRuns().length, 0);
});

test('the scheduler does not restart a review you cancelled: it asks you instead, and stops asking after a verdict', async () => {
  const s = setup();
  const { ctx, runner } = s;
  runner.replies.reviewer = 'ok\nVERDICT: APPROVE';
  runner.script('architect', [planJson([bead('b1')])]);
  const rec = await planRequest(ctx, routed(ctx).id);
  decideApproval(ctx, ctx.store.listApprovals().find((a) => a.kind === 'plan')!.id, 'approve');
  const b = ctx.store.listBeads(rec.goalId)[0]!;
  await runBead(ctx, b.id);

  const started: string[] = [];
  const hooks: SchedHooks = { isRunning: () => false, isReviewing: () => false };
  const exec = { run: () => {}, review: (id: string) => { started.push(id); } };
  runner.hang.add('reviewer');
  const review = reviewBead(ctx, b.id);
  await until(() => ctx.store.openRuns().some((r) => r.kind === 'review'));
  cancelBead(ctx, b.id);
  await review;

  const acts = tick(ctx, hooks, exec);
  assert.deepEqual(started, []);
  assert.ok(acts.some((a) => a.type === 'escalate' && a.reason === 'review_cancelled'));
  assert.equal(ctx.store.listEscalations(true).filter((e) => e.reason === 'review_cancelled').length, 1);
  tick(ctx, hooks, exec);
  assert.equal(ctx.store.listEscalations(true).filter((e) => e.reason === 'review_cancelled').length, 1); // deduplicated

  runner.hang.delete('reviewer');
  await reviewBead(ctx, b.id); // you review it by hand
  tick(ctx, hooks, exec);
  assert.equal(ctx.store.listEscalations(true).filter((e) => e.reason === 'review_cancelled').length, 0);
});

test('reviewExternalPr removes its temp directory, on success and when the runner throws', async () => {
  const seen: string[] = [];
  const ok: AgentRunner = {
    async run(req: RunRequest): Promise<RunResult> {
      seen.push(req.cwd);
      assert.ok(existsSync(req.cwd), 'the directory exists while the reviewer runs');
      return { exitCode: 0, output: 'fine\nVERDICT: APPROVE', durationMs: 1 };
    },
  };
  const { ctx } = setup({}, { forge: new FakeForge() });
  const r = await reviewExternalPr({ ...ctx, runner: ok }, { url: 'https://github.com/o/r/pull/3', identity: 'wijt' });
  assert.equal(r.verdict, 'approve');
  assert.equal(existsSync(seen[0]!), false);

  const bad: AgentRunner = { run: (req) => { seen.push(req.cwd); return Promise.reject(new Error('nope')); } };
  await assert.rejects(() => reviewExternalPr({ ...ctx, runner: bad }, { url: 'https://github.com/o/r/pull/3', identity: 'wijt' }), /nope/);
  assert.equal(existsSync(seen[1]!), false);
  assert.notEqual(seen[0], seen[1]);
});

test('friendlyGhError turns a missing or unreachable PR into a plain message and leaves unknown failures alone', () => {
  const id = parseIdentities(IDS)[0]!;
  const nf = friendlyGhError('GraphQL: Could not resolve to a PullRequest with the number of 99. (repository.pullRequest)', id)!;
  assert.match(nf, /Cannot reach that pull request as wijt \(WhoIsJaneTurner\)/);
  assert.ok(!/GraphQL/.test(nf));
  assert.match(friendlyGhError('GraphQL: Could not resolve to a Repository with the name \'o/private\'.', id)!, /Cannot reach that pull request/);
  assert.match(friendlyGhError('HTTP 404: Not Found (https://api.github.com/repos/o/r/pulls/9)', id)!, /Cannot reach that pull request/);
  assert.match(friendlyGhError('HTTP 401: Bad credentials', id)!, /gh auth login/);
  assert.match(friendlyGhError('error connecting to api.github.com', id)!, /Cannot reach GitHub/);
  assert.equal(friendlyGhError('some other failure', id), undefined);
});

test('GitHubForge surfaces the friendly message when gh cannot see the PR (stand-in gh on PATH)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'octet-fakegh-'));
  writeFileSync(join(dir, 'gh'), '#!/bin/sh\nif [ "$1" = auth ]; then echo tok; exit 0; fi\necho "GraphQL: Could not resolve to a PullRequest with the number of 99." >&2\nexit 1\n');
  chmodSync(join(dir, 'gh'), 0o755);
  const id = parseIdentities(IDS)[0]!;
  const was = process.env.PATH;
  process.env.PATH = `${dir}:${was}`;
  try {
    assert.throws(() => new GitHubForge().prDiff('https://github.com/o/r/pull/99', id), (e: Error) => /Cannot reach that pull request/.test(e.message) && !/GraphQL/.test(e.message));
    assert.throws(() => new GitHubForge().prStatus('https://github.com/o/r/pull/99', id), /Cannot reach that pull request/);
  } finally {
    process.env.PATH = was;
  }
});
