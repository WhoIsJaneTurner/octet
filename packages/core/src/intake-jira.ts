import { OctetError } from './errors.ts';
import { loadJiraCredentials, type JiraFilter } from './intake-config.ts';
import type { IntakeAdapter, IntakeItem } from './intake-sources.ts';
import type { Project } from './project.ts';

interface AdfNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type?: string; attrs?: Record<string, unknown> }[];
  content?: AdfNode[];
}

const MAX_DEPTH = 30;
const MAX_TEXT = 100_000;

const attr = (n: AdfNode, k: string): string => (typeof n.attrs?.[k] === 'string' ? (n.attrs[k] as string) : '');

/**
 * Jira's rich text (Atlassian Document Format) as plain text. Only text-bearing nodes are read; media and other
 * attachments are dropped. Unknown node types contribute their children, so new formats degrade to readable text.
 * Depth and output are bounded because the input is untrusted.
 */
export function adfToText(doc: unknown): string {
  if (typeof doc === 'string') return doc.slice(0, MAX_TEXT);
  if (!doc || typeof doc !== 'object') return '';
  const out: string[] = [];
  let size = 0;
  const emit = (s: string) => {
    if (size >= MAX_TEXT) return;
    out.push(s);
    size += s.length;
  };
  // `tight` is for a paragraph directly inside a list item or table cell, which must not add its own line break.
  const kids = (n: AdfNode, depth: number, sep = '', tight = false) => {
    (n.content ?? []).forEach((c, i) => {
      if (i && sep) emit(sep);
      walk(c, depth + 1, tight);
    });
  };
  const walk = (n: AdfNode, depth: number, tight = false): void => {
    if (!n || typeof n !== 'object' || depth > MAX_DEPTH) return;
    switch (n.type) {
      case 'text': {
        const href = n.marks?.find((m) => m.type === 'link')?.attrs?.href;
        const t = n.text ?? '';
        emit(typeof href === 'string' && href !== t ? `${t} (${href})` : t);
        return;
      }
      case 'hardBreak': return emit('\n');
      case 'rule': return emit('\n---\n');
      case 'mention': return emit(attr(n, 'text') || '@someone');
      case 'emoji': return emit(attr(n, 'text') || attr(n, 'shortName'));
      case 'status': return emit(`[${attr(n, 'text')}]`);
      case 'date': return emit(attr(n, 'timestamp'));
      case 'inlineCard': case 'blockCard': return emit(attr(n, 'url'));
      case 'media': case 'mediaSingle': case 'mediaGroup': case 'mediaInline': return; // attachments are ignored
      case 'codeBlock': emit('\n'); kids(n, depth); return emit('\n');
      case 'bulletList': case 'orderedList': {
        (n.content ?? []).forEach((item, i) => {
          emit(`\n${n.type === 'orderedList' ? `${i + 1}. ` : '- '}`);
          walk(item, depth + 1);
        });
        return emit('\n');
      }
      case 'listItem': kids(n, depth, '\n', true); return;
      case 'tableRow': kids(n, depth, ' | '); return emit('\n');
      case 'tableCell': case 'tableHeader': kids(n, depth, ' ', true); return;
      case 'blockquote': emit('\n> '); kids(n, depth); return emit('\n');
      case 'paragraph': case 'heading': kids(n, depth); return tight ? undefined : emit('\n');
      default: kids(n, depth); // doc, panel, expand, table and anything new
    }
  };
  walk(doc as AdfNode, 0);
  return out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_TEXT);
}

interface JiraIssue {
  key?: string;
  fields?: {
    summary?: string;
    description?: unknown;
    reporter?: { displayName?: string; emailAddress?: string; accountId?: string } | null;
  };
}

const KEY = /^[A-Z][A-Z0-9_]*-\d+$/i;
const PAGE = 50;
const MAX_PAGES = 4;

const loopback = (host: string): boolean => host === 'localhost' || host === '127.0.0.1' || host === '[::1]';

/**
 * Read-only Jira intake for one project, from one saved JQL filter. Credentials come from a mode-600 file per
 * identity (see `loadJiraCredentials`). Only GET-like search is used; nothing is ever written to Jira.
 */
export class JiraIntake implements IntakeAdapter {
  readonly name: string;
  private readonly filter: JiraFilter;
  private readonly identity: string;
  private readonly opts: { site?: string | null; credsDir?: string; fetch?: typeof fetch };
  constructor(filter: JiraFilter, identity: string, opts: { site?: string | null; credsDir?: string; fetch?: typeof fetch } = {}) {
    this.filter = filter;
    this.identity = identity;
    this.opts = opts;
    this.name = `jira:${filter.project}`;
  }

  async fetchNew(): Promise<IntakeItem[]> {
    const creds = loadJiraCredentials(this.identity, this.opts.credsDir);
    const site = new URL(creds.site);
    if (this.opts.site && new URL(this.opts.site).origin !== site.origin) {
      throw new OctetError(`intake.jira.site (${this.opts.site}) does not match the site in the credentials file for "${this.identity}"`);
    }
    // The token is only ever sent over TLS (loopback http exists so tests can use a local server).
    if (site.protocol !== 'https:' && !(site.protocol === 'http:' && loopback(site.hostname))) {
      throw new OctetError('The Jira site must be an https URL');
    }
    const auth = 'Basic ' + Buffer.from(`${creds.email}:${creds.token}`).toString('base64');
    const doFetch = this.opts.fetch ?? fetch;
    const items: IntakeItem[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await doFetch(`${site.origin}/rest/api/3/search/jql`, {
        method: 'POST',
        // Never follow a redirect: it could carry the credentials to another host.
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
        headers: { authorization: auth, accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ jql: this.filter.jql, fields: ['summary', 'description', 'reporter'], maxResults: PAGE, ...(pageToken ? { nextPageToken: pageToken } : {}) }),
      });
      if (res.status !== 200) throw new OctetError(`Jira responded ${res.status} for the ${this.filter.project} filter`);
      const j = (await res.json()) as { issues?: JiraIssue[]; nextPageToken?: string; isLast?: boolean };
      if (!Array.isArray(j.issues)) throw new OctetError('Jira returned something unexpected');
      for (const i of j.issues) {
        const key = i.key ?? '';
        if (!KEY.test(key) || typeof i.fields?.summary !== 'string') continue;
        const rep = i.fields.reporter;
        items.push({
          source: 'jira', externalRef: key, project: this.filter.project, title: i.fields.summary,
          body: `${site.origin}/browse/${key}\n\n${adfToText(i.fields.description)}`,
          requester: rep?.displayName || rep?.emailAddress || rep?.accountId || 'unknown',
        });
      }
      if (j.isLast !== false || !j.nextPageToken) break;
      pageToken = j.nextPageToken;
    }
    return items;
  }
}

/** One adapter per saved filter whose project exists. The project's identity picks the credentials file. */
export function jiraAdapters(
  filters: JiraFilter[],
  projects: Project[],
  opts: { site?: string | null; credsDir?: string; fetch?: typeof fetch } = {},
): IntakeAdapter[] {
  const out: IntakeAdapter[] = [];
  for (const f of filters) {
    const p = projects.find((x) => x.name === f.project);
    if (p) out.push(new JiraIntake(f, p.identity, opts));
    else out.push({ name: `jira:${f.project}`, fetchNew: () => Promise.reject(new OctetError(`intake.jira: unknown project "${f.project}"`)) });
  }
  return out;
}
