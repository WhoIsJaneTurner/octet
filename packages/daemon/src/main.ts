#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { acquireDaemonLock, ClaudeCodeRunner, dbFile, FakeRunner, OctetError, Store, type DaemonLock } from '@octet/core';
import { startDaemon } from './server.ts';

const fake = process.argv.includes('--fake') || process.env.OCTET_FAKE === '1';
const portArg = process.argv.find((a) => a.startsWith('--port='))?.slice(7);
const port = Number(portArg ?? process.env.OCTET_PORT ?? 4747);

// One daemon per database: a second one would disagree with the first about what is running.
function takeLock(): DaemonLock {
  try {
    return acquireDaemonLock();
  } catch (e) {
    if (!(e instanceof OctetError)) throw e;
    console.error(`octet: ${e.message}`);
    process.exit(1);
  }
}
const lock = takeLock();

// Taken out of the environment so agent child processes never inherit it.
const token = process.env.OCTET_TOKEN;
delete process.env.OCTET_TOKEN;

const daemon = await startDaemon({
  store: new Store(dbFile()),
  runner: fake ? new FakeRunner() : new ClaudeCodeRunner(),
  uiDir: fileURLToPath(new URL('../../ui/dist/', import.meta.url)),
  port,
  ...(token ? { token } : {}), // set by the desktop shell, which keeps it in memory
});
lock.setPort(daemon.port);

console.log(`octet daemon listening on http://127.0.0.1:${daemon.port}/  ${fake ? '(FAKE agents: no model calls)' : ''}`);
const stop = () => void daemon.close().then(() => { lock.release(); process.exit(0); });
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('exit', () => lock.release());
