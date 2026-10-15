#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { ClaudeCodeRunner, dbFile, FakeRunner, Store } from '@octet/core';
import { startDaemon } from './server.ts';

const fake = process.argv.includes('--fake') || process.env.OCTET_FAKE === '1';
const portArg = process.argv.find((a) => a.startsWith('--port='))?.slice(7);
const port = Number(portArg ?? process.env.OCTET_PORT ?? 4747);

const daemon = await startDaemon({
  store: new Store(dbFile()),
  runner: fake ? new FakeRunner() : new ClaudeCodeRunner(),
  uiDir: fileURLToPath(new URL('../../ui/dist/', import.meta.url)),
  port,
});

console.log(`octet daemon listening on http://127.0.0.1:${daemon.port}/  ${fake ? '(FAKE agents: no model calls)' : ''}`);
process.on('SIGINT', () => void daemon.close().then(() => process.exit(0)));
