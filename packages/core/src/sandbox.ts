import { execFile, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { parse } from 'smol-toml';
import { OctetError } from './errors.ts';
import type { Env } from './git.ts';
import { startNetProxy, type NetProxy } from './netproxy.ts';
import { dataHome, octetHome } from './paths.ts';
import type { RunRequest } from './runner.ts';

/**
 * Builder sandbox: an allow-list around the whole agent process, not just its shell tool.
 *
 * Decision (hardening-and-gaps.md section 1, "As built"): Claude Code's own sandbox covers only the
 * Bash tool and leaves reads open (~/.ssh included), and its Read/Edit/Write tools, MCP servers and
 * hooks run outside it. So Octet wraps the whole `claude` process in a macOS Seatbelt profile
 * (`sandbox-exec`) that denies everything and then allows only what the run needs, and routes the
 * network through a host allow-list proxy.
 */
export type SandboxMode = 'off' | 'auto' | 'required';

export interface SandboxConfig {
  mode: SandboxMode;
  /** Hosts the agent may reach, on top of the ones Claude Code itself needs. `*.example.com` allowed. */
  allowHosts: string[];
  /** Extra directories the agent may read (toolchains outside the usual places). */
  extraReadPaths: string[];
  /** Extra directories the agent may write (build caches). Use sparingly. */
  extraWritePaths: string[];
  /** Kill the run when its processes use more than this many MB resident. 0 = no ceiling. */
  memoryMb: number;
}

/** Hosts Claude Code needs to authenticate and call the model. Always allowed. */
export const CLAUDE_HOSTS = ['api.anthropic.com', 'platform.claude.com', 'console.anthropic.com'];

/** `auto`: verified end to end with a real `claude` login on macOS (see hardening-and-gaps.md section 1, "As built"). */
export const DEFAULT_SANDBOX: SandboxConfig = { mode: 'auto', allowHosts: [], extraReadPaths: [], extraWritePaths: [], memoryMb: 4096 };

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

const expand = (p: string): string => (p === '~' || p.startsWith('~/') ? homedir() + p.slice(1) : p);

/** Reads `[sandbox]` from config.toml. Missing file or keys use defaults; an unknown mode is an error, never "off". */
export function loadSandbox(file: string = join(octetHome(), 'config.toml')): SandboxConfig {
  if (!existsSync(file)) return { ...DEFAULT_SANDBOX };
  const s = (parse(readFileSync(file, 'utf8')) as { sandbox?: Record<string, unknown> }).sandbox ?? {};
  const mode = s.mode ?? DEFAULT_SANDBOX.mode;
  if (mode !== 'off' && mode !== 'auto' && mode !== 'required') {
    throw new OctetError(`config.toml [sandbox] mode must be "off", "auto" or "required", not ${JSON.stringify(mode)}`);
  }
  const mem = s.memory_mb;
  return {
    mode,
    allowHosts: strings(s.allow_hosts),
    extraReadPaths: strings(s.extra_read_paths).map(expand),
    extraWritePaths: strings(s.extra_write_paths).map(expand),
    memoryMb: typeof mem === 'number' && Number.isInteger(mem) && mem >= 0 ? mem : DEFAULT_SANDBOX.memoryMb,
  };
}

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
let probed: boolean | undefined;

/** Whether `sandbox-exec` exists and can apply a profile here (it cannot from inside another sandbox). */
export function sandboxAvailable(): boolean {
  if (probed === undefined) {
    probed = process.platform === 'darwin' && existsSync(SANDBOX_EXEC) &&
      spawnSync(SANDBOX_EXEC, ['-p', '(version 1)(allow default)', '/usr/bin/true'], { stdio: 'ignore' }).status === 0;
  }
  return probed;
}

/** Test hook: pretend the sandbox is (un)available; `undefined` goes back to probing. */
export function forceSandboxAvailability(available: boolean | undefined): void { probed = available; }

// ---------------------------------------------------------------------------------------------
// Profile

const q = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
/** Escapes a path for an SBPL regex with character classes, because backslash escapes do not survive SBPL quoting. */
const reEsc = (s: string): string => {
  if (/[\\^[\]"]/.test(s)) throw new OctetError(`Sandbox cannot express this path in a profile: ${s}`);
  return s.replace(/[.*+?${}()|]/g, '[$&]');
};

const env0Home = (env: Env): string => env.HOME || homedir();

const real = (p: string): string => { try { return realpathSync(p); } catch { return resolve(p); } };

export interface GitPaths {
  /** The worktree's private git dir (`<repo>/.git/worktrees/<name>`), or `.git` for a plain checkout. */
  gitDir: string;
  /** The repository's shared git dir (objects, refs, hooks, config). */
  commonDir: string;
  /** `refs/heads/...` the worktree has checked out, if on a branch. */
  branchRef?: string;
}

/** Finds the git directories behind a worktree. Null when `dir` is not a checkout. */
export function gitPaths(dir: string): GitPaths | null {
  const dotGit = join(dir, '.git');
  try {
    let gitDir = dotGit;
    if (statSync(dotGit).isFile()) {
      const m = readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m);
      if (!m) return null;
      gitDir = resolve(dir, m[1]!.trim());
    }
    gitDir = real(gitDir);
    let commonDir = gitDir;
    const c = join(gitDir, 'commondir');
    if (existsSync(c)) commonDir = real(resolve(gitDir, readFileSync(c, 'utf8').trim()));
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').match(/^ref:\s*(refs\/heads\/\S+)/m);
    return { gitDir, commonDir, ...(head ? { branchRef: head[1]! } : {}) };
  } catch {
    return null;
  }
}

export interface ProfileInput {
  /** Directories and files the agent may read. */
  read: string[];
  /** Directories and files the agent may read and write. */
  write: string[];
  /** Exact files (or file-name regexes, already escaped) in a writable area that stay read-only. */
  protect: string[];
  /** Regexes for single files that may be written (a branch ref and its lock file). */
  writeRegex: string[];
  /** Never readable or writable, whatever else says so. Last word. */
  deny: string[];
  /** Writable but not readable (the agent's own transcripts: it may add to them, not read other sessions'). */
  writeOnly?: string[];
  /** Loopback port of the allow-list proxy; the only network destination. */
  proxyPort?: number;
  /** Stamped on every denial in the system log, so one run's denials can be found afterwards. */
  tag?: string;
}

/**
 * Seatbelt (SBPL) profile text. Default deny; later rules win in SBPL, so the explicit denies come
 * last. Paths must already be real paths (Seatbelt does not follow symlinks in filters).
 */
export function buildProfile(p: ProfileInput): string {
  const msg = p.tag ? `(with message ${q(p.tag)})` : '';
  const sub = (xs: string[]) => xs.map((x) => `(subpath ${q(x)})`).join(' ');
  const lines = [
    '(version 1)',
    p.tag ? `(deny default (with message ${q(p.tag)}))` : '(deny default)',
    // Process basics: run programs, fork, signal itself, ask the kernel harmless questions.
    '(allow process-exec) (allow process-fork) (allow signal (target self)) (allow sysctl-read)',
    '(allow system-fsctl) (allow ipc-posix-shm) (allow ipc-posix-sem)',
    '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.logd")',
    '  (global-name "com.apple.system.notification_center") (global-name "com.apple.SecurityServer")',
    '  (global-name "com.apple.trustd.agent") (global-name "com.apple.system.logger")',
    '  (global-name "com.apple.CoreServices.coreservicesd") (global-name "com.apple.lsd.mapdb")',
    '  (global-name "com.apple.secd") (global-name "com.apple.cfprefsd.daemon") (global-name "com.apple.cfprefsd.agent")',
    '  (global-name "com.apple.FSEvents") (global-name "com.apple.coreservices.launchservicesd"))',
    // Existence and size of any path may be seen (programs stat every parent directory); contents may not.
    '(allow file-read-metadata)',
    '(allow file-read* (literal "/") (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random") (literal "/dev/zero") (literal "/dev/tty"))',
    '(allow file-write* (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper"))',
  ];
  // An allow rule with no filter allows everything, so empty lists must emit nothing.
  if (p.read.length) lines.push(`(allow file-read* ${sub(p.read)})`);
  if (p.write.length) lines.push(`(allow file-read* file-write* ${sub(p.write)})`);
  if (p.writeRegex.length) lines.push(`(allow file-write* file-read* ${p.writeRegex.map((r) => `(regex #${q(r)})`).join(' ')})`);
  if (p.proxyPort) lines.push(`(allow network-outbound (remote ip ${q(`localhost:${p.proxyPort}`)}))`);
  // Closed last, so a broad extra path cannot re-open a secret.
  if (p.protect.length) lines.push(`(deny file-write* ${msg} ${p.protect.map((x) => (x.startsWith('^') ? `(regex #${q(x)})` : `(literal ${q(x)})`)).join(' ')})`);
  if (p.writeOnly?.length) lines.push(`(deny file-read-data ${msg} ${sub(p.writeOnly)})`);
  if (p.deny.length) lines.push(`(deny file-read* file-write* ${msg} ${sub(p.deny)})`);
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------
// Environment

/** Variables the agent itself needs to reach the model. Anything else that looks like a secret goes. */
const KEEP_AUTH = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']);
const SECRETISH = /(TOKEN|SECRET|PASSW|CREDENTIAL|API_?KEY|PRIVATE_?KEY|_KEY$|SESSION|COOKIE|AUTH(?!OR))/i;
const DROP_EXACT = new Set(['SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'SSH_ASKPASS', 'OCTET_HOME', 'OCTET_DATA',
  'GNUPGHOME', 'KUBECONFIG', 'DOCKER_CONFIG', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH']);

/** The environment an agent gets: the caller's, minus anything that looks like a credential or points at Octet's state. */
export function scrubEnv(env: Env): Env {
  const out: Env = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || DROP_EXACT.has(k)) continue;
    if (k.startsWith('AWS_') || k.startsWith('OCTET_') && k !== 'OCTET_IDENTITY') continue;
    if (!KEEP_AUTH.has(k) && SECRETISH.test(k)) continue;
    out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Preparing a run

export type SandboxEvent = (kind: string, data: Record<string, unknown>) => void;

/** What a caller passes on `RunRequest.sandbox`. */
export interface SandboxRequest {
  /** Overrides config.toml (tests, or a bead that needs more hosts). */
  config?: SandboxConfig;
  /** Receives `sandbox.*` events; the orchestrator writes them to the audit log. */
  onEvent?: SandboxEvent;
}

export interface PreparedSandbox {
  command: string;
  args: string[];
  env: Env;
  profile: string;
  memoryMb: number;
  /** Stops the proxy and removes the scratch directory. */
  dispose(): Promise<void>;
  /** After the run: reports what the sandbox refused (a `sandbox.denied` event), then disposes. */
  finish(): Promise<void>;
}

function onPath(name: string, pathVar: string | undefined): string | undefined {
  for (const d of (pathVar ?? '').split(delimiter)) {
    if (d && existsSync(join(d, name))) return join(d, name);
  }
  return undefined;
}

/** Is `p` the home directory, or above it? Granting that would grant everything below. */
const coversHome = (p: string, home: string): boolean => home === p || home.startsWith(p.endsWith('/') ? p : `${p}/`);

/**
 * Wraps `command args` in the sandbox for this request, or returns undefined to run unwrapped
 * (mode `off`, or `auto` where the sandbox is unavailable, which is reported through `onEvent`).
 * `required` throws instead of ever running unprotected.
 */
export async function prepareSandbox(req: RunRequest, command: string, args: string[], fallback?: SandboxConfig): Promise<PreparedSandbox | undefined> {
  const cfg = req.sandbox?.config ?? fallback ?? loadSandbox();
  const emit = req.sandbox?.onEvent ?? (() => {});
  if (cfg.mode === 'off') return undefined;
  if (!sandboxAvailable()) {
    if (cfg.mode === 'required') {
      throw new OctetError('Sandbox is required (config.toml [sandbox] mode = "required") but sandbox-exec is not available here. Refusing to run the agent unprotected.');
    }
    emit('sandbox.unavailable', { seat: req.seat, mode: cfg.mode, message: 'sandbox-exec is not available; the agent runs WITHOUT a sandbox' });
    return undefined;
  }

  const home = real(env0Home(req.env));
  const scratch = real(mkdtempSync(join(tmpdir(), 'octet-scratch-')));
  const env = scrubEnv(req.env);
  const cwd = real(req.cwd);
  const git = gitPaths(cwd);

  // Toolchain: every PATH directory, the prefix of the node running us, and the package claude is installed in.
  // Tools installed elsewhere under the home directory (cargo, pyenv, ...) need `extra_read_paths`.
  const read = new Set<string>(['/usr', '/bin', '/sbin', '/System', '/Library', '/opt/homebrew', '/private/etc', '/private/var/db/timezone',
    '/private/var/db/dyld', '/private/var/db/icu', '/dev/fd', '/Applications/Xcode.app/Contents/Developer']);
  const tool = (dir: string) => {
    const d = real(dir);
    if (existsSync(d) && !coversHome(d, home)) read.add(d);
  };
  for (const d of (env.PATH ?? '').split(delimiter)) if (d) tool(d);
  // node-style installs keep bin/ next to lib/ (npm, claude); take the whole prefix of the node that is running us.
  const nodePrefix = dirname(dirname(real(process.execPath)));
  if (!coversHome(nodePrefix, home)) read.add(nodePrefix);
  const claudeBin = onPath(command, env.PATH);
  if (claudeBin && real(claudeBin) !== claudeBin) {
    // Installed as a symlink into a package (npm, nvm): the package directory holds the binary and what it loads.
    const d = dirname(real(claudeBin));
    for (const x of [d, dirname(d)]) if (!coversHome(x, home)) read.add(x);
  }
  for (const p of cfg.extraReadPaths) read.add(real(p));

  const write = new Set<string>([scratch, ...cfg.extraWritePaths.map(real)]);
  const protect: string[] = [];
  const writeRegex: string[] = [];
  if (req.readOnly) read.add(cwd);
  else write.add(cwd);
  if (git) {
    read.add(git.commonDir);
    if (git.gitDir !== git.commonDir) read.add(git.gitDir);
    if (!req.readOnly && git.gitDir !== git.commonDir) {
      // A linked worktree gets enough git to stage and commit on its own branch; never hooks, config, other branches, or a change of HEAD (git only locks HEAD to commit).
      write.add(join(git.commonDir, 'objects'));
      write.add(git.gitDir);
      protect.push(join(git.gitDir, 'HEAD'), join(git.gitDir, 'commondir'), join(git.gitDir, 'gitdir'),
        join(git.gitDir, 'config'), join(git.gitDir, 'config.worktree'), `^${reEsc(join(git.gitDir, 'hooks'))}(/|$)`, join(cwd, '.git'));
      if (git.branchRef) {
        for (const base of [join(git.commonDir, git.branchRef), join(git.commonDir, 'logs', git.branchRef)]) writeRegex.push(`^${reEsc(base)}([.]lock)?$`);
      }
    } else if (!req.readOnly) {
      // A plain checkout has its .git inside the writable tree: keep what git runs or trusts out of reach.
      protect.push(join(git.gitDir, 'HEAD'), join(git.gitDir, 'config'), `^${reEsc(join(git.gitDir, 'hooks'))}(/|$)`);
    }
  }

  // The agent's own state and login. ~/.claude holds transcripts, so this is a known leak (see docs).
  write.add(join(home, '.claude'));
  const writeOnly = ['projects', 'history.jsonl', 'file-history', 'sessions', 'session-env', 'backups', 'ide'].map((n) => join(home, '.claude', n));
  writeRegex.push(`^${reEsc(join(home, '.claude.json'))}([.].*)?$`);
  // Login lives in the keychain: Claude Code needs the keychain files readable and the Security server reachable (verified: it says "Not logged in" without either).
  read.add(join(home, 'Library', 'Keychains'));

  const deny = [octetHome(), dataHome(), join(home, '.ssh'), join(home, '.gnupg'), join(home, '.aws'), join(home, '.config', 'gh'),
    join(home, '.config', 'octet'), join(home, '.local', 'share', 'octet'), join(home, '.npmrc'), join(home, '.netrc'), join(home, '.claude', '.credentials.json')].map(real);

  // Network: loopback proxy only, started fresh for this run.
  const hosts = [...CLAUDE_HOSTS, ...cfg.allowHosts];
  const proxy: NetProxy = await startNetProxy({
    allowHosts: hosts,
    onDeny: (host, reason) => emit('sandbox.network_denied', { seat: req.seat, host, reason }),
  });

  const tag = `octetrun-${randomBytes(6).toString('hex')}`;
  const since = new Date(Date.now() - 1000);
  const profile = buildProfile({ read: [...read], write: [...write], protect, writeRegex, deny, writeOnly, proxyPort: proxy.port, tag });
  const url = `http://127.0.0.1:${proxy.port}`;
  Object.assign(env, {
    HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url, ALL_PROXY: url, NO_PROXY: '', no_proxy: '',
    TMPDIR: `${scratch}/`, CLAUDE_CODE_TMPDIR: scratch, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
  });
  emit('sandbox.started', { seat: req.seat, cwd, readOnly: !!req.readOnly, hosts, memoryMb: cfg.memoryMb, scratch });
  const dispose = async () => { await proxy.close(); rmSync(scratch, { recursive: true, force: true }); };
  return {
    command: SANDBOX_EXEC, args: ['-p', profile, command, ...args], env, profile, memoryMb: cfg.memoryMb, dispose,
    finish: async () => {
      const denied = await collectDenials(tag, since);
      if (denied.length) emit('sandbox.denied', { seat: req.seat, count: denied.reduce((n, d) => n + d.count, 0), denials: denied.slice(0, 100) });
      await dispose();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Denials

export interface Denial { process: string; operation: string; target: string; count: number }

const localTime = (d: Date): string => {
  const z = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
};

/** Parses `log show --style compact` Sandbox lines. Exported for tests. */
export function parseDenials(text: string): Denial[] {
  const seen = new Map<string, Denial>();
  for (const line of text.split('\n')) {
    const m = line.match(/(?:(\d+) duplicate reports? for )?Sandbox: (\S+?)\(\d+\) deny\(\d+\) (\S+)(?: (.*))?$/);
    if (!m) continue;
    const [, dup, process, operation, target = ''] = m;
    const key = `${process} ${operation} ${target}`;
    const d = seen.get(key) ?? { process: process!, operation: operation!, target, count: 0 };
    d.count += 1 + Number(dup ?? 0);
    seen.set(key, d);
  }
  return [...seen.values()];
}

/**
 * What the kernel refused this run, from the unified log (macOS keeps the profile's message tag on
 * each denial). The log lags by a moment, so this waits briefly. Best effort: empty if `log` is unavailable.
 */
export function collectDenials(tag: string, since: Date, settleMs = 1500): Promise<Denial[]> {
  return new Promise((done) => {
    setTimeout(() => {
      execFile('/usr/bin/log', ['show', '--start', localTime(since), '--style', 'compact', '--predicate',
        `sender == "Sandbox" AND eventMessage CONTAINS "${tag}"`], { maxBuffer: 8_000_000, timeout: 20_000 }, (err, out) => {
        done(err ? [] : parseDenials(out));
      });
    }, settleMs);
  });
}

// ---------------------------------------------------------------------------------------------
// Memory ceiling

/** Resident MB in use by a process group, via `ps`. */
export function groupRssMb(pgid: number): Promise<number> {
  return new Promise((done) => {
    execFile('ps', ['-A', '-o', 'pgid=,rss='], (err, out) => {
      if (err) return done(0);
      let kb = 0;
      for (const line of out.split('\n')) {
        const [g, r] = line.trim().split(/\s+/).map(Number);
        if (g === pgid && r) kb += r;
      }
      done(kb / 1024);
    });
  });
}

/** Polls a process group's memory; calls `onExceed` once if it passes `limitMb`. macOS has no enforceable per-process memory rlimit, so this is a watchdog. */
export function watchMemory(pgid: number, limitMb: number, onExceed: (mb: number) => void, everyMs = 2000): () => void {
  if (limitMb <= 0) return () => {};
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    const mb = await groupRssMb(pgid);
    if (stopped) return;
    if (mb > limitMb) { stopped = true; onExceed(mb); }
  };
  const timer = setInterval(() => { void tick(); }, everyMs);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}

/** Helper for the orchestrator: the `sandbox` field of a RunRequest that logs events against a goal, bead and seat. */
export function sandboxFor(
  ctx: { store: { log(e: { kind: string; goalId?: string; beadId?: string; seat?: string; data?: unknown }): void }; sandbox?: SandboxConfig },
  who: { goalId?: string; beadId?: string; seat: string },
): { sandbox: SandboxRequest } {
  return {
    sandbox: {
      ...(ctx.sandbox ? { config: ctx.sandbox } : {}),
      onEvent: (kind, data) => ctx.store.log({
        kind, seat: who.seat, data, ...(who.goalId ? { goalId: who.goalId } : {}), ...(who.beadId ? { beadId: who.beadId } : {}),
      }),
    },
  };
}
