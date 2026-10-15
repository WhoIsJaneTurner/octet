import { useState } from 'react';
import { api } from './api';
import type { Bead, Goal, OctetEvent, PullRequest, State } from './types';
import { Box, StatusMark } from './ui';

const BANNER = String.raw`  ___   ____ _____ _____ _____
 / _ \ / ___|_   _| ____|_   _|
| | | | |     | | |  _|   | |
| |_| | |___  | | | |___  | |
 \___/ \____| |_| |_____| |_|`;

interface SeatLine { state: string; cls: string; note: string }

/** Honest per-seat status: what is wired to code today, and what is still you at the keyboard. */
function seatLine(id: string, s: State): SeatLine {
  const count = (st: string) => s.beads.filter((b) => b.status === st).length;
  switch (id) {
    case 'engineer': {
      const n = s.running.length;
      return n ? { state: 'WORKING', cls: 'amber', note: `${n} bead${n > 1 ? 's' : ''} running` }
        : { state: 'IDLE', cls: 'dim', note: 'ready to build a bead' };
    }
    case 'warden': {
      const n = s.approvals.filter((a) => a.status === 'pending').length;
      return n ? { state: 'WAITING ON YOU', cls: 'cyan', note: `${n} outbound action${n > 1 ? 's' : ''} need your approval` }
        : { state: 'ARMED', cls: '', note: 'only the engineer writes; only the marshal merges; pushes need the courier + your OK' };
    }
    case 'courier': return { state: 'ON CALL', cls: 'dim', note: 'deterministic: pushes and opens PRs only after you approve (no model involved)' };
    case 'reviewer': {
      const n = count('in_review');
      return n ? { state: 'WAITING ON YOU', cls: 'cyan', note: `${n} bead${n > 1 ? 's' : ''} to review (you are the reviewer for now)` }
        : { state: 'MANUAL', cls: 'dim', note: 'you review diffs until this seat is built' };
    }
    case 'marshal': {
      const n = s.escalations.length;
      return n ? { state: 'NEEDS YOU', cls: 'amber', note: `${n} thing${n > 1 ? 's' : ''} the scheduler cannot decide` }
        : { state: 'SCHEDULING', cls: '', note: 'turns approved plans into beads and runs them within the caps (deterministic code)' };
    }
    case 'architect': {
      const n = s.planning.length;
      const waiting = s.plans.filter((p) => p.status === 'awaiting_approval').length;
      return n ? { state: 'PLANNING', cls: 'amber', note: `${n} request${n > 1 ? 's' : ''} being planned` }
        : waiting ? { state: 'WAITING ON YOU', cls: 'cyan', note: `${waiting} plan${waiting > 1 ? 's' : ''} to approve in the inbox` }
          : { state: 'IDLE', cls: 'dim', note: 'plans a routed request when you press PLAN (needs a project vault)' };
    }
    case 'chair': {
      const n = s.requests.filter((r) => r.status === 'new').length;
      return n ? { state: 'WAITING ON YOU', cls: 'cyan', note: `${n} request${n > 1 ? 's' : ''} to route` }
        : { state: 'INTAKE', cls: 'dim', note: 'takes typed requests; clarifying questions are not built yet' };
    }
    default: return { state: 'NOT BUILT', cls: 'faint', note: 'persona written, no runtime yet' };
  }
}

export function Council({ s }: { s: State }) {
  return (
    <>
      <pre className="banner" aria-label="OCTET">{BANNER}</pre>
      <Box title="The council (8 seats)">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Seat</th><th>Kind</th><th>State</th><th>Notes</th></tr></thead>
            <tbody>
              {s.seats.map((seat) => {
                const l = seatLine(seat.id, s);
                return (
                  <tr key={seat.id}>
                    <td><b>{seat.title}</b></td>
                    <td className="dim">{seat.kind === 'deterministic' ? 'policy' : 'agent'}</td>
                    <td className={l.cls}>{l.state}</td>
                    <td className="dim">{l.note}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Box>
      <Box title="Awaiting you">
        {s.beads.filter((b) => b.status === 'in_review').length === 0
          ? <span className="faint">Nothing to review. All quiet.</span>
          : s.beads.filter((b) => b.status === 'in_review').map((b) => (
            <div key={b.id}>◆ {b.title} <span className="faint">({b.id})</span></div>
          ))}
      </Box>
    </>
  );
}

const LANES: { key: Bead['status'][]; title: string }[] = [
  { key: ['todo', 'failed'], title: 'todo' },
  { key: ['running'], title: 'running' },
  { key: ['in_review'], title: 'review' },
  { key: ['changes_requested'], title: 'changes' },
  { key: ['merged'], title: 'merged' },
];

export function Board({ goal, beads, selected, onSelect, tag, onTogglePause }: {
  goal: Goal | undefined; beads: Bead[]; selected: string | undefined;
  onSelect: (id: string) => void; tag: React.ReactNode; onTogglePause?: () => void;
}) {
  if (!goal) return <span className="faint">No goal selected. Create one from the left panel.</span>;
  return (
    <>
      <div className="row">
        <b>{goal.title}</b> {tag} <span className="faint">{goal.branch}</span>
        <span className={goal.status === 'active' ? 'dim' : 'cyan'}>[{goal.status.replace('_', ' ')}{goal.paused ? ', paused' : ''}]</span>
        {onTogglePause && goal.status === 'active' && beads.some((b) => b.planId) && <button onClick={onTogglePause}>{goal.paused ? 'RESUME SCHEDULER' : 'PAUSE SCHEDULER'}</button>}
      </div>
      <div className="cols">
        {LANES.map((lane) => {
          const items = beads.filter((b) => lane.key.includes(b.status));
          return (
            <div className="lane" key={lane.title}>
              <h4>{lane.title} ({items.length})</h4>
              {items.map((b) => (
                <button key={b.id} className="card" aria-current={selected === b.id} onClick={() => onSelect(b.id)}>
                  <StatusMark status={b.status} />
                  <div>{b.title}</div>
                  <small>{b.id}{b.dependsOn.length ? ` · after ${b.dependsOn.join(', ')}` : ''}</small>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </>
  );
}

const summarize = (e: OctetEvent): string => {
  const d = e.data as Record<string, unknown>;
  if (typeof d.message === 'string') return d.message;
  if (typeof d.feedback === 'string') return d.feedback;
  if (typeof d.title === 'string') return d.title;
  if (typeof d.branch === 'string') return d.branch;
  if (typeof d.commits === 'number') return `${d.commits} commit(s), exit ${String(d.exitCode)}`;
  return '';
};

export function Log({ events }: { events: OctetEvent[] }) {
  return (
    <Box title="Audit log (newest first)">
      <div className="table-wrap">
        <table>
          <thead><tr><th>Time</th><th>Seat</th><th>Event</th><th>Ref</th><th>Detail</th></tr></thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td className="dim">{e.ts.slice(11, 19)}</td>
                <td>{e.seat ?? '-'}</td>
                <td className={e.kind.includes('error') || e.kind.includes('failed') ? 'red' : ''}>{e.kind}</td>
                <td className="faint">{e.beadId ?? e.goalId ?? ''}</td>
                <td className="dim">{summarize(e)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {events.length === 0 && <span className="faint">No events yet.</span>}
    </Box>
  );
}

const REVIEW_LABEL: Record<string, { text: string; cls: string }> = {
  REVIEW_REQUIRED: { text: 'WAITING ON A HUMAN REVIEWER', cls: 'amber' },
  APPROVED: { text: 'APPROVED', cls: '' },
  CHANGES_REQUESTED: { text: 'CHANGES REQUESTED', cls: 'red' },
  '': { text: 'no review rule (or not read yet)', cls: 'dim' },
};

export function PrCard({ pr, reviewing, onDone, setError }: {
  pr: PullRequest; reviewing: boolean; onDone: () => void; setError: (m: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const label = REVIEW_LABEL[pr.reviewDecision] ?? { text: pr.reviewDecision, cls: 'dim' };
  const call = async (path: string) => {
    setBusy(true); setError(null);
    try { await api(path, {}); } catch (e) { setError((e as Error).message); } finally { setBusy(false); onDone(); }
  };
  return (
    <Box title="Pull request">
      <div><a href={pr.url} target="_blank" rel="noopener noreferrer">{pr.url}</a></div>
      <table>
        <tbody>
          <tr><td className="dim">state</td><td className={pr.state === 'MERGED' ? '' : 'cyan'}>{pr.state}</td></tr>
          <tr><td className="dim">review</td><td className={label.cls}>{label.text}</td></tr>
          <tr><td className="dim">checks</td><td className={pr.checks === 'failing' ? 'red' : pr.checks === 'pending' ? 'amber' : ''}>{pr.checks}</td></tr>
        </tbody>
      </table>
      <div className="row">
        <button disabled={busy} onClick={() => void call('/api/prs/refresh')}>REFRESH</button>
        <button disabled={busy || reviewing || pr.state !== 'OPEN'} onClick={() => void call(`/api/goals/${pr.goalId}/prereview`)}
          title="Drafts an automated comment for your teammate. You approve it before anything is posted.">
          {reviewing ? 'PRE-REVIEWING…' : 'DRAFT PRE-REVIEW COMMENT'}
        </button>
      </div>
    </Box>
  );
}
