import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { childEnv, gitEnv, parseIdentities } from '../src/index.ts';

const toml = (extra: string) => `
[identities.a]
name = "A"
email = "a@example.com"
ssh_key = "/k/a"
gh_user = "a-user"
${extra}
`;

test('an identity with signing_key gets ssh signing config in the git environment', () => {
  const [id] = parseIdentities(toml('signing_key = "/k/a_sign"'));
  const env = gitEnv(id!, {});
  assert.equal(env.GIT_CONFIG_COUNT, '3');
  const cfg = Object.fromEntries([0, 1, 2].map((i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]));
  assert.deepEqual(cfg, { 'gpg.format': 'ssh', 'user.signingkey': '/k/a_sign', 'commit.gpgsign': 'true' });
});

test('an identity without signing_key gets no signing config at all', () => {
  const [id] = parseIdentities(toml(''));
  const env = childEnv(id!, { PATH: '/bin' });
  assert.equal(env.GIT_CONFIG_COUNT, undefined);
  assert.equal(Object.keys(env).some((k) => k.startsWith('GIT_CONFIG_')), false);
  assert.equal(JSON.stringify(env).includes('gpgsign'), false);
});

test('signing config is appended after git config already in the environment', () => {
  const [id] = parseIdentities(toml('signing_key = "/k/s"'));
  const env = childEnv(id!, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.editor', GIT_CONFIG_VALUE_0: 'true' });
  assert.equal(env.GIT_CONFIG_COUNT, '4');
  assert.equal(env.GIT_CONFIG_KEY_0, 'core.editor');
  assert.equal(env.GIT_CONFIG_KEY_1, 'gpg.format');
});

test('git really signs a commit with the identity key, and only when the key is set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'octet-sign-'));
  const key = join(dir, 'sign_key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key, '-C', 'octet-test']);
  const repo = join(dir, 'repo');
  const base = { PATH: process.env.PATH ?? '', HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: base });
  const commit = (extra: string): string => {
    const [id] = parseIdentities(toml(extra));
    writeFileSync(join(repo, 'f.txt'), String(Math.random()));
    const env = childEnv(id!, base);
    execFileSync('git', ['add', '.'], { cwd: repo, env });
    execFileSync('git', ['commit', '-q', '-m', 'x'], { cwd: repo, env });
    return execFileSync('git', ['cat-file', 'commit', 'HEAD'], { cwd: repo, env, encoding: 'utf8' });
  };
  assert.doesNotMatch(commit(''), /gpgsig/);
  assert.match(commit(`signing_key = "${key}"`), /gpgsig -----BEGIN SSH SIGNATURE-----/);
});
