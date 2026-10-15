import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'smol-toml';
import { OctetError } from './errors.ts';

/**
 * Validation for config.toml, projects.toml and identities.toml. Wrong types are errors that
 * name the file, section and key; unknown keys are warnings (they are usually typos, and a
 * newer file should not stop an older Octet from starting).
 *
 * New config keys: add them to the schema tables below, or they are reported as unknown.
 */

export interface Issue {
  level: 'error' | 'warn';
  /** Where, e.g. `[limits] max_engineers`. */
  where: string;
  message: string;
}

type Kind = 'bool' | 'posint' | 'string' | 'strings' | { oneOf: readonly string[] };
type Schema = Record<string, Kind>;
type Table = Record<string, unknown>;

/** config.toml. A nested section such as [intake.github] is written `intake.github`. */
export const CONFIG_SCHEMA: Record<string, Schema> = {
  limits: { max_engineers: 'posint', max_active_goals: 'posint', run_timeout_minutes: 'posint' },
  review: { auto: 'bool', auto_merge: 'bool', max_rounds: 'posint' },
  planning: { max_beads: 'posint' },
  'intake.github': { enabled: 'bool', label: 'string', poll_seconds: 'posint', allowed_authors: 'strings' },
  'intake.jira': { enabled: 'bool', site: 'string', jql: 'string', project: 'string', allowed_transitions: 'strings' },
  'intake.chat': { enabled: 'bool', allowed_users: 'strings' },
};

export const PROJECT_SCHEMA: Schema = {
  path: 'string', identity: 'string', vault: 'string', vault_git: 'bool', vault_in_repo: 'bool',
  autonomy: { oneOf: ['manual', 'plan-gated', 'auto-to-pr'] },
};

export const IDENTITY_SCHEMA: Schema = {
  name: 'string', email: 'string', ssh_key: 'string', gh_user: 'string', owners: 'strings', signing_key: 'string',
};

const isTable = (v: unknown): v is Table => typeof v === 'object' && v !== null && !Array.isArray(v);

const describe = (v: unknown): string => (typeof v === 'string' ? `"${v}"` : Array.isArray(v) ? 'a list' : isTable(v) ? 'a table' : String(v));

/** Why `v` does not fit `kind`, or null when it does. */
function typeProblem(v: unknown, kind: Kind): string | null {
  if (typeof kind === 'object') {
    return typeof v === 'string' && kind.oneOf.includes(v) ? null : `expected one of ${kind.oneOf.join(', ')}, got ${describe(v)}`;
  }
  switch (kind) {
    case 'bool': return typeof v === 'boolean' ? null : `expected true or false, got ${describe(v)}`;
    case 'posint': return typeof v === 'number' && Number.isInteger(v) && v > 0 ? null : `expected a positive whole number, got ${describe(v)}`;
    case 'string': return typeof v === 'string' && v !== '' ? null : `expected a non-empty string, got ${describe(v)}`;
    case 'strings': return Array.isArray(v) && v.every((x) => typeof x === 'string') ? null : `expected a list of strings, got ${describe(v)}`;
  }
}

/** Classic edit distance, for "did you mean" on unknown keys. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length]!;
}

function checkTable(t: Table, schema: Schema, label: string, out: Issue[]): void {
  for (const [key, v] of Object.entries(t)) {
    const kind = schema[key];
    if (!kind) {
      const near = Object.keys(schema).find((k) => editDistance(k, key.toLowerCase()) <= 2);
      out.push({ level: 'warn', where: `${label} ${key}`.trim(), message: `unknown key${near ? ` (did you mean "${near}"?)` : ''}; ignored` });
      continue;
    }
    const problem = typeProblem(v, kind);
    if (problem) out.push({ level: 'error', where: `${label} ${key}`.trim(), message: problem });
  }
}

/** Checks a parsed config.toml. */
export function checkConfigDoc(doc: Table): Issue[] {
  const out: Issue[] = [];
  const visit = (t: Table, prefix: string) => {
    for (const [name, v] of Object.entries(t)) {
      const path = prefix ? `${prefix}.${name}` : name;
      const schema = CONFIG_SCHEMA[path];
      if (schema) {
        if (!isTable(v)) out.push({ level: 'error', where: `[${path}]`, message: `expected a table, got ${describe(v)}` });
        else checkTable(v, schema, `[${path}]`, out);
      } else if (isTable(v) && Object.keys(CONFIG_SCHEMA).some((k) => k.startsWith(`${path}.`))) {
        visit(v, path); // a parent of known nested sections, such as [intake]
      } else {
        out.push({ level: 'warn', where: `[${path}]`, message: 'unknown section; ignored' });
      }
    }
  };
  visit(doc, '');
  return out;
}

/** Checks a parsed projects.toml. A missing `path` or `identity` is the loader's own error, not repeated here. */
export function checkProjectsDoc(doc: Table): Issue[] {
  const out: Issue[] = [];
  for (const [key, v] of Object.entries(doc)) {
    if (key !== 'projects') out.push({ level: 'warn', where: `[${key}]`, message: 'unknown section; ignored' });
    else if (!isTable(v)) out.push({ level: 'error', where: '[projects]', message: `expected a table, got ${describe(v)}` });
    else {
      for (const [name, t] of Object.entries(v)) {
        if (!isTable(t)) out.push({ level: 'error', where: `[projects.${name}]`, message: `expected a table, got ${describe(t)}` });
        else checkTable(t, PROJECT_SCHEMA, `[projects.${name}]`, out);
      }
    }
  }
  return out;
}

export function checkIdentitiesDoc(doc: Table): Issue[] {
  const out: Issue[] = [];
  for (const [key, v] of Object.entries(doc)) {
    if (key !== 'identities') out.push({ level: 'warn', where: `[${key}]`, message: 'unknown section; ignored' });
    else if (!isTable(v)) out.push({ level: 'error', where: '[identities]', message: `expected a table, got ${describe(v)}` });
    else {
      for (const [id, t] of Object.entries(v)) {
        if (!isTable(t)) out.push({ level: 'error', where: `[identities.${id}]`, message: `expected a table, got ${describe(t)}` });
        else checkTable(t, IDENTITY_SCHEMA, `[identities.${id}]`, out);
      }
    }
  }
  return out;
}

export type ConfigKind = 'config' | 'projects' | 'identities';
const CHECKS: Record<ConfigKind, (doc: Table) => Issue[]> = {
  config: checkConfigDoc, projects: checkProjectsDoc, identities: checkIdentitiesDoc,
};

/** Parses TOML text; a syntax error names the file. */
export function parseToml(text: string, file: string): Table {
  try {
    return parse(text) as Table;
  } catch (e) {
    throw new OctetError(`${file}: invalid TOML: ${(e as Error).message.split('\n')[0]}`);
  }
}

/** Every issue in a file's text, including a TOML syntax error as an error issue. */
export function checkTomlText(kind: ConfigKind, text: string, file: string): Issue[] {
  try {
    return CHECKS[kind](parseToml(text, file));
  } catch (e) {
    return [{ level: 'error', where: '', message: (e as Error).message.replace(`${file}: `, '') }];
  }
}

const warned = new Set<string>();

/** Throws one OctetError listing every error; prints each warning once per process. */
export function enforce(file: string, issues: Issue[]): void {
  const fmt = (i: Issue) => `${file}${i.where ? ` ${i.where}` : ''}: ${i.message}`;
  for (const i of issues) {
    if (i.level !== 'warn') continue;
    const line = fmt(i);
    if (!warned.has(line)) {
      warned.add(line);
      console.warn(`octet: warning: ${line}`);
    }
  }
  const errors = issues.filter((i) => i.level === 'error');
  if (errors.length) throw new OctetError(errors.map(fmt).join('\n'));
}

/** Reads, parses and validates a TOML file of the given kind. A missing file is an empty document. */
export function readConfigFile(kind: ConfigKind, file: string): Table {
  if (!existsSync(file)) return {};
  const doc = parseToml(readFileSync(file, 'utf8'), file);
  enforce(file, CHECKS[kind](doc));
  return doc;
}
