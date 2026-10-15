// A scripted ACP agent for tests: JSON-RPC 2.0 over stdio, one message per line.
// Usage: node fake-acp-agent.mjs <mode>   modes: ok | hostile | hang | mismatch | silent
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import readline from 'node:readline';

const mode = process.argv[2] ?? 'ok';
if (mode === 'hang') process.on('SIGTERM', () => {}); // only SIGKILL stops this agent

const out = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
let nextId = 1000;
const waiting = new Map();
const call = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  waiting.set(id, resolve);
  out({ id, method, params });
});
const say = (sessionId, text) =>
  out({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
const verdict = (r) => (r.error ? `error ${r.error.code}` : 'ok');

let cwd = process.cwd();

async function prompt(id, sessionId) {
  if (mode === 'hang') {
    // A grandchild in the same process group that would outlive a polite shutdown.
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: 'ignore' });
    writeFileSync(join(cwd, 'child.pid'), String(child.pid));
    writeFileSync(join(cwd, 'agent.pid'), String(process.pid));
    say(sessionId, 'working...\n');
    return; // never answers
  }
  if (mode === 'ok') {
    say(sessionId, 'hello ');
    out({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read a.txt', kind: 'read', status: 'pending', rawInput: { path: join(cwd, 'a.txt') } } } });
    const read = await call('fs/read_text_file', { sessionId, path: join(cwd, 'a.txt') });
    out({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'read it' } }] } } });
    const wrote = await call('fs/write_text_file', { sessionId, path: join(cwd, 'sub', 'out.txt'), content: 'written by agent\n' });
    const perm = await call('session/request_permission', {
      sessionId, toolCall: { toolCallId: 't2', title: 'Edit out.txt', kind: 'edit', locations: [{ path: join(cwd, 'sub', 'out.txt') }] },
      options: [{ optionId: 'ao', name: 'Allow once', kind: 'allow_once' }, { optionId: 'aa', name: 'Always', kind: 'allow_always' }, { optionId: 'ro', name: 'Reject', kind: 'reject_once' }],
    });
    const term = await call('terminal/create', { sessionId, command: process.execPath, args: ['-e', 'console.log("from terminal")'] });
    const tid = term.result?.terminalId;
    const exit = tid ? await call('terminal/wait_for_exit', { sessionId, terminalId: tid }) : term;
    const tout = tid ? await call('terminal/output', { sessionId, terminalId: tid }) : term;
    if (tid) await call('terminal/release', { sessionId, terminalId: tid });
    say(sessionId, `world; read=${JSON.stringify(read.result?.content)} write=${verdict(wrote)} perm=${perm.result?.outcome?.optionId} term=${tid ? JSON.stringify(tout.result?.output) : verdict(term)} exit=${exit.result?.exitCode}`);
    out({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'usage_update', used: 10, size: 100, cost: { amount: 0.01, currency: 'USD' } } } });
    out({ id, result: { stopReason: 'end_turn' } });
    return;
  }
  if (mode === 'hostile') {
    const opts = [{ optionId: 'ao', name: 'Allow once', kind: 'allow_once' }, { optionId: 'ro', name: 'Reject', kind: 'reject_once' }];
    const results = [];
    const outside = join(cwd, '..', 'escaped.txt');
    results.push(['write-outside', verdict(await call('fs/write_text_file', { sessionId, path: outside, content: 'pwned' }))]);
    results.push(['write-relative', verdict(await call('fs/write_text_file', { sessionId, path: 'rel.txt', content: 'x' }))]);
    results.push(['write-dotdot', verdict(await call('fs/write_text_file', { sessionId, path: join(cwd, 'sub', '..', '..', 'escaped2.txt'), content: 'x' }))]);
    results.push(['write-dotgit', verdict(await call('fs/write_text_file', { sessionId, path: join(cwd, '.git', 'hooks', 'pre-commit'), content: 'x' }))]);
    results.push(['write-via-symlink', verdict(await call('fs/write_text_file', { sessionId, path: join(cwd, 'link', 'escaped3.txt'), content: 'x' }))]);
    results.push(['read-outside', verdict(await call('fs/read_text_file', { sessionId, path: '/etc/passwd' }))]);
    results.push(['term-push', verdict(await call('terminal/create', { sessionId, command: 'git', args: ['push', 'origin', 'main'] }))]);
    results.push(['term-sh-push', verdict(await call('terminal/create', { sessionId, command: 'sh', args: ['-c', 'echo hi && git -C . push --force'] }))]);
    results.push(['term-gh-pr', verdict(await call('terminal/create', { sessionId, command: '/usr/bin/gh', args: ['pr', 'create'] }))]);
    results.push(['term-gh-auth', verdict(await call('terminal/create', { sessionId, command: 'gh', args: ['auth', 'token'] }))]);
    const perm = await call('session/request_permission', { sessionId, toolCall: { toolCallId: 'p1', title: 'Run git push origin main', kind: 'execute', rawInput: { command: 'git push origin main' } }, options: opts });
    results.push(['perm-push', perm.result?.outcome?.optionId]);
    const perm2 = await call('session/request_permission', { sessionId, toolCall: { toolCallId: 'p2', title: 'Fetch', kind: 'fetch' }, options: opts });
    results.push(['perm-fetch', perm2.result?.outcome?.optionId]);
    const perm3 = await call('session/request_permission', { sessionId, toolCall: { toolCallId: 'p3', title: 'Edit', kind: 'edit', locations: [{ path: outside }] }, options: opts });
    results.push(['perm-edit-outside', perm3.result?.outcome?.optionId]);
    results.push(['unknown-method', verdict(await call('fs/delete_everything', { sessionId }))]);
    say(sessionId, JSON.stringify(results));
    out({ id, result: { stopReason: 'end_turn' } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === undefined) { waiting.get(m.id)?.(m); waiting.delete(m.id); return; }
  if (m.method === 'initialize') {
    if (mode === 'silent') return;
    out({ id: m.id, result: { protocolVersion: mode === 'mismatch' ? 2 : 1, agentCapabilities: { loadSession: false, promptCapabilities: { image: false } }, agentInfo: { name: 'fake-acp', title: 'Fake ACP Agent', version: '9.9.9' }, authMethods: [] } });
  } else if (m.method === 'session/new') {
    cwd = m.params.cwd;
    out({ id: m.id, result: { sessionId: 'sess_1' } });
  } else if (m.method === 'session/prompt') {
    void prompt(m.id, m.params.sessionId);
  }
});
rl.on('close', () => { if (mode !== 'hang') process.exit(0); });
