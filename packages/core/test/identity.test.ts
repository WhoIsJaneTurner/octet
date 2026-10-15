import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkRemote, childEnv, getIdentity, gitEnv, parseIdentities, remoteOwner } from '../src/index.ts';

const toml = `
[identities.wijt]
name = "Chris"
email = "wijt@example.com"
ssh_key = "~/.ssh/id_ed25519_WIJT"
gh_user = "WhoIsJaneTurner"
owners = ["jane-org"]

[identities.personal]
name = "Chris"
email = "personal@example.com"
ssh_key = "/k/personal"
gh_user = "bioSandMan"
`;

test('parses identities and expands ~', () => {
  const ids = parseIdentities(toml);
  assert.equal(ids.length, 2);
  assert.ok(!ids[0]!.sshKey.startsWith('~'));
  assert.deepEqual(ids[0]!.owners, ['jane-org']);
});

test('missing field is an error naming the identity', () => {
  assert.throws(() => parseIdentities('[identities.x]\nname="a"'), /identities\.x: missing "email"/);
});

test('there is no default identity', () => {
  const ids = parseIdentities(toml);
  assert.throws(() => getIdentity(ids, undefined), /no default identity/i);
  assert.throws(() => getIdentity(ids, 'nope'), /Unknown identity "nope"/);
});

test('remoteOwner handles ssh and https forms', () => {
  assert.equal(remoteOwner('git@github.com:WhoIsJaneTurner/octet.git'), 'WhoIsJaneTurner');
  assert.equal(remoteOwner('https://github.com/bioSandMan/x'), 'bioSandMan');
  assert.equal(remoteOwner('ssh://git@github.com/a/b.git'), 'a');
  assert.equal(remoteOwner('git@gitlab.com:a/b.git'), null);
});

test('checkRemote blocks the wrong account and allows listed orgs', () => {
  const [wijt, personal] = parseIdentities(toml) as [ReturnType<typeof parseIdentities>[0], ReturnType<typeof parseIdentities>[0]];
  assert.ok(checkRemote(wijt, 'git@github.com:whoisjaneturner/octet.git').ok);
  assert.ok(checkRemote(wijt, 'git@github.com:jane-org/app.git').ok);
  const bad = checkRemote(personal, 'git@github.com:WhoIsJaneTurner/octet.git');
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /not allowed for identity "personal"/);
});

test('gitEnv pins the author and only the identity key', () => {
  const [wijt] = parseIdentities(toml);
  const env = gitEnv(wijt!);
  assert.equal(env.GIT_AUTHOR_EMAIL, 'wijt@example.com');
  assert.match(env.GIT_SSH_COMMAND!, /IdentitiesOnly=yes/);
});

test('childEnv strips inherited credentials from other identities', () => {
  const [wijt] = parseIdentities(toml);
  const env = childEnv(wijt!, { PATH: '/bin', GH_TOKEN: 'secret', GIT_AUTHOR_EMAIL: 'wrong@x.com' });
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.GIT_AUTHOR_EMAIL, 'wijt@example.com');
  assert.equal(env.PATH, '/bin');
});
