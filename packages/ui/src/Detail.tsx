import { useEffect, useState } from 'react';
import { api } from './api';
import type { Bead, Goal, OctetEvent, UsageTotals } from './types';
import { BeadEditor, usageLine } from './Manage';
import { Box, Diff, StatusMark } from './ui';

export function Detail({ bead, goal, beads, output, running, reviewing, events, usage, onDone, setError, view, setView }: {
  bead: Bead | undefined; goal: Goal | undefined; beads: Bead[]; output: string; running: boolean;
  reviewing: boolean; events: OctetEvent[]; usage: UsageTotals | undefined;
  onDone: () => void; setError: (m: string | null) => void;
  view: 'output' | 'diff'; setView: (v: 'output' | 'diff') => void;
}) {
  const [diff, setDiff] = useState('');
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const id = bead?.id;
  const status = bead?.status;
  const last = events.find((e) => e.kind === 'review.verdict' && e.beadId === id);
  const verdict = last ? (last.data as { verdict: string; feedback: string }) : undefined;

  useEffect(() => {
    if (!id) return;
    let alive = true;
    api<{ diff: string }>(`/api/beads/${id}/diff`).then((r) => alive && setDiff(r.diff)).catch(() => alive && setDiff(''));
    return () => { alive = false; };
  }, [id, status]);

  if (!bead || !goal) {
    return <Box title="Bead"><span className="faint">Select a bead. <span className="cursor" /></span></Box>;
  }
  const blocked = bead.dependsOn.filter((d) => beads.find((b) => b.id === d)?.status !== 'merged');
  const canRun = ['todo', 'failed', 'changes_requested', 'conflict'].includes(bead.status) && blocked.length === 0 && !running && goal.status !== 'failed';

  const act = async (path: string, body?: unknown) => {
    setBusy(true); setError(null);
    try {
      await api(`/api/beads/${bead.id}/${path}`, body ?? {});
      if (path === 'run') setView('output');
      if (path === 'changes') setFeedback('');
      onDone();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <>
      <Box title="Bead">
        <div><b>{bead.title}</b></div>
        <div className="faint">{bead.id} · {bead.branch}</div>
        <div className="row"><StatusMark status={bead.status} />{running && <span className="amber cursor">working</span>}</div>
        {bead.dependsOn.length > 0 && <div className="dim">after: {bead.dependsOn.join(', ')}{blocked.length ? <span className="amber"> (waiting on {blocked.join(', ')})</span> : null}</div>}
        <pre className="dim" style={{ marginTop: 6 }}>{bead.brief}</pre>
        <div className="faint" title="Claude Code's estimate at list prices">{usageLine(usage)}</div>
        <BeadEditor bead={bead} goal={goal} beads={beads} onDone={onDone} setError={setError} />
        <div className="row">
          <button disabled={!canRun || busy} onClick={() => void act('run')}>[r] {bead.status === 'changes_requested' ? 'RE-RUN' : bead.status === 'conflict' ? 'RESOLVE CONFLICT' : 'RUN'}</button>
          {(bead.status === 'running' || reviewing) && <button disabled={busy} onClick={() => void act('cancel')}>[x] CANCEL{reviewing ? ' REVIEW' : ''}</button>}
          <button disabled={bead.status !== 'in_review' || busy || reviewing} onClick={() => void act('review')}>[v] AI REVIEW</button>
          <button disabled={bead.status !== 'in_review' || busy} onClick={() => void act('approve')}>[a] APPROVE + MERGE</button>
        </div>
        {(reviewing || verdict) && (
          <div className="box" style={{ marginTop: 14 }}>
            <h3>Reviewer</h3>
            {reviewing && <div className="amber cursor">reading the diff</div>}
            {verdict && (
              <>
                <div className={verdict.verdict === 'approve' ? '' : verdict.verdict === 'changes_requested' ? 'amber' : 'dim'}>
                  {verdict.verdict === 'approve' ? '✔ APPROVE (recommendation: you still merge)' : verdict.verdict === 'changes_requested' ? '↺ CHANGES REQUESTED' : '? INCONCLUSIVE'}
                </div>
                <pre className="dim" style={{ marginTop: 4 }}>{verdict.feedback}</pre>
              </>
            )}
          </div>
        )}
        {bead.status === 'in_review' && (
          <>
            <label htmlFor="fb">Request changes (sent to the Engineer)</label>
            <textarea id="fb" rows={3} value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="What needs to change?" />
            <div className="row"><button disabled={!feedback.trim() || busy} onClick={() => void act('changes', { feedback })}>[c] REQUEST CHANGES</button></div>
          </>
        )}
      </Box>
      <Box title={view === 'output' ? 'Engineer output' : 'Diff vs goal branch'}>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={view === 'output'} onClick={() => setView('output')}>output</button>
          <button role="tab" aria-selected={view === 'diff'} onClick={() => setView('diff')}>diff</button>
        </div>
        <div className="out" tabIndex={0}>
          {view === 'output'
            ? (output ? <pre>{output}</pre> : <span className="faint">(no output yet)</span>)
            : <Diff text={diff} />}
        </div>
      </Box>
    </>
  );
}
