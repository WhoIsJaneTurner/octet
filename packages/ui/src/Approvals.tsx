import { useState } from 'react';
import { api } from './api';
import type { Approval, Escalation, Goal, PlanSummary } from './types';
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
        if (a.kind === 'plan') {
          return <PlanCard key={a.id} approval={a} summary={a.summary as unknown as PlanSummary} title={goal?.title ?? a.goalId}
            busy={busy === a.id} onApprove={() => void decide(a.id, 'approve')} onDone={onDone} setError={setError} />;
        }
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

/** The plan gate: everything you need to say yes, with the exact hash that will be recorded. */
function PlanCard({ approval, summary: p, title, busy, onApprove, onDone, setError }: {
  approval: Approval; summary: PlanSummary; title: string; busy: boolean; onApprove: () => void; onDone: () => void; setError: (m: string | null) => void;
}) {
  const [mode, setMode] = useState<'view' | 'reject' | 'edit'>('view');
  const [text, setText] = useState('');
  const [working, setWorking] = useState(false);
  const planId = p.planId;
  const run = async (fn: () => Promise<unknown>) => {
    setWorking(true); setError(null);
    try { await fn(); setMode('view'); setText(''); } catch (e) { setError((e as Error).message); } finally { setWorking(false); onDone(); }
  };
  const startEdit = () => run(async () => {
    const { plan } = await api<{ plan: unknown }>(`/api/plans/${planId}`);
    setText(JSON.stringify(plan, null, 2));
    setMode('edit');
  });
  const list = (items: string[]) => items.length ? <ul>{items.map((x, i) => <li key={i}>{x}</li>)}</ul> : <span className="faint"> none</span>;
  return (
    <div className="box" style={{ marginTop: 12 }}>
      <h3>Plan v{p.version}: {title}</h3>
      <div className="amber">! {approval.summary.action as string}</div>
      <div className="dim">hash {p.hash.slice(0, 16)}… is recorded in the audit log on approval</div>
      <div style={{ marginTop: 6 }}><b>Approach.</b> {p.approach}</div>
      {p.assumptions?.length > 0 && <div><b>Assumptions (approved with the plan)</b>{list(p.assumptions)}</div>}
      <div><b>Not doing</b>{list(p.notDoing)}</div>
      <div><b>Risks</b>{list(p.risks)}</div>
      <div><b>How it is verified</b>{list(p.verification)}</div>
      {p.warnings.length > 0 && <div className="amber"><b>Warnings</b>{list(p.warnings)}</div>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Bead</th><th>Size</th><th>After</th><th>Files</th><th>Acceptance</th></tr></thead>
          <tbody>
            {p.beads.map((b) => (
              <tr key={b.id}>
                <td><b>{b.id}</b> {b.title}<div className="faint">{b.objective}</div></td>
                <td>{b.size}</td><td className="dim">{b.dependsOn.join(', ') || '-'}</td>
                <td className="dim">{b.files.join(', ') || '-'}</td><td className="dim">{b.acceptance.join('; ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {mode === 'view' && (
        <div className="row">
          <button disabled={busy || working} onClick={onApprove}>APPROVE PLAN</button>
          <button disabled={busy || working} onClick={() => setMode('reject')}>REJECT WITH FEEDBACK</button>
          <button disabled={busy || working} onClick={() => void startEdit()}>EDIT</button>
        </div>
      )}
      {mode === 'reject' && (
        <>
          <label htmlFor={`fb-${planId}`}>What should the Architect change?</label>
          <textarea id={`fb-${planId}`} rows={3} value={text} onChange={(e) => setText(e.target.value)} />
          <div className="row">
            <button disabled={!text.trim() || working} onClick={() => void run(() => api(`/api/plans/${planId}/reject`, { feedback: text }))}>SEND BACK</button>
            <button onClick={() => setMode('view')}>CANCEL</button>
          </div>
        </>
      )}
      {mode === 'edit' && (
        <>
          <label htmlFor={`ed-${planId}`}>Plan JSON (saved as a new version, validated, and needs approving again)</label>
          <textarea id={`ed-${planId}`} rows={18} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
          <div className="row">
            <button disabled={working} onClick={() => void run(() => api(`/api/plans/${planId}/edit`, { plan: JSON.parse(text) as unknown }))}>SAVE AS NEW VERSION</button>
            <button onClick={() => setMode('view')}>CANCEL</button>
          </div>
        </>
      )}
    </div>
  );
}

/** Things the scheduler could not decide for itself. */
export function Escalations({ escalations, goals, onDone, setError }: {
  escalations: Escalation[]; goals: Goal[]; onDone: () => void; setError: (m: string | null) => void;
}) {
  const resolve = async (id: string) => {
    setError(null);
    try { await api(`/api/escalations/${id}/resolve`, {}); } catch (e) { setError((e as Error).message); } finally { onDone(); }
  };
  return (
    <Box title={`Needs you (${escalations.length})`}>
      {escalations.length === 0 && <span className="faint">The scheduler has nothing it cannot handle.</span>}
      {escalations.map((e) => (
        <div key={e.id} className="row">
          <span className="amber">! {e.reason.replace(/_/g, ' ')}</span>
          <span>{goals.find((g) => g.id === e.goalId)?.title ?? e.goalId}{e.beadId ? ` / ${e.beadId}` : ''}: {e.message}</span>
          <button onClick={() => void resolve(e.id)}>DISMISS</button>
        </div>
      ))}
    </Box>
  );
}
