import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  addBead, buildProfile, ClaudeCodeRunner, createGoal, DEFAULT_SANDBOX, forceSandboxAvailability, gitPaths, hostAllowed, loadSandbox,
  parseDenials, parseIdentities, runBead, sandboxAvailable, scrubEnv, startNetProxy, Store, type Ctx, type SandboxConfig,
} from '../src/index.ts';

const have = sandboxAvailable();
const skip = have ? false : 'sandbox-exec is not available here';

// ---------------------------------------------------------------------------------------------
// Fixture: a fake HOME full of canaries, a repo with two worktrees, and a "hostile engineer" as a stand-in `claude`.

const SECRET = 'CANARY-do-not-read-4f1c';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'octet-sbx-')));
  const home = join(root, 'home');
  const dirs = ['.ssh', '.config/octet', '.local/share/octet', '.claude/projects'];
  for (const d of dirs) mkdirSync(join(home, d), { recursive: true });
  const canary = {
    ssh: join(home, '.ssh', 'id_canary'),
    cfg: join(home, '.config/octet', 'identities.toml'),
    db: join(home, '.local/share/octet', 'octet.db'),
    transcript: join(home, '.claude/projects', 'other-session.jsonl'),
  };
  for (const f of Object.values(canary)) writeFileSync(f, SECRET);

  const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: 'pipe' });
  const repo = join(root, 'repo');
  mkdirSync(repo);
  g(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), SECRET);
  g(repo, 'add', '.');
  g(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  const wt = join(repo, '.octet', 'worktrees', 'bead-a');
  const other = join(repo, '.octet', 'worktrees', 'bead-b');
  g(repo, 'worktree', 'add', '-q', '-b', 'octet/goal/bead-a', wt);
  g(repo, 'worktree', 'add', '-q', '-b', 'octet/goal/bead-b', other);
  writeFileSync(join(other, 'file.txt'), SECRET);
  const otherRepo = join(root, 'other-repo');
  mkdirSync(otherRepo);
  writeFileSync(join(otherRepo, 'file.txt'), SECRET);
  const outside = join(root, 'outside');
  mkdirSync(outside);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  return { root, home, canary, repo, wt, other, otherRepo, outside, bin, git: g, common: join(repo, '.git') };
}

type Fx = ReturnType<typeof fixture>;

const HOSTILE = `#!/bin/sh
. "$(dirname "$0")/targets.sh"
a() { n=$1; shift; if e=$("$@" 2>&1 >/dev/null); then echo "RESULT $n ALLOWED"; else echo "RESULT $n denied"; echo "WHY $n $e"; fi; }
cat_to() { n=$1; f=$2; if c=$(cat "$f" 2>/dev/null); then echo "RESULT $n ALLOWED"; echo "LEAK $c"; else echo "RESULT $n denied"; fi; }
cat_to read_ssh "$T_SSH"
cat_to read_octet_config "$T_CFG"
cat_to read_octet_db "$T_DB"
cat_to read_other_transcript "$T_TRANSCRIPT"
cat_to read_other_worktree "$T_OTHERWT/file.txt"
cat_to read_other_repo "$T_OTHERREPO/file.txt"
cat_to read_repo_root "$T_REPO/a.txt"
a list_ssh ls "$HOME/.ssh"
a list_other_worktree ls "$T_OTHERWT"
a write_outside sh -c 'echo pwn > "$T_OUTSIDE/pwn.txt"'
a write_other_worktree sh -c 'echo pwn > "$T_OTHERWT/pwn.txt"'
a write_home sh -c 'echo pwn > "$HOME/pwn.txt"'
a write_ssh sh -c 'echo pwn >> "$T_SSH"'
a write_git_hook sh -c 'echo pwn > "$T_COMMON/hooks/pre-commit"'
a write_git_config sh -c 'echo pwn >> "$T_COMMON/config"'
a write_other_branch sh -c 'echo 0000000000000000000000000000000000000000 > "$T_COMMON/refs/heads/main"'
a switch_branch git checkout -q octet/goal/bead-b
a write_head sh -c 'echo "ref: refs/heads/main" > "$T_COMMON/worktrees/bead-a/HEAD"'
a write_dotgit_pointer sh -c 'echo "gitdir: /tmp" > .git'
a net_loopback_direct curl -fsS --noproxy '*' --max-time 3 "http://127.0.0.1:$T_PORT/"
a net_loopback_via_proxy curl -fsS --max-time 3 "http://127.0.0.1:$T_PORT/"
a net_blocked_host curl -fsS --max-time 3 https://evil.example.com/
a net_direct_ip curl -fsS --noproxy '*' --max-time 3 http://93.184.216.34/
a control_write_worktree sh -c 'echo ok > inside.txt'
a control_write_scratch sh -c 'echo ok > "$TMPDIR/scratch.txt"'
a control_git_add git add inside.txt
a control_git_commit git -c user.name=t -c user.email=t@t commit -q -m inside
env | sed 's/^/ENV /'
`;

/** Where the hostile script aims, as shell variables in a file next to it (not in the environment, which is under test). */
function installHostile(fx: Fx, port: number, script = HOSTILE): void {
  const t = { T_SSH: fx.canary.ssh, T_CFG: fx.canary.cfg, T_DB: fx.canary.db, T_TRANSCRIPT: fx.canary.transcript, T_OTHERWT: fx.other,
    T_OTHERREPO: fx.otherRepo, T_REPO: fx.repo, T_OUTSIDE: fx.outside, T_COMMON: fx.common, T_PORT: String(port) };
  writeFileSync(join(fx.bin, 'targets.sh'), Object.entries(t).map(([k, v]) => `${k}="${v}"`).join('\n') + '\n');
  writeFileSync(join(fx.bin, 'claude'), script, { mode: 0o755 });
}

function hostileEnv(fx: Fx): NodeJS.ProcessEnv {
  return {
    PATH: `${fx.bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: fx.home, GIT_CONFIG_GLOBAL: '/dev/null',
    // Everything below must not reach the agent.
    GH_TOKEN: 'ghp_planted', GITHUB_TOKEN: 'ghp_planted2', AWS_SECRET_ACCESS_KEY: 'aws_planted', SSH_AUTH_SOCK: '/tmp/agent.sock',
    NPM_TOKEN: 'npm_planted', OCTET_HOME: join(fx.home, '.config/octet'), OCTET_DATA: join(fx.home, '.local/share/octet'),
    GIT_SSH_COMMAND: `ssh -i ${fx.canary.ssh}`, OCTET_IDENTITY: 'wijt',
  };
}

const cfg = (over: Partial<SandboxConfig> = {}): SandboxConfig => ({ ...DEFAULT_SANDBOX, mode: 'required', memoryMb: 0, ...over });

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

function localServer(): Promise<{ port: number; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => { hits.push(req.url ?? ''); res.end('hello'); });
  servers.push(server);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as { port: number }).port, hits })));
}

// ---------------------------------------------------------------------------------------------
// The hostile engineer

test('hostile engineer: every read, write and network attempt outside the worktree fails, and is recorded', { skip }, async () => {
  const fx = fixture();
  const { port, hits } = await localServer();
  installHostile(fx, port);
  const before = Object.fromEntries(Object.entries(fx.canary).map(([k, f]) => [k, statSync(f).mtimeMs]));
  const events: Array<[string, Record<string, unknown>]> = [];
  const savedHome = process.env.OCTET_HOME;
  const savedData = process.env.OCTET_DATA;
  process.env.OCTET_HOME = join(fx.home, '.config/octet');
  process.env.OCTET_DATA = join(fx.home, '.local/share/octet');
  let res;
  try {
    res = await new ClaudeCodeRunner().run({
      seat: 'engineer', cwd: fx.wt, prompt: 'go', systemPrompt: 'x', env: hostileEnv(fx), timeoutMs: 60_000,
      sandbox: { config: cfg(), onEvent: (k, d) => events.push([k, d]) },
    });
  } finally {
    if (savedHome === undefined) delete process.env.OCTET_HOME; else process.env.OCTET_HOME = savedHome;
    if (savedData === undefined) delete process.env.OCTET_DATA; else process.env.OCTET_DATA = savedData;
  }
  const result = (n: string) => res.output.match(new RegExp(`^RESULT ${n} (\\w+)$`, 'm'))?.[1];

  // Attacks fail.
  for (const n of ['read_ssh', 'read_octet_config', 'read_octet_db', 'read_other_transcript', 'read_other_worktree', 'read_other_repo',
    'read_repo_root', 'list_ssh', 'list_other_worktree', 'write_outside', 'write_other_worktree', 'write_home', 'write_ssh',
    'write_git_hook', 'write_git_config', 'write_other_branch', 'write_dotgit_pointer', 'write_head', 'switch_branch',
    'net_loopback_direct', 'net_loopback_via_proxy', 'net_blocked_host', 'net_direct_ip']) {
    assert.equal(result(n), 'denied', `${n} should be denied\n${res.output}`);
  }
  // Legitimate work still works, so a pass is not just "everything is broken".
  for (const n of ['control_write_worktree', 'control_write_scratch', 'control_git_add', 'control_git_commit']) {
    assert.equal(result(n), 'ALLOWED', `${n} should work\n${res.output}\n${JSON.stringify(events.filter(([k]) => k === 'sandbox.denied'))}`);
  }
  assert.equal(readFileSync(join(fx.wt, 'inside.txt'), 'utf8'), 'ok\n');
  assert.match(fx.git(fx.wt, 'log', '--format=%s', '-1').toString(), /inside/);

  // Nothing leaked and nothing changed.
  assert.ok(!res.output.includes(SECRET), 'a canary was read');
  assert.ok(!existsSync(join(fx.outside, 'pwn.txt')) && !existsSync(join(fx.other, 'pwn.txt')) && !existsSync(join(fx.home, 'pwn.txt')));
  for (const [k, f] of Object.entries(fx.canary)) {
    assert.equal(readFileSync(f, 'utf8'), SECRET, `${k} canary changed`);
    assert.equal(statSync(f).mtimeMs, before[k], `${k} canary touched`);
  }
  assert.ok(!readFileSync(join(fx.common, 'config'), 'utf8').includes('pwn'));
  assert.ok(!existsSync(join(fx.common, 'hooks', 'pre-commit')));
  assert.equal(readFileSync(join(fx.wt, '.git'), 'utf8').startsWith('gitdir: ' + fx.common), true);
  assert.equal(hits.length, 0, `the local server was reached: ${hits}`);

  // The attempts are on the audit trail.
  const kinds = events.map(([k]) => k);
  assert.ok(kinds.includes('sandbox.started'));
  const net = events.filter(([k]) => k === 'sandbox.network_denied').map(([, d]) => d.host);
  assert.ok(net.includes('evil.example.com'), `proxy refusal not recorded: ${JSON.stringify(events)}`);
  const denied = events.find(([k]) => k === 'sandbox.denied')?.[1] as { denials: Array<{ target: string }> } | undefined;
  assert.ok(denied, `no kernel denials recorded: ${JSON.stringify(kinds)}`);
  const targets = denied.denials.map((d) => d.target);
  for (const f of [fx.canary.ssh, fx.canary.db, fx.canary.cfg]) assert.ok(targets.includes(f), `denial for ${f} not recorded`);
});

test('the agent environment holds no tokens and no Octet paths', { skip }, async () => {
  const fx = fixture();
  installHostile(fx, 1);
  const env = hostileEnv(fx);
  const res = await new ClaudeCodeRunner().run({ seat: 'engineer', cwd: fx.wt, prompt: 'go', systemPrompt: 'x', env, timeoutMs: 60_000, sandbox: { config: cfg() } });
  const seen = Object.fromEntries(res.output.split('\n').filter((l) => l.startsWith('ENV ')).map((l) => l.slice(4)).map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1)]));
  assert.ok(seen.PATH, 'environment was not captured');
  for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'SSH_AUTH_SOCK', 'NPM_TOKEN', 'OCTET_HOME', 'OCTET_DATA', 'GIT_SSH_COMMAND']) {
    assert.equal(seen[k], undefined, `${k} reached the agent`);
  }
  const text = Object.entries(seen).map(([k, v]) => `${k}=${v}`).join('\n');
  for (const needle of ['planted', '.ssh', '.config/octet', '.local/share/octet']) assert.ok(!text.includes(needle), `environment mentions ${needle}`);
  assert.equal(seen.OCTET_IDENTITY, 'wijt'); // an identity name is not a secret and the commit hooks of other tools may want it
  assert.match(seen.HTTPS_PROXY ?? '', /^http:\/\/127\.0\.0\.1:\d+$/);
});

test('a reviewer (read-only) sandbox can read its worktree but write nothing there', { skip }, async () => {
  const fx = fixture();
  writeFileSync(join(fx.wt, 'seen.txt'), 'review me');
  writeFileSync(join(fx.bin, 'claude'), `#!/bin/sh
cat seen.txt && echo
if sh -c 'echo x > planted.txt' 2>/dev/null; then echo WROTE; else echo READONLY; fi
if sh -c 'echo x > "$TMPDIR/s.txt"' 2>/dev/null; then echo SCRATCH; fi
`, { mode: 0o755 });
  const res = await new ClaudeCodeRunner().run({ seat: 'reviewer', cwd: fx.wt, prompt: 'go', systemPrompt: 'x', env: { PATH: `${fx.bin}:/usr/bin:/bin`, HOME: fx.home }, readOnly: true, sandbox: { config: cfg() } });
  assert.match(res.output, /review me/);
  assert.match(res.output, /READONLY/);
  assert.match(res.output, /SCRATCH/);
  assert.ok(!existsSync(join(fx.wt, 'planted.txt')));
});

test('memory ceiling: a run that grows past it is killed and reported', { skip }, async () => {
  const fx = fixture();
  writeFileSync(join(fx.bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" -e "const b = Buffer.alloc(600 * 1024 * 1024, 1); setTimeout(() => console.log(b.length), 60000)"\n`, { mode: 0o755 });
  const events: string[] = [];
  const res = await new ClaudeCodeRunner().run({
    seat: 'engineer', cwd: fx.wt, prompt: 'go', systemPrompt: 'x', env: { PATH: `${fx.bin}:/usr/bin:/bin`, HOME: fx.home }, timeoutMs: 60_000,
    sandbox: { config: cfg({ memoryMb: 200 }), onEvent: (k) => events.push(k) },
  });
  assert.equal(res.memoryExceeded, true);
  assert.ok(res.durationMs < 30_000);
  assert.ok(events.includes('sandbox.memory_exceeded'));
});

// ---------------------------------------------------------------------------------------------
// Modes (these run everywhere)

test('required mode refuses to run the agent when the sandbox is unavailable, and never falls back', async () => {
  const fx = fixture();
  writeFileSync(join(fx.bin, 'claude'), `#!/bin/sh\ntouch "${join(fx.outside, 'ran')}"\n`, { mode: 0o755 });
  forceSandboxAvailability(false);
  try {
    await assert.rejects(
      new ClaudeCodeRunner().run({ seat: 'engineer', cwd: fx.wt, prompt: 'go', systemPrompt: 'x', env: { PATH: `${fx.bin}:/usr/bin:/bin` }, sandbox: { config: cfg() } }),
      /Sandbox is required/,
    );
    assert.ok(!existsSync(join(fx.outside, 'ran')), 'the agent ran unprotected');
  } finally { forceSandboxAvailability(undefined); }
});

test('auto mode runs unprotected when the sandbox is unavailable, and says so in an event; off mode is silent', async () => {
  const fx = fixture();
  writeFileSync(join(fx.bin, 'claude'), '#!/bin/sh\necho ran\n', { mode: 0o755 });
  const run = async (mode: 'auto' | 'off') => {
    const events: Array<[string, Record<string, unknown>]> = [];
    const res = await new ClaudeCodeRunner().run({
      seat: 'engineer', cwd: fx.wt, prompt: 'go', systemPrompt: 'x', env: { PATH: `${fx.bin}:/usr/bin:/bin` },
      sandbox: { config: cfg({ mode }), onEvent: (k, d) => events.push([k, d]) },
    });
    return { res, events };
  };
  forceSandboxAvailability(false);
  try {
    const auto = await run('auto');
    assert.match(auto.res.output, /ran/);
    assert.deepEqual(auto.events.map(([k]) => k), ['sandbox.unavailable']);
    assert.match(String(auto.events[0]![1].message), /WITHOUT a sandbox/);
    const off = await run('off');
    assert.match(off.res.output, /ran/);
    assert.deepEqual(off.events, []);
  } finally { forceSandboxAvailability(undefined); }
});

test('config.toml [sandbox] is parsed, with safe defaults and a hard error on a bad mode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'octet-cfg-'));
  const file = join(dir, 'config.toml');
  assert.deepEqual(loadSandbox(file), DEFAULT_SANDBOX);
  writeFileSync(file, '[sandbox]\nmode = "required"\nallow_hosts = ["registry.npmjs.org", "*.pypi.org"]\nextra_read_paths = ["/opt/tools"]\nextra_write_paths = ["/opt/cache"]\nmemory_mb = 2048\n');
  assert.deepEqual(loadSandbox(file), { mode: 'required', allowHosts: ['registry.npmjs.org', '*.pypi.org'], extraReadPaths: ['/opt/tools'], extraWritePaths: ['/opt/cache'], memoryMb: 2048 });
  writeFileSync(file, '[sandbox]\nmode = "yes"\n');
  assert.throws(() => loadSandbox(file), /mode must be/); // a typo must not silently mean "off"
  writeFileSync(file, '[limits]\nmax_engineers = 2\n');
  assert.equal(loadSandbox(file).mode, DEFAULT_SANDBOX.mode);
});

// ---------------------------------------------------------------------------------------------
// Pieces

test('scrubEnv drops credentials and Octet paths and keeps what tools need', () => {
  const out = scrubEnv({
    PATH: '/usr/bin', HOME: '/h', LANG: 'en_US.UTF-8', GH_TOKEN: 'x', GITHUB_TOKEN: 'x', NPM_TOKEN: 'x', MY_SECRET: 'x', DB_PASSWORD: 'x',
    AWS_PROFILE: 'x', SSH_AUTH_SOCK: 'x', OCTET_HOME: '/o', OCTET_DATA: '/d', GIT_SSH_COMMAND: 'ssh -i k', OCTET_IDENTITY: 'wijt',
    GIT_AUTHOR_NAME: 'Bot', ANTHROPIC_API_KEY: 'sk-agent-own', CLAUDE_CODE_OAUTH_TOKEN: 'own', STRIPE_API_KEY: 'x',
  });
  assert.deepEqual(Object.keys(out).sort(), ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GIT_AUTHOR_NAME', 'HOME', 'LANG', 'OCTET_IDENTITY', 'PATH']);
});

test('buildProfile: default deny, explicit denies last, and no empty allow that would open everything', () => {
  const p = buildProfile({ read: ['/usr'], write: [], protect: ['/w/.git'], writeRegex: [], deny: ['/h/.ssh'], proxyPort: 4000, tag: 'octetrun-x' });
  assert.match(p, /^\(version 1\)\n\(deny default \(with message "octetrun-x"\)\)/);
  assert.ok(!/\(allow file-read\* file-write\* \)/.test(p));
  assert.ok(p.indexOf('(deny file-read* file-write* (with message "octetrun-x") (subpath "/h/.ssh"))') > p.indexOf('(allow file-read* (subpath "/usr"))'));
  assert.match(p, /\(allow network-outbound \(remote ip "localhost:4000"\)\)/);
  assert.ok(!/network-outbound \(remote ip "\*/.test(p));
});

test('gitPaths finds the private git dir, shared git dir and branch of a linked worktree', () => {
  const fx = fixture();
  const gp = gitPaths(fx.wt)!;
  assert.equal(gp.commonDir, fx.common);
  assert.equal(gp.gitDir, join(fx.common, 'worktrees', 'bead-a'));
  assert.equal(gp.branchRef, 'refs/heads/octet/goal/bead-a');
  assert.equal(gitPaths(fx.outside), null);
});

test('hostAllowed: exact names and *.suffix wildcards, case-insensitive, nothing else', () => {
  const allow = ['api.anthropic.com', '*.npmjs.org'];
  assert.ok(hostAllowed('API.anthropic.com', allow));
  assert.ok(hostAllowed('registry.npmjs.org', allow));
  assert.ok(!hostAllowed('npmjs.org', allow));
  assert.ok(!hostAllowed('evilapi.anthropic.com', allow));
  assert.ok(!hostAllowed('api.anthropic.com.evil.test', allow));
});

test('parseDenials aggregates kernel log lines', () => {
  const text = [
    '2026-10-15 09:34:35.127 E  kernel[0:1] (Sandbox) Sandbox: cat(61577) deny(1) file-read-data /h/.ssh/id',
    'octetrun-x',
    '2026-10-15 09:34:35.128 E  kernel[0:1] (Sandbox) 3 duplicate reports for Sandbox: cat(61577) deny(1) file-read-data /h/.ssh/id',
    '2026-10-15 09:34:35.129 E  kernel[0:1] (Sandbox) Sandbox: curl(61580) deny(1) network-outbound 93.184.216.34:80',
  ].join('\n');
  assert.deepEqual(parseDenials(text), [
    { process: 'cat', operation: 'file-read-data', target: '/h/.ssh/id', count: 5 },
    { process: 'curl', operation: 'network-outbound', target: '93.184.216.34:80', count: 1 },
  ]);
});

// The proxy needs no sandbox: it is a plain allow-list CONNECT proxy.
test('net proxy: tunnels allowed hosts, refuses the rest and reports each refusal', async () => {
  const { port: webPort, hits } = await localServer();
  const denied: string[] = [];
  const allowed: string[] = [];
  const proxy = await startNetProxy({ allowHosts: ['127.0.0.1'], allowPrivate: true, onDeny: (h) => denied.push(h), onAllow: (h) => allowed.push(h) });
  const talk = (target: string, send: string) => new Promise<string>((resolve) => {
    let buf = '';
    const s = connect(proxy.port, '127.0.0.1', () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n${send}`));
    s.on('data', (d) => { buf += d.toString(); });
    s.on('close', () => resolve(buf));
    setTimeout(() => s.destroy(), 1500);
  });
  const ok = await talk(`127.0.0.1:${webPort}`, 'GET /through HTTP/1.0\r\n\r\n');
  assert.match(ok, /^HTTP\/1\.1 200/);
  assert.match(ok, /hello/);
  assert.deepEqual(hits, ['/through']);
  assert.match(await talk('evil.example.com:443', ''), /^HTTP\/1\.1 403/);
  assert.match(await talk('not-a-target', ''), /^HTTP\/1\.1 403/);
  assert.deepEqual(allowed, ['127.0.0.1']);
  assert.deepEqual(denied, ['evil.example.com', 'not-a-target']);
  await proxy.close();
});

test('net proxy: by default refuses hosts that resolve to private addresses (SSRF), even if allow-listed', async () => {
  const { port: webPort, hits } = await localServer();
  const denied: string[] = [];
  const proxy = await startNetProxy({ allowHosts: ['127.0.0.1', 'localhost'], onDeny: (h, why) => denied.push(`${h}: ${why}`) });
  const reply = await new Promise<string>((resolve) => {
    let buf = '';
    const s = connect(proxy.port, '127.0.0.1', () => s.write(`CONNECT localhost:${webPort} HTTP/1.1\r\n\r\nGET /x HTTP/1.0\r\n\r\n`));
    s.on('data', (d) => { buf += d.toString(); });
    s.on('close', () => resolve(buf));
  });
  assert.match(reply, /^HTTP\/1\.1 403/);
  assert.match(denied[0] ?? '', /private address/);
  assert.deepEqual(hits, []);
  await proxy.close();
});

// ---------------------------------------------------------------------------------------------
// Wiring: a bead run goes through the sandbox and its events land in the audit chain.

test('runBead runs the engineer sandboxed and records sandbox events in the audit log', { skip }, async () => {
  const fx = fixture();
  writeFileSync(join(fx.bin, 'claude'), `#!/bin/sh
echo built > built.txt
if cat "${fx.canary.ssh}" >/dev/null 2>&1; then echo LEAKED; else echo contained; fi
`, { mode: 0o755 });
  const ctx: Ctx = {
    store: new Store(':memory:'),
    identities: parseIdentities('[identities.wijt]\nname = "Bot"\nemail = "wijt@example.com"\nssh_key = "/nonexistent"\ngh_user = "WhoIsJaneTurner"\n'),
    projects: [{ name: 'demo', path: fx.repo, identity: 'wijt' }], runner: new ClaudeCodeRunner(), sandbox: cfg(),
    runsDir: mkdtempSync(join(tmpdir(), 'octet-runs-')),
  };
  const goal = createGoal(ctx, { project: 'demo', title: 'sandboxed' });
  const bead = addBead(ctx, { goalId: goal.id, title: 'A', brief: 'a' });
  const savedPath = process.env.PATH;
  process.env.PATH = `${fx.bin}:${savedPath}`;
  const savedHome = process.env.HOME;
  process.env.HOME = fx.home;
  let out;
  try { out = await runBead(ctx, bead.id); } finally { process.env.PATH = savedPath; process.env.HOME = savedHome; }
  assert.equal(out.status, 'in_review');
  const started = ctx.store.eventsOfKind('sandbox.started');
  assert.equal(started.length, 1);
  assert.equal(started[0]!.beadId, bead.id);
  assert.equal(started[0]!.seat, 'engineer');
  const ready = ctx.store.lastEvent('bead.ready_for_review', bead.id);
  assert.match(JSON.stringify(ready?.data), /contained/);
  assert.ok(ctx.store.eventsOfKind('sandbox.denied').length >= 1);
  assert.equal(ctx.store.verifyChain().ok, true);
});

// ---------------------------------------------------------------------------------------------
// Live check: the real `claude`, logged in on this machine, under the sandbox. Costs one tiny model call, so it only runs on request:
//   OCTET_LIVE=1 node --test packages/core/test/sandbox.test.ts

test('LIVE: the real claude starts, authenticates and writes in its worktree under the sandbox', { skip: skip || (process.env.OCTET_LIVE === '1' ? false : 'set OCTET_LIVE=1 to call a real model'), timeout: 180_000 }, async () => {
  const fx = fixture();
  const events: string[] = [];
  const res = await new ClaudeCodeRunner().run({
    seat: 'engineer', cwd: fx.wt, env: process.env, timeoutMs: 150_000, systemPrompt: 'Be terse.',
    prompt: 'Create a file named hello.txt in the current directory containing exactly the word ok. Then reply with the single word done.',
    sandbox: { config: cfg(), onEvent: (k) => events.push(k) },
  });
  assert.equal(res.exitCode, 0, res.output);
  assert.equal(readFileSync(join(fx.wt, 'hello.txt'), 'utf8').trim(), 'ok');
  assert.ok(events.includes('sandbox.started'));
});
