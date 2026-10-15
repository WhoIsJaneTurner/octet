import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/index.ts';

const fresh = () => {
  const s = new Store(':memory:');
  for (let i = 0; i < 4; i++) s.log({ kind: `e${i}`, seat: 'marshal', data: { i } });
  return s;
};

test('an untouched log verifies', () => {
  const s = fresh();
  const c = s.verifyChain();
  assert.equal(c.ok, true);
  assert.equal(c.checked, 4);
  assert.equal(c.head, s.chainHead());
});

test('editing an event is detected', () => {
  const s = fresh();
  s.db.prepare("UPDATE events SET data = '{\"i\":99}' WHERE id = 2").run();
  const c = s.verifyChain();
  assert.equal(c.ok, false);
  assert.equal(c.brokenAt, 2);
  assert.match(c.reason!, /modified/);
});

test('deleting an event from the middle is detected', () => {
  const s = fresh();
  s.db.prepare('DELETE FROM events WHERE id = 2').run();
  const c = s.verifyChain();
  assert.equal(c.ok, false);
  assert.equal(c.brokenAt, 3);
  assert.match(c.reason!, /removed or inserted/);
});

test('truncating the tail is not detectable from inside the log, but the head hash changes', () => {
  const s = fresh();
  const before = s.chainHead();
  s.db.prepare('DELETE FROM events WHERE id = 4').run();
  assert.equal(s.verifyChain().ok, true);
  assert.notEqual(s.chainHead(), before, 'an externally stored head hash would reveal this');
});

test('a database from before chaining is upgraded and old events are skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'octet-mig-'));
  const file = join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, kind TEXT NOT NULL,
    goal_id TEXT, bead_id TEXT, seat TEXT, data TEXT NOT NULL);
    INSERT INTO events (ts, kind, data) VALUES ('2026-01-01T00:00:00Z', 'legacy', '{}');`);
  old.close();
  const s = new Store(file);
  s.log({ kind: 'new' });
  const c = s.verifyChain();
  assert.equal(c.ok, true);
  assert.equal(c.checked, 1);
  assert.equal(s.events().length, 2);
});
