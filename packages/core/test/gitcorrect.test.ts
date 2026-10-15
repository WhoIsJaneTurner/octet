import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  addBead, approveBead, createGoal, decideApproval, decide, defaultBranch, FakeForge, getGithubHosts, planRequest, remoteHost,
  remoteOwner, remoteSlug, requestDelivery, reviewBead, reviewGoal, runBead, setGithubHosts, tick, type Ctx,
} from '../src/index.ts';
import { bead, planJson, routed, setup } from './helpers.ts';

const status = (wt: string) => execFileSync('git', ['status', '--porcelain'], { cwd: wt, encoding: 'utf8' }).trim();
const merging = (wt: string) => { try { execFileSync('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: wt, stdio: 'ignore' }); return true; } catch { return false; } };

function two(over: Partial<Ctx> = {}) {
  const s = setup({}, over);
  const goal = createGoal(s.ctx, { project: 'demo', title: 'conflicts' });
  const a = addBead(s.ctx, { goalId: goal.id, title: 'A', brief: 'a' });
  const b = addBead(s.ctx, { goalId: goal.id, title: 'B', brief: 'b' });
  return { ...s, goal, a, b };
}

test('merging a bead that conflicts aborts cleanly, leaves the goal worktree clean, and marks the bead conflict', async () => {
  const { ctx, goal, a, b } = two();
  await runBead(ctx, a.id);
  await runBead(ctx, b.id); // both write engineer-output.txt with different content
  assert.equal(approveBead(ctx, a.id).status, 'merged');
  const out = approveBead(ctx, b.id);
  assert.equal(out.status, 'conflict');
  assert.equal(merging(goal.worktree), false);
  assert.equal(status(goal.worktree), '');
  const ev = ctx.store.lastEvent('bead.conflict', b.id)!;
  assert.deepEqual((ev.data as { files: string[]; stage: string }), { files: ['engineer-output.txt'], stage: 'merge' });
  assert.ok(existsSync(b.worktree)); // the bead's work is kept
  assert.equal(ctx.store.verifyChain().ok, true);
});

test('a conflicted bead is re-run: the goal branch is merged into it, the engineer resolves, and it goes back to review', async () => {
  const { ctx, runner, a, b } = two();
  await runBead(ctx, a.id);
  await runBead(ctx, b.id);
  approveBead(ctx, a.id);
  approveBead(ctx, b.id);
  assert.equal(ctx.store.getBead(b.id)!.status, 'conflict');
  const out = await runBead(ctx, b.id); // the fake engineer overwrites the file, which resolves the conflict
  assert.equal(out.status, 'in_review');
  const prompt = runner.calls.at(-1)!.prompt;
  assert.match(prompt, /A merge conflict to resolve[\s\S]*engineer-output\.txt/);
  assert.equal(merging(b.worktree), false);
  assert.equal(approveBead(ctx, b.id).status, 'merged'); // now it merges
});

test('conflict markers left behind are not committed: the bead stays conflicted and the run is recorded as unresolved', async () => {
  const { ctx, runner, a, b } = two();
  await runBead(ctx, a.id);
  await runBead(ctx, b.id);
  approveBead(ctx, a.id);
  approveBead(ctx, b.id);
  runner.afterEngineer = (req) => writeFileSync(join(req.cwd, 'engineer-output.txt'), '<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> goal\n');
  const out = await runBead(ctx, b.id);
  assert.equal(out.status, 'conflict');
  const ev = ctx.store.lastEvent('bead.failed', b.id)!;
  assert.equal((ev.data as { reason: string }).reason, 'unresolved_conflict');
});

test('stale base: a bead finished after others merged gets the goal branch merged in; a conflict there goes to conflict, not review', async () => {
  const s = two();
  s.runner.uniqueFiles = true;
  await runBead(s.ctx, s.a.id);
  approveBead(s.ctx, s.a.id);
  const clean = await runBead(s.ctx, s.b.id); // started after A merged: already current
  assert.equal(clean.status, 'in_review');

  const t = two();
  t.runner.uniqueFiles = true;
  await runBead(t.ctx, t.a.id);
  // B builds while A merges meanwhile: simulate by merging A into the goal during B's run.
  t.runner.afterEngineer = () => { t.runner.afterEngineer = undefined; approveBead(t.ctx, t.a.id); };
  const out = await runBead(t.ctx, t.b.id);
  assert.equal(out.status, 'in_review'); // different files: the sync merge was clean
  const log = execFileSync('git', ['log', '--format=%s'], { cwd: t.b.worktree, encoding: 'utf8' });
  assert.match(log, /Merge feat\/.* into octet\//);

  const u = two(); // same file name in both: the sync conflicts
  await runBead(u.ctx, u.a.id);
  u.runner.afterEngineer = () => { u.runner.afterEngineer = undefined; approveBead(u.ctx, u.a.id); };
  const c = await runBead(u.ctx, u.b.id);
  assert.equal(c.status, 'conflict');
  assert.equal((u.ctx.store.lastEvent('bead.conflict', u.b.id)!.data as { stage: string }).stage, 'sync');
  assert.equal(merging(u.b.worktree), false);
});

async function managedGoal(autonomy: 'plan-gated' | 'auto-to-pr' = 'auto-to-pr') {
  const s = setup({ autonomy });
  s.runner.uniqueFiles = true;
  s.runner.replies.reviewer = 'Fine.\nVERDICT: APPROVE';
  s.runner.script('architect', [planJson([bead('b1')])]);
  const rec = await planRequest(s.ctx, routed(s.ctx).id);
  decideApproval(s.ctx, s.ctx.store.listApprovals().find((a) => a.kind === 'plan')!.id, 'approve');
  const running = new Set<string>();
  const pending: Promise<unknown>[] = [];
  const hooks = { isRunning: (i: string) => running.has(i), isReviewing: (i: string) => running.has(`r${i}`) };
  const exec = {
    run: (i: string) => { running.add(i); pending.push(runBead(s.ctx, i).catch(() => {}).finally(() => running.delete(i))); },
    review: (i: string) => { running.add(`r${i}`); pending.push(reviewBead(s.ctx, i).catch(() => {}).finally(() => running.delete(`r${i}`))); },
    goalReview: (i: string) => { running.add(`r${i}`); pending.push(reviewGoal(s.ctx, i).catch(() => {}).finally(() => running.delete(`r${i}`))); },
  };
  const settle = async () => {
    for (let i = 0; i < 40; i++) {
      const acts = tick(s.ctx, hooks, exec);
      const w = pending.splice(0);
      await Promise.all(w);
      if (!w.length && !acts.some((x) => x.type === 'merge' || x.type === 'deliver')) return;
    }
    throw new Error('did not settle');
  };
  return { ...s, rec, settle, hooks };
}

test('delivery waits for the goal-level review; an approving review releases it to the delivery approval', async () => {
  const { ctx, settle, rec } = await managedGoal();
  await settle();
  assert.equal(ctx.store.countGoalEvents('goal.review.verdict', rec.goalId), 1);
  assert.equal(ctx.store.listApprovals().filter((a) => a.kind === 'deliver').length, 1);
});

test('a goal review that asks for changes creates a fix bead, which runs and merges, then the goal is reviewed again; rounds are capped', async () => {
  const { ctx, runner, settle, rec } = await managedGoal();
  ctx.review = { auto: false, autoMerge: false, maxRounds: 1 };
  runner.replies.reviewer = 'Parts do not fit.\nVERDICT: CHANGES_REQUESTED';
  // bead reviews also see CHANGES_REQUESTED, so let the first bead review pass explicitly
  const beadReply = 'ok\nVERDICT: APPROVE';
  const orig = runner.run.bind(runner);
  runner.run = async (req, on) => {
    if (req.seat === 'reviewer' && !/Final review of the whole goal/.test(req.prompt)) runner.replies.reviewer = beadReply;
    else runner.replies.reviewer = 'Parts do not fit.\nVERDICT: CHANGES_REQUESTED';
    return orig(req, on);
  };
  await settle();
  const fix = ctx.store.listBeads(rec.goalId).filter((b) => b.title.startsWith('Address final review'));
  assert.equal(fix.length, 1); // round 1 only: maxRounds is 1
  assert.equal(fix[0]!.status, 'merged');
  assert.match(fix[0]!.brief, /Parts do not fit/);
  assert.deepEqual(ctx.store.listEscalations(true).map((e) => e.reason), ['goal_review_rounds']);
  assert.equal(ctx.store.listApprovals().filter((a) => a.kind === 'deliver').length, 0); // never delivered while unsatisfied
});

test('a truncated bead review never auto-merges; the human is asked', async () => {
  const { ctx, runner, settle } = await managedGoal();
  runner.afterEngineer = (req) => writeFileSync(join(req.cwd, 'big.txt'), 'x'.repeat(200_000));
  await settle();
  const beads = ctx.store.listBeads();
  assert.equal(beads[0]!.status, 'in_review');
  assert.ok(ctx.store.listEscalations(true).some((e) => e.reason === 'review_truncated'));
  assert.equal((ctx.store.lastEvent('review.verdict', beads[0]!.id)!.data as { truncated: boolean }).truncated, true);
});

async function conflictingPair() {
  const s = setup({ autonomy: 'auto-to-pr' });
  s.runner.replies.reviewer = 'Fine.\nVERDICT: APPROVE';
  // Two independent beads; the fake engineer writes the same file in both, so the second merge conflicts.
  s.runner.script('architect', [planJson([bead('b1', { files: ['src/one.ts'] }), bead('b2', { files: ['src/two.ts'] })])]);
  const rec = await planRequest(s.ctx, routed(s.ctx).id);
  decideApproval(s.ctx, s.ctx.store.listApprovals().find((a) => a.kind === 'plan')!.id, 'approve');
  const running = new Set<string>();
  const pending: Promise<unknown>[] = [];
  const hooks = { isRunning: (i: string) => running.has(i), isReviewing: (i: string) => running.has(`r${i}`) };
  const exec = {
    run: (i: string) => { running.add(i); pending.push(runBead(s.ctx, i).catch(() => {}).finally(() => running.delete(i))); },
    review: (i: string) => { running.add(`r${i}`); pending.push(reviewBead(s.ctx, i).catch(() => {}).finally(() => running.delete(`r${i}`))); },
    goalReview: (i: string) => { running.add(`r${i}`); pending.push(reviewGoal(s.ctx, i).catch(() => {}).finally(() => running.delete(`r${i}`))); },
  };
  const settle = async () => {
    for (let i = 0; i < 60; i++) {
      const acts = tick(s.ctx, hooks, exec);
      const w = pending.splice(0);
      await Promise.all(w);
      if (!w.length && !acts.some((x) => x.type === 'merge' || x.type === 'deliver')) return;
    }
    throw new Error('did not settle');
  };
  return { ...s, rec, settle };
}

test('a bead conflict is handed to the engineer once automatically; resolved, the goal carries on to delivery', async () => {
  const { ctx, rec, settle } = await conflictingPair();
  await settle();
  const beads = ctx.store.listBeads(rec.goalId);
  assert.deepEqual(beads.map((b) => b.status), ['merged', 'merged']);
  const conflicted = beads.find((b) => ctx.store.countEvents('bead.conflict', b.id) > 0)!;
  assert.equal(ctx.store.countEvents('bead.conflict_resolve_started', conflicted.id), 1);
  assert.equal(ctx.store.listApprovals().filter((a) => a.kind === 'deliver').length, 1);
  assert.equal(ctx.store.listEscalations(true).length, 0);
});

test('if the engineer cannot resolve the conflict in that one attempt, it escalates to you and stops', async () => {
  const { ctx, runner, rec, settle } = await conflictingPair();
  runner.afterEngineer = (req) => { if (/merge conflict to resolve/.test(req.prompt)) writeFileSync(join(req.cwd, 'engineer-output.txt'), '<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n'); };
  await settle();
  const stuck = ctx.store.listBeads(rec.goalId).find((b) => b.status === 'conflict')!;
  assert.ok(stuck);
  assert.equal(ctx.store.countEvents('bead.conflict_resolve_started', stuck.id), 1); // exactly one attempt
  assert.deepEqual(ctx.store.listEscalations(true).map((e) => e.reason), ['merge_conflict']);
  assert.equal(ctx.store.listApprovals().filter((a) => a.kind === 'deliver').length, 0);
});

test('delivery adopts an existing open PR for the branch instead of opening a second one', async () => {
  const forge = new FakeForge();
  const s = setup({}, { forge });
  const goal = createGoal(s.ctx, { project: 'demo', title: 'Adopt' });
  const bd = addBead(s.ctx, { goalId: goal.id, title: 'w', brief: 'w' });
  await runBead(s.ctx, bd.id);
  approveBead(s.ctx, bd.id);
  const appr = requestDelivery(s.ctx, goal.id);
  forge.openPrs.set(goal.branch, 'https://github.com/WhoIsJaneTurner/demo/pull/77');
  decideApproval(s.ctx, appr.id, 'approve');
  assert.equal(forge.prs.length, 0);
  assert.equal(s.ctx.store.getPr(goal.id)!.number, 77);
  assert.ok(s.ctx.store.eventsOfKind('delivery.pr.adopted').length === 1);
  assert.equal(s.ctx.store.getGoal(goal.id)!.status, 'delivered');
});

test('default branch: origin/HEAD, then a lone main/master, then a single branch; ambiguity is an error; config wins', () => {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' };
  const repo = (branches: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'octet-db-'));
    const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, env, stdio: 'ignore' });
    g('init', '-q', '-b', branches[0]!);
    g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'i');
    for (const b of branches.slice(1)) g('branch', b);
    return dir;
  };
  assert.equal(defaultBranch(repo(['main']), env), 'main');
  assert.equal(defaultBranch(repo(['trunk']), env), 'trunk'); // the only branch
  assert.equal(defaultBranch(repo(['master', 'feature']), env), 'master');
  assert.throws(() => defaultBranch(repo(['dev', 'staging']), env), /Cannot tell which branch is the default/);
  assert.throws(() => defaultBranch(repo(['main', 'master']), env), /Cannot tell/);
  assert.equal(defaultBranch(repo(['dev', 'staging']), env, 'staging'), 'staging');
});

test('GitHub Enterprise hosts are recognized only when configured', () => {
  const ghe = 'git@ghe.corp.example:platform/api.git';
  assert.equal(remoteOwner(ghe), null);
  try {
    setGithubHosts(['ghe.corp.example']);
    assert.deepEqual([remoteOwner(ghe), remoteSlug(ghe), remoteHost(ghe)], ['platform', 'platform/api', 'ghe.corp.example']);
    assert.equal(remoteOwner('https://ghe.corp.example/platform/api'), 'platform');
    assert.equal(remoteOwner('git@github.com:me/x.git'), 'me');
    assert.equal(remoteOwner('git@evil.example:platform/api.git'), null);
    assert.ok(getGithubHosts().includes('github.com'));
  } finally {
    setGithubHosts([]);
  }
  assert.equal(remoteOwner(ghe), null);
  assert.equal(readFileSync(new URL('../src/identity.ts', import.meta.url), 'utf8').includes('github\\.com'), false); // no hard-coded host regex left
});
