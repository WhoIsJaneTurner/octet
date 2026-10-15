import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { parse } from 'smol-toml';
import { OctetError } from './errors.ts';
import { identitiesFile } from './paths.ts';

export interface Identity {
  id: string;
  name: string;
  email: string;
  sshKey: string;
  ghUser: string;
  /** Extra GitHub owners (orgs) this identity may push to, besides its own user. */
  owners: string[];
  signingKey?: string;
}

export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? homedir() + p.slice(1) : p;
}

function str(table: Record<string, unknown>, key: string, id: string): string {
  const v = table[key];
  if (typeof v !== 'string' || v === '') {
    throw new OctetError(`identities.${id}: missing "${key}"`);
  }
  return v;
}

export function parseIdentities(text: string): Identity[] {
  const doc = parse(text) as { identities?: Record<string, Record<string, unknown>> };
  const out: Identity[] = [];
  for (const [id, t] of Object.entries(doc.identities ?? {})) {
    const owners = Array.isArray(t.owners) ? t.owners.map(String) : [];
    const signingKey = typeof t.signing_key === 'string' ? expandHome(t.signing_key) : undefined;
    out.push({
      id,
      name: str(t, 'name', id),
      email: str(t, 'email', id),
      sshKey: expandHome(str(t, 'ssh_key', id)),
      ghUser: str(t, 'gh_user', id),
      owners,
      ...(signingKey ? { signingKey } : {}),
    });
  }
  return out;
}

export function loadIdentities(file: string = identitiesFile()): Identity[] {
  if (!existsSync(file)) {
    throw new OctetError(
      `No identities file at ${file}. Copy identities.example.toml there and edit it.`,
    );
  }
  return parseIdentities(readFileSync(file, 'utf8'));
}

/** There is deliberately no default identity: callers must name one. */
export function getIdentity(list: Identity[], id: string | undefined): Identity {
  if (!id) throw new OctetError('No identity named. Octet has no default identity.');
  const found = list.find((i) => i.id === id);
  if (!found) {
    throw new OctetError(
      `Unknown identity "${id}". Available: ${list.map((i) => i.id).join(', ') || '(none)'}`,
    );
  }
  return found;
}

const STRIPPED_ENV = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_SSH_COMMAND'];

/** Environment variables that pin git to one identity, independent of ~/.gitconfig. */
export function gitEnv(id: Identity): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: id.name,
    GIT_AUTHOR_EMAIL: id.email,
    GIT_COMMITTER_NAME: id.name,
    GIT_COMMITTER_EMAIL: id.email,
    GIT_SSH_COMMAND: `ssh -i "${id.sshKey}" -o IdentitiesOnly=yes -o BatchMode=yes`,
    GIT_TERMINAL_PROMPT: '0',
    OCTET_IDENTITY: id.id,
  };
}

/** Full environment for a child process: inherited env minus other identities' credentials. */
export function childEnv(
  id: Identity,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of STRIPPED_ENV) delete env[k];
  return { ...env, ...gitEnv(id) };
}

/** Fetches the gh token for this identity's account. Only the Courier should call this. */
export function ghToken(id: Identity): string {
  try {
    return execFileSync('gh', ['auth', 'token', '--user', id.ghUser], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    throw new OctetError(`No gh login for ${id.ghUser}. Run: gh auth login`);
  }
}

export function remoteOwner(url: string): string | null {
  const m = url
    .trim()
    .match(/^(?:git@|ssh:\/\/git@|https?:\/\/(?:[^@/]+@)?)github\.com[:/]([^/]+)\/[^/]+?(?:\.git)?\/?$/);
  return m?.[1] ?? null;
}

/** "owner/repo" for a GitHub remote URL, or null. */
export function remoteSlug(url: string): string | null {
  const m = url
    .trim()
    .match(/^(?:git@|ssh:\/\/git@|https?:\/\/(?:[^@/]+@)?)github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  return m?.[1] ?? null;
}

export interface RemoteCheck {
  ok: boolean;
  owner: string | null;
  reason: string;
}

/** The wrong-account guard: a remote's owner must be this identity's user or an allowed org. */
export function checkRemote(id: Identity, url: string): RemoteCheck {
  const owner = remoteOwner(url);
  if (!owner) return { ok: false, owner, reason: `Not a recognizable GitHub remote: ${url}` };
  const allowed = [id.ghUser, ...id.owners].map((s) => s.toLowerCase());
  if (allowed.includes(owner.toLowerCase())) return { ok: true, owner, reason: 'owner matches' };
  return {
    ok: false,
    owner,
    reason: `Remote owner "${owner}" is not allowed for identity "${id.id}" (allowed: ${allowed.join(', ')})`,
  };
}

/** The `ssh` arguments that make GitHub greet the account this identity's key belongs to. */
export const sshProbeArgs = (id: Identity): string[] => ['-T', '-i', id.sshKey, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new', 'git@github.com'];

/** Asks GitHub which user this identity's SSH key authenticates as. */
export function sshWhoAmI(id: Identity): string | null {
  try {
    execFileSync('ssh', sshProbeArgs(id), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return null;
  } catch (e) {
    // GitHub exits 1 even on success; the greeting is on stderr.
    const stderr = String((e as { stderr?: unknown }).stderr ?? '');
    return stderr.match(/^Hi ([^!]+)!/m)?.[1] ?? null;
  }
}
