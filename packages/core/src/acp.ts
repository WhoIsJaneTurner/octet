import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { confinePath, decidePermission, deniedCommand } from './agent-policy.ts';
import { notify, untrusted, type AgentHandshake, type RunObserver } from './observe.ts';
import type { AgentRunner, RunRequest, RunResult } from './runner.ts';

/**
 * Agent Client Protocol client (JSON-RPC 2.0, one JSON message per line over the agent's stdio).
 * Pinned: protocolVersion 1, schema v1.25.0 (2026-10-09) from https://agentclientprotocol.com/protocol.
 * Octet is the client: it launches the agent, drives one prompt turn and answers the agent's requests
 * (files, terminals, permissions) under the same denials as the Claude Code runner.
 */
export const ACP_PROTOCOL_VERSION = 1;
export const ACP_SCHEMA_REVISION = 'agent-client-protocol schema v1.25.0 (2026-10-09), protocolVersion 1';

const KILL_GRACE_MS = 5000;
const MAX_LINE_BYTES = 8_000_000;
const MAX_OUTPUT_CHARS = 8_000_000;
const MAX_READ_CHARS = 1_000_000;
const TERMINAL_OUTPUT_LIMIT = 1_000_000;

/** Server entry for `session/new`; shapes per the ACP session-setup page. */
export type AcpMcpServer =
  | { name: string; command: string; args: string[]; env: { name: string; value: string }[] }
  | { type: 'http'; name: string; url: string; headers: { name: string; value: string }[] };

export interface AcpRunnerOptions {
  /** Program and arguments that start the agent speaking ACP on stdio. */
  command: string[];
  /** Servers to hand the agent in `session/new` (already filtered through the MCP policy). */
  mcpServers?: (req: RunRequest) => AcpMcpServer[];
  /** No answer to `initialize` within this long fails the run. */
  handshakeTimeoutMs?: number;
  /** SIGTERM to SIGKILL delay when stopping the agent's process group. */
  killGraceMs?: number;
}

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});

/** Newline-delimited JSON-RPC 2.0 over a pair of streams. */
class Peer {
  private buf = '';
  private nextId = 1;
  private readonly pending = new Map<unknown, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly write: (line: string) => void;
  private readonly onRequest: (method: string, params: Json) => Promise<unknown>;
  private readonly onNotification: (method: string, params: Json) => void;
  private readonly onOversize: () => void;
  constructor(
    write: (line: string) => void,
    onRequest: (method: string, params: Json) => Promise<unknown>,
    onNotification: (method: string, params: Json) => void,
    onOversize: () => void,
  ) {
    this.write = write;
    this.onRequest = onRequest;
    this.onNotification = onNotification;
    this.onOversize = onOversize;
  }

  feed(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.handle(line);
    }
    if (this.buf.length > MAX_LINE_BYTES) { this.buf = ''; this.onOversize(); }
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  closeAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private send(m: unknown): void {
    try { this.write(`${JSON.stringify(m)}\n`); } catch { /* the pipe is gone; close handling reports it */ }
  }

  private handle(line: string): void {
    let m: Json;
    try { m = obj(JSON.parse(line)); } catch { return; }
    if (typeof m.method === 'string') {
      const params = obj(m.params);
      if (m.id === undefined || m.id === null) { this.onNotification(m.method, params); return; }
      const id = m.id;
      this.onRequest(m.method, params).then(
        (result) => this.send({ jsonrpc: '2.0', id, result: result ?? {} }),
        (e: unknown) => this.send({
          jsonrpc: '2.0', id,
          error: e instanceof RpcError ? { code: e.code, message: e.message } : { code: -32603, message: 'internal error' },
        }),
      );
      return;
    }
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.error) p.reject(new RpcError(Number(obj(m.error).code ?? -32603), String(obj(m.error).message ?? 'error')));
    else p.resolve(m.result);
  }
}

interface Terminal {
  child: ChildProcess;
  output: string;
  truncated: boolean;
  exit?: { exitCode: number | null; signal: string | null };
  limit: number;
  waiters: (() => void)[];
}

const BLOCKED_ENV = /^(LD_|DYLD_|GIT_SSH|GIT_ASKPASS|SSH_)/;

export class AcpRunner implements AgentRunner {
  private readonly opts: AcpRunnerOptions;
  constructor(opts: AcpRunnerOptions) {
    this.opts = opts;
  }

  run(req: RunRequest, onChunk?: (text: string) => void): Promise<RunResult> {
    const { command, killGraceMs = KILL_GRACE_MS, handshakeTimeoutMs = 30_000 } = this.opts;
    const [program, ...args] = command;
    const started = Date.now();
    const root = resolve(req.cwd);
    const readOnly = req.readOnly === true;
    const obs: RunObserver | undefined = req.observer;
    const decide = (request: string, subject: string, allowed: boolean, reason: string) =>
      notify(obs, 'decision', { request, subject: untrusted(subject, 300), allowed, reason });

    return new Promise((resolveRun, rejectRun) => {
      if (!program) return rejectRun(new Error('ACP agent command is empty'));
      // Own process group, so a kill reaches everything the agent started.
      const child = spawn(program, args, { cwd: root, env: req.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      let output = '';
      let stderrTail = '';
      let cancelled = false;
      let timedOut = false;
      let killTimer: NodeJS.Timeout | undefined;
      let exitTimer: NodeJS.Timeout | undefined;
      let failure: string | undefined;
      let stopReason: string | undefined;
      let sessionId = '';
      const terminals = new Map<string, Terminal>();
      let termSeq = 0;

      const killGroup = (pid: number | undefined, sig: NodeJS.Signals) => {
        if (pid) try { process.kill(-pid, sig); } catch { /* already gone */ }
      };
      const stop = () => {
        killGroup(child.pid, 'SIGTERM');
        killTimer ??= setTimeout(() => killGroup(child.pid, 'SIGKILL'), killGraceMs).unref();
      };
      const onAbort = () => { cancelled = true; stop(); };
      if (req.signal?.aborted) onAbort();
      else req.signal?.addEventListener('abort', onAbort, { once: true });
      const timer = req.timeoutMs ? setTimeout(() => { timedOut = true; stop(); }, req.timeoutMs) : undefined;
      const cleanup = () => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        clearTimeout(exitTimer);
        req.signal?.removeEventListener('abort', onAbort);
      };

      // ---- requests from the agent ------------------------------------------------------------
      const fsRead = (p: Json): unknown => {
        const c = confinePath(root, p.path, false);
        if (!c.ok) { decide('fs/read_text_file', String(p.path), false, c.reason); throw new RpcError(-32602, c.reason); }
        decide('fs/read_text_file', c.path, true, 'inside worktree');
        let text = readFileSync(c.path, 'utf8');
        const line = typeof p.line === 'number' && p.line > 0 ? p.line : 1;
        const limit = typeof p.limit === 'number' && p.limit > 0 ? p.limit : Infinity;
        if (line > 1 || limit !== Infinity) text = text.split('\n').slice(line - 1, line - 1 + limit).join('\n');
        return { content: text.length > MAX_READ_CHARS ? text.slice(0, MAX_READ_CHARS) : text };
      };

      const fsWrite = (p: Json): unknown => {
        if (readOnly) { decide('fs/write_text_file', String(p.path), false, 'read-only seat'); throw new RpcError(-32000, 'read-only seat'); }
        const c = confinePath(root, p.path, true);
        if (!c.ok) { decide('fs/write_text_file', String(p.path), false, c.reason); throw new RpcError(-32602, c.reason); }
        if (typeof p.content !== 'string') throw new RpcError(-32602, 'content must be a string');
        decide('fs/write_text_file', c.path, true, 'inside worktree');
        mkdirSync(dirname(c.path), { recursive: true });
        writeFileSync(c.path, p.content);
        return {};
      };

      const termCreate = (p: Json): unknown => {
        const cmd = typeof p.command === 'string' ? p.command : '';
        const cargs = Array.isArray(p.args) ? p.args.filter((a): a is string => typeof a === 'string') : [];
        const line = [cmd, ...cargs].join(' ');
        if (readOnly) { decide('terminal/create', line, false, 'read-only seat'); throw new RpcError(-32000, 'read-only seat'); }
        const hit = deniedCommand(line);
        if (hit) { decide('terminal/create', line, false, `denied action: ${hit}`); throw new RpcError(-32000, `denied action: ${hit}`); }
        if (!cmd) throw new RpcError(-32602, 'command is required');
        const cwd = p.cwd === undefined ? { ok: true as const, path: root } : confinePath(root, p.cwd, false);
        if (!cwd.ok) { decide('terminal/create', line, false, `cwd: ${cwd.reason}`); throw new RpcError(-32602, `cwd: ${cwd.reason}`); }
        const env = { ...req.env };
        for (const e of Array.isArray(p.env) ? p.env : []) {
          const { name, value } = obj(e);
          if (typeof name === 'string' && typeof value === 'string' && !BLOCKED_ENV.test(name)) env[name] = value;
        }
        decide('terminal/create', line, true, 'not denied');
        const limit = typeof p.outputByteLimit === 'number' && p.outputByteLimit > 0 ? p.outputByteLimit : TERMINAL_OUTPUT_LIMIT;
        const t: Terminal = { child: spawn(cmd, cargs, { cwd: cwd.path, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true }), output: '', truncated: false, limit, waiters: [] };
        const take = (b: Buffer) => {
          t.output += b.toString();
          if (t.output.length > t.limit) { t.output = t.output.slice(t.output.length - t.limit); t.truncated = true; }
        };
        t.child.stdout?.on('data', take);
        t.child.stderr?.on('data', take);
        const done = (exitCode: number | null, signal: string | null) => {
          t.exit ??= { exitCode, signal };
          for (const w of t.waiters.splice(0)) w();
        };
        t.child.on('error', (e) => { take(Buffer.from(`${e.message}\n`)); done(1, null); });
        t.child.on('close', done);
        const id = `term_${++termSeq}`;
        terminals.set(id, t);
        return { terminalId: id };
      };

      const term = (p: Json): Terminal => {
        const t = terminals.get(String(p.terminalId));
        if (!t) throw new RpcError(-32602, 'unknown terminal');
        return t;
      };

      const onRequest = async (method: string, p: Json): Promise<unknown> => {
        switch (method) {
          case 'fs/read_text_file': return fsRead(p);
          case 'fs/write_text_file': return fsWrite(p);
          case 'terminal/create': return termCreate(p);
          case 'terminal/output': {
            const t = term(p);
            return { output: t.output, truncated: t.truncated, ...(t.exit ? { exitStatus: t.exit } : {}) };
          }
          case 'terminal/wait_for_exit': {
            const t = term(p);
            if (!t.exit) await new Promise<void>((r) => t.waiters.push(r));
            return t.exit;
          }
          case 'terminal/kill': killGroup(term(p).child.pid, 'SIGKILL'); return {};
          case 'terminal/release': {
            const t = term(p);
            killGroup(t.child.pid, 'SIGKILL');
            terminals.delete(String(p.terminalId));
            return {};
          }
          case 'session/request_permission': {
            const d = decidePermission(root, readOnly, {
              toolCall: obj(p.toolCall),
              options: (Array.isArray(p.options) ? p.options : []).map(obj).filter((o) => typeof o.optionId === 'string')
                .map((o) => ({ optionId: o.optionId as string, ...(typeof o.kind === 'string' ? { kind: o.kind } : {}) })),
            });
            decide('session/request_permission', d.subject, d.allowed, d.reason);
            return { outcome: d.optionId ? { outcome: 'selected', optionId: d.optionId } : { outcome: 'cancelled' } };
          }
          default:
            decide(method, '', false, 'method not supported by this client');
            throw new RpcError(-32601, `method not found: ${method}`);
        }
      };

      // ---- notifications from the agent -------------------------------------------------------
      const onNotification = (method: string, p: Json) => {
        if (method !== 'session/update' || (sessionId && p.sessionId !== sessionId)) return;
        const u = obj(p.update);
        switch (u.sessionUpdate) {
          case 'agent_message_chunk': {
            const c = obj(u.content);
            if (c.type === 'text' && typeof c.text === 'string' && output.length < MAX_OUTPUT_CHARS) {
              output += c.text;
              onChunk?.(c.text);
            }
            break;
          }
          case 'tool_call': {
            const id = String(u.toolCallId ?? '');
            // The kind (read, edit, execute...) names the tool: titles carry paths and commands, so they stay out of span names.
            notify(obs, 'toolCall', { id, name: untrusted(u.kind ?? 'other', 50), input: u.rawInput });
            if (u.status === 'completed' || u.status === 'failed') notify(obs, 'toolResult', { id, isError: u.status === 'failed' });
            break;
          }
          case 'tool_call_update':
            if (u.status === 'completed' || u.status === 'failed') {
              notify(obs, 'toolResult', { id: String(u.toolCallId ?? ''), isError: u.status === 'failed', output: updateText(u.content) });
            }
            break;
          case 'usage_update': {
            const cost = obj(u.cost);
            if (cost.currency === 'USD' && typeof cost.amount === 'number') notify(obs, 'usage', { costUsd: cost.amount });
            break;
          }
        }
      };

      const peer = new Peer(
        (line) => child.stdin?.write(line),
        onRequest,
        onNotification,
        () => { failure = 'agent sent a message over the size limit'; stop(); },
      );
      child.stdin?.on('error', () => { /* agent closed its stdin; close handling reports it */ });
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (s: string) => peer.feed(s));
      child.stderr?.on('data', (b: Buffer) => { stderrTail = (stderrTail + b.toString()).slice(-4000); });

      // ---- the turn ---------------------------------------------------------------------------
      let hello: AgentHandshake | undefined;
      let spawnFailed = false;
      const drive = async () => {
        let hsTimer: NodeJS.Timeout | undefined;
        const hs = new Promise<never>((_, rej) => { hsTimer = setTimeout(() => rej(new Error('no answer to initialize')), handshakeTimeoutMs).unref(); });
        const init = obj(await Promise.race([
          peer.request('initialize', {
            protocolVersion: ACP_PROTOCOL_VERSION,
            clientCapabilities: { fs: { readTextFile: true, writeTextFile: !readOnly }, terminal: !readOnly },
            clientInfo: { name: 'octet', title: 'Octet', version: '0.1.0' },
          }),
          hs,
        ]).finally(() => clearTimeout(hsTimer)));
        const info = obj(init.agentInfo);
        hello = {
          protocol: 'acp',
          command: [program, ...args],
          ...(typeof init.protocolVersion === 'number' ? { protocolVersion: init.protocolVersion } : {}),
          ...(typeof info.name === 'string' ? { agentName: untrusted(info.name, 100) } : {}),
          ...(typeof info.title === 'string' ? { agentTitle: untrusted(info.title, 100) } : {}),
          ...(typeof info.version === 'string' ? { agentVersion: untrusted(info.version, 100) } : {}),
          capabilities: init.agentCapabilities ?? {},
        };
        if (init.protocolVersion !== ACP_PROTOCOL_VERSION) {
          throw new Error(`agent speaks ACP version ${untrusted(init.protocolVersion, 20)}; Octet supports ${ACP_PROTOCOL_VERSION}`);
        }
        const sess = obj(await peer.request('session/new', { cwd: root, mcpServers: this.opts.mcpServers?.(req) ?? [] }));
        if (typeof sess.sessionId !== 'string') throw new Error('agent did not return a sessionId');
        sessionId = sess.sessionId;
        hello = { ...hello, sessionId };
        notify(obs, 'handshake', hello);
        const text = `${req.systemPrompt}\n\n---\n\n${req.prompt}`;
        const res = obj(await peer.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }));
        stopReason = typeof res.stopReason === 'string' ? res.stopReason : 'unknown';
      };

      child.on('error', (e) => { spawnFailed = true; cleanup(); rejectRun(e); });
      child.on('close', () => {
        cleanup();
        peer.closeAll(new Error('agent exited'));
        // Anything left in the agent's group, and any terminal it opened, goes with it.
        killGroup(child.pid, 'SIGKILL');
        for (const t of terminals.values()) killGroup(t.child.pid, 'SIGKILL');
        const stopped = cancelled || timedOut;
        if (!stopped && !failure && stopReason === undefined) failure = 'agent exited before finishing the turn';
        const note = failure ? `\n[acp] ${failure}${stderrTail ? `\n${untrusted(stderrTail, 2000)}` : ''}\n` : stopReason && stopReason !== 'end_turn' ? `\n[acp] stopped: ${stopReason}\n` : '';
        const exitCode = stopped ? 143 : failure ? 1 : stopReason === 'end_turn' ? 0 : stopReason === 'cancelled' ? 143 : 1;
        resolveRun({
          exitCode, output: output + note, durationMs: Date.now() - started,
          ...(cancelled ? { cancelled } : {}), ...(timedOut ? { timedOut } : {}),
        });
      });

      drive().then(
        () => {
          // Turn complete: let the agent exit on its own, but not forever.
          child.stdin?.end();
          exitTimer = setTimeout(stop, 2000).unref();
        },
        (e: unknown) => {
          if (spawnFailed) return;
          if (!cancelled && !timedOut) failure = (e as Error).message;
          // A handshake that never completed is still recorded, with why.
          if (!hello?.sessionId) notify(obs, 'handshake', { ...(hello ?? { protocol: 'acp', command: [program, ...args] }), error: untrusted((e as Error).message, 300) });
          stop();
        },
      );
    });
  }
}

function updateText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts = content.map((c) => obj(obj(c).content)).filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text as string);
  return parts.length ? parts.join('\n') : undefined;
}
