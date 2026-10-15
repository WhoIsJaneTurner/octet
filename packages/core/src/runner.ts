import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeStreamParser } from './claude-stream.ts';
import type { Env } from './git.ts';
import type { McpLaunch } from './mcp-policy.ts';
import { notify, type RunObserver } from './observe.ts';
import { prepareSandbox, watchMemory, type SandboxConfig, type SandboxRequest } from './sandbox.ts';
import type { SeatId } from './seats.ts';

export interface RunRequest {
  seat: SeatId;
  cwd: string;
  prompt: string;
  systemPrompt: string;
  env: Env;
  model?: string;
  /** Read-only seats (Reviewer) may inspect files but cannot edit or run commands. */
  readOnly?: boolean;
  /** Aborting stops the agent: its whole process group is killed. */
  signal?: AbortSignal;
  /** Kill the agent if it is still running after this long. */
  timeoutMs?: number;
  /** Told about handshakes, tool calls and permission decisions as they happen; see observe.ts. */
  observer?: RunObserver;
  /** Wraps the agent in the builder sandbox (see sandbox.ts). Absent = config.toml decides, with no event sink. */
  sandbox?: SandboxRequest;
}

export interface RunResult {
  exitCode: number;
  output: string;
  durationMs: number;
  /** Stopped because `signal` was aborted. */
  cancelled?: boolean;
  /** Stopped because `timeoutMs` elapsed. */
  timedOut?: boolean;
  /** Stopped because the agent's processes passed the sandbox memory ceiling. */
  memoryExceeded?: boolean;
}

export interface AgentRunner {
  run(req: RunRequest, onChunk?: (text: string) => void): Promise<RunResult>;
}

/** Actions an agent may never take itself; the Courier delivers, via the Warden. */
export const DENIED_TOOLS = ['Bash(git push:*)', 'Bash(gh pr:*)', 'Bash(gh repo:*)', 'Bash(gh auth:*)'];

const KILL_GRACE_MS = 5000;

export interface ClaudeCodeOptions {
  /** Executable to start. Default `claude`. */
  command?: string;
  /** MCP servers for a run. Default: none, which is also what a missing option means. */
  mcp?: (req: RunRequest) => McpLaunch;
  /** Read `--output-format stream-json` so tool calls reach `req.observer`. Off = plain text output, as before. */
  observe?: (req: RunRequest) => boolean;
  /** Keep tool results in the events passed to the observer (content capture). */
  captureResults?: boolean;
  /** Sandbox settings for every run (tests that use a stand-in `claude` turn it off). Unset reads `[sandbox]` from config.toml. */
  sandbox?: SandboxConfig;
}

export class ClaudeCodeRunner implements AgentRunner {
  private readonly opts: ClaudeCodeOptions;
  /** Sandbox settings for every run; unset reads `[sandbox]` from config.toml. A request's own `sandbox.config` wins. */
  sandbox?: SandboxConfig;
  constructor(opts: ClaudeCodeOptions = {}) {
    this.opts = opts;
  }

  async run(req: RunRequest, onChunk?: (text: string) => void): Promise<RunResult> {
    const mcp = this.opts.mcp?.(req);
    const stream = this.opts.observe?.(req) === true;
    const args = [
      '-p',
      '--append-system-prompt', req.systemPrompt,
      // Builders get no MCP servers unless the seat's allow-list (mcp-policy.ts) names some.
      '--strict-mcp-config', '--mcp-config', mcp?.json ?? '{"mcpServers":{}}',
      ...(req.readOnly
        ? ['--permission-mode', 'default', '--allowedTools', ['Read', 'Grep', 'Glob', ...(mcp?.allowedTools ?? [])].join(','),
          '--disallowedTools', ['Edit', 'Write', 'NotebookEdit', 'Bash', ...DENIED_TOOLS].join(',')]
        : ['--permission-mode', 'acceptEdits', '--disallowedTools', DENIED_TOOLS.join(','),
          ...(mcp?.allowedTools.length ? ['--allowedTools', mcp.allowedTools.join(',')] : [])]),
      ...(stream ? ['--output-format', 'stream-json', '--verbose'] : []),
    ];
    if (req.model) args.push('--model', req.model);
    // Throws in `required` mode when the sandbox cannot be applied: an agent never runs unprotected by accident.
    const sb = await prepareSandbox(req, this.opts.command ?? 'claude', args, this.sandbox ?? this.opts.sandbox);
    const started = Date.now();
    return new Promise((resolve, reject) => {
      // Own process group, so a kill reaches everything the agent started, not just `claude`.
      const child = spawn(sb?.command ?? this.opts.command ?? 'claude', sb?.args ?? args, { cwd: req.cwd, env: sb?.env ?? req.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      let output = '';
      let cancelled = false;
      let timedOut = false;
      let memoryExceeded = false;
      let violation: string | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      const killGroup = (sig: NodeJS.Signals) => {
        try { process.kill(-child.pid!, sig); } catch { /* already gone */ }
      };
      const stop = () => {
        killGroup('SIGTERM');
        killTimer ??= setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
      };
      const onAbort = () => { cancelled = true; stop(); };
      if (req.signal?.aborted) onAbort();
      else req.signal?.addEventListener('abort', onAbort, { once: true });
      const timer = req.timeoutMs ? setTimeout(() => { timedOut = true; stop(); }, req.timeoutMs) : undefined;
      const stopMemory = sb && child.pid ? watchMemory(child.pid, sb.memoryMb, (mb) => {
        memoryExceeded = true;
        req.sandbox?.onEvent?.('sandbox.memory_exceeded', { seat: req.seat, usedMb: Math.round(mb), limitMb: sb.memoryMb });
        stop();
      }) : undefined;
      const cleanup = () => {
        stopMemory?.();
        clearTimeout(timer);
        clearTimeout(killTimer);
        req.signal?.removeEventListener('abort', onAbort);
      };
      const take = (b: Buffer) => {
        const s = b.toString();
        output += s;
        onChunk?.(s);
      };
      const parser = stream
        ? new ClaudeStreamParser({
          text: (s) => onChunk?.(s),
          raw: (s) => { output += s; onChunk?.(s); },
          // A server connected that the allow-list did not name: stop before the model can use it.
          unlistedServer: (name) => {
            violation = `MCP server "${name}" connected but is not on this seat's allow-list`;
            notify(req.observer, 'decision', { request: 'mcp/connect', subject: name, allowed: false, reason: 'not on the allow-list' });
            stop();
          },
        }, req.observer, new Set(mcp?.servers ?? []), this.opts.captureResults === true)
        : undefined;
      let stderr = '';
      child.stdout.on('data', parser ? (b: Buffer) => parser.push(b.toString()) : take);
      child.stderr.on('data', parser ? (b: Buffer) => { stderr += b.toString(); onChunk?.(b.toString()); } : take);
      child.on('error', (e) => { cleanup(); void sb?.dispose(); reject(e); });
      child.on('close', async (code) => {
        cleanup();
        // Anything left in the group after the leader exits is cleaned up too.
        killGroup('SIGKILL');
        if (parser) {
          parser.end();
          output = parser.output + output + stderr + (violation ? `\n[octet] ${violation}\n` : '');
        }
        const durationMs = Date.now() - started;
        await sb?.finish().catch(() => {});
        resolve({ exitCode: violation ? 1 : code ?? 1, output, durationMs, ...(cancelled ? { cancelled } : {}), ...(timedOut ? { timedOut } : {}), ...(memoryExceeded ? { memoryExceeded } : {}) });
      });
      child.stdin.end(req.prompt);
    });
  }
}

/** Test and dry-run runner: writes a marker file instead of calling a model. */
export class FakeRunner implements AgentRunner {
  readonly calls: RunRequest[] = [];
  /** Scripted replies by seat, e.g. a Reviewer verdict. */
  readonly replies: Partial<Record<SeatId, string>> = {};
  private readonly queues = new Map<SeatId, string[]>();
  /** Replies handed out in order, one per call, before falling back to `replies`: e.g. a malformed one, then a valid one. */
  script(seat: SeatId, replies: string[]): void {
    this.queues.set(seat, [...(this.queues.get(seat) ?? []), ...replies]);
  }
  /** Seats that block until their signal aborts or their timeout elapses, like a stuck agent. */
  readonly hang = new Set<SeatId>();
  /** Write a different file per worktree, so separate beads merge cleanly (the default same-name file makes them conflict). */
  uniqueFiles = false;
  /** Runs after the fake engineer's write, to simulate edits (conflict markers, huge files). */
  afterEngineer?: (req: RunRequest) => void;
  /** Exit code to report per seat (default 0): lets a test make the engineer fail. */
  readonly exit = new Map<SeatId, number>();
  async run(req: RunRequest, onChunk?: (text: string) => void): Promise<RunResult> {
    this.calls.push(req);
    if (this.hang.has(req.seat)) {
      onChunk?.('working...\n');
      return new Promise((resolve) => {
        let timer: NodeJS.Timeout | undefined;
        const done = (r: Partial<RunResult>) => {
          clearTimeout(timer);
          resolve({ exitCode: 143, output: 'working...\n', durationMs: 1, ...r });
        };
        if (req.signal?.aborted) return done({ cancelled: true });
        req.signal?.addEventListener('abort', () => done({ cancelled: true }), { once: true });
        if (req.timeoutMs) timer = setTimeout(() => done({ timedOut: true }), req.timeoutMs);
      });
    }
    if (req.seat === 'engineer') {
      writeFileSync(join(req.cwd, this.uniqueFiles ? `${req.seat}-output-${req.cwd.split('/').pop()}.txt` : `${req.seat}-output.txt`), req.prompt);
      this.afterEngineer?.(req);
    }
    const output = this.queues.get(req.seat)?.shift() ?? this.replies[req.seat] ?? 'fake run complete\n';
    onChunk?.(output);
    return { exitCode: this.exit.get(req.seat) ?? 0, output, durationMs: 1 };
  }
}
