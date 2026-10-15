import type { Request, State } from './types';

/** One line under the inbox: which external sources are on, when they last ran, and what is being held for you. */
export function IntakeLine({ intake, requests }: { intake: State['intake']; requests: Request[] }) {
  const on = intake?.sources.filter((s) => s.enabled) ?? [];
  if (!on.length) return null;
  const held = requests.filter((r) => intake?.held.includes(r.id) && r.status === 'new');
  return (
    <div className="dim" style={{ margin: '8px 0' }}>
      <span>intake:</span>{' '}
      {on.map((s) => (
        <span key={s.kind} className={s.lastError ? 'red' : ''} title={s.lastError ?? s.detail} style={{ marginRight: 12 }}>
          {s.kind} {s.lastError ? `✖ ${s.lastError.slice(0, 60)}` : s.lastPollAt ? `✔ ${new Date(s.lastPollAt).toLocaleTimeString()}` : '…'}
        </span>
      ))}
      {held.length > 0 && <span className="amber">⚠ {held.length} held for you (sender not allow-listed): {held.map((r) => r.title.slice(0, 40)).join('; ')}</span>}
    </div>
  );
}
