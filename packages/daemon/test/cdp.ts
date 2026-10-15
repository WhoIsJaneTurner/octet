import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A tiny Chrome DevTools Protocol driver with no dependencies (Node 24 has a global WebSocket).
 * Chrome's own `--screenshot` flag hangs on pages that hold an event stream open, so tests drive
 * the browser over the protocol and wait for specific elements instead.
 */

export const CHROME = process.env.OCTET_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const chromeAvailable = (): boolean => existsSync(CHROME);

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export class Browser {
  private ws!: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners: ((method: string, params: Record<string, unknown>, sessionId?: string) => void)[] = [];
  private proc!: ChildProcess;
  private profile!: string;

  static async launch(): Promise<Browser> {
    const b = new Browser();
    b.profile = mkdtempSync(join(tmpdir(), 'octet-chrome-'));
    b.proc = spawn(CHROME, [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${b.profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    const url = await new Promise<string>((resolve, reject) => {
      let text = '';
      const timer = setTimeout(() => reject(new Error(`Chrome did not report a DevTools address:\n${text}`)), 20_000);
      b.proc.stderr!.on('data', (d: Buffer) => {
        text += d.toString();
        const m = text.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) { clearTimeout(timer); resolve(m[1]!); }
      });
      b.proc.once('exit', () => reject(new Error(`Chrome exited early:\n${text}`)));
    });
    b.ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      b.ws.addEventListener('open', () => resolve());
      b.ws.addEventListener('error', () => reject(new Error('could not connect to DevTools')));
    });
    b.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
      if (msg.id !== undefined) {
        const p = b.pending.get(msg.id);
        b.pending.delete(msg.id);
        if (msg.error) p?.reject(new Error(msg.error.message));
        else p?.resolve(msg.result);
      } else if (msg.method) {
        for (const l of b.listeners) l(msg.method, msg.params ?? {}, msg.sessionId);
      }
    });
    return b;
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(fn: (method: string, params: Record<string, unknown>, sessionId?: string) => void): void {
    this.listeners.push(fn);
  }

  async newPage(): Promise<Page> {
    const { targetId } = await this.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, sessionId);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    return page;
  }

  async close(): Promise<void> {
    try { this.ws?.close(); } catch { /* already closed */ }
    this.proc?.kill('SIGKILL');
    await new Promise<void>((r) => (this.proc.exitCode !== null ? r() : this.proc.once('exit', () => r())));
    rmSync(this.profile, { recursive: true, force: true });
  }
}

export class Page {
  /** JavaScript dialogs (alert, prompt) that opened, newest last. */
  readonly dialogs: { type: string; message: string }[] = [];
  /** What to answer the next prompt/confirm with. */
  nextPrompt = '';

  private readonly browser: Browser;
  private readonly sessionId: string;

  constructor(browser: Browser, sessionId: string) {
    this.browser = browser;
    this.sessionId = sessionId;
    browser.on((method, params, sid) => {
      if (sid !== sessionId || method !== 'Page.javascriptDialogOpening') return;
      this.dialogs.push({ type: String(params.type), message: String(params.message) });
      void this.send('Page.handleJavaScriptDialog', { accept: true, promptText: this.nextPrompt });
    });
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.browser.send<T>(method, params, this.sessionId);
  }

  async goto(url: string): Promise<void> {
    await this.send('Page.navigate', { url });
  }

  /** Evaluates an expression in the page and returns its JSON value. */
  async eval<T = unknown>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
      'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value as T;
  }

  /** Polls until the expression is truthy; the failure message says what was awaited and what the page looked like. */
  async waitFor(expression: string, what: string, timeoutMs = 10_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    let last: unknown;
    while (Date.now() < end) {
      try {
        last = await this.eval(expression);
        if (last) return;
      } catch (e) { last = (e as Error).message; }
      await new Promise((r) => setTimeout(r, 50));
    }
    const body = await this.eval<string>('document.body ? document.body.innerText.slice(0, 600) : "(no body)"').catch(() => '(unreadable)');
    throw new Error(`timed out waiting for ${what} (last value ${JSON.stringify(last)}). Page text:\n${body}`);
  }

  /** Types into an input the way a user does, so React sees it. */
  async type(selector: string, text: string): Promise<void> {
    await this.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.select?.(); })()`);
    await this.send('Input.insertText', { text });
  }

  /** Picks an option of a <select> the way React expects. */
  async select(selector: string, value: string): Promise<void> {
    await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
  }

  /** Clicks the first button (or tab) whose text contains `text`. */
  async clickButton(text: string): Promise<void> {
    const clicked = await this.eval<boolean>(`(() => {
      const el = [...document.querySelectorAll('button')].find((b) => !b.disabled && b.textContent.includes(${JSON.stringify(text)}));
      if (!el) return false;
      el.click();
      return true;
    })()`);
    if (!clicked) throw new Error(`no enabled button containing "${text}"`);
  }
}
