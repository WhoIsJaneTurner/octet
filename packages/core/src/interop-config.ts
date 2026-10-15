import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { OctetError } from './errors.ts';
import type { McpPolicy, McpServerDef } from './mcp-policy.ts';
import { octetHome } from './paths.ts';
import { SEAT_IDS, type SeatId } from './seats.ts';

/**
 * The `[agents]`, `[mcp]` and `[telemetry]` tables of config.toml:
 *
 *   [agents]                       # seat -> command speaking ACP on stdio; absent or "claude" = Claude Code
 *   reviewer = "my-agent --acp"
 *
 *   [mcp.servers.docs]             # servers Octet may hand to an agent
 *   command = "docs-mcp"           # or: type = "http", url = "https://..."
 *   args = ["--stdio"]
 *   env = { DOCS_ROOT = "/srv/docs" }
 *   tools = ["search"]             # optional: pin tool names
 *   read_only = true               # may be used by read-only seats
 *   [mcp.allow]                    # seat -> server names; default none
 *   engineer = ["docs"]
 *
 *   [telemetry]
 *   otlp_endpoint = "http://127.0.0.1:4318"   # unset = no export
 *   capture_content = false                   # prompts, outputs, tool arguments: off unless true
 *   [telemetry.headers]                       # optional, e.g. an auth header for the collector
 */

export type AgentsConfig = Partial<Record<SeatId, string[]>>;

export interface TelemetryConfig {
  otlpEndpoint?: string;
  captureContent: boolean;
  headers: Record<string, string>;
}

export interface InteropConfig {
  agents: AgentsConfig;
  mcp: McpPolicy;
  telemetry: TelemetryConfig;
}

type Tbl = Record<string, unknown>;
const tbl = (v: unknown): Tbl => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Tbl) : {});
const strings = (v: unknown, what: string): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new OctetError(`config: ${what} must be a list of strings`);
  return v as string[];
};
const stringMap = (v: unknown, what: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(tbl(v))) {
    if (typeof val !== 'string') throw new OctetError(`config: ${what}.${k} must be a string`);
    out[k] = val;
  }
  return out;
};
const seatId = (s: string, where: string): SeatId => {
  if (!(SEAT_IDS as readonly string[]).includes(s)) throw new OctetError(`config: ${where}: "${s}" is not a seat (${SEAT_IDS.join(', ')})`);
  return s as SeatId;
};

/** Splits a command line into words, honouring single quotes, double quotes and backslashes. No shell is involved. */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let have = false;
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = undefined;
      else if (c === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
    } else if (c === '"' || c === "'") { quote = c; have = true; }
    else if (c === '\\' && i + 1 < line.length) { cur += line[++i]; have = true; }
    else if (/\s/.test(c)) { if (have) { out.push(cur); cur = ''; have = false; } }
    else { cur += c; have = true; }
  }
  if (quote) throw new OctetError(`config: unterminated quote in command: ${line}`);
  if (have) out.push(cur);
  return out;
}

export function parseInterop(text: string): InteropConfig {
  const doc = parse(text) as Tbl;

  const agents: AgentsConfig = {};
  for (const [k, v] of Object.entries(tbl(doc.agents))) {
    const seat = seatId(k, '[agents]');
    const argv = typeof v === 'string' ? splitCommand(v) : strings(v, `[agents].${k}`);
    if (!argv.length) throw new OctetError(`config: [agents].${k} is empty`);
    if (argv.length === 1 && argv[0] === 'claude') continue;
    agents[seat] = argv;
  }

  const mcpDoc = tbl(doc.mcp);
  const servers: Record<string, McpServerDef> = {};
  for (const [name, raw] of Object.entries(tbl(mcpDoc.servers))) {
    // `__` separates server from tool in Claude Code's tool names, so it cannot be inside a server name.
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name) || name.includes('__')) throw new OctetError(`config: [mcp.servers.${name}]: name may use letters, digits, "-" and single "_"`);
    const s = tbl(raw);
    const type = s.type === 'http' ? 'http' : 'stdio';
    if (type === 'stdio' && typeof s.command !== 'string') throw new OctetError(`config: [mcp.servers.${name}] needs "command" (or type = "http" and "url")`);
    if (type === 'http' && !(typeof s.url === 'string' && /^https?:\/\//.test(s.url))) throw new OctetError(`config: [mcp.servers.${name}] needs an http(s) "url"`);
    servers[name] = {
      name, type,
      ...(type === 'stdio' ? { command: s.command as string } : { url: s.url as string }),
      args: strings(s.args, `[mcp.servers.${name}].args`),
      env: stringMap(s.env, `[mcp.servers.${name}].env`),
      headers: stringMap(s.headers, `[mcp.servers.${name}].headers`),
      tools: strings(s.tools, `[mcp.servers.${name}].tools`),
      readOnly: s.read_only === true,
    };
  }
  const allow: McpPolicy['allow'] = {};
  for (const [k, v] of Object.entries(tbl(mcpDoc.allow))) {
    const seat = seatId(k, '[mcp.allow]');
    const names = strings(v, `[mcp.allow].${k}`);
    for (const n of names) if (!servers[n]) throw new OctetError(`config: [mcp.allow].${k} names "${n}", which is not defined under [mcp.servers]`);
    if (names.length) allow[seat] = names;
  }

  const t = tbl(doc.telemetry);
  const endpoint = typeof t.otlp_endpoint === 'string' && t.otlp_endpoint.trim() ? t.otlp_endpoint.trim() : undefined;
  if (endpoint && !/^https?:\/\//.test(endpoint)) throw new OctetError('config: [telemetry].otlp_endpoint must be an http(s) URL');
  const telemetry: TelemetryConfig = {
    ...(endpoint ? { otlpEndpoint: endpoint } : {}),
    captureContent: t.capture_content === true,
    headers: stringMap(t.headers, '[telemetry].headers'),
  };

  return { agents, mcp: { servers, allow }, telemetry };
}

/** Reads the interop tables from ~/.config/octet/config.toml. A missing file means defaults: Claude Code, no MCP, no telemetry. */
export function loadInterop(file: string = join(octetHome(), 'config.toml')): InteropConfig {
  return parseInterop(existsSync(file) ? readFileSync(file, 'utf8') : '');
}
