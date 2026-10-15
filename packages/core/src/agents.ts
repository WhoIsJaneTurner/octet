import { basename } from 'node:path';
import { AcpRunner } from './acp.ts';
import { loadInterop, type InteropConfig } from './interop-config.ts';
import { acpServersFor, mcpFor } from './mcp-policy.ts';
import { ObservedRunner } from './observed-runner.ts';
import { OtlpHttpExporter, Tracer } from './otel.ts';
import type { SandboxConfig } from './sandbox.ts';
import { ClaudeCodeRunner, FakeRunner, type AgentRunner, type RunRequest, type RunResult } from './runner.ts';
import type { SeatId } from './seats.ts';
import type { Store } from './store.ts';

/** Sends each run to the runner configured for its seat, so `Ctx.runner` stays one object. */
export class RoutingRunner implements AgentRunner {
  private readonly fallback: AgentRunner;
  private readonly bySeat: Partial<Record<SeatId, AgentRunner>>;
  constructor(fallback: AgentRunner, bySeat: Partial<Record<SeatId, AgentRunner>> = {}) {
    this.fallback = fallback;
    this.bySeat = bySeat;
  }
  run(req: RunRequest, onChunk?: (text: string) => void): Promise<RunResult> {
    return (this.bySeat[req.seat] ?? this.fallback).run(req, onChunk);
  }
}

/** The runner for one seat: an ACP agent if `[agents]` names one, otherwise `fallback` (Claude Code). */
export function selectRunner(config: InteropConfig, seat: SeatId, fallback: AgentRunner): AgentRunner {
  const command = config.agents[seat];
  if (!command) return fallback;
  return new AcpRunner({ command, mcpServers: (req) => acpServersFor(config.mcp, seat, req.readOnly === true) });
}

export interface RunnerBundle {
  runner: AgentRunner;
  /** Flushes buffered spans. Call once on the way out; never throws. */
  shutdown(): Promise<void>;
}

export interface BuildRunnerOptions {
  store: Store;
  /** Dry runs: the fake runner, no config read. */
  fake?: boolean;
  /** Defaults to the tables in ~/.config/octet/config.toml. */
  config?: InteropConfig;
  fetchImpl?: typeof fetch;
  /** Claude Code executable, for tests and non-standard installs. */
  claudeCommand?: string;
  /** Sandbox settings for Claude Code runs; unset reads `[sandbox]` from config.toml. Tests with a stand-in `claude` turn it off. */
  sandbox?: SandboxConfig;
}

/**
 * The runner the daemon and CLI use: Claude Code by default, ACP agents per seat from `[agents]`, MCP limited to
 * `[mcp]` allow-lists, everything audited, and traces exported if `[telemetry] otlp_endpoint` is set.
 */
export function buildRunner(opts: BuildRunnerOptions): RunnerBundle {
  if (opts.fake) return { runner: new FakeRunner(), shutdown: async () => {} };
  const config = opts.config ?? loadInterop();
  const { telemetry } = config;
  const exporter = telemetry.otlpEndpoint
    ? new OtlpHttpExporter({
      endpoint: telemetry.otlpEndpoint, headers: telemetry.headers, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    })
    : undefined;

  const claude = new ClaudeCodeRunner({
    ...(opts.claudeCommand ? { command: opts.claudeCommand } : {}),
    ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
    mcp: (req) => mcpFor(config.mcp, req.seat, req.readOnly === true),
    // Tool calls are only visible in stream-json, so it is read when something consumes them.
    observe: (req) => !!exporter || mcpFor(config.mcp, req.seat, req.readOnly === true).servers.length > 0,
    captureResults: telemetry.captureContent,
  });
  const bySeat: Partial<Record<SeatId, AgentRunner>> = {};
  for (const seat of Object.keys(config.agents) as SeatId[]) bySeat[seat] = selectRunner(config, seat, claude);

  const runner = new ObservedRunner(new RoutingRunner(claude, bySeat), {
    store: opts.store,
    ...(exporter ? { tracer: new Tracer(exporter) } : {}),
    captureContent: telemetry.captureContent,
    providerFor: (seat) => {
      const command = config.agents[seat as SeatId]?.[0];
      return command ? basename(command) : 'anthropic';
    },
  });
  return { runner, shutdown: async () => { await exporter?.shutdown(); } };
}
