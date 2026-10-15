import type { AcpMcpServer } from './acp.ts';
import type { SeatId } from './seats.ts';

/**
 * Which MCP servers a seat may use. Default: none, so every run gets the same empty config it always had.
 * Pinned MCP specification revision: 2026-07-28 (the "current" revision on modelcontextprotocol.io when this
 * was written). Octet does not speak MCP itself: it only decides which servers the agent is launched with, and
 * the agent (Claude Code, an ACP agent) negotiates the protocol revision with each server. Which revisions
 * those agents support is not something Octet can check.
 */
export const MCP_SPEC_REVISION = '2026-07-28';

export interface McpServerDef {
  name: string;
  type: 'stdio' | 'http';
  command?: string;
  args: string[];
  /** Variables set for the server, from config only; nothing is copied from Octet's own environment. */
  env: Record<string, string>;
  url?: string;
  headers: Record<string, string>;
  /** Tool names the seat may call. Empty = the whole server. Pinning names limits what a changed server can add. */
  tools: string[];
  /** Safe for seats that must not change anything (Reviewer). Only servers marked so reach read-only runs. */
  readOnly: boolean;
}

export interface McpPolicy {
  servers: Record<string, McpServerDef>;
  allow: Partial<Record<SeatId, string[]>>;
}

export const NO_MCP: McpPolicy = { servers: {}, allow: {} };

export interface McpLaunch {
  /** Value for `--mcp-config`. */
  json: string;
  /** Entries to add to `--allowedTools`: headless runs cannot ask, so an MCP tool is usable only if listed. */
  allowedTools: string[];
  /** Server names that will be available; used to spot a server that connects without being listed. */
  servers: string[];
}

/** Servers this seat may use in this run: the allow-list, minus servers that are not read-only on a read-only run. */
export function serversFor(policy: McpPolicy, seat: SeatId, readOnly: boolean): McpServerDef[] {
  return (policy.allow[seat] ?? [])
    .map((n) => policy.servers[n])
    .filter((s): s is McpServerDef => !!s && (!readOnly || s.readOnly));
}

/**
 * Builds the Claude Code launch for a run. Tool descriptions never pass through Octet: the agent reads them
 * from the server, so they are untrusted input to the model, and the only thing Octet controls is which
 * servers and tool names are reachable (names come from the config, not from the server).
 */
export function mcpFor(policy: McpPolicy, seat: SeatId, readOnly: boolean): McpLaunch {
  const servers = serversFor(policy, seat, readOnly);
  const mcpServers: Record<string, unknown> = {};
  const allowedTools: string[] = [];
  for (const s of servers) {
    mcpServers[s.name] = s.type === 'http'
      ? { type: 'http', url: s.url, ...(Object.keys(s.headers).length ? { headers: s.headers } : {}) }
      : { command: s.command, args: s.args, env: s.env };
    if (s.tools.length) allowedTools.push(...s.tools.map((t) => `mcp__${s.name}__${t}`));
    else allowedTools.push(`mcp__${s.name}`);
  }
  return { json: JSON.stringify({ mcpServers }), allowedTools, servers: servers.map((s) => s.name) };
}

/** The same servers in the shape ACP's `session/new` wants. Only stdio servers: HTTP needs a capability the agent states later. */
export function acpServersFor(policy: McpPolicy, seat: SeatId, readOnly: boolean): AcpMcpServer[] {
  return serversFor(policy, seat, readOnly).filter((s) => s.type === 'stdio').map((s) => ({
    name: s.name, command: s.command!, args: s.args, env: Object.entries(s.env).map(([name, value]) => ({ name, value })),
  }));
}
