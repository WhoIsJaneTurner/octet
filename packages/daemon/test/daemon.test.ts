import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { FakeForge, FakeRunner, Store } from '@octet/core';
import { startDaemon, type Daemon } from '../src/server.ts';

let d: Daemon;
const forge = new FakeForge();
const runner = new FakeRunner();
let runsDir: string;
let repo: string;
const base = () => `http://127.0.0.1:${d.port}`;
const call = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(base() + path, {
    ...init,
    headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  return { status: res.status, body: (await res.json()) as any };
};
const waitFor = async (fn: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 30)); }
  throw new Error('timed out');
};

before(async () => {
  const home = mkdtempSync(join(tmpdir(), 'octet-home-'));
  repo = mkdtempSync(join(tmpdir(), 'octet-drepo-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  g('init', '-q', '-b', 'main');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  g('remote', 'add', 'origin', 'git@github.com:WhoIsJaneTurner/demo.git');
  const identitiesFile = join(home, 'identities.toml');
  writeFileSync(identitiesFile, '[identities.wijt]\nname="Bot"\nemail="wijt@example.com"\nssh_key="/nonexistent"\ngh_user="WhoIsJaneTurner"\n');
  const projectsFile = join(home, 'projects.toml');
  writeFileSync(projectsFile, `[projects.demo]\npath = "${repo}"\nidentity = "wijt"\n`);
  runsDir = join(home, 'runs');
  const uiDir = join(home, 'ui') + '/'; // trailing slash, as the real entrypoint passes it
  mkdirSync(join(uiDir, 'assets'), { recursive: true });
  writeFileSync(join(uiDir, 'index.html'), '<meta name="octet-token" content="__OCTET_TOKEN__">');
  writeFileSync(join(uiDir, 'assets', 'a.js'), 'console.log(1)');
  writeFileSync(join(home, 'secret.txt'), 'top secret');
  d = await startDaemon({ store: new Store(':memory:'), runner, forge, runsDir, identitiesFile, projectsFile, uiDir });
});
after(() => d.close());

test('rejects requests without the token', async () => {
  const res = await fetch(`${base()}/api/state`);
  assert.equal(res.status, 401);
});

test('rejects a foreign Host header (DNS rebinding)', async () => {
  // fetch() forbids overriding Host, so use a raw request.
  const status = await new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: d.port, path: '/api/state',
      headers: { host: 'evil.example.com', authorization: `Bearer ${d.token}` } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});

test('state never exposes key paths', async () => {
  const { status, body } = await call('/api/state');
  assert.equal(status, 200);
  assert.equal(body.seats.length, 8);
  assert.ok(!JSON.stringify(body).includes('/nonexistent'));
});

test('full loop over HTTP: goal, bead, run, diff, request changes, rerun, approve', async () => {
  const goal = (await call('/api/goals', { method: 'POST', body: JSON.stringify({ project: 'demo', title: 'HTTP loop' }) })).body;
  const bead = (await call('/api/beads', { method: 'POST', body: JSON.stringify({ goalId: goal.id, title: 'B', brief: 'do it' }) })).body;

  assert.equal((await call(`/api/beads/${bead.id}/run`, { method: 'POST' })).status, 202);
  await waitFor(async () => (await call('/api/state')).body.beads[0].status === 'in_review');

  const diff = (await call(`/api/beads/${bead.id}/diff`)).body.diff as string;
  assert.match(diff, /engineer-output\.txt/);

  const noFeedback = await call(`/api/beads/${bead.id}/changes`, { method: 'POST', body: JSON.stringify({ feedback: ' ' }) });
  assert.equal(noFeedback.status, 400);
  await call(`/api/beads/${bead.id}/changes`, { method: 'POST', body: JSON.stringify({ feedback: 'add tests' }) });
  assert.equal((await call('/api/state')).body.beads[0].status, 'changes_requested');

  await call(`/api/beads/${bead.id}/run`, { method: 'POST' });
  await waitFor(async () => (await call('/api/state')).body.beads[0].status === 'in_review');
  const out = (await call(`/api/beads/${bead.id}/output`)).body.output as string;
  assert.match(out, /fake run complete/);

  const approved = await call(`/api/beads/${bead.id}/approve`, { method: 'POST' });
  assert.equal(approved.body.status, 'merged');
});

test('SSE announces changes', async () => {
  const res = await fetch(`${base()}/api/events?token=${d.token}`);
  const reader = res.body!.getReader();
  await call('/api/goals', { method: 'POST', body: JSON.stringify({ project: 'demo', title: 'sse' }) });
  let text = '';
  const dec = new TextDecoder();
  for (let i = 0; i < 10 && !text.includes('event: change'); i++) text += dec.decode((await reader.read()).value);
  await reader.cancel();
  assert.match(text, /event: change/);
});

test('unknown projects and bad input give clean errors, not 500s', async () => {
  const r = await call('/api/goals', { method: 'POST', body: JSON.stringify({ project: 'nope', title: 'x' }) });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Unknown project/);
  assert.equal((await call('/api/goals', { method: 'POST', body: '{bad' })).status, 400);
});

test('serves the UI with the token injected, and never files outside the UI dir', async () => {
  const html = await (await fetch(`${base()}/`)).text();
  assert.ok(html.includes(d.token));
  assert.ok(!html.includes('__OCTET_TOKEN__'));
  const js = await fetch(`${base()}/assets/a.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type') ?? '', /javascript/);
  // Raw request so the client does not normalize the traversal away.
  const body = await new Promise<string>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: d.port, path: '/..%2fsecret.txt' }, (res) => {
      let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve(t));
    });
    req.on('error', reject); req.end();
  });
  assert.ok(!body.includes('top secret'));
});

test('delivery over HTTP: request, inspect, approve, and the audit chain stays valid', async () => {
  const goal = (await call('/api/goals', { method: 'POST', body: JSON.stringify({ project: 'demo', title: 'Deliver me' }) })).body;
  const bead = (await call('/api/beads', { method: 'POST', body: JSON.stringify({ goalId: goal.id, title: 'B', brief: 'x' }) })).body;
  const early = await call(`/api/goals/${goal.id}/deliver`, { method: 'POST' });
  assert.equal(early.status, 400);
  assert.match(early.body.error, /Not every bead is merged/);

  await call(`/api/beads/${bead.id}/run`, { method: 'POST' });
  await waitFor(async () => (await call('/api/state')).body.beads.find((b: any) => b.id === bead.id).status === 'in_review');
  await call(`/api/beads/${bead.id}/approve`, { method: 'POST' });

  const appr = await call(`/api/goals/${goal.id}/deliver`, { method: 'POST' });
  assert.equal(appr.status, 201);
  assert.equal(forge.pushes.length, 0, 'asking pushes nothing');
  const state = (await call('/api/state')).body;
  assert.equal(state.approvals.filter((a: any) => a.status === 'pending').length, 1);

  const done = await call(`/api/approvals/${appr.body.id}/approve`, { method: 'POST' });
  assert.equal(done.body.status, 'approved');
  assert.equal(forge.pushes.length, 1);
  assert.equal((await call('/api/audit/verify')).body.ok, true);
  assert.equal((await call(`/api/approvals/${appr.body.id}/approve`, { method: 'POST' })).status, 400);
});

test('cancel over HTTP stops a stuck engineer; output survives from the run log', async () => {
  const goal = (await call('/api/goals', { method: 'POST', body: JSON.stringify({ project: 'demo', title: 'Cancel me' }) })).body;
  const bead = (await call('/api/beads', { method: 'POST', body: JSON.stringify({ goalId: goal.id, title: 'Stuck', brief: 'x' }) })).body;
  runner.hang.add('engineer');
  assert.equal((await call(`/api/beads/${bead.id}/cancel`, { method: 'POST', body: '{}' })).status, 400); // not running yet
  assert.equal((await call(`/api/beads/${bead.id}/run`, { method: 'POST', body: '{}' })).status, 202);
  await waitFor(async () => (await call('/api/state')).body.running.includes(bead.id));
  assert.equal((await call(`/api/beads/${bead.id}/cancel`, { method: 'POST', body: '{}' })).status, 202);
  await waitFor(async () => (await call('/api/state')).body.beads.find((b: any) => b.id === bead.id).status === 'failed');
  const st = (await call('/api/state')).body;
  assert.deepEqual(st.running, []);
  assert.ok(st.events.some((e: any) => e.kind === 'bead.cancelled' && e.beadId === bead.id));
  assert.match((await call(`/api/beads/${bead.id}/output`)).body.output, /working/);
  runner.hang.clear();
});

test('requests over HTTP: file, route, decline; the source cannot be spoofed and the chain stays valid', async () => {
  const post = (path: string, body: unknown) => call(path, { method: 'POST', body: JSON.stringify(body) });
  const a = (await post('/api/requests', { title: 'Do the thing', body: 'details', source: 'github', requester: 'root' })).body;
  assert.deepEqual([a.status, a.project, a.source, a.requester], ['new', null, 'ui', 'local user']);
  assert.equal((await post('/api/requests', { title: '' })).status, 400);
  assert.equal((await post('/api/requests', { title: 'x', project: 'nope' })).status, 400);
  assert.equal((await post(`/api/requests/${a.id}/route`, { project: 'nope' })).status, 400);
  assert.equal((await post(`/api/requests/${a.id}/route`, { project: 'demo' })).body.status, 'routed');
  const b = (await post('/api/requests', { title: 'Second', project: 'demo' })).body;
  assert.equal(b.status, 'routed');
  assert.equal((await post(`/api/requests/${b.id}/reject`, {})).status, 400); // reason required
  assert.equal((await post(`/api/requests/${b.id}/reject`, { reason: 'later' })).body.rejectReason, 'later');
  const st = (await call('/api/state')).body;
  assert.equal(st.requests.length, 2);
  assert.equal(st.audit.ok, true);
});
