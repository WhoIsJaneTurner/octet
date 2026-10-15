import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeRunner, parseIdentities, Store, submitRequest, type Ctx, type Project } from '../src/index.ts';

export const IDS = `
[identities.wijt]
name = "WhoIsJaneTurner"
email = "wijt@example.com"
ssh_key = "/nonexistent"
gh_user = "WhoIsJaneTurner"
`;

/** A git repo, a vault directory and a context wired to a FakeRunner. */
export function setup(over: Partial<Project> = {}, ctxOver: Partial<Ctx> = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'octet-pl-'));
  const vault = mkdtempSync(join(tmpdir(), 'octet-vault-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  g('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  g('add', '.');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  g('remote', 'add', 'origin', 'git@github.com:WhoIsJaneTurner/demo.git');
  const runner = new FakeRunner();
  const project: Project = { name: 'demo', path: repo, identity: 'wijt', vault, ...over };
  const ctx: Ctx = {
    store: new Store(':memory:'), identities: parseIdentities(IDS), runner, projects: [project],
    runsDir: mkdtempSync(join(tmpdir(), 'octet-runs-')), heartbeatMs: 20, ...ctxOver,
  };
  return { ctx, runner, repo, vault, project };
}

export const bead = (id: string, extra: Record<string, unknown> = {}) => ({
  id, title: `Bead ${id}`, objective: `Do ${id}`, files: [`src/${id}.ts`], acceptance: [`${id} works`],
  out_of_scope: [], depends_on: [], size: 's', ...extra,
});

export const planJson = (beads: unknown[] = [bead('b1'), bead('b2', { depends_on: ['b1'] })], extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    approach: 'Add the thing in two steps.', assumptions: ['Node 24'], not_doing: ['No refactor'], risks: ['Might be slow'],
    verification: ['Run the tests'], beads, ...extra,
  });

export function routed(ctx: Ctx, title = 'Add the thing', body = 'please') {
  return submitRequest(ctx, { source: 'ui', project: 'demo', title, body, requester: 'me' }).request;
}
