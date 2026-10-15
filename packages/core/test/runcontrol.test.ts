import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  addBead, cancelBead, ClaudeCodeRunner, createGoal, DEFAULT_LIMITS, DEFAULT_SANDBOX, FakeRunner, parseIdentities, readRunOutput, reconcileRunning,
  runBead, Store, type AgentRunner, type Ctx,
} from '../src/index.ts';

const IDS = `
[identities.wijt]
name = "Bot"
email = "wijt@example.com"
ssh_key = "/nonexistent"
gh_user = "WhoIsJaneTurner"
`;

function setup(over: Partial<Ctx> = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'octet-rc-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  g('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  g('add', '.');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  const runner = new FakeRunner();
  const ctx: Ctx = {
    store: new Store(':memory:'), identities: parseIdentities(IDS), runner,
    projects: [{ name: 'demo', path: repo, identity: 'wijt' }],
    runsDir: mkdtempSync(join(tmpdir(), 'octet-runs-')), heartbeatMs: 20, ...over,
  };
  const goal = createGoal(ctx, { project: 'demo', title: 'rc' });
  const bead = addBead(ctx, { goalId: goal.id, title: 'A', brief: 'a' });
  return { ctx, runner, goal, bead };
}

const until = async (fn: () => boolean) => {
  for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(fn(), 'condition not met in time');
};

test('cancelling a running bead stops the agent, fails the bead with reason "cancelled" and keeps the worktree', async () => {
  const { ctx, runner, bead } = setup();
  runner.hang.add('engineer');
  const done = runBead(ctx, bead.id);
  await until(() => ctx.store.getBead(bead.id)!.status === 'running');
  assert.equal(cancelBead(ctx, bead.id), true);
  const out = await done;
  assert.equal(out.status, 'failed');
  assert.ok(existsSync(bead.worktree));
  const ev = ctx.store.lastEvent('bead.cancelled', bead.id);
  assert.equal((ev?.data as { reason: string }).reason, 'cancelled');
  assert.ok(ctx.store.lastEvent('bead.cancel_requested', bead.id));
  assert.equal(ctx.store.openRuns().length, 0);
  assert.equal(ctx.store.verifyChain().ok, true);
});

test('a cancel requested through the database (another process) is honoured at the next heartbeat', async () => {
  const { ctx, runner, bead } = setup();
  runner.hang.add('engineer');
  const done = runBead(ctx, bead.id);
  await until(() => ctx.store.getBead(bead.id)!.status === 'running');
  ctx.store.requestCancel(bead.id); // what a CLI in another process does
  assert.equal((await done).status, 'failed');
  assert.equal(ctx.store.lastRun(bead.id)!.endReason, 'cancelled');
});

test('an external AbortSignal cancels too (Ctrl-C in the CLI)', async () => {
  const { ctx, runner, bead } = setup();
  runner.hang.add('engineer');
  const ac = new AbortController();
  const done = runBead(ctx, bead.id, undefined, { signal: ac.signal });
  await until(() => ctx.store.getBead(bead.id)!.status === 'running');
  ac.abort();
  assert.equal((await done).status, 'failed');
});

test('a run that exceeds the timeout is killed and reported as a timeout', async () => {
  const { ctx, runner, bead } = setup({ limits: { ...DEFAULT_LIMITS, runTimeoutMs: 50 } });
  runner.hang.add('engineer');
  const out = await runBead(ctx, bead.id);
  assert.equal(out.status, 'failed');
  const ev = ctx.store.lastEvent('bead.failed', bead.id);
  assert.equal((ev?.data as { reason: string }).reason, 'timeout');
});

test('a bead can be re-run after a cancel', async () => {
  const { ctx, runner, bead } = setup();
  runner.hang.add('engineer');
  const first = runBead(ctx, bead.id);
  await until(() => ctx.store.getBead(bead.id)!.status === 'running');
  cancelBead(ctx, bead.id);
  await first;
  runner.hang.clear();
  assert.equal((await runBead(ctx, bead.id)).status, 'in_review');
  assert.equal(ctx.store.lastRun(bead.id)!.n, 2);
});

test('cancel on a bead that is not running is a clear error', () => {
  const { ctx, bead } = setup();
  assert.throws(() => cancelBead(ctx, bead.id), /not running/);
  assert.throws(() => cancelBead(ctx, 'nope'), /Unknown bead/);
});

test('engineer output is written to a per-run log and can be read back after a "restart"', async () => {
  const { ctx, runner, bead } = setup();
  runner.replies.engineer = 'did the thing\n';
  await runBead(ctx, bead.id);
  const file = join(ctx.runsDir!, bead.id, '1.log');
  assert.equal(readFileSync(file, 'utf8'), 'did the thing\n');
  assert.equal(readRunOutput({ store: ctx.store, runsDir: ctx.runsDir }, bead.id), 'did the thing\n');
});

test('if the runner throws, the bead is failed and the run is closed rather than left running', async () => {
  const { ctx, bead } = setup();
  const boom: AgentRunner = { run: () => Promise.reject(new Error('spawn claude ENOENT')) };
  ctx.runner = boom;
  await assert.rejects(runBead(ctx, bead.id), /ENOENT/);
  assert.equal(ctx.store.getBead(bead.id)!.status, 'failed');
  assert.equal(ctx.store.openRuns().length, 0);
});

test('reconcile leaves a live run alone, and recovers a dead pid, a stale heartbeat and a run-less bead', () => {
  const { ctx, goal } = setup();
  const mk = (t: string) => addBead(ctx, { goalId: goal.id, title: t, brief: t });
  const live = mk('live'), deadPid = mk('deadpid'), stale = mk('stale'), none = mk('none'), remote = mk('remote');
  for (const b of [live, deadPid, stale, none, remote]) ctx.store.setBeadStatus(b.id, 'running');
  ctx.store.startRun(live.id, process.pid, hostname());
  ctx.store.startRun(deadPid.id, 2_147_483_000, hostname());
  const s = ctx.store.startRun(stale.id, process.pid, hostname());
  ctx.store.db.prepare('UPDATE bead_runs SET heartbeat_at = ? WHERE id = ?').run(new Date(Date.now() - 120_000).toISOString(), s.id);
  ctx.store.startRun(remote.id, 1, 'some-other-machine'); // pid cannot be checked; a fresh heartbeat is trusted
  const recovered = reconcileRunning(ctx.store).sort();
  assert.deepEqual(recovered, [deadPid.id, none.id, stale.id].sort());
  assert.equal(ctx.store.getBead(live.id)!.status, 'running');
  assert.equal(ctx.store.getBead(remote.id)!.status, 'running');
  assert.equal(ctx.store.openRuns().length, 2);
});

test('ClaudeCodeRunner kills the whole process group, grandchildren included, on abort', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'octet-bin-'));
  const pidFile = join(bin, 'child.pid');
  // A stand-in `claude` that starts a long-lived grandchild and records its pid.
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\nsleep 300 &\necho $! > "${pidFile}"\nwait\n`, { mode: 0o755 });
  const ac = new AbortController();
  const runner = new ClaudeCodeRunner({ sandbox: { ...DEFAULT_SANDBOX, mode: 'off' } });
  const p = runner.run({
    seat: 'engineer', cwd: bin, prompt: 'x', systemPrompt: 'x', signal: ac.signal,
    env: { PATH: `${bin}:${process.env.PATH}` } as never,
  });
  await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '');
  const grandchild = Number(readFileSync(pidFile, 'utf8').trim());
  assert.doesNotThrow(() => process.kill(grandchild, 0)); // alive
  ac.abort();
  const res = await p;
  assert.equal(res.cancelled, true);
  await until(() => { try { process.kill(grandchild, 0); return false; } catch { return true; } });
});
