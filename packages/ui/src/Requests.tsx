import { useState } from 'react';
import { api } from './api';
import type { Project, Request } from './types';
import { Box } from './ui';

/** Typed intake: what you want done, in your words. The project is optional; leave it blank and route it from the inbox. */
export function NewRequest({ projects, onDone, setError }: {
  projects: Project[]; onDone: () => void; setError: (m: string | null) => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [project, setProject] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      await api('/api/requests', { title, body, project });
      setTitle(''); setBody('');
      onDone();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Box title="New request">
      <label htmlFor="rq-title">What do you want done?</label>
      <input id="rq-title" style={{ width: '100%' }} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Add rate limiting to the upload endpoint" />
      <label htmlFor="rq-body">Details (optional)</label>
      <textarea id="rq-body" rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Context, constraints, what done looks like" />
      <label htmlFor="rq-project">Project</label>
      <select id="rq-project" value={project} onChange={(e) => setProject(e.target.value)}>
        <option value="">(decide later: it waits in the inbox)</option>
        {projects.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
      </select>
      <div className="row"><button disabled={!title.trim() || busy} onClick={() => void submit()}>SUBMIT REQUEST</button></div>
    </Box>
  );
}

const STATE: Record<Request['status'], { glyph: string; cls: string }> = {
  new: { glyph: '?', cls: 'cyan' }, routed: { glyph: '○', cls: 'dim' }, planning: { glyph: '▶', cls: 'amber' },
  planned: { glyph: '◆', cls: '' }, rejected: { glyph: '✖', cls: 'faint' },
};

/** Requests that still need you: route the unrouted ones, or decline any that have not been planned. */
export function RequestList({ requests, projects, planning, onDone, setError }: {
  requests: Request[]; projects: Project[]; planning: string[]; onDone: () => void; setError: (m: string | null) => void;
}) {
  const [pick, setPick] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const open = requests.filter((r) => r.status === 'new' || r.status === 'routed');
  const act = async (id: string, what: 'route' | 'reject' | 'plan', body: Record<string, string>) => {
    setBusy(id); setError(null);
    try { await api(`/api/requests/${id}/${what}`, body); } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); onDone(); }
  };
  const reject = (id: string) => {
    const reason = window.prompt('Why are you declining this request?');
    if (reason?.trim()) void act(id, 'reject', { reason });
  };
  return (
    <Box title={`Requests (${open.length})`}>
      {open.length === 0 && <span className="faint">No open requests.</span>}
      {open.map((r) => (
        <div key={r.id} className="box" style={{ marginTop: 12 }}>
          <h3>{r.title}</h3>
          <div className={STATE[r.status].cls}>{STATE[r.status].glyph} {r.status === 'new' ? 'route this request' : `routed to ${r.project}`} <span className="faint">({r.id} · {r.source} · {r.requester})</span></div>
          {r.body && <pre className="dim out" style={{ marginTop: 6 }}>{r.body}</pre>}
          <div className="row">
            <select aria-label={`Project for ${r.title}`} value={pick[r.id] ?? r.project ?? ''} onChange={(e) => setPick({ ...pick, [r.id]: e.target.value })}>
              <option value="">(choose a project)</option>
              {projects.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
            <button disabled={busy === r.id || !(pick[r.id] ?? r.project) || (pick[r.id] ?? r.project) === r.project} onClick={() => void act(r.id, 'route', { project: pick[r.id]! })}>ROUTE</button>
            {r.project && <button disabled={busy === r.id || planning.includes(r.id) || r.status === 'new'} onClick={() => void act(r.id, 'plan', {})}>
              {planning.includes(r.id) ? 'PLANNING…' : r.status === 'planning' ? 'PLAN AGAIN' : 'PLAN'}
            </button>}
            <button disabled={busy === r.id} onClick={() => reject(r.id)}>DECLINE</button>
          </div>
        </div>
      ))}
    </Box>
  );
}
