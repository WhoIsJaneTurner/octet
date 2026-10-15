import { MAX_REQUEST_BODY, submitRequest, TRUNCATED, type RequestInput } from './intake.ts';
import type { Ctx } from './orchestrate.ts';

/** One thing an external source says is new. `held` means: record it for the human, but do not route it. */
export interface IntakeItem extends RequestInput {
  /** Why this item must wait for you (for example an author who is not on the allow-list). Logged and shown. */
  held?: string;
}

/**
 * A source that Octet polls. Read-only: `fetchNew` returns what the source currently offers and changes nothing
 * there. De-duplication is not the adapter's job; `submitRequest` already keys on `(source, externalRef)`.
 */
export interface IntakeAdapter {
  /** Stable label for events and status, for example `github:myapp`. */
  readonly name: string;
  fetchNew(): Promise<IntakeItem[]>;
}

/** Returns canned items, or fails once on demand. For tests. */
export class FakeIntake implements IntakeAdapter {
  items: IntakeItem[] = [];
  /** If set, the next `fetchNew` rejects with it and the field is cleared. */
  failNext: Error | null = null;
  fetches = 0;
  readonly name: string;
  constructor(name = 'fake') {
    this.name = name;
  }
  async fetchNew(): Promise<IntakeItem[]> {
    this.fetches++;
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    return this.items.map((i) => ({ ...i }));
  }
}

export interface AdapterResult {
  adapter: string;
  at: string;
  ok: boolean;
  created: number;
  duplicates: number;
  updated: number;
  held: number;
  /** Items the source offered that Octet refused to store (a bad title, an unknown project). */
  rejected: number;
  error?: string;
}

export interface PollOptions {
  /** Last error message per adapter, so a source that stays down logs once, not on every poll. */
  lastErrors?: Map<string, string>;
}

/** The same cap `submitRequest` applies, so an edited body can be compared with what was stored. */
export function capBody(raw: string): string {
  return raw.length > MAX_REQUEST_BODY ? raw.slice(0, MAX_REQUEST_BODY) + TRUNCATED : raw;
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 500);

/**
 * Runs every adapter once and submits what they return through the one intake path. Never throws: an adapter
 * that fails is logged as `intake.error` and the others still run (and so does the next poll). An edit to an
 * already-ingested item refreshes its request only while the request is still `new`.
 */
export async function pollIntake(ctx: Ctx, adapters: IntakeAdapter[], opts: PollOptions = {}): Promise<AdapterResult[]> {
  const results: AdapterResult[] = [];
  for (const adapter of adapters) {
    const r: AdapterResult = { adapter: adapter.name, at: new Date().toISOString(), ok: true, created: 0, duplicates: 0, updated: 0, held: 0, rejected: 0 };
    try {
      const items = await adapter.fetchNew();
      for (const item of items) {
        try {
          // A held item never carries a project, whatever the adapter set: it must wait for you.
          const input: RequestInput = item.held ? { ...item, project: null } : item;
          const { request, duplicate } = submitRequest(ctx, input);
          if (duplicate) {
            r.duplicates++;
            const title = squash(item.title);
            const body = capBody(item.body ?? '');
            if (title && (title !== request.title || body !== request.body) && ctx.store.updateRequestText(request.id, { title, body })) {
              r.updated++;
              ctx.store.log({ kind: 'request.updated', data: { request: request.id, source: request.source, externalRef: request.externalRef } });
            }
            continue;
          }
          r.created++;
          if (item.held) {
            r.held++;
            ctx.store.log({ kind: 'intake.held', data: { request: request.id, source: request.source, externalRef: request.externalRef, requester: request.requester, reason: item.held } });
          }
        } catch (e) {
          r.rejected++;
          ctx.store.log({ kind: 'intake.error', data: { adapter: adapter.name, externalRef: item.externalRef ?? null, message: message(e) } });
        }
      }
      opts.lastErrors?.delete(adapter.name);
    } catch (e) {
      r.ok = false;
      r.error = message(e);
      if (opts.lastErrors?.get(adapter.name) !== r.error) {
        ctx.store.log({ kind: 'intake.error', data: { adapter: adapter.name, message: r.error } });
      }
      opts.lastErrors?.set(adapter.name, r.error);
    }
    results.push(r);
  }
  return results;
}
