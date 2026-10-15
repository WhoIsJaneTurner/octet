import { notify, untrusted, type RunObserver } from './observe.ts';
import { parseUsage, type RunUsage } from './usage.ts';

const MAX_DETAIL = 120;

/** One short line saying what a tool call is about, e.g. the file an Edit touches. */
function toolDetail(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  const v = [i.file_path, i.path, i.command, i.pattern, i.url, i.description].find((x) => typeof x === 'string') as string | undefined;
  const flat = (v ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > MAX_DETAIL ? `${flat.slice(0, MAX_DETAIL)}...` : flat;
}

/**
 * Reads `claude -p --output-format stream-json --verbose`. Field names below were checked against a real run
 * (Claude Code 2.1.296), not assumed: one JSON object per line, `type` is one of
 *   system (subtype init: session_id, model, claude_code_version, mcp_servers[{name,status}], tools[]),
 *   assistant (message.content[]: {type:'text'} or {type:'tool_use', id, name, input}),
 *   user (message.content[]: {type:'tool_result', tool_use_id, content, is_error?}),
 *   result (result: final text, is_error, usage, total_cost_usd, session_id),
 *   rate_limit_event (ignored).
 * An MCP tool is named `mcp__<server>__<tool>`.
 */

export interface StreamSink {
  /** Assistant text and one `> Tool detail` line per tool call, for live display. */
  text(s: string): void;
  /** A line that was not JSON (an error banner, say). */
  raw(s: string): void;
  /** The init event listed an MCP server Octet did not allow. */
  unlistedServer?(name: string): void;
}

export const mcpName = (name: string): { server: string; tool: string } | undefined => {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? { server: m[1]!, tool: m[2]! } : undefined;
};

const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export class ClaudeStreamParser {
  private buf = '';
  /** The final `result` text, if the run got that far. */
  result: string | undefined;
  /** The closing `result` message as received (usage, cost, is_error). */
  private resultMessage: Record<string, unknown> | undefined;
  private assistantText = '';

  private readonly sink: StreamSink;
  private readonly obs: RunObserver | undefined;
  private readonly allowedServers: ReadonlySet<string>;
  private readonly captureResults: boolean;

  constructor(sink: StreamSink, obs: RunObserver | undefined, allowedServers: ReadonlySet<string>, captureResults: boolean) {
    this.sink = sink;
    this.obs = obs;
    this.allowedServers = allowedServers;
    this.captureResults = captureResults;
  }

  /** Tokens and estimated cost from the closing `result`, when it carried them. */
  get usage(): RunUsage | undefined {
    return parseUsage(this.resultMessage);
  }

  /** The agent itself reported an error result, whatever the exit code says. */
  get failed(): boolean {
    return this.resultMessage?.is_error === true;
  }

  /** What to report as the run's output: the final result, else whatever the assistant said. */
  get output(): string {
    return this.result ?? this.assistantText;
  }

  push(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.line(line);
    }
  }

  end(): void {
    const rest = this.buf.trim();
    this.buf = '';
    if (rest) this.line(rest);
  }

  private line(line: string): void {
    let m: Record<string, unknown>;
    try { m = asObj(JSON.parse(line)); } catch { this.sink.raw(`${line}\n`); return; }
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') this.init(m);
        break;
      case 'assistant':
        for (const b of this.blocks(m)) {
          if (b.type === 'text' && typeof b.text === 'string') {
            this.assistantText += `${b.text}\n`;
            this.sink.text(`${b.text}\n`);
          } else if (b.type === 'tool_use' && typeof b.name === 'string') {
            const name = untrusted(b.name, 200);
            this.sink.text(`> ${name} ${toolDetail(b.input)}`.trimEnd() + '\n');
            const mcp = mcpName(name);
            notify(this.obs, 'toolCall', { id: String(b.id ?? ''), name, input: b.input, ...(mcp ? { mcp: { server: untrusted(mcp.server, 100), tool: untrusted(mcp.tool, 100) } } : {}) });
          }
        }
        break;
      case 'user':
        for (const b of this.blocks(m)) {
          if (b.type === 'tool_result') {
            notify(this.obs, 'toolResult', {
              id: String(b.tool_use_id ?? ''), isError: b.is_error === true,
              ...(this.captureResults ? { output: resultText(b.content) } : {}),
            });
          }
        }
        break;
      case 'result': {
        this.resultMessage = m;
        if (typeof m.result === 'string') this.result = m.result;
        const u = asObj(m.usage);
        const num = (v: unknown) => (typeof v === 'number' ? v : 0);
        notify(this.obs, 'usage', {
          // Input tokens include the cached ones, as the conventions ask.
          inputTokens: num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens),
          outputTokens: num(u.output_tokens),
          ...(typeof m.total_cost_usd === 'number' ? { costUsd: m.total_cost_usd } : {}),
        });
        break;
      }
    }
  }

  private init(m: Record<string, unknown>): void {
    const servers = (Array.isArray(m.mcp_servers) ? m.mcp_servers : []).map(asObj)
      .filter((s) => typeof s.name === 'string')
      .map((s) => ({ name: untrusted(s.name, 100), ...(typeof s.status === 'string' ? { status: untrusted(s.status, 50) } : {}) }));
    notify(this.obs, 'handshake', {
      protocol: 'claude-stream-json', agentName: 'claude-code', provider: 'anthropic',
      ...(typeof m.claude_code_version === 'string' ? { agentVersion: untrusted(m.claude_code_version, 50) } : {}),
      ...(typeof m.model === 'string' ? { model: untrusted(m.model, 100) } : {}),
      ...(typeof m.session_id === 'string' ? { sessionId: m.session_id } : {}),
      ...(typeof m.permissionMode === 'string' ? { capabilities: { permissionMode: m.permissionMode, tools: Array.isArray(m.tools) ? m.tools.length : 0 } } : {}),
      mcpServers: servers,
    });
    for (const s of servers) if (!this.allowedServers.has(s.name)) this.sink.unlistedServer?.(s.name);
  }

  private blocks(m: Record<string, unknown>): Record<string, unknown>[] {
    const c = asObj(m.message).content;
    return Array.isArray(c) ? c.map(asObj) : [];
  }
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(asObj).map((b) => (typeof b.text === 'string' ? b.text : '')).join('\n');
  return '';
}
