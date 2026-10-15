/**
 * What a runner can tell the outside world about a run while it happens. Runners call these hooks; the
 * ObservedRunner decorator turns them into audit events and trace spans. A hook that throws never affects the run.
 */

export interface AgentHandshake {
  /** Wire protocol the facts below came from. */
  protocol: 'acp' | 'claude-stream-json';
  /** Protocol version the agent answered with, when the protocol has one. */
  protocolVersion?: number;
  /** How the agent was launched (ACP). */
  command?: string[];
  agentName?: string;
  agentTitle?: string;
  agentVersion?: string;
  /** Raw capabilities as the agent reported them, kept as data and never interpreted. */
  capabilities?: unknown;
  model?: string;
  /** Provider of the underlying model, if the agent says. */
  provider?: string;
  sessionId?: string;
  /** MCP servers the agent actually connected, as it reports them. */
  mcpServers?: { name: string; status?: string }[];
  /** Set when the handshake failed (version mismatch, no answer). */
  error?: string;
}

export interface ToolCallEvent {
  id: string;
  name: string;
  input?: unknown;
  /** Set when the call went to an MCP server. */
  mcp?: { server: string; tool: string };
}

export interface ToolResultEvent {
  id: string;
  isError: boolean;
  /** Result text; only recorded when content capture is on. */
  output?: string;
}

/** A request the agent made of the client (file, terminal, permission) and what Octet answered. */
export interface DecisionEvent {
  request: string;
  subject: string;
  allowed: boolean;
  reason: string;
}

export interface UsageEvent {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface RunObserver {
  handshake?(h: AgentHandshake): void;
  toolCall?(e: ToolCallEvent): void;
  toolResult?(e: ToolResultEvent): void;
  decision?(e: DecisionEvent): void;
  usage?(e: UsageEvent): void;
}

/** Calls one hook if present. Observers are advisory: their failures are swallowed. */
export function notify<K extends keyof RunObserver>(o: RunObserver | undefined, hook: K, ev: Parameters<NonNullable<RunObserver[K]>>[0]): void {
  try {
    (o?.[hook] as ((e: typeof ev) => void) | undefined)?.call(o, ev);
  } catch { /* observers never break a run */ }
}

/** Server- and agent-supplied text is untrusted: strip control characters and cap the length before it is stored or shown. */
export function untrusted(text: unknown, max = 500): string {
  const s = typeof text === 'string' ? text : JSON.stringify(text) ?? '';
  const clean = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return clean.length > max ? `${clean.slice(0, max)}...[truncated ${clean.length - max}]` : clean;
}
