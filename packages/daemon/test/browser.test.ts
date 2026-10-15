import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FakeForge, FakeRunner, Store } from '@octet/core';
import { startDaemon, type Daemon } from '../src/server.ts';
import { Browser, chromeAvailable, type Page } from './cdp.ts';

// Real-browser smoke test. Off by default so the suite stays fast: OCTET_BROWSER=1 pnpm test.
// Needs Chrome (OCTET_CHROME overrides the path) and a built UI (pnpm ui:build).
const uiDir = fileURLToPath(new URL('../../ui/dist/', import.meta.url));
const skip = process.env.OCTET_BROWSER !== '1' ? 'set OCTET_BROWSER=1 to run the browser smoke test'
  : !chromeAvailable() ? 'Chrome not found (set OCTET_CHROME)'
    : !existsSync(join(uiDir, 'index.html')) ? 'UI not built (run pnpm ui:build)' : false;

let d: Daemon;
let browser: Browser;
let page: Page;
const api = async (path: string) => (await fetch(`http://127.0.0.1:${d.port}${path}`, { headers: { authorization: `Bearer ${d.token}` } })).json() as Promise<any>;

before(async () => {
  if (skip) return;
  const home = mkdtempSync(join(tmpdir(), 'octet-browser-'));
  const repo = join(home, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  const identitiesFile = join(home, 'identities.toml');
  writeFileSync(identitiesFile, '[identities.wijt]\nname="Bot"\nemail="wijt@example.com"\nssh_key="/nonexistent"\ngh_user="WhoIsJaneTurner"\n');
  const projectsFile = join(home, 'projects.toml');
  writeFileSync(projectsFile, `[projects.demo]\npath = "${repo}"\nidentity = "wijt"\n`);
  d = await startDaemon({
    store: new Store(':memory:'), runner: new FakeRunner(), forge: new FakeForge(), runsDir: join(home, 'runs'),
    identitiesFile, projectsFile, uiDir,
  });
  browser = await Browser.launch();
  page = await browser.newPage();
});

after(async () => {
  await browser?.close();
  await d?.close();
});

test('UI smoke: council table, submit a request, see it in the inbox, route it, then decline another', { skip }, async () => {
  await page.goto(`http://127.0.0.1:${d.port}/`);

  // The council: eight seats once the first state load lands.
  await page.waitFor("document.querySelectorAll('table tbody tr').length === 8", 'the council table with 8 seats');
  const seats = await page.eval<string[]>("[...document.querySelectorAll('table tbody tr td:first-child')].map((td) => td.textContent)");
  assert.deepEqual(seats.slice().sort(), ['Architect', 'Chair', 'Courier', 'Engineer', 'Marshal', 'Reviewer', 'Scout', 'Warden']);
  await page.waitFor("document.body.innerText.includes('daemon online')", 'the daemon-online indicator');

  // Submit a new request from the form. No project chosen, so it waits in the inbox.
  await page.type('#rq-title', 'Add rate limiting to the upload endpoint');
  await page.type('#rq-body', 'Keep it under 100 requests a minute.');
  await page.waitFor("[...document.querySelectorAll('button')].some((b) => b.textContent === 'SUBMIT REQUEST' && !b.disabled)", 'the submit button to enable');
  await page.clickButton('SUBMIT REQUEST');
  await page.waitFor("document.body.innerText.includes('to route')", 'the header to show a request waiting to be routed');
  let requests = (await api('/api/state')).requests as { id: string; title: string; status: string; source: string }[];
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.status, 'new');
  assert.equal(requests[0]!.source, 'ui');

  // It shows up in the inbox; route it to the project.
  await page.clickButton('inbox');
  await page.waitFor("[...document.querySelectorAll('h3')].some((h) => h.textContent === 'Add rate limiting to the upload endpoint')", 'the request in the inbox');
  await page.select('select[aria-label^="Project for Add rate"]', 'demo');
  await page.clickButton('ROUTE');
  await page.waitFor("document.body.innerText.includes('routed to demo')", 'the request to show as routed');
  requests = (await api('/api/state')).requests;
  assert.equal(requests[0]!.status, 'routed');

  // A second request, declined through the browser's own prompt dialog.
  await page.clickButton('council');
  await page.waitFor("!!document.querySelector('#rq-title')", 'the request form');
  await page.type('#rq-title', 'Rewrite everything in Rust');
  await page.clickButton('SUBMIT REQUEST');
  for (let i = 0; i < 100 && (await api('/api/state')).requests.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
  await page.clickButton('inbox');
  await page.waitFor("[...document.querySelectorAll('h3')].some((h) => h.textContent === 'Rewrite everything in Rust')", 'the second request in the inbox');
  page.nextPrompt = 'out of scope';
  await page.eval(`(() => {
    const box = [...document.querySelectorAll('.box')].find((b) => b.querySelector('h3')?.textContent === 'Rewrite everything in Rust');
    [...box.querySelectorAll('button')].find((b) => b.textContent === 'DECLINE').click();
  })()`);
  await page.waitFor("![...document.querySelectorAll('h3')].some((h) => h.textContent === 'Rewrite everything in Rust')", 'the declined request to leave the inbox');
  assert.equal(page.dialogs.length, 1);
  const final = (await api('/api/state')).requests as { title: string; status: string; rejectReason: string | null }[];
  const declined = final.find((r) => r.title === 'Rewrite everything in Rust')!;
  assert.equal(declined.status, 'rejected');
  assert.equal(declined.rejectReason, 'out of scope');
  assert.equal(final.find((r) => r.title.startsWith('Add rate'))!.status, 'routed');
  assert.equal((await api('/api/audit/verify')).ok, true);
});
