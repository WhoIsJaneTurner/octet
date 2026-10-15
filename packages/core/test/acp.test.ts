import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AcpRunner, confinePath, decidePermission, deniedCommand, DENIED_TOOLS,
  type AgentHandshake, type DecisionEvent, type RunObserver, type RunRequest, type ToolCallEvent, type ToolResultEvent, type UsageEvent,
} from '../src/index.ts';

const AGENT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-acp-agent.mjs');

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'octet-acp-'));
  const wt = join(root, 'wt');
  const outside = join(root, 'outside');
  mkdirSync(join(wt, '.git', 'hooks'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(wt, 'a.txt'), 'a content');
  symlinkSync(outside, join(wt, 'link'));
  return { root, wt, outside };
}

function observer() {
  const seen = { handshakes: [] as AgentHandshake[], calls: [] as ToolCallEvent[], results: [] as ToolResultEvent[], decisions: [] as DecisionEvent[], usage: [] as UsageEvent[] };
  const o: RunObserver = {
    handshake: (h) => seen.handshakes.push(h), toolCall: (e) => seen.calls.push(e), toolResult: (e) => seen.results.push(e),
    decision: (e) => seen.decisions.push(e), usage: (e) => seen.usage.push(e),
  };
  return { seen, o };
}

const request = (cwd: string, over: Partial<RunRequest> = {}): RunRequest =>
  ({ seat: 'engineer', cwd, prompt: 'do the thing', systemPrompt: 'be careful', env: { PATH: process.env.PATH! }, ...over });
const runner = (mode: string, extra: Record<string, unknown> = {}) =>
  new AcpRunner({ command: [process.execPath, AGENT, mode], killGraceMs: 200, ...extra });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (fn: () => boolean, ms = 5000) => {
  for (let t = 0; t < ms && !fn(); t += 20) await new Promise((r) => setTimeout(r, 20));
  assert.ok(fn(), 'condition not met in time');
};

test('ACP: handshake, streamed output, file and terminal requests inside the worktree', async () => {
  const { wt } = sandbox();
  const { seen, o } = observer();
  const chunks: string[] = [];
  const r = await runner('ok').run(request(wt, { observer: o }), (c) => chunks.push(c));
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /^hello world; /);
  assert.match(r.output, /read="a content"/);
  assert.match(r.output, /write=ok/);
  assert.match(r.output, /perm=ao/, 'one-time allow, never allow_always');
  assert.match(r.output, /term="from terminal\\n"/);
  assert.equal(readFileSync(join(wt, 'sub', 'out.txt'), 'utf8'), 'written by agent\n');
  assert.equal(chunks.join(''), r.output, 'every chunk is streamed');

  assert.equal(seen.handshakes.length, 1);
  const h = seen.handshakes[0]!;
  assert.deepEqual([h.protocol, h.protocolVersion, h.agentName, h.agentVersion, h.sessionId], ['acp', 1, 'fake-acp', '9.9.9', 'sess_1']);
  assert.deepEqual((h.capabilities as { loadSession: boolean }).loadSession, false);
  assert.equal(h.error, undefined);
  assert.deepEqual(seen.calls.map((c) => [c.id, c.name]), [['t1', 'read']]);
  assert.deepEqual(seen.results.map((c) => [c.id, c.isError, c.output]), [['t1', false, 'read it']]);
  assert.deepEqual(seen.usage, [{ costUsd: 0.01 }]);
  assert.ok(seen.decisions.length >= 4 && seen.decisions.every((d) => d.allowed), 'every decision is reported, all allowed here');
});

test('ACP: a hostile agent is refused everywhere and every refusal is reported', async () => {
  const { wt, root, outside } = sandbox();
  const { seen, o } = observer();
  const r = await runner('hostile').run(request(wt, { observer: o }));
  assert.equal(r.exitCode, 0);
  const results = Object.fromEntries(JSON.parse(r.output) as [string, string][]);
  for (const k of ['write-outside', 'write-relative', 'write-dotdot', 'write-dotgit', 'write-via-symlink', 'read-outside', 'term-push', 'term-sh-push', 'term-gh-pr', 'term-gh-auth', 'unknown-method']) {
    assert.match(results[k]!, /^error /, `${k} must be refused`);
  }
  assert.deepEqual([results['perm-push'], results['perm-fetch'], results['perm-edit-outside']], ['ro', 'ro', 'ro']);
  assert.ok(!existsSync(join(root, 'escaped.txt')) && !existsSync(join(root, 'escaped2.txt')));
  assert.ok(!existsSync(join(wt, '.git', 'hooks', 'pre-commit')));
  assert.ok(!existsSync(join(outside, 'escaped3.txt')), 'a symlink inside the worktree cannot be used to leave it');
  const denied = seen.decisions.filter((d) => !d.allowed);
  assert.equal(denied.length, 14);
  assert.ok(denied.some((d) => d.request === 'terminal/create' && /git push/.test(d.reason)));
  assert.ok(denied.some((d) => d.request === 'terminal/create' && /gh pr/.test(d.reason)));
  assert.ok(denied.some((d) => d.request === 'fs/write_text_file' && /outside the worktree/.test(d.reason)));
  assert.ok(denied.some((d) => d.request === 'session/request_permission' && /git push/.test(d.reason)));
  assert.equal(seen.decisions.filter((d) => d.allowed).length, 0);
});

test('ACP: a read-only seat can read but not write or run anything', async () => {
  const { wt } = sandbox();
  const { seen, o } = observer();
  const r = await runner('ok').run(request(wt, { seat: 'reviewer', readOnly: true, observer: o }));
  assert.match(r.output, /read="a content"/);
  assert.match(r.output, /write=error/);
  assert.match(r.output, /perm=ro/, 'the permission request is rejected');
  assert.match(r.output, /term=error/);
  assert.ok(!existsSync(join(wt, 'sub', 'out.txt')));
  assert.equal(seen.decisions.filter((d) => !d.allowed && d.reason === 'read-only seat').length, 3);
});

test('ACP: aborting kills the agent and the process group it started', async () => {
  const { wt } = sandbox();
  const ac = new AbortController();
  const done = runner('hang').run(request(wt, { signal: ac.signal }));
  await until(() => existsSync(join(wt, 'child.pid')) && existsSync(join(wt, 'agent.pid')));
  const agent = Number(readFileSync(join(wt, 'agent.pid'), 'utf8'));
  const child = Number(readFileSync(join(wt, 'child.pid'), 'utf8'));
  assert.ok(alive(agent) && alive(child));
  ac.abort();
  const r = await done;
  assert.equal(r.cancelled, true);
  assert.equal(r.exitCode, 143);
  await until(() => !alive(agent) && !alive(child));
});

test('ACP: the run timeout kills a stuck agent and its children', async () => {
  const { wt } = sandbox();
  const t0 = Date.now();
  const r = await runner('hang').run(request(wt, { timeoutMs: 500 }));
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 4000);
  const child = Number(readFileSync(join(wt, 'child.pid'), 'utf8'));
  await until(() => !alive(child));
  assert.match(r.output, /working\.\.\./);
});

test('ACP: an agent on another protocol version is refused and the mismatch is recorded', async () => {
  const { wt } = sandbox();
  const { seen, o } = observer();
  const r = await runner('mismatch').run(request(wt, { observer: o }));
  assert.equal(r.exitCode, 1);
  assert.match(r.output, /agent speaks ACP version 2; Octet supports 1/);
  assert.equal(seen.handshakes.length, 1);
  assert.match(seen.handshakes[0]!.error!, /version 2/);
  assert.equal(seen.handshakes[0]!.agentName, 'fake-acp');
});

test('ACP: an agent that never answers initialize fails the handshake instead of hanging', async () => {
  const { wt } = sandbox();
  const { seen, o } = observer();
  const r = await runner('silent', { handshakeTimeoutMs: 200 }).run(request(wt, { observer: o }));
  assert.equal(r.exitCode, 1);
  assert.match(r.output, /no answer to initialize/);
  assert.match(seen.handshakes[0]!.error!, /no answer/);
});

test('ACP: a missing agent program rejects like a missing claude binary', async () => {
  const { wt } = sandbox();
  await assert.rejects(new AcpRunner({ command: ['/nonexistent/octet-agent'] }).run(request(wt)));
});

test('deny-list matches the Claude Code DENIED_TOOLS and common spellings', () => {
  assert.equal(DENIED_TOOLS.length, 4);
  for (const c of ['git push', 'git push origin main', 'git -C /x push --force', '/usr/bin/git push', 'cd x && git push', 'sh -c "gh pr create"', 'gh repo delete x', 'gh auth token', 'GH_TOKEN=x gh pr merge']) {
    assert.ok(deniedCommand(c), c);
  }
  for (const c of ['git status', 'git commit -m fix', 'git pull', 'gh issue list', 'echo pushing', 'npm test', 'git log; echo push', 'github pr']) {
    assert.equal(deniedCommand(c), undefined, c);
  }
});

test('confinePath: inside only, after symlinks and dot segments; .git is write-protected', () => {
  const { wt, outside } = sandbox();
  assert.equal(confinePath(wt, join(wt, 'a.txt'), false).ok, true);
  assert.equal(confinePath(wt, join(wt, 'new', 'deep', 'f.txt'), true).ok, true);
  assert.equal(confinePath(wt, join(wt, '..', 'x'), false).ok, false);
  assert.equal(confinePath(wt, 'a.txt', false).ok, false);
  assert.equal(confinePath(wt, join(wt, 'link', 'f'), false).ok, false);
  assert.equal(confinePath(wt, join(outside, 'f'), false).ok, false);
  assert.equal(confinePath(wt, join(wt, '.git', 'config'), false).ok, true, 'reading .git is fine');
  assert.equal(confinePath(wt, join(wt, '.git', 'config'), true).ok, false);
  assert.equal(confinePath(wt, wt, true).ok, false);
  assert.equal(confinePath(wt, `${wt}/a\0.txt`, false).ok, false);
  assert.equal(confinePath(wt, 42, false).ok, false);
});

test('decidePermission picks one-time options only and refuses unknown kinds', () => {
  const { wt } = sandbox();
  const options = [{ optionId: 'aa', kind: 'allow_always' }, { optionId: 'ao', kind: 'allow_once' }, { optionId: 'ra', kind: 'reject_always' }];
  const d = decidePermission(wt, false, { toolCall: { kind: 'read', title: 'Read' }, options });
  assert.deepEqual([d.allowed, d.optionId], [true, 'ao']);
  const onlyAlways = decidePermission(wt, false, { toolCall: { kind: 'read' }, options: [{ optionId: 'aa', kind: 'allow_always' }] });
  assert.equal(onlyAlways.allowed, false);
  assert.equal(decidePermission(wt, false, { toolCall: { kind: 'execute', title: 'x', rawInput: { command: ['gh', 'pr', 'merge'] } }, options }).optionId, 'ra');
  assert.equal(decidePermission(wt, false, { toolCall: { kind: 'mystery' }, options }).allowed, false);
  assert.equal(decidePermission(wt, false, { options }).allowed, false);
  assert.equal(decidePermission(wt, true, { toolCall: { kind: 'edit' }, options }).allowed, false);
  assert.equal(decidePermission(wt, true, { toolCall: { kind: 'search' }, options }).allowed, true);
});
