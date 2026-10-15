import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { OctetError } from './errors.ts';
import { octetHome } from './paths.ts';

export interface GithubIntakeConfig {
  enabled: boolean;
  /** The opt-in label. Issues without it are never read. */
  label: string;
  pollSeconds: number;
  /** Required (non-empty) for public repos; an author not on it is held, not routed. */
  allowedAuthors: string[];
  /** Projects to poll. Null means every configured project whose remote the identity owns. */
  projects: string[] | null;
}

export interface JiraFilter { project: string; jql: string }

export interface JiraIntakeConfig {
  enabled: boolean;
  /** Optional here; the credentials file carries the site. If both are set they must agree. */
  site: string | null;
  filters: JiraFilter[];
  pollSeconds: number;
  /** Parsed so the file is future-proof. Write-back is not built, so nothing reads this yet. */
  allowedTransitions: string[];
}

export interface ChatIntakeConfig {
  enabled: boolean;
  /** Slack user ids allowed to submit. Everyone else is dropped and logged. */
  allowedUsers: string[];
  /** The slash command to listen for. */
  command: string;
  /** Route every chat request here when set; otherwise an explicit `project:<name>` argument, else unrouted. */
  project: string | null;
  /** Linked in replies, since chat never approves anything. */
  inboxUrl: string;
}

export interface IntakeConfig { github: GithubIntakeConfig; jira: JiraIntakeConfig; chat: ChatIntakeConfig }

export const DEFAULT_POLL_SECONDS = 300;
/** A floor so a typo cannot hammer GitHub or Jira. */
export const MIN_POLL_SECONDS = 30;

type Tbl = Record<string, unknown>;
const tbl = (v: unknown): Tbl => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Tbl) : {});
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const poll = (v: unknown): number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? Math.max(v, MIN_POLL_SECONDS) : DEFAULT_POLL_SECONDS;

/** Reads the `[intake.*]` tables of config.toml. Everything is off unless `enabled = true`. */
export function loadIntake(file: string = join(octetHome(), 'config.toml')): IntakeConfig {
  const doc = existsSync(file) ? tbl(tbl(parse(readFileSync(file, 'utf8'))).intake) : {};
  const g = tbl(doc.github);
  const j = tbl(doc.jira);
  const c = tbl(doc.chat);

  const filters: JiraFilter[] = [];
  const jql = text(j.jql);
  const project = text(j.project);
  if (jql && project) filters.push({ project, jql });
  for (const [name, t] of Object.entries(tbl(j.projects))) {
    const q = text(tbl(t).jql);
    if (q) filters.push({ project: name, jql: q });
  }
  return {
    github: {
      enabled: g.enabled === true,
      label: text(g.label) ?? 'octet',
      pollSeconds: poll(g.poll_seconds),
      allowedAuthors: strList(g.allowed_authors),
      projects: Array.isArray(g.projects) ? strList(g.projects) : null,
    },
    jira: {
      enabled: j.enabled === true,
      site: text(j.site),
      filters,
      pollSeconds: poll(j.poll_seconds),
      allowedTransitions: strList(j.allowed_transitions),
    },
    chat: {
      enabled: c.enabled === true,
      allowedUsers: strList(c.allowed_users),
      command: text(c.command) ?? '/octet',
      project: text(c.project),
      inboxUrl: text(c.inbox_url) ?? 'http://127.0.0.1:4747/',
    },
  };
}

/**
 * Reads a TOML secrets file from the Octet config directory, refusing it if group or others could read it
 * (mode looser than 600). A symlink is refused, so the mode checked is the file's own.
 */
export function readSecretFile(file: string): Tbl {
  if (!existsSync(file)) throw new OctetError(`No credentials file at ${file}`);
  const st = lstatSync(file);
  if (!st.isFile()) throw new OctetError(`${file} must be a regular file`);
  if ((st.mode & 0o177) !== 0) {
    throw new OctetError(`${file} has mode ${(st.mode & 0o777).toString(8)}; it must be 600. Run: chmod 600 ${file}`);
  }
  return tbl(parse(readFileSync(file, 'utf8')));
}

export interface JiraCredentials { site: string; email: string; token: string }

const SAFE_ID = /^[\w.-]+$/;

/** `<config dir>/jira-<identity>.toml` with `site`, `email`, `token`. One file per identity, never in the repo. */
export function jiraCredentialsFile(identity: string, dir: string = octetHome()): string {
  if (!SAFE_ID.test(identity)) throw new OctetError(`Identity "${identity}" cannot be used in a file name`);
  return join(dir, `jira-${identity}.toml`);
}

export function loadJiraCredentials(identity: string, dir: string = octetHome()): JiraCredentials {
  const file = jiraCredentialsFile(identity, dir);
  const t = readSecretFile(file);
  const site = text(t.site);
  const email = text(t.email);
  const token = text(t.token);
  if (!site || !email || !token) throw new OctetError(`${file} needs "site", "email" and "token"`);
  return { site: site.replace(/\/+$/, ''), email, token };
}

export interface SlackCredentials { appToken: string; botToken: string }

/** `<config dir>/slack.toml` with `app_token` (xapp-, Socket Mode) and `bot_token` (xoxb-, posting replies). */
export function loadSlackCredentials(dir: string = octetHome()): SlackCredentials {
  const file = join(dir, 'slack.toml');
  const t = readSecretFile(file);
  const appToken = text(t.app_token);
  const botToken = text(t.bot_token);
  if (!appToken || !botToken) throw new OctetError(`${file} needs "app_token" and "bot_token"`);
  return { appToken, botToken };
}
