import { SlackIntake, SlackSocketTransport, type SlackTransport } from './intake-chat.ts';
import { loadSlackCredentials, type IntakeConfig } from './intake-config.ts';
import { githubAdapters, type GhFn } from './intake-github.ts';
import { jiraAdapters } from './intake-jira.ts';
import { pollIntake, type AdapterResult, type IntakeAdapter } from './intake-sources.ts';
import type { Ctx } from './orchestrate.ts';

export type IntakeKind = 'github' | 'jira' | 'chat';

export interface IntakeSourceStatus {
  kind: IntakeKind;
  enabled: boolean;
  /** One line of what is configured, for the status line and `octet intake status`. */
  detail: string;
  lastPollAt: string | null;
  lastError: string | null;
  lastResult: { created: number; duplicates: number; updated: number; held: number; rejected: number } | null;
}

export interface IntakeStatus {
  sources: IntakeSourceStatus[];
  /** Requests ingested but held for you (an author or sender Octet would not auto-route). Still `new`. */
  held: string[];
}

/** Test seams. Production leaves all of them out. */
export interface IntakeDeps {
  gh?: GhFn;
  fetch?: typeof fetch;
  /** Where the credential files live. Defaults to the Octet config directory. */
  credsDir?: string;
  slackTransport?: SlackTransport;
  /** Replace the polled adapters outright. */
  adapters?: Partial<Record<'github' | 'jira', () => IntakeAdapter[]>>;
}

const blank = (kind: IntakeKind, enabled: boolean, detail: string): IntakeSourceStatus =>
  ({ kind, enabled, detail, lastPollAt: null, lastError: null, lastResult: null });

/**
 * Owns the enabled intake sources for one process: polls GitHub and Jira on their timers, runs the Slack
 * connection, and reports what it is doing. Nothing here is required for Octet to work; a source that fails
 * only shows an error and tries again.
 */
export class IntakeService {
  private readonly src: Record<IntakeKind, IntakeSourceStatus>;
  private readonly lastErrors = new Map<string, string>();
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private readonly busy = new Set<IntakeKind>();
  private chat: SlackIntake | null = null;

  private readonly ctx: Ctx;
  private readonly cfg: IntakeConfig;
  private readonly deps: IntakeDeps;

  constructor(ctx: Ctx, cfg: IntakeConfig, deps: IntakeDeps = {}) {
    this.ctx = ctx;
    this.cfg = cfg;
    this.deps = deps;
    const { github: g, jira: j, chat: c } = cfg;
    this.src = {
      github: blank('github', g.enabled, `label "${g.label}", every ${g.pollSeconds}s, ${g.projects ? g.projects.join(', ') : 'all projects'}`),
      jira: blank('jira', j.enabled, `${j.filters.length} filter(s), every ${j.pollSeconds}s`),
      chat: blank('chat', c.enabled, `Slack ${c.command}, ${c.allowedUsers.length} allowed user(s)`),
    };
  }

  private adapters(kind: 'github' | 'jira'): IntakeAdapter[] {
    const override = this.deps.adapters?.[kind];
    if (override) return override();
    if (kind === 'github') {
      return githubAdapters(this.cfg.github, { identities: this.ctx.identities, projects: () => this.ctx.projects }, this.deps.gh);
    }
    return jiraAdapters(this.cfg.jira.filters, this.ctx.projects, {
      site: this.cfg.jira.site, ...(this.deps.credsDir ? { credsDir: this.deps.credsDir } : {}), ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
    });
  }

  /** Polls the enabled pollable sources (or just `kind`) once. Never throws. */
  async pollOnce(kind?: 'github' | 'jira'): Promise<AdapterResult[]> {
    const out: AdapterResult[] = [];
    for (const k of kind ? [kind] : (['github', 'jira'] as const)) {
      if (!this.src[k].enabled || this.busy.has(k)) continue;
      this.busy.add(k);
      try {
        const results = await pollIntake(this.ctx, this.adapters(k), { lastErrors: this.lastErrors });
        const s = this.src[k];
        s.lastPollAt = new Date().toISOString();
        s.lastError = results.find((r) => !r.ok)?.error ?? null;
        s.lastResult = results.reduce(
          (a, r) => ({ created: a.created + r.created, duplicates: a.duplicates + r.duplicates, updated: a.updated + r.updated, held: a.held + r.held, rejected: a.rejected + r.rejected }),
          { created: 0, duplicates: 0, updated: 0, held: 0, rejected: 0 },
        );
        out.push(...results);
      } finally {
        this.busy.delete(k);
      }
    }
    return out;
  }

  /** Starts the timers and the Slack connection for whatever is enabled. Safe to call without any source enabled. */
  start(): void {
    for (const k of ['github', 'jira'] as const) {
      if (!this.src[k].enabled) continue;
      const seconds = this.cfg[k].pollSeconds;
      void this.pollOnce(k);
      const t = setInterval(() => void this.pollOnce(k), seconds * 1000);
      t.unref();
      this.timers.push(t);
    }
    if (this.src.chat.enabled) void this.startChat();
  }

  private async startChat(): Promise<void> {
    const s = this.src.chat;
    try {
      const transport = this.deps.slackTransport ?? new SlackSocketTransport(loadSlackCredentials(this.deps.credsDir), {
        onError: (m) => { s.lastError = m; },
      });
      this.chat = new SlackIntake(this.ctx, this.cfg.chat, transport);
      await this.chat.start();
      s.lastError = null;
    } catch (e) {
      s.lastError = (e as Error).message.slice(0, 500);
      this.ctx.store.log({ kind: 'intake.error', data: { adapter: 'chat', message: s.lastError } });
    }
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
    this.chat?.stop();
    this.chat = null;
  }

  status(): IntakeStatus {
    const chat = this.src.chat;
    if (this.chat) {
      chat.lastPollAt = this.chat.status.lastEventAt;
      chat.lastError = this.chat.status.lastError ?? chat.lastError;
    }
    const held = this.ctx.store.eventsOfKind('intake.held')
      .map((e) => (e.data as { request?: string }).request)
      .filter((id): id is string => !!id && this.ctx.store.getRequest(id)?.status === 'new');
    return { sources: [this.src.github, this.src.jira, chat].map((s) => ({ ...s })), held };
  }
}
