import { parseUsage, type RunUsage } from './usage.ts';

const MAX_DETAIL = 120;

/** One short line saying what a tool call is about, e.g. the file an Edit touches. */
function toolDetail(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  const v = [i.file_path, i.path, i.command, i.pattern, i.url, i.description].find((x) => typeof x === 'string') as string | undefined;
  const flat = (v ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > MAX_DETAIL ? `${flat.slice(0, MAX_DETAIL)}...` : flat;
}

/**
 * Reads Claude Code's `--output-format stream-json` (one JSON object per line) and turns it into the plain
 * text Octet always showed: the assistant's words as they arrive, one `> Tool detail` line per tool call, and
 * nothing for the bulky parts (init, tool results). The closing `result` message carries the final answer,
 * the token counts and the cost. A line that is not JSON is passed through untouched, so a warning from
 * the CLI is never lost.
 */
export class ClaudeStream {
  /** Everything emitted so far. */
  text = '';
  /** The closing `result` message, once seen. */
  result: Record<string, unknown> | undefined;
  private buf = '';
  private readonly emit: (s: string) => void;

  constructor(emit: (s: string) => void) {
    this.emit = emit;
  }

  feed(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.line(line);
    }
  }

  /** Flushes a final line that had no newline. */
  end(): void {
    const rest = this.buf.trim();
    this.buf = '';
    if (rest) this.line(rest);
  }

  private out(s: string): void {
    this.text += s;
    this.emit(s);
  }

  private line(line: string): void {
    let msg: unknown;
    try { msg = JSON.parse(line); } catch { return void this.out(`${line}\n`); }
    if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') return void this.out(`${line}\n`);
    const m = msg as { type: string; message?: { content?: unknown } };
    if (m.type === 'result') { this.result = msg as Record<string, unknown>; return; }
    if (m.type !== 'assistant' || !Array.isArray(m.message?.content)) return;
    for (const block of m.message.content as { type?: string; text?: string; name?: string; input?: unknown }[]) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text) this.out(block.text.endsWith('\n') ? block.text : `${block.text}\n`);
      else if (block.type === 'tool_use') this.out(`> ${block.name ?? 'tool'} ${toolDetail(block.input)}`.trimEnd() + '\n');
    }
  }

  /** The agent's final answer: the `result` text when there is one, else what streamed. */
  get answer(): string {
    return typeof this.result?.result === 'string' ? this.result.result : this.text;
  }

  get usage(): RunUsage | undefined {
    return parseUsage(this.result);
  }

  /** The agent itself reported an error result, whatever the exit code says. */
  get failed(): boolean {
    return this.result?.is_error === true;
  }
}
