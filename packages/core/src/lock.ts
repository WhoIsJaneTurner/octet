import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { OctetError } from './errors.ts';
import { dataHome } from './paths.ts';

/**
 * One daemon per database. Two daemons would each keep their own in-memory view of what is
 * running and disagree, so the second one refuses to start.
 */

export const daemonLockFile = (): string => join(dataHome(), 'daemon.lock');

export interface LockInfo {
  pid: number;
  /** 0 until the server is listening. */
  port: number;
  startedAt: string;
}

export interface DaemonLock {
  readonly file: string;
  readonly info: LockInfo;
  /** Records the port once the server is listening. */
  setPort(port: number): void;
  /** Removes the lock if it is still ours. Safe to call more than once. */
  release(): void;
}

export const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // exists, but owned by someone else
  }
};

/** The lock's contents, or null when there is no file or it is unreadable. */
export function readLock(file: string = daemonLockFile()): LockInfo | null {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as Partial<LockInfo>;
    return typeof v.pid === 'number' && typeof v.port === 'number'
      ? { pid: v.pid, port: v.port, startedAt: String(v.startedAt ?? '') }
      : null;
  } catch {
    return null;
  }
}

/**
 * Takes the lock, or throws an OctetError naming the daemon that holds it. A lock left by a
 * process that no longer exists is taken over. `alive` is injectable for tests.
 */
export function acquireDaemonLock(
  file: string = daemonLockFile(),
  alive: (pid: number) => boolean = pidAlive,
  pid: number = process.pid,
): DaemonLock {
  mkdirSync(dirname(file), { recursive: true });
  const info: LockInfo = { pid, port: 0, startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      // Written in full to a private name, then linked into place: link fails if the lock exists,
      // and nobody ever sees a half-written lock file.
      const tmp = `${file}.${pid}.new`;
      writeFileSync(tmp, JSON.stringify(info));
      try { linkSync(tmp, file); } finally { unlinkSync(tmp); }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const held = readLock(file);
      if (held && held.pid !== pid && alive(held.pid)) {
        throw new OctetError(
          `Another octet daemon is already running on this database (pid ${held.pid}, ${held.port ? `port ${held.port}` : 'still starting'}). `
          + `${held.port ? `Open http://127.0.0.1:${held.port}/ or stop it` : 'Stop it'} (kill ${held.pid}) before starting another. Lock file: ${file}`,
        );
      }
      // Stale (dead owner, or unreadable): remove only if it is still the file we looked at.
      if (JSON.stringify(readLock(file)) === JSON.stringify(held)) {
        try { unlinkSync(file); } catch { /* someone else removed it */ }
      }
      if (attempt === 4) throw new OctetError(`Could not take the daemon lock at ${file}`);
    }
  }
  let released = false;
  const write = () => {
    const tmp = `${file}.${pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(info));
    renameSync(tmp, file);
  };
  return {
    file, info,
    setPort(port) {
      info.port = port;
      write();
    },
    release() {
      if (released) return;
      released = true;
      // Only remove a lock that is still ours.
      if (readLock(file)?.pid === pid) {
        try { unlinkSync(file); } catch { /* already gone */ }
      }
    },
  };
}
