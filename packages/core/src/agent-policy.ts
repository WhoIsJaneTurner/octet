import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DENIED_TOOLS } from './runner.ts';

/**
 * What Octet allows when an agent that Octet does not control (an ACP agent) asks the client to act.
 * Pure functions, so the boundary can be tested without spawning anything.
 */

/** `Bash(git push:*)` becomes ['git', 'push']: the command words the Claude deny-list blocks. */
const deniedWords = DENIED_TOOLS.map((t) => /^Bash\((.+?):\*\)$/.exec(t)?.[1]?.split(/\s+/) ?? []).filter((w) => w.length >= 2);

const deniedPatterns = deniedWords.map((w) => ({
  label: w.join(' '),
  // The first word, then (within the same shell segment) the second word anywhere after it. Over-blocking
  // `git commit -m "push"` is the right failure for a deny-list.
  re: new RegExp(`(?<![\\w-])${w[0]}(?![\\w])[^;&|\\n]*?(?<![\\w-])${w[1]}(?![\\w])`),
}));

/** The first denied action a command line contains, or undefined. Same denials as DENIED_TOOLS. */
export function deniedCommand(commandLine: string): string | undefined {
  return deniedPatterns.find((p) => p.re.test(commandLine))?.label;
}

export type Confined = { ok: true; path: string } | { ok: false; reason: string };

/** Resolves `p` and accepts it only if it is inside `root` after symlinks are followed. Writes may not touch `.git`. */
export function confinePath(root: string, p: unknown, write: boolean): Confined {
  if (typeof p !== 'string' || !p || p.includes('\0')) return { ok: false, reason: 'path is not a usable string' };
  if (!isAbsolute(p)) return { ok: false, reason: 'path is not absolute' };
  let realRoot: string;
  try { realRoot = realpathSync(root); } catch { return { ok: false, reason: 'worktree is not readable' }; }
  // Follow symlinks in the part that exists; the rest (a file about to be created) is appended as written.
  let existing = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try { existing = realpathSync(existing); break; } catch {
      const parent = dirname(existing);
      if (parent === existing) return { ok: false, reason: 'path has no existing ancestor' };
      tail.unshift(basename(existing));
      existing = parent;
    }
  }
  const full = join(existing, ...tail);
  const rel = relative(realRoot, full);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return { ok: false, reason: 'path is outside the worktree' };
  if (write && rel.split(sep).includes('.git')) return { ok: false, reason: 'writes to .git are not allowed' };
  if (write && rel === '') return { ok: false, reason: 'cannot write the worktree root' };
  return { ok: true, path: full };
}

export interface PermissionOption { optionId: string; name?: string; kind?: string }

export interface PermissionInput {
  /** `toolCall` of a session/request_permission request, as sent by the agent. Untrusted. */
  toolCall?: { kind?: unknown; title?: unknown; rawInput?: unknown; locations?: unknown };
  options?: PermissionOption[];
}

export interface PermissionDecision {
  allowed: boolean;
  reason: string;
  /** The option to answer with; absent means answer `cancelled`. */
  optionId?: string;
  subject: string;
}

const SAFE_KINDS = new Set(['read', 'search', 'think']);
const WRITE_KINDS = new Set(['edit', 'delete', 'move']);

const asStrings = (v: unknown): string[] =>
  typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** Paths and command text an agent put in a tool call, wherever the common agents put them. */
function describe(tc: NonNullable<PermissionInput['toolCall']>): { text: string; paths: string[]; command: string } {
  const raw = (tc.rawInput && typeof tc.rawInput === 'object' ? tc.rawInput : {}) as Record<string, unknown>;
  const locs = Array.isArray(tc.locations) ? tc.locations : [];
  const paths = [
    ...locs.map((l) => (l as { path?: unknown })?.path).filter((x): x is string => typeof x === 'string'),
    ...asStrings(raw.path), ...asStrings(raw.file_path), ...asStrings(raw.filePath),
  ];
  const command = [...asStrings(raw.command), ...asStrings(raw.cmd), ...asStrings(raw.args)].join(' ');
  const title = typeof tc.title === 'string' ? tc.title : '';
  let rawText = '';
  try { rawText = tc.rawInput === undefined ? '' : JSON.stringify(tc.rawInput); } catch { /* unserialisable: judged on the rest */ }
  return { text: `${title} ${command} ${rawText}`, paths, command };
}

export function decidePermission(root: string, readOnly: boolean, input: PermissionInput): PermissionDecision {
  const tc = input.toolCall ?? {};
  const kind = typeof tc.kind === 'string' ? tc.kind : 'other';
  const { text, paths } = describe(tc);
  const subject = `${kind}: ${(typeof tc.title === 'string' ? tc.title : '').slice(0, 200)}`;
  const options = input.options ?? [];
  const pick = (...kinds: string[]) => kinds.map((k) => options.find((o) => o.kind === k)).find(Boolean)?.optionId;
  const deny = (reason: string): PermissionDecision => {
    const optionId = pick('reject_once', 'reject_always');
    return { allowed: false, reason, subject, ...(optionId ? { optionId } : {}) };
  };

  const hit = deniedCommand(text);
  if (hit) return deny(`denied action: ${hit}`);
  if (SAFE_KINDS.has(kind)) {
    for (const p of paths) {
      const c = confinePath(root, p, false);
      if (!c.ok) return deny(c.reason);
    }
  } else if (WRITE_KINDS.has(kind)) {
    if (readOnly) return deny('read-only seat');
    for (const p of paths) {
      const c = confinePath(root, p, true);
      if (!c.ok) return deny(c.reason);
    }
  } else if (kind === 'execute') {
    if (readOnly) return deny('read-only seat');
  } else {
    return deny(`tool kind "${kind}" is not allowed`);
  }
  // Only ever a one-time grant: Octet never lets an agent persist its own permissions.
  const optionId = pick('allow_once');
  if (!optionId) return deny('no one-time allow option offered');
  return { allowed: true, reason: `${kind} allowed`, optionId, subject };
}
