import { execFile } from 'node:child_process';
import type { Store } from '@octet/core';

export type Notifier = (title: string, body: string) => void;

const clean = (s: string, max: number): string => s.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max);

/**
 * Shows a macOS notification through `osascript`. The text is passed as arguments to a fixed script, never spliced
 * into it. A missing `osascript` (or any other platform) is silently ignored: a notification must never break a run.
 */
export function macosNotifier(): Notifier {
  return (title, body) => {
    if (process.platform !== 'darwin') return;
    try {
      execFile(
        'osascript',
        ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', clean(title, 80), clean(body, 200)],
        { timeout: 10_000 },
        () => { /* not installed, or no permission to notify: nothing to do */ },
      );
    } catch { /* same */ }
  };
}

/**
 * Notifies when something new needs you: an approval (plan, delivery, PR comment) or an escalation. What is already
 * waiting when this starts is not announced again. Returns a function that stops watching.
 */
export function watchForNotifications(store: Store, notifier: Notifier): () => void {
  const notify: Notifier = (title, body) => { try { notifier(title, body); } catch { /* a broken notifier must not stop the others */ } };
  const seen = new Set<string>([
    ...store.listApprovals().filter((a) => a.status === 'pending').map((a) => a.id),
    ...store.listEscalations(true).map((e) => e.id),
  ]);
  const title = (goalId: string) => store.getGoal(goalId)?.title ?? goalId;
  const WHAT: Record<string, string> = { plan: 'A plan is waiting for your approval', deliver: 'A delivery is waiting for your approval', comment: 'A PR comment is waiting for your approval' };
  const check = () => {
    for (const a of store.listApprovals().filter((x) => x.status === 'pending')) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      notify('Octet: approval needed', `${WHAT[a.kind] ?? 'An approval is waiting'}: ${title(a.goalId)}`);
    }
    for (const e of store.listEscalations(true)) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      notify('Octet: a goal needs you', `${title(e.goalId)}: ${e.message}`);
    }
  };
  let timer: NodeJS.Timeout | undefined;
  const off = store.subscribe(() => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      try { check(); } catch { /* never fail the daemon over a notification */ }
    }, 150);
    timer.unref();
  });
  return () => { off(); clearTimeout(timer); };
}
