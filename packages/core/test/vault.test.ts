import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { atomicWrite, MIGRATIONS, parseFrontmatter, redact, Store, stringifyFrontmatter, Vault } from '../src/index.ts';

test('front matter round-trips strings, numbers, booleans, null and lists, including awkward values', () => {
  const fm = {
    octet: 'plan', version: 2, pinned: true, pr: null, title: 'Fix: the "thing", #1', empty: '', num_like: '123',
    beads: ['bead-1', 'bead-2'], tricky: ['a, b', 'c'], none: [] as string[],
  };
  const { data, body } = parseFrontmatter(stringifyFrontmatter(fm) + '\nBody text\n');
  assert.deepEqual(data, fm);
  assert.equal(body.trim(), 'Body text');
  assert.deepEqual(parseFrontmatter('no front matter').data, {});
});

test('redaction catches common token shapes and counts them', () => {
  const text = [
    'ghp_' + 'x'.repeat(30), 'sk-' + 'a'.repeat(30), 'AKIA' + 'B'.repeat(16), 'xoxb-1234567890-abcdef',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz', 'password = hunter2hunter2',
    '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----', 'harmless text and sk-short',
  ].join('\n');
  const r = redact(text);
  assert.equal(r.count, 7);
  assert.ok(!/ghp_x|AKIAB|hunter2|abcdefghijklmnop|BEGIN OPENSSH/.test(r.text));
  assert.match(r.text, /harmless text and sk-short/);
  assert.equal(redact('nothing here').count, 0);
});

test('atomic writes leave no temp files and replace content whole', () => {
  const dir = mkdtempSync(join(tmpdir(), 'octet-atomic-'));
  const f = join(dir, 'a', 'b.txt');
  atomicWrite(f, 'one');
  atomicWrite(f, 'two');
  assert.equal(readFileSync(f, 'utf8'), 'two');
  assert.deepEqual(readdirSync(join(dir, 'a')), ['b.txt']);
});

test('a stale lock from a dead process is taken over; a live holder blocks writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'octet-lock-'));
  const v = new Vault(dir);
  writeFileSync(join(dir, '.octet.lock'), '2147483000'); // no such process
  v.init();
  assert.ok(existsSync(join(dir, 'README.md')));
  assert.ok(!existsSync(join(dir, '.octet.lock')));
  // pid 1 is alive and not us
  writeFileSync(join(dir, '.octet.lock'), '1');
  assert.throws(() => v.init(), /locked by process 1/);
});

test('plan slugs are dated and de-duplicated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'octet-slug-'));
  const v = new Vault(dir);
  v.init();
  const d = new Date('2026-10-12T10:00:00Z');
  const a = v.planSlug('Add rate limiting!', d);
  assert.equal(a, '2026-10-12-add-rate-limiting');
  atomicWrite(join(dir, 'plans', a, 'x'), '');
  assert.equal(v.planSlug('Add rate limiting!', d), '2026-10-12-add-rate-limiting-2');
});

test('an old database is backed up, migrated in order, and ends at the current version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'octet-mig-'));
  const file = join(dir, 'octet.db');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE goals (id TEXT PRIMARY KEY, project TEXT NOT NULL, title TEXT NOT NULL, branch TEXT NOT NULL, worktree TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE beads (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, title TEXT NOT NULL, brief TEXT NOT NULL, depends_on TEXT NOT NULL, status TEXT NOT NULL, branch TEXT NOT NULL, worktree TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, kind TEXT NOT NULL, goal_id TEXT, bead_id TEXT, seat TEXT, data TEXT NOT NULL);
    INSERT INTO goals VALUES ('g1','p','t','b','/w','active','2026-01-01');
  `);
  old.close();
  const store = new Store(file);
  assert.equal(store.schemaVersion(), MIGRATIONS.length);
  assert.ok(existsSync(`${file}.bak-v0`));
  const g = store.getGoal('g1')!;
  assert.equal(g.paused, false);
  store.insertBead({ id: 'b1', goalId: 'g1', title: 't', brief: 'b', dependsOn: [], branch: 'x', worktree: '/w' });
  assert.equal(store.getBead('b1')!.planId, null);
  store.close();
  // Re-opening is a no-op: no second backup, same version.
  const again = new Store(file);
  assert.equal(again.schemaVersion(), MIGRATIONS.length);
  assert.deepEqual(readdirSync(dir).filter((f) => f.includes('.bak')), ['octet.db.bak-v0']);
});
