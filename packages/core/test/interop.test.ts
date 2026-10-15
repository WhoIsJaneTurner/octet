import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  acpServersFor, buildRunner, ClaudeCodeRunner, mcpFor, mcpName, NO_MCP, ObservedRunner, OctetError, OtlpHttpExporter, parseInterop,
  RoutingRunner, selectRunner, splitCommand, Store, Tracer, tracesUrl, untrusted, ATTR, AcpRunner, FakeRunner,
  type AgentHandshake, type DecisionEvent, type RunObserver, type RunRequest, type ToolCallEvent, type ToolResultEvent, type UsageEvent,
} from '../src/index.ts';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FAKE_CLAUDE = join(FIX, 'fake-claude.mjs');
const AGENT = join(FIX, 'fake-acp-agent.mjs');

const CONFIG = `
[agents]
reviewer = "node ${AGENT} ok"
scout = ["claude"]

[mcp.servers.echo]
command = "node"
args = ["echo.mjs", "--stdio"]
env = { ROOT = "/srv" }
tools = ["echo"]

[mcp.servers.docs]
type = "http"
url = "https://docs.example.com/mcp"
headers = { Authorization = "Bearer x" }
read_only = true

[mcp.allow]
engineer = ["echo", "docs"]
reviewer = ["echo", "docs"]

[telemetry]
otlp_endpoint = "http://127.0.0.1:4318"
`;

function work() {
  const dir = mkdtempSync(join(tmpdir(), 'octet-interop-'));
  const cwd = join(dir, 'wt');
  mkdirSync(cwd);
  writeFileSync(join(cwd, 'a.txt'), 'a content');
  return { dir, cwd, argsFile: join(dir, 'args.json') };
}
const req = (cwd: string, over: Partial<RunRequest> = {}): RunRequest =>
  ({ seat: 'engineer', cwd, prompt: 'SECRET-PROMPT please build', systemPrompt: 'SECRET-SYSTEM persona', env: { PATH: process.env.PATH!, ...over.env }, ...over });
/** Claude launch that allows only the `echo` server, as the captured transcript used. */
const echoOnly = (r: RunRequest) => mcpFor({ ...parseInterop(CONFIG).mcp, allow: { engineer: ['echo'] } }, r.seat, r.readOnly === true);
const argsOf = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as string[];
const flag = (a: string[], name: string) => a[a.indexOf(name) + 1];

// ---- configuration --------------------------------------------------------------------------------------------

test('config: no tables means Claude Code, no MCP, no telemetry', () => {
  const c = parseInterop('');
  assert.deepEqual(c.agents, {});
  assert.deepEqual(c.mcp, NO_MCP);
  assert.deepEqual(c.telemetry, { captureContent: false, headers: {} });
});

test('config: agents, MCP allow-lists and telemetry parse; "claude" means the default', () => {
  const c = parseInterop(CONFIG);
  assert.deepEqual(c.agents, { reviewer: ['node', AGENT, 'ok'] });
  assert.deepEqual(Object.keys(c.mcp.servers), ['echo', 'docs']);
  assert.deepEqual(c.mcp.allow, { engineer: ['echo', 'docs'], reviewer: ['echo', 'docs'] });
  assert.equal(c.telemetry.otlpEndpoint, 'http://127.0.0.1:4318');
  assert.equal(c.telemetry.captureContent, false);
});

test('config: mistakes are reported with the table and key', () => {
  assert.throws(() => parseInterop('[agents]\nengeneer = "x"'), /not a seat/);
  assert.throws(() => parseInterop('[agents]\nengineer = ""'), /empty/);
  assert.throws(() => parseInterop('[mcp.allow]\nengineer = ["nope"]'), /not defined under \[mcp.servers\]/);
  assert.throws(() => parseInterop('[mcp.servers.a]\nargs = []'), /needs "command"/);
  assert.throws(() => parseInterop('[mcp.servers.a__b]\ncommand = "x"'), /name may use/);
  assert.throws(() => parseInterop('[telemetry]\notlp_endpoint = "localhost:4318"'), OctetError);
});

test('splitCommand honours quotes and escapes without a shell', () => {
  assert.deepEqual(splitCommand(`agent --flag "two words" 'it''s' a\\ b`), ['agent', '--flag', 'two words', 'its', 'a b']);
  assert.throws(() => splitCommand('agent "oops'), /unterminated/);
});

// ---- MCP policy -----------------------------------------------------------------------------------------------

test('MCP: default is the empty config; allow-lists build the launch; read-only seats get read-only servers only', () => {
  const none = mcpFor(NO_MCP, 'engineer', false);
  assert.equal(none.json, '{"mcpServers":{}}');
  assert.deepEqual([none.allowedTools, none.servers], [[], []]);

  const { mcp } = parseInterop(CONFIG);
  const eng = mcpFor(mcp, 'engineer', false);
  assert.deepEqual(JSON.parse(eng.json), {
    mcpServers: {
      echo: { command: 'node', args: ['echo.mjs', '--stdio'], env: { ROOT: '/srv' } },
      docs: { type: 'http', url: 'https://docs.example.com/mcp', headers: { Authorization: 'Bearer x' } },
    },
  });
  assert.deepEqual(eng.allowedTools, ['mcp__echo__echo', 'mcp__docs'], 'pinned tool names, or the whole server');
  assert.deepEqual(mcpFor(mcp, 'reviewer', true).servers, ['docs']);
  assert.deepEqual(mcpFor(mcp, 'architect', false).servers, [], 'a seat not in [mcp.allow] gets nothing');
  assert.deepEqual(acpServersFor(mcp, 'engineer', false), [{ name: 'echo', command: 'node', args: ['echo.mjs', '--stdio'], env: [{ name: 'ROOT', value: '/srv' }] }]);
});

test('MCP: server-supplied text is stripped and capped before it is stored', () => {
  assert.equal(untrusted('ok\u0007\u001b[31m name'), 'ok[31m name');
  assert.match(untrusted('x'.repeat(600)), /\[truncated 100\]$/);
  assert.deepEqual(mcpName('mcp__my_server__do__thing'), { server: 'my_server', tool: 'do__thing' });
  assert.equal(mcpName('Bash'), undefined);
});

// ---- Claude Code runner ---------------------------------------------------------------------------------------

test('Claude runner: without options the command line is exactly the old one (MCP off, plain output)', async () => {
  const { cwd, argsFile } = work();
  const r = await new ClaudeCodeRunner({ command: FAKE_CLAUDE }).run(req(cwd, { env: { PATH: process.env.PATH!, FAKE_CLAUDE_ARGS: argsFile } }));
  assert.equal(r.output.trim(), 'plain output');
  const a = argsOf(argsFile);
  assert.deepEqual(a.slice(0, 5), ['-p', '--append-system-prompt', 'SECRET-SYSTEM persona', '--strict-mcp-config', '--mcp-config']);
  assert.equal(flag(a, '--mcp-config'), '{"mcpServers":{}}');
  assert.ok(!a.includes('--output-format') && !a.includes('--allowedTools'));
});

function recorder() {
  const seen = { handshakes: [] as AgentHandshake[], calls: [] as ToolCallEvent[], results: [] as ToolResultEvent[], decisions: [] as DecisionEvent[], usage: [] as UsageEvent[] };
  const o: RunObserver = {
    handshake: (h) => seen.handshakes.push(h), toolCall: (e) => seen.calls.push(e), toolResult: (e) => seen.results.push(e),
    decision: (e) => seen.decisions.push(e), usage: (e) => seen.usage.push(e),
  };
  return { seen, o };
}

test('Claude runner: stream-json exposes the handshake, MCP tool calls with arguments, results and usage', async () => {
  const { cwd, argsFile } = work();
  const { seen, o } = recorder();
  const runner = new ClaudeCodeRunner({ command: FAKE_CLAUDE, mcp: echoOnly, observe: () => true, captureResults: true });
  const chunks: string[] = [];
  const r = await runner.run(req(cwd, { env: { PATH: process.env.PATH!, FAKE_CLAUDE_ARGS: argsFile }, observer: o }), (c) => chunks.push(c));
  assert.equal(r.exitCode, 0);
  assert.equal(r.output, 'done', 'the final result text, as the plain mode gave');
  assert.equal(chunks.join(''), 'done\n');
  const a = argsOf(argsFile);
  assert.deepEqual([flag(a, '--output-format'), a.includes('--verbose'), flag(a, '--allowedTools')], ['stream-json', true, 'mcp__echo__echo']);
  assert.deepEqual(JSON.parse(flag(a, '--mcp-config')!).mcpServers.echo.command, 'node');

  assert.deepEqual(seen.handshakes.map((h) => [h.protocol, h.agentName, h.agentVersion, h.model, h.sessionId, h.mcpServers]),
    [['claude-stream-json', 'claude-code', '2.1.296', 'claude-haiku-5-5', '1035e2a6-ce59-4f97-abef-832438e81b31', [{ name: 'echo', status: 'connected' }]]]);
  assert.deepEqual(seen.calls, [{ id: 'toolu_01DJc1ZFawh2eyWH4S7MsFuS', name: 'mcp__echo__echo', input: { text: 'ping' }, mcp: { server: 'echo', tool: 'echo' } }]);
  assert.deepEqual(seen.results, [{ id: 'toolu_01DJc1ZFawh2eyWH4S7MsFuS', isError: false, output: 'echo: ping' }]);
  assert.deepEqual(seen.usage, [{ inputTokens: 6 + 10618 + 87953, outputTokens: 140, costUsd: 0.0032009300000000007 }]);
  assert.deepEqual(seen.decisions, []);
});

test('Claude runner: a server that connects without being on the allow-list ends the run', async () => {
  const { cwd } = work();
  const { seen, o } = recorder();
  const runner = new ClaudeCodeRunner({ command: FAKE_CLAUDE, mcp: echoOnly, observe: () => true });
  const t0 = Date.now();
  const r = await runner.run(req(cwd, { env: { PATH: process.env.PATH!, FAKE_CLAUDE_ROGUE: '1' }, observer: o }));
  assert.ok(Date.now() - t0 < 4000);
  assert.equal(r.exitCode, 1);
  assert.match(r.output, /MCP server "rogue" connected but is not on this seat's allow-list/);
  assert.ok(seen.decisions.some((d) => d.request === 'mcp/connect' && !d.allowed));
});

// ---- audit ----------------------------------------------------------------------------------------------------

function storeWithBead(cwd: string) {
  const store = new Store(':memory:');
  store.insertGoal({ id: 'g-1', project: 'demo', title: 'goal', branch: 'goal/x', worktree: join(cwd, '..', 'goal-wt') });
  store.insertBead({ id: 'b-1', goalId: 'g-1', title: 'bead', brief: 'b', dependsOn: [], branch: 'bead/x', worktree: cwd });
  return store;
}

test('audit: handshakes and MCP tool calls land in the hash chain, attributed to the bead', async () => {
  const { cwd } = work();
  const store = storeWithBead(cwd);
  const claude = new ClaudeCodeRunner({ command: FAKE_CLAUDE, mcp: echoOnly, observe: () => true });
  const r = await new ObservedRunner(claude, { store }).run(req(cwd));
  assert.equal(r.exitCode, 0);
  const kinds = store.events(50).map((e) => e.kind).sort();
  assert.deepEqual(kinds, ['agent.handshake', 'mcp.tool_call', 'mcp.tool_result']);
  const call = store.lastEvent('mcp.tool_call', 'b-1')!;
  assert.deepEqual(call.data, { id: 'toolu_01DJc1ZFawh2eyWH4S7MsFuS', server: 'echo', tool: 'echo', arguments: { text: 'ping' } });
  assert.equal(call.goalId, 'g-1');
  assert.equal(call.seat, 'engineer');
  const hs = store.lastEvent('agent.handshake', 'b-1')!.data as { agent: { name: string; version: string } };
  assert.deepEqual([hs.agent.name, hs.agent.version], ['claude-code', '2.1.296']);
  assert.equal(store.verifyChain().ok, true);
});

test('audit: a broken store never breaks a run', async () => {
  const { cwd } = work();
  const store = storeWithBead(cwd);
  store.log = () => { throw new Error('disk full'); };
  const r = await new ObservedRunner(new ClaudeCodeRunner({ command: FAKE_CLAUDE, mcp: echoOnly, observe: () => true }), { store }).run(req(cwd));
  assert.equal(r.exitCode, 0);
});

// ---- OpenTelemetry --------------------------------------------------------------------------------------------

interface Collector { url: string; bodies: unknown[]; paths: string[]; raw: string[]; close(): Promise<void> }
async function collector(behaviour: 'ok' | 'error' | 'hang' = 'ok'): Promise<Collector> {
  const c: Collector = { url: '', bodies: [], paths: [], raw: [], close: async () => {} };
  const sockets = new Set<import('node:net').Socket>();
  const server: Server = createServer((rq: IncomingMessage, res) => {
    let body = '';
    rq.on('data', (d) => { body += d; });
    rq.on('end', () => {
      c.paths.push(rq.url ?? '');
      c.raw.push(body);
      try { c.bodies.push(JSON.parse(body)); } catch { /* recorded raw */ }
      if (behaviour === 'hang') return;
      res.statusCode = behaviour === 'error' ? 500 : 200;
      res.end('{}');
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  c.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  c.close = () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); });
  return c;
}

type OtlpSpan = { traceId: string; spanId: string; parentSpanId?: string; name: string; kind: number; startTimeUnixNano: string; endTimeUnixNano: string; attributes: { key: string; value: Record<string, string> }[]; status: { code: number } };
const spansOf = (c: Collector): OtlpSpan[] =>
  (c.bodies as { resourceSpans: { scopeSpans: { spans: OtlpSpan[] }[] }[] }[]).flatMap((b) => b.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)));
const attr = (s: OtlpSpan, key: string) => { const v = s.attributes.find((a) => a.key === key)?.value; return v && Object.values(v)[0]; };

test('OTel: one invoke_agent span with execute_tool children, GenAI attribute names, no content by default', async () => {
  const col = await collector();
  const { cwd } = work();
  const store = storeWithBead(cwd);
  const exporter = new OtlpHttpExporter({ endpoint: col.url, flushIntervalMs: 60_000 });
  const claude = new ClaudeCodeRunner({ command: FAKE_CLAUDE, mcp: echoOnly, observe: () => true });
  const runner = new ObservedRunner(claude, { store, tracer: new Tracer(exporter) });
  await runner.run(req(cwd, { model: 'haiku' }));
  assert.equal(col.bodies.length, 0, 'nothing is sent until the batch is flushed');
  await exporter.shutdown();
  await col.close();

  assert.deepEqual(col.paths, ['/v1/traces']);
  const body = col.bodies[0] as { resourceSpans: { resource: { attributes: { key: string; value: unknown }[] } }[] };
  assert.deepEqual(body.resourceSpans[0]!.resource.attributes, [{ key: 'service.name', value: { stringValue: 'octet' } }]);
  const spans = spansOf(col);
  assert.equal(spans.length, 2);
  const root = spans.find((s) => s.name === 'invoke_agent engineer')!;
  const tool = spans.find((s) => s.name === 'execute_tool mcp__echo__echo')!;
  assert.ok(root && tool);
  assert.equal(tool.parentSpanId, root.spanId);
  assert.equal(tool.traceId, root.traceId);
  assert.match(root.traceId, /^[0-9a-f]{32}$/);
  assert.match(root.spanId, /^[0-9a-f]{16}$/);
  assert.equal(root.parentSpanId, undefined);
  assert.equal(root.kind, 3);
  assert.equal(tool.kind, 1);
  assert.ok(BigInt(root.endTimeUnixNano) >= BigInt(root.startTimeUnixNano));
  assert.deepEqual(root.status, { code: 1 });

  assert.equal(attr(root, ATTR.operationName), 'invoke_agent');
  assert.equal(attr(root, 'gen_ai.operation.name'), 'invoke_agent');
  assert.equal(attr(root, 'gen_ai.agent.name'), 'engineer');
  assert.equal(attr(root, 'gen_ai.provider.name'), 'anthropic');
  assert.equal(attr(root, 'gen_ai.request.model'), 'haiku');
  assert.equal(attr(root, 'gen_ai.agent.version'), '2.1.296');
  assert.equal(attr(root, 'gen_ai.conversation.id'), '1035e2a6-ce59-4f97-abef-832438e81b31');
  assert.equal(attr(root, 'gen_ai.usage.output_tokens'), '140');
  assert.equal(attr(root, 'octet.bead.id'), 'b-1');
  assert.equal(attr(tool, 'gen_ai.operation.name'), 'execute_tool');
  assert.equal(attr(tool, 'gen_ai.tool.name'), 'mcp__echo__echo');
  assert.equal(attr(tool, 'gen_ai.tool.call.id'), 'toolu_01DJc1ZFawh2eyWH4S7MsFuS');
  assert.equal(attr(tool, 'gen_ai.tool.type'), 'extension');

  const wire = col.raw.join('');
  for (const secret of ['SECRET-PROMPT', 'SECRET-SYSTEM', 'ping', 'echo: ping', 'gen_ai.input.messages', 'gen_ai.tool.call.arguments']) {
    assert.ok(!wire.includes(secret), `content "${secret}" must not be exported by default`);
  }
});

test('OTel: content capture, when switched on, adds the opt-in attributes', async () => {
  const col = await collector();
  const { cwd } = work();
  const exporter = new OtlpHttpExporter({ endpoint: `${col.url}/v1/traces` });
  const claude = new ClaudeCodeRunner({ command: FAKE_CLAUDE, mcp: echoOnly, observe: () => true, captureResults: true });
  await new ObservedRunner(claude, { tracer: new Tracer(exporter), captureContent: true }).run(req(cwd));
  await exporter.shutdown();
  await col.close();
  assert.deepEqual(col.paths, ['/v1/traces'], 'a full traces URL is used as given');
  const [root, tool] = [spansOf(col).find((s) => s.name.startsWith('invoke_agent'))!, spansOf(col).find((s) => s.name.startsWith('execute_tool'))!];
  assert.match(String(attr(root, 'gen_ai.input.messages')), /SECRET-PROMPT/);
  assert.match(String(attr(root, 'gen_ai.system_instructions')), /SECRET-SYSTEM/);
  assert.match(String(attr(root, 'gen_ai.output.messages')), /done/);
  assert.equal(attr(tool, 'gen_ai.tool.call.arguments'), '{"text":"ping"}');
  assert.equal(attr(tool, 'gen_ai.tool.call.result'), 'echo: ping');
});

test('OTel: failures are marked on the span with error.type', async () => {
  const col = await collector();
  const { cwd } = work();
  const exporter = new OtlpHttpExporter({ endpoint: col.url });
  const fake = new FakeRunner();
  fake.hang.add('engineer');
  const runner = new ObservedRunner(fake, { tracer: new Tracer(exporter) });
  const r = await runner.run(req(cwd, { timeoutMs: 20 }));
  assert.equal(r.timedOut, true);
  await exporter.shutdown();
  await col.close();
  const root = spansOf(col)[0]!;
  assert.deepEqual(root.status.code, 2);
  assert.equal(attr(root, 'error.type'), 'timeout');
});

test('OTel: an unreachable, failing or hanging collector never affects a run and shutdown stays bounded', async () => {
  const { cwd } = work();
  const hang = await collector('hang');
  const err = await collector('error');
  const dead = await collector();
  const deadUrl = dead.url;
  await dead.close();
  for (const [endpoint, label] of [[deadUrl, 'unreachable'], [err.url, 'http 500'], [hang.url, 'hanging']] as const) {
    const exporter = new OtlpHttpExporter({ endpoint, timeoutMs: 300, maxBatch: 1 });
    const runner = new ObservedRunner(new FakeRunner(), { tracer: new Tracer(exporter) });
    const t0 = Date.now();
    const r = await runner.run(req(cwd));
    assert.equal(r.exitCode, 0, label);
    assert.ok(Date.now() - t0 < 200, `${label}: the run does not wait for the export`);
    await exporter.shutdown();
    assert.ok(Date.now() - t0 < 3000, `${label}: shutdown is bounded`);
    assert.equal(exporter.dropped, 1, label);
    assert.ok(exporter.lastError, label);
  }
  await err.close();
  await hang.close();
});

test('OTel: the exporter batches, drops oldest beyond its queue and tolerates later spans after shutdown', async () => {
  const col = await collector();
  const exporter = new OtlpHttpExporter({ endpoint: col.url, maxBatch: 100, maxQueue: 3, flushIntervalMs: 60_000 });
  const tracer = new Tracer(exporter);
  for (let i = 0; i < 5; i++) tracer.start(`s${i}`).end();
  await exporter.shutdown();
  tracer.start('late').end();
  await exporter.flush();
  await col.close();
  assert.equal(col.bodies.length, 1, 'one batch');
  assert.deepEqual(spansOf(col).map((s) => s.name), ['s2', 's3', 's4']);
  assert.equal(exporter.dropped, 2);
  assert.equal(tracesUrl('http://h:4318/'), 'http://h:4318/v1/traces');
});

// ---- wiring ---------------------------------------------------------------------------------------------------

test('wiring: seats route to their configured runner; unset seats use Claude Code', async () => {
  const claude = new FakeRunner();
  claude.replies.engineer = 'from claude';
  const config = parseInterop(CONFIG);
  const reviewer = selectRunner(config, 'reviewer', claude);
  assert.ok(reviewer instanceof AcpRunner);
  assert.equal(selectRunner(config, 'engineer', claude), claude);
  const routing = new RoutingRunner(claude, { reviewer });
  const { cwd } = work();
  assert.equal((await routing.run(req(cwd))).output, 'from claude');
  const acp = await routing.run(req(cwd, { seat: 'reviewer', readOnly: true }));
  assert.match(acp.output, /^hello world; /, 'the reviewer seat was answered by the ACP agent');
});

test('wiring: buildRunner routes, audits the ACP handshake and exports spans; fake mode is untouched', async () => {
  const col = await collector();
  const { cwd } = work();
  const store = storeWithBead(cwd);
  const config = parseInterop(`${CONFIG.replace('http://127.0.0.1:4318', col.url)}`);
  const bundle = buildRunner({ store, config, claudeCommand: FAKE_CLAUDE });
  const acp = await bundle.runner.run(req(cwd, { seat: 'reviewer', readOnly: true }));
  assert.equal(acp.exitCode, 0);
  const claude = await bundle.runner.run(req(cwd));
  assert.equal(claude.output, 'done', 'telemetry is on, so Claude is read as stream-json');
  await bundle.shutdown();
  await col.close();

  const hs = store.eventsOfKind('agent.handshake');
  assert.equal(hs.length, 2);
  assert.deepEqual(hs.map((e) => (e.data as { protocol: string }).protocol).sort(), ['acp', 'claude-stream-json']);
  const acpHs = hs.find((e) => (e.data as { protocol: string }).protocol === 'acp')!;
  assert.equal((acpHs.data as { agent: { name: string } }).agent.name, 'fake-acp');
  assert.equal(acpHs.seat, 'reviewer');
  // The reviewer is read-only: its file write, permission and terminal requests were refused and logged.
  const refused = store.eventsOfKind('agent.permission').filter((e) => (e.data as { allowed: boolean }).allowed === false);
  assert.equal(refused.length, 3);
  assert.equal(store.verifyChain().ok, true);
  const names = spansOf(col).map((s) => s.name).sort();
  assert.deepEqual(names, ['execute_tool mcp__echo__echo', 'execute_tool read', 'invoke_agent engineer', 'invoke_agent reviewer']);
  assert.equal(attr(spansOf(col).find((s) => s.name === 'invoke_agent reviewer')!, 'gen_ai.provider.name'), 'node');

  assert.ok(buildRunner({ store, fake: true }).runner instanceof FakeRunner);
});

test('wiring: with no telemetry and no MCP, Claude Code is not switched to stream-json', async () => {
  const { cwd, argsFile } = work();
  const bundle = buildRunner({ store: new Store(':memory:'), config: parseInterop(''), claudeCommand: FAKE_CLAUDE });
  const r = await bundle.runner.run(req(cwd, { env: { PATH: process.env.PATH!, FAKE_CLAUDE_ARGS: argsFile } }));
  assert.equal(r.output.trim(), 'plain output');
  assert.ok(!argsOf(argsFile).includes('--output-format'));
  await bundle.shutdown();
});
