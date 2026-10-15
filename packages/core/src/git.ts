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

/**
 * The branch work is based on and PRs target. Never guesses silently: origin/HEAD first, then a lone `main` or
 * `master`, then a repo with a single local branch, then the remote itself; ambiguity is an error that names the fix.
 */
export function defaultBranch(repo: string, env: Env, configured?: string): string {
  if (configured) return configured;
  try {
    return git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], env).replace(/^origin\//, '');
  } catch { /* no local record of the remote's default */ }
  const locals = git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], env).split('\n').filter((b) => b && !b.startsWith('octet/') && !b.startsWith('feat/'));
  const common = locals.filter((b) => b === 'main' || b === 'master');
  if (common.length === 1) return common[0]!;
  if (!common.length && locals.length === 1) return locals[0]!;
  try {
    const out = execFileSync('git', ['ls-remote', '--symref', 'origin', 'HEAD'], { cwd: repo, env, encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] });
    const m = out.match(/^ref: refs\/heads\/(\S+)\s+HEAD/m);
    if (m) return m[1]!;
  } catch { /* offline or unauthenticated */ }
  throw new OctetError(`Cannot tell which branch is the default in ${repo} (candidates: ${locals.join(', ') || 'none'}). Set default_branch for the project in projects.toml.`);
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

/** Files with unresolved merge conflicts in a worktree. */
export function unmergedFiles(wt: string, env: Env): string[] {
  return git(wt, ['diff', '--name-only', '--diff-filter=U'], env).split('\n').filter(Boolean);
}

export function isMerging(wt: string, env: Env): boolean {
  try { git(wt, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], env); return true; } catch { return false; }
}

export function abortMerge(wt: string, env: Env): void {
  if (isMerging(wt, env)) git(wt, ['merge', '--abort'], env);
}

export type MergeAttempt = { ok: true } | { ok: false; files: string[] };

/**
 * Merges `branch` into the worktree's branch. A conflict is a normal outcome, not an exception: the files are
 * reported and the worktree is left in the conflicted state for the caller to abort or hand to an engineer.
 */
export function tryMerge(wt: string, branch: string, message: string, env: Env): MergeAttempt {
  try {
    mergeBranch(wt, branch, message, env);
    return { ok: true };
  } catch (e) {
    const files = unmergedFiles(wt, env);
    if (!files.length) throw e; // a failure that is not a conflict
    return { ok: false, files };
  }
}

/** Commits on `base` that this worktree's branch does not have yet. */
export function commitsBehind(wt: string, base: string, env: Env): number {
  return Number(git(wt, ['rev-list', '--count', `HEAD..${base}`], env));
}

/** Do any of these files still contain conflict markers? */
export function hasConflictMarkers(wt: string, files: string[]): boolean {
  return files.some((f) => {
    try { return /^(<<<<<<< |>>>>>>> |=======$)/m.test(readFileSync(join(wt, f), 'utf8')); } catch { return false; }
  });
}
