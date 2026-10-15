import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluate, parseIdentities, SEATS } from '../src/index.ts';

const [wijt, personal] = parseIdentities(`
[identities.wijt]
name="a"
email="a@a"
ssh_key="/k"
gh_user="WhoIsJaneTurner"
[identities.personal]
name="a"
email="a@a"
ssh_key="/k"
gh_user="bioSandMan"
`) as [ReturnType<typeof parseIdentities>[0], ReturnType<typeof parseIdentities>[0]];

test('there are exactly eight seats and only the engineer writes code', () => {
  assert.equal(SEATS.length, 8);
  assert.deepEqual(SEATS.filter((s) => s.writesCode).map((s) => s.id), ['engineer']);
});

test('only the engineer may write', () => {
  assert.equal(evaluate({ seat: 'engineer', kind: 'fs.write' }).decision, 'allow');
  assert.equal(evaluate({ seat: 'marshal', kind: 'fs.write' }).decision, 'deny');
  assert.equal(evaluate({ seat: 'reviewer', kind: 'git.commit' }).decision, 'deny');
});

test('only the marshal merges', () => {
  assert.equal(evaluate({ seat: 'marshal', kind: 'git.merge' }).decision, 'allow');
  assert.equal(evaluate({ seat: 'engineer', kind: 'git.merge' }).decision, 'deny');
});

test('only the courier pushes, and only after approval', () => {
  const remote = 'git@github.com:WhoIsJaneTurner/octet.git';
  assert.equal(evaluate({ seat: 'engineer', kind: 'git.push', identity: wijt, remoteUrl: remote }).decision, 'deny');
  assert.equal(evaluate({ seat: 'courier', kind: 'git.push', identity: wijt, remoteUrl: remote }).decision, 'ask');
  assert.equal(evaluate({ seat: 'courier', kind: 'git.push', identity: wijt, remoteUrl: remote, approved: true }).decision, 'allow');
});

test('the courier is denied on the wrong account even when approved', () => {
  const d = evaluate({ seat: 'courier', kind: 'git.push', identity: personal,
    remoteUrl: 'git@github.com:WhoIsJaneTurner/octet.git', approved: true });
  assert.equal(d.decision, 'deny');
});
