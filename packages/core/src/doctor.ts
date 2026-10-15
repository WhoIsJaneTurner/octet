import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkTomlText, parseToml } from './configcheck.ts';
import { expandHome, ghToken, loadIdentities, sshWhoAmI, type Identity } from './identity.ts';
import { daemonLockFile, pidAlive, readLock } from './lock.ts';
import { dbFile, identitiesFile, octetHome, projectsFile } from './paths.ts';
import { Store } from './store.ts';

/**
 * `octet doctor`: every check is a plain function that returns Check lines, and anything that
 * touches the outside world (PATH, ssh, gh) comes in through DoctorEnv so tests can fake it.
 * The CLI only formats the result.
 */

export type CheckLevel = 'ok' | 'warn' | 'fail';

export interface Check {
  level: CheckLevel;
  name: string;
  message: string;
}

export interface PlansResult {
  ok: boolean;
  checked: number;
  reason?: string;
}

export interface DoctorEnv {
  nodeVersion: string;
  /** Where a command is on PATH and what it reports for `--version`; null when it is not found. */
  tool(name: string): { path: string; version: string } | null;
  pathEnv: string;
  home: string;
  configFile: string;
  identitiesFile: string;
  projectsFile: string;
  dbFile: string;
  lockFile: string;
  /** What GitHub says about an identity: the user its SSH key logs in as, and whether a gh token exists. */
  identityProbe(id: Identity): { sshUser: string | null; token: boolean };
  /** Optional: re-hash stored plans against their files. Wired when the plan vault exists. */
  verifyPlans?: (store: Store) => PlansResult;
  alive?: (pid: number) => boolean;
}

const ok = (name: string, message: string): Check => ({ level: 'ok', name, message });
const warn = (name: string, message: string): Check => ({ level: 'warn', name, message });
const fail = (name: string, message: string): Check => ({ level: 'fail', name, message });

export const MIN_NODE_MAJOR = 24;

export function checkNode(version: string): Check {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  return major >= MIN_NODE_MAJOR
    ? ok('node', `v${version}`)
    : fail('node', `v${version}; Octet needs Node ${MIN_NODE_MAJOR} or newer`);
}

export function checkTool(name: string, env: Pick<DoctorEnv, 'tool'>, hint: string): Check {
  const t = env.tool(name);
  return t ? ok(name, `${t.version} (${t.path})`) : fail(name, `not found on PATH. ${hint}`);
}

/** The `identity doctor` checks, as data. */
export function checkIdentity(id: Identity, probe: DoctorEnv['identityProbe']): Check[] {
  const out: Check[] = [];
  const name = `identity ${id.id}`;
  if (!existsSync(id.sshKey)) out.push(fail(name, `ssh key not found at ${id.sshKey}`));
  const { sshUser, token } = probe(id);
  const sshOk = sshUser?.toLowerCase() === id.ghUser.toLowerCase();
  out.push(sshOk && token
    ? ok(name, `ssh=${sshUser}, gh token present`)
    : fail(name, `ssh=${sshUser ?? 'no auth (offline, or the key is not registered)'} (want ${id.ghUser}), gh token=${token ? 'yes' : 'no'}${token ? '' : `; run: gh auth login`}`));
  if (id.signingKey && !existsSync(id.signingKey)) out.push(fail(name, `signing_key not found at ${id.signingKey}`));
  return out;
}

function fileIssues(kind: 'config' | 'projects' | 'identities', file: string, label: string): Check[] {
  if (!existsSync(file)) {
    if (kind === 'config') return [ok(label, `${file} not present; defaults apply`)];
    if (kind === 'projects') return [warn(label, `${file} not found; add a project with: octet project add <name> <path> --identity <id>`)];
    return [fail(label, `${file} not found. Copy identities.example.toml there and edit it`)];
  }
  const issues = checkTomlText(kind, readFileSync(file, 'utf8'), file);
  if (!issues.length) return [ok(label, file)];
  return issues.map((i) => (i.level === 'error' ? fail : warn)(label, `${i.where ? `${i.where}: ` : ''}${i.message}`));
}

/** A directory we could write into: it, or its nearest existing parent when it will be created. */
function writableTarget(dir: string): { ok: boolean; exists: boolean } {
  let d = resolve(dir);
  const exists = existsSync(d);
  while (!existsSync(d) && dirname(d) !== d) d = dirname(d);
  try {
    accessSync(d, constants.W_OK);
    return { ok: statSync(d).isDirectory(), exists };
  } catch {
    return { ok: false, exists };
  }
}

export function checkProjects(file: string, identities: Identity[]): Check[] {
  if (!existsSync(file)) return [];
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(readFileSync(file, 'utf8'), file);
  } catch {
    return []; // already reported by the file check
  }
  const out: Check[] = [];
  const projects = (doc.projects ?? {}) as Record<string, Record<string, unknown>>;
  if (!Object.keys(projects).length) out.push(warn('projects', 'none configured. Add one: octet project add <name> <path> --identity <id>'));
  for (const [name, t] of Object.entries(projects)) {
    const label = `project ${name}`;
    if (typeof t.path !== 'string' || typeof t.identity !== 'string') {
      out.push(fail(label, 'needs both "path" and "identity"'));
      continue;
    }
    const path = resolve(expandHome(t.path));
    const problems: string[] = [];
    if (!existsSync(path)) problems.push(`path does not exist: ${path}`);
    else if (!existsSync(join(path, '.git'))) problems.push(`${path} is not a git repository`);
    if (!identities.some((i) => i.id === t.identity)) problems.push(`unknown identity "${t.identity}"`);
    if (typeof t.vault === 'string') {
      const vault = resolve(expandHome(t.vault));
      const w = writableTarget(vault);
      if (!w.ok) problems.push(`vault ${vault} is not writable`);
    }
    out.push(problems.length ? fail(label, problems.join('; ')) : ok(label, `${path} as ${t.identity}`));
  }
  return out;
}

export function checkDatabase(env: Pick<DoctorEnv, 'dbFile' | 'verifyPlans'>): Check[] {
  const file = env.dbFile;
  if (!existsSync(file)) return [warn('database', `${file} does not exist yet; it is created on first use`)];
  const out: Check[] = [];
  const raw = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = raw.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
    const bad = rows.map((r) => r.integrity_check).filter((m) => m !== 'ok');
    out.push(bad.length ? fail('database', `integrity_check: ${bad.slice(0, 3).join('; ')}`) : ok('database', `integrity_check ok (${file})`));
    const hasTable = raw.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'").get();
    const userVersion = (raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (hasTable) {
      const v = raw.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null };
      out.push(ok('schema', `version ${v.v ?? 0}`));
    } else if (userVersion > 0) {
      out.push(ok('schema', `user_version ${userVersion}`));
    } else {
      out.push(ok('schema', 'unversioned (applied ad hoc; no schema_version table yet)'));
    }
  } finally {
    raw.close();
  }
  if (out[0]?.level === 'fail') return out; // do not run further queries on a damaged file
  const store = new Store(file);
  try {
    const c = store.verifyChain();
    out.push(c.ok ? ok('audit chain', `${c.checked} events, head ${c.head.slice(0, 12) || '(empty)'}`)
      : fail('audit chain', `broken at event ${String(c.brokenAt)}: ${String(c.reason)}`));
    if (env.verifyPlans) {
      const p = env.verifyPlans(store);
      out.push(p.ok ? ok('plans', `${p.checked} plan hashes match`) : fail('plans', p.reason ?? 'plan hash mismatch'));
    } else {
      out.push(ok('plans', 'skipped: no plan verifier wired in this build'));
    }
  } finally {
    store.close();
  }
  return out;
}

export function checkPath(env: Pick<DoctorEnv, 'pathEnv' | 'home'>): Check {
  const bin = join(env.home, '.local', 'bin');
  const dirs = env.pathEnv.split(delimiter).map((d) => d.replace(/\/+$/, ''));
  return dirs.includes(bin)
    ? ok('PATH', `${bin} is on PATH`)
    : warn('PATH', `${bin} is not on PATH. Run: octet install   (it prints the line to add)`);
}

export function checkDaemon(env: Pick<DoctorEnv, 'lockFile' | 'alive'>): Check {
  const held = readLock(env.lockFile);
  if (!held) return ok('daemon', 'not running');
  return (env.alive ?? pidAlive)(held.pid)
    ? ok('daemon', `running, pid ${held.pid}${held.port ? `, http://127.0.0.1:${held.port}/` : ''}`)
    : warn('daemon', `stale lock from pid ${held.pid}, which is gone; the next daemon start takes it over`);
}

/** Runs every check. Never throws: a check that blows up becomes a FAIL line. */
export function runDoctor(env: DoctorEnv): Check[] {
  const out: Check[] = [];
  const guard = (name: string, fn: () => Check[]) => {
    try { out.push(...fn()); } catch (e) { out.push(fail(name, (e as Error).message)); }
  };
  out.push(checkNode(env.nodeVersion));
  out.push(checkTool('git', env, 'Install Xcode command line tools or git.'));
  out.push(checkTool('gh', env, 'Install the GitHub CLI: brew install gh'));
  out.push(checkTool('claude', env, 'Install Claude Code.'));
  out.push(checkPath(env));

  guard('config.toml', () => fileIssues('config', env.configFile, 'config.toml'));
  guard('projects.toml', () => fileIssues('projects', env.projectsFile, 'projects.toml'));
  guard('identities.toml', () => fileIssues('identities', env.identitiesFile, 'identities.toml'));

  let identities: Identity[] = [];
  guard('identities', () => {
    if (!existsSync(env.identitiesFile)) return [];
    identities = loadIdentities(env.identitiesFile);
    return identities.length ? identities.flatMap((i) => checkIdentity(i, env.identityProbe)) : [warn('identities', 'none configured')];
  });
  guard('projects', () => checkProjects(env.projectsFile, identities));
  guard('database', () => checkDatabase(env));
  guard('daemon', () => [checkDaemon(env)]);
  return out;
}

function realTool(name: string, pathEnv: string): { path: string; version: string } | null {
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    const path = join(dir, name);
    try {
      accessSync(path, constants.X_OK);
      if (statSync(path).isDirectory()) continue;
    } catch { continue; }
    try {
      const out = execFileSync(path, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
      return { path, version: out.split('\n')[0]!.trim() || 'unknown version' };
    } catch {
      return { path, version: 'version unknown' };
    }
  }
  return null;
}

/** The real machine. Tests build a DoctorEnv by hand instead. */
export function realDoctorEnv(overrides: Partial<DoctorEnv> = {}): DoctorEnv {
  const pathEnv = process.env.PATH ?? '';
  return {
    nodeVersion: process.versions.node,
    tool: (n) => realTool(n, pathEnv),
    pathEnv,
    home: homedir(),
    configFile: join(octetHome(), 'config.toml'),
    identitiesFile: identitiesFile(),
    projectsFile: projectsFile(),
    dbFile: dbFile(),
    lockFile: daemonLockFile(),
    identityProbe: (id) => {
      let token = true;
      try { ghToken(id); } catch { token = false; }
      return { sshUser: sshWhoAmI(id), token };
    },
    ...overrides,
  };
}
