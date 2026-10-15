import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { FakeForge, FakeRunner, Store } from '@octet/core';
import { watchForNotifications } from '../src/notify.ts';
import { startDaemon, type Daemon } from '../src/server.ts';

// Never read the real ~/.config/octet or ~/.local/share/octet.
const home = mkdtempSync(join(tmpdir(), 'octet-mhome-'));
process.env.OCTET_HOME = join(home, 'config');
process.env.OCTET_DATA = join(home, 'data');

let d: Daemon;
let store: Store;
let repo: string;
let repo2: string;
let projectsFile: string;
const runner = new FakeRunner();
const notes: { title: string; body: string }[] = [];
const doctorCalls: string[][] = [];
const base = () => `http://127.0.0.1:${d.port}`;
const call = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(base() + path, {
    ...init, headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  return { status: res.status, body: (await res.json()) as any };
};
const post = (path: string, body: unknown = {}) => call(path, { method: 'POST', body: JSON.stringify(body) });
const state = async () => (await call('/api/state')).body;
const waitFor = async (fn: () => Promise<boolean> | boolean) => {
  for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 30)); }
  throw new Error('timed out');
};
const makeRepo = () => {
  const r = mkdtempSync(join(tmpdir(), 'octet-mrepo-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: r, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  g('init', '-q', '-b', 'main');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  g('remote', 'add', 'origin', 'git@github.com:WhoIsJaneTurner/demo.git');
  return r;
};

before(async () => {
  repo = makeRepo();
  repo2 = makeRepo();
  const identitiesFile = join(home, 'identities.toml');
  writeFileSync(identitiesFile, '[identities.wijt]\nname="Bot"\nemail="wijt@example.com"\nssh_key="/nonexistent"\ngh_user="WhoIsJaneTurner"\n');
  projectsFile = join(home, 'projects.toml');
  writeFileSync(projectsFile, `[projects.demo]\npath = "${repo}"\nidentity = "wijt"\n`);
  store = new Store(':memory:');
  d = await startDaemon({
    store, runner, forge: new FakeForge(), runsDir: join(home, 'runs'), scheduler: false, identitiesFile, projectsFile,
    limits: { maxEngineers: 3, maxActiveGoals: 50, runTimeoutMs: 60_000 },
    usage: { dailyCostUsd: 1 },
    notifier: (title, body) => { notes.push({ title, body }); },
    doctor: async (ids) => { doctorCalls.push(ids.map((i) => i.id)); return ids.map((i) => ({ id: i.id, ghUser: i.ghUser, sshUser: i.ghUser, sshOk: true, tokenOk: false, ok: false })); },
  });
});
after(() => d.close());

test('adding a project from the form: vault and autonomy are stored, validated, and shown in state', async () => {
  const vault = join(home, 'vault2');
  const r = await post('/api/projects', { name: 'second', path: repo2, identity: 'wijt', vault, autonomy: 'auto-to-pr', vaultGit: true });
  assert.equal(r.status, 201);
  assert.deepEqual([r.body.vault, r.body.autonomy, r.body.vaultGit], [vault, 'auto-to-pr', true]);
  const p = (await state()).projects.find((x: any) => x.name === 'second');
  assert.equal(p.autonomy, 'auto-to-pr');
  assert.equal(p.vault, vault);

  assert.equal((await post('/api/projects', { name: 'second', path: repo2, identity: 'wijt' })).status, 400); // duplicate
  assert.equal((await post('/api/projects', { name: 'x', path: repo2, identity: 'nobody' })).status, 400);
  assert.equal((await post('/api/projects', { name: 'x', path: join(home, 'nope'), identity: 'wijt' })).status, 400); // not a repo
  const bad = await post('/api/projects', { name: 'x', path: repo2, identity: 'wijt', autonomy: 'reckless' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /autonomy must be one of/);
  assert.equal((await post('/api/projects', { name: 'x', path: repo2, identity: 'wijt', vaultGit: 'yes' })).status, 400);
  assert.equal((await post('/api/projects', { name: 'x', path: repo2, identity: 'wijt', vault: 5 })).status, 400);
  assert.equal((await state()).projects.some((x: any) => x.name === 'x'), false);
});

test('changing a project\'s autonomy and vault from the UI', async () => {
  const r = await post('/api/projects/second', { autonomy: 'manual' });
  assert.equal(r.status, 200);
  assert.equal(r.body.autonomy, 'manual');
  assert.equal((await state()).projects.find((x: any) => x.name === 'second').autonomy, 'manual');
  assert.equal((await post('/api/projects/ghost', { autonomy: 'manual' })).status, 400);
  assert.equal((await post('/api/projects/second', { autonomy: 'nope' })).status, 400);
});

test('the daemon re-reads projects.toml when the file changes, and keeps the last good list if it breaks', async () => {
  const repo3 = makeRepo();
  const toml = `[projects.demo]\npath = "${repo}"\nidentity = "wijt"\n\n[projects.second]\npath = "${repo2}"\nidentity = "wijt"\n\n[projects.fromcli]\npath = "${repo3}"\nidentity = "wijt"\n`;
  writeFileSync(projectsFile, toml); // what `octet project add` does from another shell
  const st = await state(); // the very next request sees it, no restart
  assert.ok(st.projects.some((p: any) => p.name === 'fromcli'));
  assert.equal(st.projectsError, undefined);

  writeFileSync(projectsFile, '[projects.broken]\npath = "/x"\n'); // missing identity
  const bad = await state();
  assert.ok(bad.projects.some((p: any) => p.name === 'fromcli'), 'last good list is kept');
  assert.match(bad.projectsError, /missing "identity"/);

  writeFileSync(projectsFile, toml.replace('[projects.fromcli]', '[projects.renamed]'));
  const fixed = await state();
  assert.equal(fixed.projectsError, undefined);
  assert.ok(fixed.projects.some((p: any) => p.name === 'renamed') && !fixed.projects.some((p: any) => p.name === 'fromcli'));
  // A goal can be made in a project that only exists because the file changed.
  assert.equal((await post('/api/goals', { project: 'renamed', title: 'in a reloaded project' })).status, 201);
});

test('identity doctor runs only when asked, once at a time, and reports every identity', async () => {
  assert.equal(doctorCalls.length, 0, 'not run by loading state');
  await state();
  assert.equal(doctorCalls.length, 0);
  assert.equal((await call('/api/identities/doctor')).status, 404); // GET is not the way
  const [a, b] = await Promise.all([post('/api/identities/doctor'), post('/api/identities/doctor')]);
  assert.equal(a.status, 200);
  assert.deepEqual(a.body.results, [{ id: 'wijt', ghUser: 'WhoIsJaneTurner', sshUser: 'WhoIsJaneTurner', sshOk: true, tokenOk: false, ok: false }]);
  assert.ok(a.body.at && b.status === 200);
  assert.ok(doctorCalls.length >= 1 && doctorCalls.length <= 2);
});

test('edit and delete beads over HTTP, with the same rules as the core', async () => {
  const goal = (await post('/api/goals', { project: 'demo', title: 'manage beads' })).body;
  const a = (await post('/api/beads', { goalId: goal.id, title: 'A', brief: 'old brief' })).body;
  const b = (await post('/api/beads', { goalId: goal.id, title: 'B', brief: 'b', dependsOn: [a.id] })).body;

  const e = await post(`/api/beads/${a.id}/edit`, { brief: 'new brief', title: 'A2' });
  assert.deepEqual([e.status, e.body.brief, e.body.title], [200, 'new brief', 'A2']);
  assert.equal((await post(`/api/beads/${a.id}/edit`, { brief: '  ' })).status, 400);
  assert.equal((await post('/api/beads/ghost/edit', { brief: 'x' })).status, 400);

  const blocked = await call(`/api/beads/${a.id}`, { method: 'DELETE' });
  assert.equal(blocked.status, 400);
  assert.match(blocked.body.error, /"B" waits on it/);
  assert.equal((await call(`/api/beads/${b.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await call(`/api/beads/${a.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await state()).beads.some((x: any) => x.goalId === goal.id), false);
});

test('abandon a goal over HTTP: running agent stopped, worktrees removed, state shows it failed', async () => {
  const goal = (await post('/api/goals', { project: 'demo', title: 'abandon me' })).body;
  const bead = (await post('/api/beads', { goalId: goal.id, title: 'Stuck', brief: 'x' })).body;
  runner.hang.add('engineer');
  assert.equal((await post(`/api/beads/${bead.id}/run`)).status, 202);
  await waitFor(async () => (await state()).running.includes(bead.id));
  assert.ok(existsSync(bead.worktree));

  const r = await post(`/api/goals/${goal.id}/abandon`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.cancelled, [bead.id]);
  const st = await state();
  assert.equal(st.goals.find((g: any) => g.id === goal.id).status, 'failed');
  assert.deepEqual(st.running, []);
  assert.equal(existsSync(bead.worktree), false);
  assert.equal(existsSync(goal.worktree), false);
  assert.ok(st.events.some((e: any) => e.kind === 'goal.abandoned' && e.goalId === goal.id));
  assert.equal(st.audit.ok, true);
  assert.equal((await post(`/api/beads/${bead.id}/run`)).status, 202); // accepted, then refused inside: nothing runs
  await waitFor(async () => (await state()).events.some((e: any) => e.kind === 'bead.error' && /abandoned/.test(e.data.message)));
  assert.equal((await post('/api/goals/ghost/abandon')).status, 400);
  runner.hang.clear();
});

test('gc over HTTP: GET lists, POST with apply deletes', async () => {
  const stray = join(repo, '.octet', 'worktrees', 'stray-dir');
  mkdirSync(stray, { recursive: true });
  const dry = await call('/api/gc');
  assert.ok(dry.body.stragglers.some((s: any) => s.path === stray));
  assert.ok(existsSync(stray));
  assert.equal((await post('/api/gc', {})).body.removed.length, 0);
  assert.ok(existsSync(stray));
  const done = await post('/api/gc', { apply: true });
  assert.ok(done.body.removed.includes(stray));
  assert.equal(existsSync(stray), false);
});

test('a review can be cancelled over HTTP: the bead stays in review and the UI can see it was being reviewed', async () => {
  const goal = (await post('/api/goals', { project: 'demo', title: 'cancel review' })).body;
  const bead = (await post('/api/beads', { goalId: goal.id, title: 'R', brief: 'x' })).body;
  await post(`/api/beads/${bead.id}/run`);
  await waitFor(async () => (await state()).beads.find((b: any) => b.id === bead.id).status === 'in_review');

  runner.hang.add('reviewer');
  assert.equal((await post(`/api/beads/${bead.id}/review`)).status, 202);
  await waitFor(async () => (await state()).reviewing.includes(bead.id));
  assert.equal((await post(`/api/beads/${bead.id}/cancel`)).status, 202);
  await waitFor(async () => !(await state()).reviewing.includes(bead.id));
  const st = await state();
  assert.equal(st.beads.find((b: any) => b.id === bead.id).status, 'in_review');
  assert.ok(st.events.some((e: any) => e.kind === 'review.cancelled' && e.beadId === bead.id));
  runner.hang.clear();
});

test('usage totals and the daily ceiling are in state', async () => {
  runner.usage.set('engineer', { inputTokens: 100, outputTokens: 20, cacheReadTokens: 1000, cacheCreationTokens: 10, costUsd: 0.75 });
  const goal = (await post('/api/goals', { project: 'demo', title: 'costly' })).body;
  const bead = (await post('/api/beads', { goalId: goal.id, title: 'C', brief: 'x' })).body;
  let st = await state();
  assert.equal(st.usage.hold, undefined);
  await post(`/api/beads/${bead.id}/run`);
  await waitFor(async () => (await state()).usage.byBead[bead.id] !== undefined);
  st = await state();
  assert.equal(st.usage.byBead[bead.id].costUsd, 0.75);
  assert.equal(st.usage.byGoal[goal.id].inputTokens, 100);
  assert.ok(st.usage.byDay.length >= 1);
  assert.deepEqual(st.usage.ceiling, { dailyCostUsd: 1 });

  const bead2 = (await post('/api/beads', { goalId: goal.id, title: 'C2', brief: 'x' })).body;
  await post(`/api/beads/${bead2.id}/run`);
  await waitFor(async () => (await state()).usage.hold !== undefined);
  assert.match((await state()).usage.hold, /daily ceiling of \$1\.00/);
  runner.usage.clear();
});

test('notifications: new approvals and escalations notify once; what was already waiting does not; a notifier that throws is harmless', async () => {
  const goal = (await post('/api/goals', { project: 'demo', title: 'notify me' })).body;
  notes.length = 0;
  const a = store.insertApproval({ kind: 'deliver', goalId: goal.id, summary: { action: 'x' } });
  store.escalate({ goalId: goal.id, reason: 'idle', message: 'Nothing can run' });
  await waitFor(() => notes.length >= 2);
  await new Promise((r) => setTimeout(r, 400)); // further store activity must not repeat them
  await post('/api/goals', { project: 'demo', title: 'unrelated' });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(notes.length, 2);
  assert.deepEqual(notes.map((n) => n.title).sort(), ['Octet: a goal needs you', 'Octet: approval needed']);
  assert.match(notes.find((n) => n.title.includes('approval'))!.body, /delivery is waiting for your approval: notify me/);
  assert.match(notes.find((n) => n.title.includes('needs you'))!.body, /notify me: Nothing can run/);
  store.decideApproval(a.id, 'denied');
  assert.equal(notes.length, 2);
});

test('a notifier that throws does not stop other notifications or break the store', async () => {
  const s = new Store(':memory:');
  const got: string[] = [];
  const stop = watchForNotifications(s, (_t, body) => { got.push(body); throw new Error('osascript missing'); });
  s.insertApproval({ kind: 'plan', goalId: 'g1', summary: {} });
  s.insertApproval({ kind: 'comment', goalId: 'g2', summary: {} });
  await waitFor(() => got.length === 2);
  stop();
  s.insertApproval({ kind: 'plan', goalId: 'g3', summary: {} });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(got.length, 2);
});
