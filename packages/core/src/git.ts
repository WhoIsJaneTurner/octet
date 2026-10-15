import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { OctetError } from './errors.ts';

export type Env = NodeJS.ProcessEnv;

export function git(cwd: string, args: string[], env: Env): string {
  try {
    return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    const stderr = String((e as { stderr?: unknown }).stderr ?? '').trim();
    throw new OctetError(`git ${args.join(' ')} failed in ${cwd}: ${stderr || (e as Error).message}`);
  }
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'item';
}

export function defaultBranch(repo: string, env: Env): string {
  try {
    return git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], env).replace(/^origin\//, '');
  } catch {
    return git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'], env);
  }
}

export function remoteUrl(repo: string, env: Env): string | null {
  try {
    return git(repo, ['remote', 'get-url', 'origin'], env);
  } catch {
    return null;
  }
}

/** Keeps Octet's worktrees out of the user's `git status`. */
export function ensureExcluded(repo: string, env: Env): void {
  const rel = git(repo, ['rev-parse', '--git-path', 'info/exclude'], env);
  const file = resolve(repo, rel);
  mkdirSync(dirname(file), { recursive: true });
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (!current.split('\n').includes('.octet/')) appendFileSync(file, `${current.endsWith('\n') || !current ? '' : '\n'}.octet/\n`);
}

export const worktreePath = (repo: string, name: string): string => join(repo, '.octet', 'worktrees', name);

/** Creates `branch` from `base` (or reuses it) and checks it out in a new worktree at `path`. */
export function addWorktree(repo: string, path: string, branch: string, base: string, env: Env): void {
  const exists = (() => {
    try {
      git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], env);
      return true;
    } catch {
      return false;
    }
  })();
  const args = exists ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, base];
  git(repo, args, env);
}

export function removeWorktree(repo: string, path: string, env: Env): void {
  git(repo, ['worktree', 'remove', '--force', path], env);
}

export function hasChanges(wt: string, env: Env): boolean {
  return git(wt, ['status', '--porcelain'], env) !== '';
}

export function commitAll(wt: string, message: string, env: Env): boolean {
  if (!hasChanges(wt, env)) return false;
  git(wt, ['add', '-A'], env);
  git(wt, ['commit', '-m', message], env);
  return true;
}

export function mergeBranch(wt: string, branch: string, message: string, env: Env): void {
  git(wt, ['merge', '--no-ff', '-m', message, branch], env);
}

export function commitsAhead(wt: string, base: string, env: Env): number {
  return Number(git(wt, ['rev-list', '--count', `${base}..HEAD`], env));
}
