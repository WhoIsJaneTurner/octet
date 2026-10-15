import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  addBead, createGoal, MAX_LOG_BYTES, readRunOutput, RunLogWriter, runBead, Store, type AgentRunner, type Ctx, type RunResult,
} from '../src/index.ts';
import { setup } from './helpers.ts';

const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(3)}`;
const KEY = ['-----BEGIN OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmU', 'QyNTUxOQAAACDsecretsecretsecret', '-----END OPENSSH PRIVATE KEY-----'].join('\n');

const tmpLog = () => join(mkdtempSync(join(tmpdir(), 'octet-log-')), 'x', '1.log');

test('a token split across two chunks is still redacted in the log', () => {
  const file = tmpLog();
  const w = new RunLogWriter(file);
  w.write(`using token ${TOKEN.slice(0, 17)}`);
  w.write(`${TOKEN.slice(17)} for the push\nnext line\n`);
  w.close();
  const text = readFileSync(file, 'utf8');
  assert.equal(text, 'using token [REDACTED github token] for the push\nnext line\n');
  assert.equal(w.redacted, 1);
});

test('one-character chunks cannot smuggle a token past the writer', () => {
  const file = tmpLog();
  const w = new RunLogWriter(file);
  for (const ch of `export GH=${TOKEN}\npassword = hunter2hunter2\nok\n`) w.write(ch);
  w.close();
  const text = readFileSync(file, 'utf8');
  assert.ok(!text.includes(TOKEN.slice(0, 20)));
  assert.ok(!text.includes('hunter2hunter2'));
  assert.match(text, /export GH=\[REDACTED github token\]\npassword = \[REDACTED\]\nok\n/);
});

test('a private key block that arrives in pieces is redacted whole', () => {
  const file = tmpLog();
  const w = new RunLogWriter(file);
  const text = `before\n${KEY}\nafter\n`;
  for (let i = 0; i < text.length; i += 13) w.write(text.slice(i, i + 13));
  w.close();
  const out = readFileSync(file, 'utf8');
  assert.ok(!out.includes('secretsecret'));
  assert.ok(!out.includes('b3BlbnNzaC1r'));
  assert.equal(out, 'before\n[REDACTED private key]\nafter\n');
});

test('an unfinished last line is redacted when the log closes, and the size cap still holds', () => {
  const file = tmpLog();
  const w = new RunLogWriter(file);
  w.write(`no newline ${TOKEN}`);
  w.close();
  assert.equal(readFileSync(file, 'utf8'), 'no newline [REDACTED github token]');

  const big = tmpLog();
  const b = new RunLogWriter(big);
  for (let i = 0; i < 30; i++) b.write(`${'x'.repeat(99_999)}\n`);
  const exact = readFileSync(big, 'utf8').length;
  assert.ok(exact > MAX_LOG_BYTES - 1, 'the log fills up to the cap');
  b.close();
  const size = readFileSync(big, 'utf8').length;
  assert.ok(size <= MAX_LOG_BYTES + 100, `log grew to ${size}`);
  assert.match(readFileSync(big, 'utf8'), /\[log truncated\]/);
});

test('a very long line without a newline is flushed in pieces without losing a token at the seam', () => {
  const file = tmpLog();
  const w = new RunLogWriter(file);
  const a = 'y'.repeat(70_000 - 11);
  w.write(`${a} ${TOKEN.slice(0, 10)}`); // crosses the flush threshold in the middle of the token
  w.write(TOKEN.slice(10) + ' tail\n');
  w.close();
  const out = readFileSync(file, 'utf8');
  assert.ok(!out.includes('ghp_'));
  assert.ok(out.endsWith('[REDACTED github token] tail\n'));
});

class Leaky implements AgentRunner {
  async run(_req: unknown, onChunk?: (t: string) => void): Promise<RunResult> {
    onChunk?.(`found ${TOKEN.slice(0, 12)}`);
    onChunk?.(`${TOKEN.slice(12)}\n`);
    return { exitCode: 1, output: `failed with ${TOKEN}`, durationMs: 1 };
  }
}

test('runBead persists a redacted log and redacted event data, logs the count, and the audit chain stays valid', async () => {
  const { ctx } = setup();
  const leaky: Ctx = { ...ctx, runner: new Leaky() };
  const goal = createGoal(leaky, { project: 'demo', title: 'leaks' });
  const bead = addBead(leaky, { goalId: goal.id, title: 'A', brief: 'a' });
  const live: string[] = [];
  await runBead(leaky, bead.id, (t) => live.push(t));

  const log = readRunOutput(leaky, bead.id);
  assert.equal(log, 'found [REDACTED github token]\n');
  assert.equal(live.join(''), `found ${TOKEN}\n`); // the live stream is not persisted, so it is passed on as is

  const failed = leaky.store.lastEvent('bead.failed', bead.id)!;
  const data = failed.data as { tail: string; redacted: number };
  assert.equal(data.tail, 'failed with [REDACTED github token]');
  assert.equal(data.redacted, 1);
  const rec = leaky.store.lastEvent('run.redacted', bead.id)!;
  assert.deepEqual(rec.data, { run: 1, redacted: 1 });

  const raw = JSON.stringify(leaky.store.events(100));
  assert.ok(!raw.includes('A1b2C3d4E5'));
  assert.equal(leaky.store.verifyChain().ok, true);
});

test('Store.log redacts nested event data before hashing; verifyChain agrees with what is stored', () => {
  const store = new Store(':memory:');
  store.log({ kind: 'a', data: { message: 'plain' } });
  store.log({ kind: 'b', data: { nested: { list: [`Bearer ${'z'.repeat(30)}`, 'fine'] }, redacted: 2 } });
  store.log({ kind: 'c', data: 'a bare string' });
  const [c, b, a] = store.events(3);
  assert.deepEqual(a!.data, { message: 'plain' }); // nothing hit: no count added
  assert.deepEqual(b!.data, { nested: { list: ['Bearer [REDACTED]', 'fine'] }, redacted: 3 });
  assert.equal(c!.data, 'a bare string');
  assert.equal(store.verifyChain().ok, true);
  // Tampering with a stored event is still caught.
  store.db.prepare("UPDATE events SET data = '{\"message\":\"edited\"}' WHERE kind = 'a'").run();
  assert.equal(store.verifyChain().ok, false);
});
