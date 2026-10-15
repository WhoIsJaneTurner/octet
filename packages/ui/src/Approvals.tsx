import { useState } from 'react';
import { api } from './api';
import type { Approval, Goal } from './types';
import { Box, IdentityTag } from './ui';

/** The Warden's inbox: every outbound action waits here with its exact target, account and diff. */
export function Inbox({ approvals, goals, order, onDone, setError }: {
  approvals: Approval[]; goals: Goal[]; order: string[]; onDone: () => void; setError: (m: string | null) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const pending = approvals.filter((a) => a.status === 'pending');
  const decide = async (id: string, what: 'approve' | 'deny') => {
    setBusy(id); setError(null);
    try { await api(`/api/approvals/${id}/${what}`, {}); } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); onDone(); }
  };
  return (
    <Box title={`Warden inbox (${pending.length})`}>
      {pending.length === 0 && <span className="faint">No outbound actions waiting. Nothing leaves this machine without your OK.</span>}
      {pending.map((a) => {
        const s = a.summary as Record<string, string | number | string[]>;
        const goal = goals.find((g) => g.id === a.goalId);
        return (
          <div key={a.id} className="box" style={{ marginTop: 12 }}>
            <h3>{goal?.title ?? a.goalId}</h3>
            <div className="amber">! {String(s.action)}</div>
            <table>
              <tbody>
                <tr><td className="dim">account</td><td><IdentityTag id={String(s.identity)} order={order} /> {String(s.account)}</td></tr>
                <tr><td className="dim">remote</td><td>{String(s.remote)}</td></tr>
                {a.kind === 'deliver' ? (
                  <>
                    <tr><td className="dim">branch</td><td>{String(s.branch)} → {String(s.base)} ({String(s.commits)} commits)</td></tr>
                    <tr><td className="dim">beads</td><td>{(s.beads as string[]).join(', ')}</td></tr>
                  </>
                ) : (
                  <tr><td className="dim">pull request</td><td>{String(s.pr)}</td></tr>
                )}
              </tbody>
            </table>
            <pre className="dim out" style={{ marginTop: 6 }}>{a.kind === 'deliver' ? String(s.diffstat) : String(s.body)}</pre>
            <div className="row">
              <button disabled={busy === a.id} onClick={() => void decide(a.id, 'approve')}>{a.kind === 'deliver' ? 'APPROVE: PUSH + OPEN PR' : 'APPROVE: POST COMMENT'}</button>
              <button disabled={busy === a.id} onClick={() => void decide(a.id, 'deny')}>DENY</button>
            </div>
          </div>
        );
      })}
    </Box>
  );
}
