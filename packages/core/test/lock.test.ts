import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquireDaemonLock, pidAlive, readLock } from '../src/index.ts';

const lockPath = () => join(mkdtempSync(join(tmpdir(), 'octet-lock-')), 'daemon.lock');

test('the first daemon takes the lock and records its pid and port', () => {
  const file = lockPath();
  const lock = acquireDaemonLock(file, () => true, 111);
  assert.deepEqual(readLock(file)?.pid, 111);
  assert.equal(readLock(file)?.port, 0);
  lock.setPort(4747);
  assert.deepEqual(readLock(file), { pid: 111, port: 4747, startedAt: lock.info.startedAt });
  lock.release();
  assert.equal(existsSync(file), false);
});

test('a second daemon is refused with a message naming the first one', () => {
  const file = lockPath();
  const first = acquireDaemonLock(file, () => true, 111);
  first.setPort(4747);
  assert.throws(() => acquireDaemonLock(file, () => true, 222), (e: Error) => {
    assert.match(e.message, /pid 111/);
    assert.match(e.message, /port 4747/);
    assert.match(e.message, /http:\/\/127\.0\.0\.1:4747\//);
    return true;
  });
  assert.equal(readLock(file)?.pid, 111, 'the first lock is untouched');
});

test('a lock left by a dead pid is taken over', () => {
  const file = lockPath();
  writeFileSync(file, JSON.stringify({ pid: 999999, port: 4747, startedAt: 'x' }));
  const lock = acquireDaemonLock(file, (pid) => pid !== 999999, 222);
  assert.equal(readLock(file)?.pid, 222);
  lock.release();
});

test('an unreadable lock file is treated as stale', () => {
  const file = lockPath();
  writeFileSync(file, 'not json');
  acquireDaemonLock(file, () => true, 222);
  assert.equal(readLock(file)?.pid, 222);
});

test('release only removes a lock that is still ours, and is idempotent', () => {
  const file = lockPath();
  const lock = acquireDaemonLock(file, () => true, 111);
  writeFileSync(file, JSON.stringify({ pid: 333, port: 1, startedAt: 'x' })); // someone took over meanwhile
  lock.release();
  lock.release();
  assert.equal(readLock(file)?.pid, 333);
});

test('with real processes: a live pid blocks, and a pid that exited does not', async () => {
  const file = lockPath();
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  try {
    const pid = child.pid!;
    assert.ok(pidAlive(pid));
    writeFileSync(file, JSON.stringify({ pid, port: 5000, startedAt: 'x' }));
    assert.throws(() => acquireDaemonLock(file), new RegExp(`pid ${pid}`));
  } finally {
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
  }
  assert.equal(pidAlive(child.pid!), false);
  const lock = acquireDaemonLock(file); // now stale
  assert.equal(readLock(file)?.pid, process.pid);
  assert.match(readFileSync(file, 'utf8'), /startedAt/);
  lock.release();
});
