import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FakeIntake, FakeRunner, loadIntake, Store } from '@octet/core';
import { startDaemon, type Daemon } from '../src/server.ts';

const state = async (d: Daemon) => {
  const res = await fetch(`http://127.0.0.1:${d.port}/api/state`, { headers: { authorization: `Bearer ${d.token}` } });
  return (await res.json()) as any;
};
const until = async (fn: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 30)); }
  throw new Error('timed out');
};

const boot = async (fake: FakeIntake, enabled: boolean): Promise<Daemon> => {
  const home = mkdtempSync(join(tmpdir(), 'octet-intake-d-'));
  const identitiesFile = join(home, 'identities.toml');
  writeFileSync(identitiesFile, '[identities.wijt]\nname="Bot"\nemail="w@example.com"\nssh_key="/nonexistent"\ngh_user="WhoIsJaneTurner"\n');
  const projectsFile = join(home, 'projects.toml');
  writeFileSync(projectsFile, '');
  const config = loadIntake('/nonexistent');
  config.github.enabled = enabled;
  return startDaemon({
    store: new Store(':memory:'), runner: new FakeRunner(), identitiesFile, projectsFile, runsDir: join(home, 'runs'),
    intake: { config, deps: { adapters: { github: () => [fake] } } },
  });
};

test('the daemon polls enabled intake sources, files what they return and reports status and held requests', async () => {
  const fake = new FakeIntake('fake');
  fake.items = [{ source: 'github', externalRef: 'https://github.com/o/r/issues/1', title: 'From the fake', body: 'b', requester: 'someone', held: 'author not allowed' }];
  const d = await boot(fake, true);
  try {
    await until(async () => (await state(d)).requests.length === 1);
    const s = await state(d);
    assert.deepEqual([s.requests[0].status, s.requests[0].project], ['new', null]);
    const gh = s.intake.sources.find((x: any) => x.kind === 'github');
    assert.equal(gh.enabled, true);
    assert.ok(gh.lastPollAt);
    assert.equal(gh.lastError, null);
    assert.deepEqual(s.intake.held, [s.requests[0].id]);
    assert.equal(s.intake.sources.find((x: any) => x.kind === 'jira').enabled, false);
    assert.equal(s.intake.sources.find((x: any) => x.kind === 'chat').enabled, false);
  } finally {
    await d.close();
  }
});

test('a failing source is reported as lastError and the daemon stays up', async () => {
  const fake = new FakeIntake('fake');
  fake.failNext = new Error('gh rate limited');
  const d = await boot(fake, true);
  try {
    await until(async () => (await state(d)).intake.sources.find((x: any) => x.kind === 'github').lastError !== null);
    const s = await state(d);
    assert.equal(s.intake.sources.find((x: any) => x.kind === 'github').lastError, 'gh rate limited');
    assert.equal(s.requests.length, 0);
    assert.ok(s.events.some((e: any) => e.kind === 'intake.error'));
  } finally {
    await d.close();
  }
});

test('nothing is polled unless a source is enabled', async () => {
  const fake = new FakeIntake('fake');
  const d = await boot(fake, false);
  try {
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(fake.fetches, 0);
    assert.equal((await state(d)).intake.sources.find((x: any) => x.kind === 'github').enabled, false);
  } finally {
    await d.close();
  }
});
