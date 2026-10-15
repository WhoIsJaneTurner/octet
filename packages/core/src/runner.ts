import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from './git.ts';
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
}

export interface RunResult {
  exitCode: number;
  output: string;
  durationMs: number;
  /** Stopped because `signal` was aborted. */
  cancelled?: boolean;
  /** Stopped because `timeoutMs` elapsed. */
  timedOut?: boolean;
}

export interface AgentRunner {
  run(req: RunRequest, onChunk?: (text: string) => void): Promise<RunResult>;
}

/** Actions an agent may never take itself; the Courier delivers, via the Warden. */
export const DENIED_TOOLS = ['Bash(git push:*)', 'Bash(gh pr:*)', 'Bash(gh repo:*)', 'Bash(gh auth:*)'];

const KILL_GRACE_MS = 5000;

export class ClaudeCodeRunner implements AgentRunner {
  run(req: RunRequest, onChunk?: (text: string) => void): Promise<RunResult> {
    const args = [
      '-p',
      '--append-system-prompt', req.systemPrompt,
      // Builders get no MCP servers: account-level connectors are irrelevant to them and add noise.
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      ...(req.readOnly
        ? ['--permission-mode', 'default', '--allowedTools', 'Read,Grep,Glob',
          '--disallowedTools', ['Edit', 'Write', 'NotebookEdit', 'Bash', ...DENIED_TOOLS].join(',')]
        : ['--permission-mode', 'acceptEdits', '--disallowedTools', DENIED_TOOLS.join(',')]),
    ];
    if (req.model) args.push('--model', req.model);
    const started = Date.now();
    return new Promise((resolve, reject) => {
      // Own process group, so a kill reaches everything the agent started, not just `claude`.
      const child = spawn('claude', args, { cwd: req.cwd, env: req.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      let output = '';
      let cancelled = false;
      let timedOut = false;
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
      const cleanup = () => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        req.signal?.removeEventListener('abort', onAbort);
      };
      const take = (b: Buffer) => {
        const s = b.toString();
        output += s;
        onChunk?.(s);
      };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
      child.on('error', (e) => { cleanup(); reject(e); });
      child.on('close', (code) => {
        cleanup();
        // Anything left in the group after the leader exits is cleaned up too.
        killGroup('SIGKILL');
        resolve({ exitCode: code ?? 1, output, durationMs: Date.now() - started, ...(cancelled ? { cancelled } : {}), ...(timedOut ? { timedOut } : {}) });
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
  /** Seats that block until their signal aborts or their timeout elapses, like a stuck agent. */
  readonly hang = new Set<SeatId>();
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
    if (req.seat === 'engineer') writeFileSync(join(req.cwd, `${req.seat}-output.txt`), req.prompt);
    const output = this.replies[req.seat] ?? 'fake run complete\n';
    onChunk?.(output);
    return { exitCode: 0, output, durationMs: 1 };
  }
}
