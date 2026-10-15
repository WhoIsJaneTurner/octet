import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  addBead, ClaudeCodeRunner, ClaudeStream, createGoal, decideApproval, loadUsage, parseUsage, planRequest, reviewBead, runBead, Store,
  tick, usageHold, type RunUsage, type SchedHooks,
} from '../src/index.ts';
import { bead, planJson, routed, setup } from './helpers.ts';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'claude-stream-ok.jsonl');
const real = readFileSync(FIXTURE, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
const realResult = real.find((m) => m.type === 'result')!;

test('parseUsage reads the closing result message of real Claude Code output', () => {
  assert.deepEqual(parseUsage(realResult), {
    inputTokens: 2, outputTokens: 4, cacheReadTokens: 22366, cacheCreationTokens: 9525,
    costUsd: 0.0403806, numTurns: 1, model: 'claude-sonnet-5-5',
  });
});

test('parseUsage tolerates missing and malformed fields', () => {
  assert.equal(parseUsage(undefined), undefined);
  assert.equal(parseUsage({}), undefined);
  assert.equal(parseUsage({ usage: 'lots', total_cost_usd: 'free' }), undefined);
  assert.deepEqual(parseUsage({ total_cost_usd: 0.5 }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.5 });
  assert.deepEqual(parseUsage({ usage: { input_tokens: 7, output_tokens: -3, cache_read_input_tokens: NaN } }),
    { inputTokens: 7, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
});

test('ClaudeStream turns stream-json into text, survives chunk boundaries and keeps unknown lines', () => {
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', name: 'Edit', input: { file_path: 'src/a.ts' } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'HUGE' }] } }),
    'warning: something plain',
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', result: 'Done.', total_cost_usd: 0.1, usage: { input_tokens: 1, output_tokens: 2 } }),
  ].join('\n');
  const got: string[] = [];
  const s = new ClaudeStream((t) => got.push(t));
  for (let i = 0; i < lines.length; i += 7) s.feed(lines.slice(i, i + 7)); // 7-byte chunks cut every JSON line apart
  s.end(); // the last line has no newline
  assert.equal(got.join(''), 'Looking.\n> Edit src/a.ts\nwarning: something plain\nDone.\n');
  assert.equal(s.answer, 'Done.');
  assert.equal(s.usage?.costUsd, 0.1);
  assert.equal(s.failed, false);
});

test('ClaudeCodeRunner against a stand-in `claude`: prompt on stdin, stream-json flags, live text, usage and the final answer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'octet-fakeclaude-'));
  copyFileSync(FIXTURE, join(dir, 'out.jsonl'));
  writeFileSync(join(dir, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args.txt"\ncat > "${dir}/stdin.txt"\ncat "${dir}/out.jsonl"\n`);
  chmodSync(join(dir, 'claude'), 0o755);
  const chunks: string[] = [];
  const res = await new ClaudeCodeRunner().run(
    { seat: 'engineer', cwd: dir, prompt: 'do the thing', systemPrompt: 'be good', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } },
    (t) => chunks.push(t),
  );
  assert.equal(res.exitCode, 0);
  assert.equal(res.output, 'ok');
  assert.equal(chunks.join(''), 'ok\n');
  assert.equal(res.usage?.costUsd, 0.0403806);
  assert.equal(res.usage?.cacheReadTokens, 22366);
  assert.equal(readFileSync(join(dir, 'stdin.txt'), 'utf8'), 'do the thing');
  const args = readFileSync(join(dir, 'args.txt'), 'utf8').split('\n');
  assert.deepEqual(args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 3), ['--output-format', 'stream-json', '--verbose']);
});

test('an error result makes a zero exit code a failure, and stderr is kept after the answer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'octet-fakeclaude-'));
  const err = JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'Ran out of turns', usage: { input_tokens: 5 } });
  writeFileSync(join(dir, 'claude'), `#!/bin/sh\ncat > /dev/null\necho 'trouble' >&2\nprintf '%s\\n' '${err}'\n`);
  chmodSync(join(dir, 'claude'), 0o755);
  const res = await new ClaudeCodeRunner().run({ seat: 'engineer', cwd: dir, prompt: 'x', systemPrompt: 's', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
  assert.equal(res.exitCode, 1);
  assert.match(res.output, /^Ran out of turns\ntrouble/);
  assert.equal(res.usage?.inputTokens, 5);
});

const U = (costUsd: number, extra: Partial<RunUsage> = {}): RunUsage => ({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheCreationTokens: 50, costUsd, ...extra });

function twoBeads() {
  const s = setup();
  const goal = createGoal(s.ctx, { project: 'demo', title: 'costs' });
  const a = addBead(s.ctx, { goalId: goal.id, title: 'A', brief: 'a' });
  const b = addBead(s.ctx, { goalId: goal.id, title: 'B', brief: 'b' });
  return { ...s, goal, a, b };
}

test('usage is stored per run and totalled per bead, goal and day, engineer and reviewer runs alike', async () => {
  const { ctx, runner, goal, a, b } = twoBeads();
  runner.usage.set('engineer', U(0.25, { numTurns: 3, model: 'claude-sonnet-5-5' }));
  runner.usage.set('reviewer', U(0.05));
  await runBead(ctx, a.id);
  await reviewBead(ctx, a.id);
  await runBead(ctx, b.id);
  const run = ctx.store.lastRun(a.id)!;
  assert.deepEqual(run.usage, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheCreationTokens: 50, costUsd: 0.25, numTurns: 3, model: 'claude-sonnet-5-5' });
  assert.equal(run.kind, 'engineer'); // the review run does not displace the engineer run (its number names the log file)

  const u = ctx.store.usageSummary();
  assert.equal(u.byBead[a.id]!.runs, 2);
  assert.ok(Math.abs(u.byBead[a.id]!.costUsd - 0.3) < 1e-9);
  assert.ok(Math.abs(u.byGoal[goal.id]!.costUsd - 0.55) < 1e-9);
  assert.equal(u.byGoal[goal.id]!.cacheReadTokens, 300);
  assert.equal(u.byDay.length, 1);
  assert.equal(u.byDay[0]!.runs, 3);
  assert.equal(u.today.runs, 3);
  assert.equal(u.total.runs, 3);
  assert.ok(/^\d{4}-\d\d-\d\d$/.test(u.byDay[0]!.day));
});

test('runs without usage still count as runs, and a run with partial usage is fine', async () => {
  const { ctx, runner, a, b } = twoBeads();
  await runBead(ctx, a.id); // no usage reported
  runner.usage.set('engineer', { inputTokens: 3, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
  await runBead(ctx, b.id);
  assert.equal(ctx.store.lastRun(a.id)!.usage, undefined);
  assert.equal(ctx.store.lastRun(b.id)!.usage!.costUsd, undefined);
  const u = ctx.store.usageSummary();
  assert.equal(u.today.runs, 2);
  assert.equal(u.today.costUsd, 0);
  assert.equal(u.today.inputTokens, 3);
});

test('migration 4 upgrades a database from before usage existed and keeps a backup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'octet-mig-'));
  const file = join(dir, 'o.db');
  const first = new Store(file);
  first.startRun('bead-x', 1, 'h');
  first.close();
  // Rebuild bead_runs the way it was at version 3: no kind, no usage columns.
  const raw = new DatabaseSync(file);
  raw.exec(`CREATE TABLE old AS SELECT id, bead_id, n, pid, host, started_at, heartbeat_at, ended_at, end_reason, cancel_requested FROM bead_runs;
    DROP TABLE bead_runs; ALTER TABLE old RENAME TO bead_runs; UPDATE schema_version SET version = 3;`);
  raw.close();
  const store = new Store(file);
  assert.ok(existsSync(`${file}.bak-v3`));
  const run = store.lastRun('bead-x')!;
  assert.equal(run.kind, 'engineer');
  assert.equal(run.usage, undefined);
  store.setRunUsage(run.id, U(1));
  assert.equal(store.lastRun('bead-x')!.usage!.costUsd, 1);
});

test('[usage] config: ceilings are optional and positive', () => {
  const dir = mkdtempSync(join(tmpdir(), 'octet-cfg-'));
  const f = join(dir, 'config.toml');
  assert.deepEqual(loadUsage(f), {});
  writeFileSync(f, '[usage]\ndaily_cost_usd = 12.5\ndaily_runs = 40\n');
  assert.deepEqual(loadUsage(f), { dailyCostUsd: 12.5, dailyRuns: 40 });
  writeFileSync(f, '[usage]\ndaily_cost_usd = -1\ndaily_runs = "many"\n');
  assert.deepEqual(loadUsage(f), {});
});

test('usageHold: no ceiling means never held; cost and run ceilings hold, and the first hit each day is logged once', async () => {
  const { ctx, runner, a } = twoBeads();
  assert.equal(usageHold(ctx), undefined);
  runner.usage.set('engineer', U(0.4));
  await runBead(ctx, a.id);
  assert.equal(usageHold({ store: ctx.store, usage: { dailyCostUsd: 1 } }), undefined);
  assert.equal(usageHold({ store: ctx.store, usage: { dailyRuns: 1 } }) !== undefined, true);
  const held = usageHold({ store: ctx.store, usage: { dailyCostUsd: 0.4 } });
  assert.match(held!, /cost \$0\.40 has reached the daily ceiling of \$0\.40/);
  usageHold({ store: ctx.store, usage: { dailyCostUsd: 0.4 } });
  assert.equal(ctx.store.eventsOfKind('usage.ceiling_reached').length, 1);
  assert.equal(ctx.store.verifyChain().ok, true);
});

test('the scheduler starts no new runs or reviews while the daily ceiling holds, and resumes when it is lifted', async () => {
  const s = setup({ autonomy: 'plan-gated' }, { usage: { dailyRuns: 1 } });
  const { ctx, runner } = s;
  runner.replies.reviewer = 'Fine.\nVERDICT: APPROVE';
  runner.script('architect', [planJson([bead('b1'), bead('b2')])]);
  const rec = await planRequest(ctx, routed(ctx).id);
  decideApproval(ctx, ctx.store.listApprovals().find((a) => a.kind === 'plan')!.id, 'approve');
  const beads = ctx.store.listBeads(rec.goalId);

  const started: string[] = [];
  const hooks: SchedHooks = { isRunning: () => false, isReviewing: () => false };
  const exec = { run: (id: string) => { started.push(`run:${id}`); }, review: (id: string) => { started.push(`review:${id}`); } };

  // One run already happened today, which is the whole allowance.
  await runBead(ctx, beads[0]!.id);
  started.length = 0;
  const acts = tick(ctx, hooks, exec);
  assert.deepEqual(acts.filter((a) => a.type === 'run' || a.type === 'review'), []);
  assert.deepEqual(started, []);
  assert.equal(ctx.store.eventsOfKind('usage.ceiling_reached').length, 1);

  delete ctx.usage; // lift the ceiling
  const after = tick(ctx, hooks, exec);
  assert.ok(after.some((a) => a.type === 'run' || a.type === 'review'));
  assert.ok(started.length > 0);
});
