import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkNode, checkPath, runDoctor, Store, type Check, type DoctorEnv } from '../src/index.ts';

function fixture(over: Partial<DoctorEnv> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'octet-doc-'));
  const repo = join(home, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  const key = join(home, 'key');
  writeFileSync(key, 'k');
  const identitiesFile = join(home, 'identities.toml');
  writeFileSync(identitiesFile, `[identities.a]\nname="A"\nemail="a@x"\nssh_key="${key}"\ngh_user="a-user"\n`);
  const projectsFile = join(home, 'projects.toml');
  writeFileSync(projectsFile, `[projects.app]\npath="${repo}"\nidentity="a"\n`);
  const env: DoctorEnv = {
    nodeVersion: '24.1.0',
    tool: (n) => ({ path: `/bin/${n}`, version: `${n} 1.0` }),
    pathEnv: `/bin:${join(home, '.local', 'bin')}`,
    home,
    configFile: join(home, 'config.toml'),
    identitiesFile, projectsFile,
    dbFile: join(home, 'octet.db'),
    lockFile: join(home, 'daemon.lock'),
    identityProbe: () => ({ sshUser: 'a-user', token: true }),
    ...over,
  };
  return { env, home, repo };
}

const find = (checks: Check[], name: string) => checks.filter((c) => c.name === name);
const levels = (checks: Check[]) => checks.map((c) => c.level);

test('a healthy setup has no warnings or failures', () => {
  const { env } = fixture();
  new Store(env.dbFile).close();
  const checks = runDoctor(env);
  assert.deepEqual(checks.filter((c) => c.level !== 'ok'), [], JSON.stringify(checks.filter((c) => c.level !== 'ok')));
  assert.ok(find(checks, 'git')[0]!.message.includes('git 1.0'));
  assert.match(find(checks, 'audit chain')[0]!.message, /0 events/);
});

test('node older than 24 fails', () => {
  assert.equal(checkNode('22.11.0').level, 'fail');
  assert.equal(checkNode('24.0.0').level, 'ok');
  assert.equal(checkNode('25.1.0').level, 'ok');
});

test('a missing tool fails with an install hint; a missing PATH entry only warns', () => {
  const { env } = fixture({ tool: (n) => (n === 'gh' ? null : { path: `/bin/${n}`, version: 'v' }), pathEnv: '/bin' });
  const checks = runDoctor(env);
  assert.equal(find(checks, 'gh')[0]!.level, 'fail');
  assert.match(find(checks, 'gh')[0]!.message, /brew install gh/);
  assert.equal(find(checks, 'PATH')[0]!.level, 'warn');
  assert.equal(checkPath({ pathEnv: '/a:/h/.local/bin/', home: '/h' }).level, 'ok');
});

test('identity failures: wrong ssh account, missing token, missing key', () => {
  const { env } = fixture({ identityProbe: () => ({ sshUser: 'someone-else', token: false }) });
  const c = find(runDoctor(env), 'identity a');
  assert.equal(c.length, 1);
  assert.equal(c[0]!.level, 'fail');
  assert.match(c[0]!.message, /ssh=someone-else \(want a-user\), gh token=no/);
  const { env: env2 } = fixture();
  writeFileSync(env2.identitiesFile, '[identities.a]\nname="A"\nemail="a@x"\nssh_key="/nonexistent/k"\ngh_user="a-user"\n');
  assert.match(find(runDoctor(env2), 'identity a')[0]!.message, /ssh key not found/);
});

test('config problems: wrong types fail, unknown keys warn', () => {
  const { env } = fixture();
  writeFileSync(env.configFile, '[limits]\nmax_engineers = "x"\nmax_engineer = 1\n');
  const c = find(runDoctor(env), 'config.toml');
  assert.deepEqual(levels(c).sort(), ['fail', 'warn']);
  assert.ok(c.some((x) => x.message.includes('[limits] max_engineers')));
});

test('project problems: missing path, not a git repo, unknown identity, unwritable vault', () => {
  const { env, home } = fixture();
  const plain = join(home, 'plain');
  mkdirSync(plain);
  writeFileSync(env.projectsFile, [
    '[projects.gone]\npath="/nonexistent/x"\nidentity="a"',
    `[projects.plain]\npath="${plain}"\nidentity="a"`,
    `[projects.who]\npath="${plain}"\nidentity="nobody"`,
    `[projects.vaulty]\npath="${plain}"\nidentity="a"\nvault="/nonexistent-root/vault"`,
  ].join('\n'));
  const byName = Object.fromEntries(runDoctor(env).filter((c) => c.name.startsWith('project ')).map((c) => [c.name, c]));
  assert.match(byName['project gone']!.message, /path does not exist/);
  assert.match(byName['project plain']!.message, /not a git repository/);
  assert.match(byName['project who']!.message, /unknown identity "nobody"/);
  assert.match(byName['project vaulty']!.message, /vault .* is not writable/);
  assert.ok(Object.values(byName).every((c) => c.level === 'fail'));
});

test('a vault that does not exist yet but can be created is fine', () => {
  const { env, home, repo } = fixture();
  writeFileSync(env.projectsFile, `[projects.app]\npath="${repo}"\nidentity="a"\nvault="${join(home, 'vaults', 'app')}"\n`);
  assert.equal(find(runDoctor(env), 'project app')[0]!.level, 'ok');
});

test('database: missing is a warning; corrupt fails; a tampered audit chain fails', () => {
  const { env } = fixture();
  assert.equal(find(runDoctor(env), 'database')[0]!.level, 'warn');

  const store = new Store(env.dbFile);
  store.log({ kind: 'a.b' });
  store.log({ kind: 'c.d' });
  store.db.exec("UPDATE events SET kind = 'tampered' WHERE id = 1");
  store.close();
  const checks = runDoctor(env);
  assert.equal(find(checks, 'database')[0]!.level, 'ok');
  assert.equal(find(checks, 'audit chain')[0]!.level, 'fail');
  assert.match(find(checks, 'audit chain')[0]!.message, /event 1/);

  const { env: bad } = fixture();
  writeFileSync(bad.dbFile, 'this is not a sqlite database at all, just text'.repeat(50));
  const c = runDoctor(bad);
  assert.ok(find(c, 'database').some((x) => x.level === 'fail'), JSON.stringify(find(c, 'database')));
  assert.equal(find(c, 'audit chain').length, 0);
});

test('schema version is reported, and an injected plan verifier is honoured', () => {
  const { env } = fixture({ verifyPlans: () => ({ ok: false, checked: 3, reason: 'plan p-1 hash mismatch' }) });
  const store = new Store(env.dbFile);
  store.db.exec('UPDATE schema_version SET version = 4');
  store.close();
  const checks = runDoctor(env);
  assert.match(find(checks, 'schema')[0]!.message, /version 4/);
  assert.equal(find(checks, 'plans')[0]!.level, 'fail');
  const ok = runDoctor({ ...env, verifyPlans: () => ({ ok: true, checked: 3 }) });
  assert.match(find(ok, 'plans')[0]!.message, /3 plan hashes match/);
});

test('daemon lock: live, stale and absent', () => {
  const { env } = fixture({ alive: (p) => p === 10 });
  assert.match(find(runDoctor(env), 'daemon')[0]!.message, /not running/);
  writeFileSync(env.lockFile, JSON.stringify({ pid: 10, port: 4747, startedAt: 'x' }));
  assert.match(find(runDoctor(env), 'daemon')[0]!.message, /pid 10, http:\/\/127\.0\.0\.1:4747/);
  writeFileSync(env.lockFile, JSON.stringify({ pid: 11, port: 4747, startedAt: 'x' }));
  assert.equal(find(runDoctor(env), 'daemon')[0]!.level, 'warn');
});

test('a missing identities file fails once, with the path', () => {
  const { env, home } = fixture({ identitiesFile: '/nonexistent/identities.toml' });
  const c = runDoctor(env).filter((x) => x.level === 'fail');
  assert.ok(c.some((x) => x.name === 'identities.toml' && x.message.includes('/nonexistent/identities.toml')));
  assert.ok(home);
});
