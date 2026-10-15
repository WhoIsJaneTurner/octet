#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { buildRunner, dbFile, Store } from '@octet/core';
import { startDaemon } from './server.ts';

const fake = process.argv.includes('--fake') || process.env.OCTET_FAKE === '1';
const portArg = process.argv.find((a) => a.startsWith('--port='))?.slice(7);
const port = Number(portArg ?? process.env.OCTET_PORT ?? 4747);

const store = new Store(dbFile());
const { runner, shutdown } = buildRunner({ store, fake });

const daemon = await startDaemon({
  store,
  runner,
  uiDir: fileURLToPath(new URL('../../ui/dist/', import.meta.url)),
  port,
});

console.log(`octet daemon listening on http://127.0.0.1:${daemon.port}/  ${fake ? '(FAKE agents: no model calls)' : ''}`);
process.on('SIGINT', () => void daemon.close().then(shutdown).then(() => process.exit(0)));
