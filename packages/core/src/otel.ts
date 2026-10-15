import { randomBytes } from 'node:crypto';
import { SPAN_KIND } from './otel-attrs.ts';

/**
 * A minimal tracer and OTLP/HTTP JSON exporter. No dependencies: spans are plain objects, the export is one
 * `fetch` POST of an ExportTraceServiceRequest. Exporting is best effort and never blocks or fails a run.
 * Attribute names live in otel-attrs.ts, not here.
 */

export type AttrValue = string | number | boolean;
export type Attrs = Record<string, AttrValue | undefined>;

export interface FinishedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startMs: number;
  endMs: number;
  attrs: Record<string, AttrValue>;
  error?: string;
}

export interface SpanSink {
  enqueue(span: FinishedSpan): void;
}

export class Span {
  readonly traceId: string;
  readonly spanId = randomBytes(8).toString('hex');
  private readonly attrs: Record<string, AttrValue> = {};
  private readonly startMs: number;
  private error: string | undefined;
  private ended = false;
  private readonly sink: SpanSink;
  private readonly name: string;
  private readonly kind: number;
  private readonly parent: Span | undefined;
  constructor(sink: SpanSink, name: string, kind: number, parent?: Span) {
    this.sink = sink;
    this.name = name;
    this.kind = kind;
    this.parent = parent;
    this.traceId = parent?.traceId ?? randomBytes(16).toString('hex');
    this.startMs = Date.now();
  }
  set(attrs: Attrs): this {
    for (const [k, v] of Object.entries(attrs)) if (v !== undefined) this.attrs[k] = v;
    return this;
  }
  /** Marks the span failed. The message is the span status message, not an attribute. */
  fail(message: string): this {
    this.error = message;
    return this;
  }
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.sink.enqueue({
      traceId: this.traceId, spanId: this.spanId, ...(this.parent ? { parentSpanId: this.parent.spanId } : {}),
      name: this.name, kind: this.kind, startMs: this.startMs, endMs: Date.now(), attrs: this.attrs,
      ...(this.error !== undefined ? { error: this.error } : {}),
    });
  }
}

export class Tracer {
  private readonly sink: SpanSink;
  constructor(sink: SpanSink) {
    this.sink = sink;
  }
  start(name: string, opts: { kind?: number; parent?: Span; attrs?: Attrs } = {}): Span {
    return new Span(this.sink, name, opts.kind ?? SPAN_KIND.internal, opts.parent).set(opts.attrs ?? {});
  }
}

type OtlpValue = { stringValue: string } | { boolValue: boolean } | { intValue: string } | { doubleValue: number };
const otlpValue = (v: AttrValue): OtlpValue =>
  typeof v === 'string' ? { stringValue: v }
    : typeof v === 'boolean' ? { boolValue: v }
      : Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
const otlpAttrs = (a: Record<string, AttrValue>) => Object.entries(a).map(([key, v]) => ({ key, value: otlpValue(v) }));
const nanos = (ms: number): string => `${ms}000000`;

/** Builds the ExportTraceServiceRequest body (OTLP/JSON: hex ids, int64 as decimal strings). */
export function encodeSpans(spans: FinishedSpan[], resource: Record<string, AttrValue>, scope = { name: 'octet', version: '0.1.0' }) {
  return {
    resourceSpans: [{
      resource: { attributes: otlpAttrs(resource) },
      scopeSpans: [{
        scope,
        spans: spans.map((s) => ({
          traceId: s.traceId, spanId: s.spanId, ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
          name: s.name, kind: s.kind, startTimeUnixNano: nanos(s.startMs), endTimeUnixNano: nanos(s.endMs),
          attributes: otlpAttrs(s.attrs),
          status: s.error !== undefined ? { code: 2, message: s.error } : { code: 1 },
        })),
      }],
    }],
  };
}

export interface ExporterOptions {
  /** Collector base URL (`http://localhost:4318`) or the full traces URL; `/v1/traces` is appended to a base. */
  endpoint: string;
  headers?: Record<string, string>;
  resource?: Record<string, AttrValue>;
  flushIntervalMs?: number;
  /** A batch this large is sent without waiting for the timer. */
  maxBatch?: number;
  /** Spans beyond this many waiting are dropped, oldest first. */
  maxQueue?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export const tracesUrl = (endpoint: string): string =>
  /\/v1\/traces\/?$/.test(endpoint) ? endpoint : `${endpoint.replace(/\/+$/, '')}/v1/traces`;

export class OtlpHttpExporter implements SpanSink {
  private queue: FinishedSpan[] = [];
  private readonly inflight = new Set<Promise<void>>();
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  /** Spans lost to a full queue or a failed export, for diagnostics. */
  dropped = 0;
  exported = 0;
  lastError: string | undefined;
  private readonly url: string;
  private readonly o: Required<Pick<ExporterOptions, 'flushIntervalMs' | 'maxBatch' | 'maxQueue' | 'timeoutMs'>>;

  private readonly opts: ExporterOptions;

  constructor(opts: ExporterOptions) {
    this.opts = opts;
    this.url = tracesUrl(opts.endpoint);
    this.o = { flushIntervalMs: 5000, maxBatch: 64, maxQueue: 2048, timeoutMs: 5000, ...stripUndefined(opts) };
  }

  enqueue(span: FinishedSpan): void {
    if (this.closed) return;
    this.queue.push(span);
    if (this.queue.length > this.o.maxQueue) {
      this.queue.shift();
      this.dropped++;
    }
    if (this.queue.length >= this.o.maxBatch) void this.flush();
    else this.timer ??= setTimeout(() => { this.timer = undefined; void this.flush(); }, this.o.flushIntervalMs).unref();
  }

  /** Sends whatever is queued and waits for exports already in flight. Never rejects. */
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    while (this.queue.length) {
      const batch = this.queue.splice(0, this.o.maxBatch);
      const p = this.send(batch).finally(() => this.inflight.delete(p));
      this.inflight.add(p);
    }
    await Promise.allSettled([...this.inflight]);
  }

  /** Final flush; later spans are ignored. */
  async shutdown(): Promise<void> {
    this.closed = true;
    await this.flush();
  }

  private async send(batch: FinishedSpan[]): Promise<void> {
    try {
      const res = await (this.opts.fetchImpl ?? fetch)(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.opts.headers },
        body: JSON.stringify(encodeSpans(batch, { 'service.name': 'octet', ...this.opts.resource })),
        signal: AbortSignal.timeout(this.o.timeoutMs),
      });
      await res.body?.cancel().catch(() => {});
      if (!res.ok) throw new Error(`collector answered HTTP ${res.status}`);
      this.exported += batch.length;
    } catch (e) {
      this.dropped += batch.length;
      this.lastError = (e as Error).message;
    }
  }
}

const stripUndefined = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
