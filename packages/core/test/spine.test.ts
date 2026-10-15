import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  addBead, approveBead, createGoal, FakeRunner, parseIdentities, runBead, Store, type Ctx,
} from '../src/index.ts';

const run = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();

function setup(remote?: string) {
  const repo = mkdtempSync(join(tmpdir(), 'octet-repo-'));
  run(repo, 'init', '-q', '-b', 'main');
  run(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  writeFileSync(join(repo, 'README.md'), 'hello\n');
  run(repo, 'add', '.');
  run(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'readme');
  if (remote) run(repo, 'remote', 'add', 'origin', remote);
  const identities = parseIdentities(`
[identities.wijt]
name = "Jane Bot"
email = "wijt@example.com"
ssh_key = "/nonexistent"
gh_user = "WhoIsJaneTurner"
`);
  const runner = new FakeRunner();
  const ctx: Ctx = {
    store: new Store(':memory:'), identities, runner,
    projects: [{ name: 'demo', path: repo, identity: 'wijt' }],
  };
  return { repo, ctx, runner };
}

test('goal -> bead -> engineer run -> approve lands the work on the goal branch under the right identity', async () => {
  const { repo, ctx, runner } = setup('git@github.com:WhoIsJaneTurner/demo.git');
  const goal = createGoal(ctx, { project: 'demo', title: 'Add rate limiting' });
  assert.ok(existsSync(goal.worktree));
  assert.equal(run(repo, 'status', '--porcelain'), '', 'main checkout stays clean');

  const bead = addBead(ctx, { goalId: goal.id, title: 'Middleware', brief: 'Write the middleware.' });
  const ran = await runBead(ctx, bead.id);
  assert.equal(ran.status, 'in_review');
  assert.equal(runner.calls[0]!.seat, 'engineer');
  assert.match(runner.calls[0]!.prompt, /Write the middleware/);
  assert.equal(runner.calls[0]!.env.GIT_AUTHOR_EMAIL, 'wijt@example.com');

  const merged = approveBead(ctx, bead.id);
  assert.equal(merged.status, 'merged');
  assert.ok(existsSync(join(goal.worktree, 'engineer-output.txt')), 'work reached the goal branch');
  assert.ok(!existsSync(join(repo, 'engineer-output.txt')), 'main checkout untouched');
  assert.equal(run(repo, 'log', '-1', '--format=%ae', goal.branch), 'wijt@example.com');
  assert.equal(readFileSync(join(repo, 'README.md'), 'utf8'), 'hello\n');
});

test('a bead waits for its dependencies to be merged', async () => {
  const { ctx } = setup();
  const goal = createGoal(ctx, { project: 'demo', title: 'Two step' });
  const a = addBead(ctx, { goalId: goal.id, title: 'A', brief: 'first' });
  const b = addBead(ctx, { goalId: goal.id, title: 'B', brief: 'second', dependsOn: [a.id] });
  await assert.rejects(runBead(ctx, b.id), /waiting on/);
  await runBead(ctx, a.id);
  approveBead(ctx, a.id);
  assert.equal((await runBead(ctx, b.id)).status, 'in_review');
});

test('Octet refuses to start a goal when the remote belongs to another account', () => {
  const { ctx } = setup('git@github.com:bioSandMan/other.git');
  assert.throws(() => createGoal(ctx, { project: 'demo', title: 'x' }), /Refusing to start/);
});

test('an unreviewed bead cannot be merged', () => {
  const { ctx } = setup();
  const goal = createGoal(ctx, { project: 'demo', title: 'g' });
  const bead = addBead(ctx, { goalId: goal.id, title: 'b', brief: 'x' });
  assert.throws(() => approveBead(ctx, bead.id), /not in_review/);
});
