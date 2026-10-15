import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { redact } from './redact.ts';

/** One run's log stops growing here; the tail keeps the end of the story. */
export const MAX_LOG_BYTES = 2_000_000;
/** A line longer than this is flushed without waiting for its newline. */
const MAX_PENDING = 64_000;
/** What stays buffered on such a flush, so a token cut in two is still whole when its second half arrives. */
const KEEP_BACK = 1_024;

const KEY_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const KEY_END = /-----END [A-Z ]*PRIVATE KEY-----/;

/**
 * Appends a run's output to its log file with secrets redacted. Chunks arrive at arbitrary boundaries, so a token
 * can be split across two of them; redacting each chunk alone would miss it. This writer holds text back until it has
 * a complete line (and, for a private key block, the whole block), redacts that, and only then writes. `close()`
 * flushes the rest. Nothing unredacted ever reaches the disk.
 */
export class RunLogWriter {
  /** Total number of redactions made, for the audit log. */
  redacted = 0;
  private pending = '';
  private written = 0;
  private truncated = false;
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    mkdirSync(dirname(file), { recursive: true });
  }

  write(text: string): void {
    this.pending += text;
    let cut = this.pending.lastIndexOf('\n') + 1;
    // An open private-key block stays buffered until its END line arrives.
    const begins = [...this.pending.matchAll(KEY_BEGIN)];
    const open = begins.at(-1);
    if (open && !KEY_END.test(this.pending.slice(open.index!)) && this.pending.length - open.index! < MAX_PENDING) cut = Math.min(cut, open.index!);
    if (cut === 0 && this.pending.length > MAX_PENDING) cut = this.pending.length - KEEP_BACK;
    if (cut > 0) this.flush(this.pending.slice(0, cut), this.pending.slice(cut));
  }

  /** Writes whatever is still held back. Call once, when the run is over. */
  close(): void {
    if (this.pending) this.flush(this.pending, '');
  }

  private flush(ready: string, rest: string): void {
    this.pending = rest;
    const r = redact(ready);
    this.redacted += r.count;
    if (this.truncated) return;
    const room = MAX_LOG_BYTES - this.written;
    this.truncated = r.text.length > room;
    const part = this.truncated ? `${r.text.slice(0, room)}\n[log truncated]\n` : r.text;
    try { appendFileSync(this.file, part); } catch { /* a full disk must not kill the run */ }
    this.written += Math.min(r.text.length, room);
  }
}
