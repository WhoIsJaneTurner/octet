import { OctetError } from './errors.ts';
import type { ChatIntakeConfig, SlackCredentials } from './intake-config.ts';
import { MAX_REQUEST_TITLE, submitRequest } from './intake.ts';
import type { Ctx } from './orchestrate.ts';

/** The part of a Slack Socket Mode envelope this code reads. Everything in `payload` is untrusted. */
export interface SlackEnvelope {
  envelope_id?: string;
  type?: string;
  retry_attempt?: number;
  payload?: Record<string, any>;
}

/** Everything that touches Slack's network lives behind this, so the logic can be tested with a fake. */
export interface SlackTransport {
  /** Connects, then calls `onEnvelope` for each envelope after acknowledging it to Slack. */
  start(onEnvelope: (e: SlackEnvelope) => void | Promise<void>): Promise<void>;
  stop(): void;
  /** Posts into a channel, in a thread when `threadTs` is given. */
  postMessage(m: { channel: string; text: string; threadTs?: string }): Promise<void>;
}

/** Records posts and lets a test push envelopes in. */
export class FakeSlackTransport implements SlackTransport {
  readonly posts: { channel: string; text: string; threadTs?: string }[] = [];
  failPosts = false;
  started = false;
  private handler: ((e: SlackEnvelope) => void | Promise<void>) | null = null;
  async start(onEnvelope: (e: SlackEnvelope) => void | Promise<void>): Promise<void> {
    this.handler = onEnvelope;
    this.started = true;
  }
  stop(): void { this.started = false; }
  async postMessage(m: { channel: string; text: string; threadTs?: string }): Promise<void> {
    if (this.failPosts) throw new OctetError('slack post failed');
    this.posts.push(m);
  }
  /** Deliver an envelope as Slack would, awaiting the handler. */
  async deliver(e: SlackEnvelope): Promise<void> { await this.handler!(e); }
}

const unescapeSlack = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * Splits chat text into an optional explicit project and the request text:
 *   [<@BOT>] [ask] [project:<name>] free text...
 * Only the `project:` argument names a project; the words of the request never do.
 */
export function parseChatText(raw: string): { project: string | null; text: string } {
  let t = unescapeSlack(raw).replace(/^\s*(<@[A-Z0-9]+(\|[^>]*)?>\s*)+/, '').trim();
  t = t.replace(/^ask\b\s*/i, '');
  const m = t.match(/^project:([\w.-]+)\s*/i);
  if (m) t = t.slice(m[0].length);
  return { project: m?.[1] ?? null, text: t.trim() };
}

const SEEN_MAX = 2000;

export interface ChatStatus { started: boolean; lastEventAt: string | null; lastError: string | null }

/**
 * Slack intake. Slash command or mention, allow-listed users only, replies in the thread, never an approval.
 * Dedup is `(chat, channel:ts)` or `(chat, slash:trigger_id)` in the requests table, so a Slack retry or a
 * replayed envelope can never make a second request; the in-memory set only saves a lookup.
 */
export class SlackIntake {
  private readonly seen = new Set<string>();
  readonly status: ChatStatus = { started: false, lastEventAt: null, lastError: null };
  private readonly ctx: Ctx;
  private readonly cfg: ChatIntakeConfig;
  private readonly transport: SlackTransport;
  constructor(ctx: Ctx, cfg: ChatIntakeConfig, transport: SlackTransport) {
    this.ctx = ctx;
    this.cfg = cfg;
    this.transport = transport;
  }

  async start(): Promise<void> {
    await this.transport.start((e) => this.handle(e));
    this.status.started = true;
  }

  stop(): void {
    this.transport.stop();
    this.status.started = false;
  }

  private fail(message: string): void {
    this.status.lastError = message.slice(0, 500);
    this.ctx.store.log({ kind: 'intake.error', data: { adapter: 'chat', message: this.status.lastError } });
  }

  /** Never throws: a bad envelope is logged and dropped. */
  async handle(env: SlackEnvelope): Promise<void> {
    try {
      await this.process(env);
    } catch (e) {
      this.fail((e as Error).message);
    }
  }

  private async process(env: SlackEnvelope): Promise<void> {
    const p = env.payload ?? {};
    let user: string, ref: string, text: string, channel: string, threadTs: string | undefined, via: 'mention' | 'slash';
    if (env.type === 'events_api' && p.event?.type === 'app_mention') {
      const ev = p.event;
      if (ev.bot_id || ev.subtype) return; // our own and other bots' messages
      via = 'mention';
      user = String(ev.user ?? ''); channel = String(ev.channel ?? ''); text = String(ev.text ?? '');
      ref = `${channel}:${String(ev.ts ?? '')}`;
      threadTs = String(ev.thread_ts ?? ev.ts ?? '');
      if (!ev.ts) return this.drop(user, via, 'no message id');
    } else if (env.type === 'slash_commands' && p.command === this.cfg.command) {
      via = 'slash';
      user = String(p.user_id ?? ''); channel = String(p.channel_id ?? ''); text = String(p.text ?? '');
      if (!p.trigger_id) return this.drop(user, via, 'no trigger id');
      ref = `slash:${String(p.trigger_id)}`;
    } else {
      return; // hello, disconnect, other events and other commands: ignored, not logged
    }
    this.status.lastEventAt = new Date().toISOString();

    if (!user || !this.cfg.allowedUsers.includes(user)) return this.drop(user, via, 'user is not in intake.chat.allowed_users');
    if (this.seen.has(ref)) return;
    this.seen.add(ref);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value!);

    const parsed = parseChatText(text);
    const reply = (msg: string) => this.reply(channel, msg, threadTs);
    if (!parsed.text) return reply(`Say what you want done, for example: ${this.cfg.command} ask project:<name> Add rate limiting to uploads`);

    let project: string | null = null;
    let note = '';
    if (parsed.project) {
      if (this.ctx.projects.some((x) => x.name === parsed.project)) project = parsed.project;
      else note = ` I do not know a project called "${parsed.project.slice(0, 40)}", so it is not routed.`;
    } else if (this.cfg.project && this.ctx.projects.some((x) => x.name === this.cfg.project)) {
      project = this.cfg.project;
    }

    const line = parsed.text.split('\n')[0]!.trim();
    const title = line.slice(0, MAX_REQUEST_TITLE);
    const { request, duplicate } = submitRequest(this.ctx, {
      source: 'chat', externalRef: ref, project, title, body: parsed.text === title ? '' : parsed.text, requester: user,
    });
    if (duplicate) return; // a retry or replay: stay quiet, the first reply stands
    await reply(`Got it (${request.id}). ${project ? `Routed to ${project}.` : 'Not routed yet.'}${note} Nothing runs until you review it in the Octet inbox: ${this.cfg.inboxUrl}`);
  }

  private drop(user: string, via: string, reason: string): void {
    this.ctx.store.log({ kind: 'intake.dropped', data: { source: 'chat', via, user: user.slice(0, 40), reason } });
  }

  private async reply(channel: string, text: string, threadTs?: string): Promise<void> {
    try {
      await this.transport.postMessage({ channel, text, ...(threadTs ? { threadTs } : {}) });
    } catch (e) {
      this.fail(`reply failed: ${(e as Error).message}`);
    }
  }
}

/**
 * The real transport: Slack Socket Mode over Node's global WebSocket. Outbound only, no inbound port. Socket Mode
 * has no HTTP request signature (the secret wss URL from `apps.connections.open` is the trust anchor), so the
 * signing secret is not used. Reconnects with backoff. NOT exercised against real Slack; see the tests.
 */
export class SlackSocketTransport implements SlackTransport {
  private ws: WebSocket | null = null;
  private handler: ((e: SlackEnvelope) => void | Promise<void>) | null = null;
  private stopped = true;
  private delay = 1000;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly api: string;
  private readonly creds: SlackCredentials;
  private readonly opts: { apiBase?: string; onError?: (message: string) => void };
  constructor(creds: SlackCredentials, opts: { apiBase?: string; onError?: (message: string) => void } = {}) {
    this.creds = creds;
    this.opts = opts;
    this.api = (opts.apiBase ?? 'https://slack.com/api').replace(/\/+$/, '');
  }

  async start(onEnvelope: (e: SlackEnvelope) => void | Promise<void>): Promise<void> {
    this.handler = onEnvelope;
    this.stopped = false;
    await this.connect(); // the first failure is the caller's to see; later ones retry
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }

  private async connect(): Promise<void> {
    const res = await fetch(`${this.api}/apps.connections.open`, {
      method: 'POST', signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${this.creds.appToken}`, 'content-type': 'application/x-www-form-urlencoded' },
    });
    const j = (await res.json()) as { ok?: boolean; url?: string; error?: string };
    if (!j.ok || !j.url) throw new OctetError(`Slack apps.connections.open failed: ${j.error ?? res.status}`);
    const ws = new WebSocket(j.url);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new OctetError('Slack WebSocket could not connect'));
    });
    this.ws = ws;
    this.delay = 1000;
    ws.onerror = () => this.opts.onError?.('Slack WebSocket error');
    ws.onmessage = (ev) => {
      let env: SlackEnvelope;
      try { env = JSON.parse(String(ev.data)) as SlackEnvelope; } catch { return; }
      // Slack redelivers anything not acknowledged within seconds, so ack before doing any work.
      if (env.envelope_id) ws.send(JSON.stringify({ envelope_id: env.envelope_id }));
      if (env.type === 'disconnect') return void ws.close();
      void Promise.resolve(this.handler?.(env)).catch((e: unknown) => this.opts.onError?.((e as Error).message));
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      if (!this.stopped) this.retry();
    };
  }

  private retry(): void {
    this.timer = setTimeout(() => {
      this.connect().catch((e: unknown) => {
        this.opts.onError?.((e as Error).message);
        if (!this.stopped) this.retry();
      });
    }, this.delay);
    this.timer.unref();
    this.delay = Math.min(this.delay * 2, 60_000);
  }

  async postMessage(m: { channel: string; text: string; threadTs?: string }): Promise<void> {
    const res = await fetch(`${this.api}/chat.postMessage`, {
      method: 'POST', signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${this.creds.botToken}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel: m.channel, text: m.text, ...(m.threadTs ? { thread_ts: m.threadTs } : {}), unfurl_links: false, link_names: false }),
    });
    const j = (await res.json()) as { ok?: boolean; error?: string };
    if (!j.ok) throw new OctetError(`Slack chat.postMessage failed: ${j.error ?? res.status}`);
  }
}
