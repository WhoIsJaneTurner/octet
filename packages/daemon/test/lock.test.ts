import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));

function start(home: string, data: string): { child: ChildProcess; out: Promise<string>; exited: Promise<number | null> } {
  const child = spawn(process.execPath, [MAIN, '--fake', '--port=0'], {
    env: { ...process.env, OCTET_HOME: home, OCTET_DATA: data }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let text = '';
  const out = new Promise<string>((resolve) => {
    const on = (b: Buffer) => { text += b.toString(); if (/listening on|already running/.test(text)) resolve(text); };
    child.stdout!.on('data', on);
    child.stderr!.on('data', on);
    child.once('exit', () => resolve(text));
  });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, out, exited };
}

test('two daemons on one database: the second refuses and names the first; the lock goes away on SIGTERM', async () => {
  const home = mkdtempSync(join(tmpdir(), 'octet-lockhome-'));
  const data = mkdtempSync(join(tmpdir(), 'octet-lockdata-'));
  writeFileSync(join(home, 'identities.toml'), '[identities.a]\nname="A"\nemail="a@x"\nssh_key="/k"\ngh_user="u"\n');
  const first = start(home, data);
  try {
    const said = await first.out;
    assert.match(said, /listening on http:\/\/127\.0\.0\.1:(\d+)\//);
    const port = said.match(/:(\d+)\//)![1];

    const second = start(home, data);
    const msg = await second.out;
    assert.equal(await second.exited, 1);
    assert.match(msg, new RegExp(`pid ${first.child.pid}`));
    assert.match(msg, new RegExp(`port ${port}`));

    // A different database is not affected.
    const other = start(home, mkdtempSync(join(tmpdir(), 'octet-lockdata2-')));
    assert.match(await other.out, /listening on/);
    other.child.kill('SIGTERM');
    await other.exited;
  } finally {
    first.child.kill('SIGTERM');
  }
  await first.exited;
  assert.equal(existsSync(join(data, 'daemon.lock')), false, 'lock released on shutdown');

  // And the database can be taken again.
  const again = start(home, data);
  assert.match(await again.out, /listening on/);
  again.child.kill('SIGTERM');
  await again.exited;
});
