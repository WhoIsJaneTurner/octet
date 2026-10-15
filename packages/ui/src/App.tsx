import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, useOctet } from './api';
import { Detail } from './Detail';
import { Clarifications, Escalations, Inbox } from './Approvals';
import { NewRequest, RequestList } from './Requests';
import { IntakeLine } from './IntakeLine';
import { Board, Council, Log, PrCard } from './views';
import { IdentityTag } from './ui';

type Tab = 'council' | 'board' | 'inbox' | 'log';
const TABS: { id: Tab; label: string }[] = [
  { id: 'council', label: '1 council' },
  { id: 'board', label: '2 board' },
  { id: 'inbox', label: '3 inbox' },
  { id: 'log', label: '4 log' },
];

function load(key: string, fallback: string): string {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function save(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* storage may be blocked */ }
}

export function App() {
  const { state, online, outputs, loadOutput, refresh } = useOctet();
  const [tab, setTabState] = useState<Tab>(() => {
    const h = window.location.hash.slice(1);
    return TABS.some((t) => t.id === h) ? (h as Tab) : 'council';
  });
  const setTab = (t: Tab) => { setTabState(t); window.history.replaceState(null, '', `#${t}`); };
  const [goalId, setGoalId] = useState<string>();
  const [beadId, setBeadId] = useState<string>();
  const [view, setView] = useState<'output' | 'diff'>('output');
  const [error, setError] = useState<string | null>(null);
  const [crt, setCrt] = useState(load('octet.crt', '1') === '1');
  const [form, setForm] = useState<'goal' | 'bead' | null>(null);

  useEffect(() => { document.body.classList.toggle('crt', crt); save('octet.crt', crt ? '1' : '0'); }, [crt]);

  const idOrder = useMemo(() => state?.identities.map((i) => i.id) ?? [], [state]);
  const goal = state?.goals.find((g) => g.id === goalId) ?? state?.goals[0];
  const goalBeads = useMemo(() => state?.beads.filter((b) => b.goalId === goal?.id) ?? [], [state, goal?.id]);
  const bead = goalBeads.find((b) => b.id === beadId) ?? (tab === 'board' ? goalBeads[0] : undefined);
  const project = state?.projects.find((p) => p.name === goal?.project);
  const identityTag = project ? <IdentityTag id={project.identity} order={idOrder} /> : null;
  const isRunning = !!bead && !!state?.running.includes(bead.id);

  const activeBeadId = bead?.id;
  useEffect(() => { if (activeBeadId) void loadOutput(activeBeadId); }, [activeBeadId, loadOutput]);

  const select = (id: string) => { setBeadId(id); setTab('board'); };
  const deliver = async () => {
    if (!goal) return;
    setError(null);
    try { await api(`/api/goals/${goal.id}/deliver`, {}); setTab('inbox'); await refresh(); }
    catch (e) { setError((e as Error).message); }
  };
  const run = async (path: 'run' | 'approve' | 'review' | 'cancel') => {
    if (!bead) return;
    setError(null);
    try { await api(`/api/beads/${bead.id}/${path}`, {}); if (path === 'run') setView('output'); await refresh(); }
    catch (e) { setError((e as Error).message); }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '1') setTab('council');
      else if (e.key === '2') setTab('board');
      else if (e.key === '3') setTab('inbox');
      else if (e.key === '4') setTab('log');
      else if (e.key === 'j' || e.key === 'k') {
        const i = goalBeads.findIndex((b) => b.id === bead?.id);
        const next = goalBeads[Math.min(goalBeads.length - 1, Math.max(0, i + (e.key === 'j' ? 1 : -1)))];
        if (next) { setBeadId(next.id); setTab('board'); }
      } else if (e.key === 'r') void run('run');
      else if (e.key === 'x') void run('cancel');
      else if (e.key === 'a') void run('approve');
      else if (e.key === 'v') void run('review');
      else if (e.key === 'd') setView((v) => (v === 'diff' ? 'output' : 'diff'));
      else if (e.key === 'c') document.getElementById('fb')?.focus();
      else return;
      if (e.key === 'c') e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!state) {
    return (
      <div className="app"><div className="bar"><b>OCTET</b><span className={online ? 'on' : 'off'}>{online ? 'connecting' : 'daemon offline'}</span></div>
        <div className="col">{online ? 'loading' : 'Cannot reach the Octet daemon. Start it with: pnpm start'}<span className="cursor" /></div><div /></div>
    );
  }

  return (
    <div className="app">
      <header className="bar">
        <b>OCTET v0.1</b>
        <span className={online ? 'on' : 'off'}>{online ? '● daemon online' : '○ daemon offline'}</span>
        <span className="dim">{state.identities.length} identities</span>
        <span className={state.running.length ? 'amber' : 'dim'}>{state.running.length}/{state.limits.maxEngineers} running</span>
        <span className={state.audit.ok ? 'dim' : 'red'} title={state.audit.ok ? `head ${state.audit.head.slice(0, 12)}` : state.audit.reason}>{state.audit.ok ? `audit ✔ ${state.audit.checked}` : '✖ AUDIT CHAIN BROKEN'}</span>
        {state.requests.some((r) => r.status === 'new') && <span className="cyan">? {state.requests.filter((r) => r.status === 'new').length} to route</span>}
        {state.clarifications.length > 0 && <span className="cyan">? {state.clarifications.length} question{state.clarifications.length > 1 ? 's' : ''} for you</span>}
        {state.escalations.length > 0 && <span className="amber">! {state.escalations.length} need{state.escalations.length === 1 ? 's' : ''} you</span>}
        {state.approvals.some((a) => a.status === 'pending') && <span className="cyan">◆ {state.approvals.filter((a) => a.status === 'pending').length} awaiting approval</span>}
        <span className="sp" />
        <button onClick={() => setCrt(!crt)} aria-pressed={crt} title="Toggle scanlines and glow">CRT {crt ? 'on' : 'off'}</button>
      </header>

      <div className="main">
        <nav className="col" aria-label="Projects and goals">
          {state.projects.length === 0 && <div className="amber">No projects. Add one with:<pre className="dim">octet project add &lt;name&gt; &lt;path&gt; --identity &lt;id&gt;</pre></div>}
          {state.projects.map((p) => (
            <div key={p.name}>
              <div className="proj">{p.name} <IdentityTag id={p.identity} order={idOrder} /></div>
              {state.goals.filter((g) => g.project === p.name).map((g) => (
                <button key={g.id} className="nav-item" aria-current={goal?.id === g.id}
                  onClick={() => { setGoalId(g.id); setBeadId(undefined); setTab('board'); }}>
                  {g.title}{g.status === 'delivered' ? ' ⇡' : g.status === 'done' ? ' ✔' : g.status === 'planning' ? ' …' : g.status === 'plan_ready' ? ' ?' : g.paused ? ' ‖' : ''}
                </button>
              ))}
            </div>
          ))}
          <div className="row">
            <button disabled={!state.projects.length} onClick={() => setForm(form === 'goal' ? null : 'goal')}>+ goal</button>
            <button disabled={!goal} onClick={() => setForm(form === 'bead' ? null : 'bead')}>+ bead</button>
            <button disabled={!goal || goal.status !== 'active' || goalBeads.length === 0 || goalBeads.some((b) => b.status !== 'merged')}
              title="Available once every bead is merged" onClick={() => void deliver()}>deliver</button>
          </div>
          {form === 'goal' && <GoalForm projects={state.projects.map((p) => p.name)} defaultProject={goal?.project}
            onDone={(g) => { setForm(null); setGoalId(g); void refresh(); }} setError={setError} />}
          {form === 'bead' && goal && <BeadForm goalId={goal.id} others={goalBeads}
            onDone={(b) => { setForm(null); setBeadId(b); setTab('board'); void refresh(); }} setError={setError} />}
        </nav>

        <main className="col">
          {error && <div className="err" role="alert">! {error} <button onClick={() => setError(null)}>dismiss</button></div>}
          <div className="tabs" role="tablist">
            {TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>
            ))}
          </div>
          {tab === 'council' && <><Council s={state} /><NewRequest projects={state.projects} onDone={() => void refresh()} setError={setError} /></>}
          {tab === 'board' && goal && state.prs.find((p) => p.goalId === goal.id) && (
            <PrCard pr={state.prs.find((p) => p.goalId === goal.id)!} reviewing={state.reviewing.includes(goal.id)}
              onDone={() => void refresh()} setError={setError} />
          )}
          {tab === 'board' && <Board goal={goal} beads={goalBeads} selected={bead?.id} onSelect={select} tag={identityTag}
            onTogglePause={goal ? () => { void api(`/api/goals/${goal.id}/${goal.paused ? 'resume' : 'pause'}`, {}).then(() => refresh()).catch((e: Error) => setError(e.message)); } : undefined} />}
          {tab === 'inbox' && <IntakeLine intake={state.intake} requests={state.requests} />}
          {tab === 'inbox' && <Clarifications items={state.clarifications} goals={state.goals} onDone={() => void refresh()} setError={setError} />}
          {tab === 'inbox' && <Escalations escalations={state.escalations} goals={state.goals} onDone={() => void refresh()} setError={setError} />}
          {tab === 'inbox' && <RequestList requests={state.requests} projects={state.projects} planning={state.planning} onDone={() => void refresh()} setError={setError} />}
          {tab === 'inbox' && <Inbox approvals={state.approvals} goals={state.goals} order={idOrder} onDone={() => void refresh()} setError={setError} />}
          {tab === 'log' && <Log events={state.events} />}
        </main>

        <aside className="col detail" aria-label="Bead detail">
          <Detail bead={bead} goal={goal} beads={goalBeads} output={bead ? outputs[bead.id] ?? '' : ''} running={isRunning} reviewing={!!bead && state.reviewing.includes(bead.id)} events={state.events}
            view={view} setView={setView} setError={setError} onDone={() => void refresh()} />
        </aside>
      </div>

      <footer className="foot">
        <kbd>1</kbd>council<kbd>2</kbd>board<kbd>3</kbd>inbox<kbd>4</kbd>log<kbd>j</kbd><kbd>k</kbd>bead<kbd>r</kbd>run<kbd>x</kbd>cancel<kbd>v</kbd>review<kbd>a</kbd>approve<kbd>c</kbd>changes<kbd>d</kbd>diff
      </footer>
    </div>
  );
}

function GoalForm({ projects, defaultProject, onDone, setError }: {
  projects: string[]; defaultProject: string | undefined; onDone: (goalId: string) => void; setError: (m: string | null) => void;
}) {
  const [project, setProject] = useState(defaultProject ?? projects[0] ?? '');
  const [title, setTitle] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setError(null);
    try { onDone((await api<{ id: string }>('/api/goals', { project, title })).id); setTitle(''); }
    catch (err) { setError((err as Error).message); }
  };
  return (
    <form onSubmit={(e) => void submit(e)}>
      <label htmlFor="gp">Project</label>
      <select id="gp" value={project} onChange={(e) => setProject(e.target.value)}>{projects.map((p) => <option key={p}>{p}</option>)}</select>
      <label htmlFor="gt">Goal</label>
      <input id="gt" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add rate limiting" autoFocus />
      <div className="row"><button type="submit" disabled={!title.trim()}>create</button></div>
    </form>
  );
}

function BeadForm({ goalId, others, onDone, setError }: {
  goalId: string; others: { id: string; title: string }[]; onDone: (beadId: string) => void; setError: (m: string | null) => void;
}) {
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [after, setAfter] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setError(null);
    try {
      const b = await api<{ id: string }>('/api/beads', { goalId, title, brief, dependsOn: after ? [after] : [] });
      setTitle(''); setBrief(''); setAfter(''); onDone(b.id);
    } catch (err) { setError((err as Error).message); }
  };
  return (
    <form onSubmit={(e) => void submit(e)}>
      <label htmlFor="bt">Bead title</label>
      <input id="bt" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      <label htmlFor="bb">Brief for the Engineer</label>
      <textarea id="bb" rows={4} value={brief} onChange={(e) => setBrief(e.target.value)} />
      <label htmlFor="ba">After</label>
      <select id="ba" value={after} onChange={(e) => setAfter(e.target.value)}>
        <option value="">(nothing)</option>
        {others.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
      </select>
      <div className="row"><button type="submit" disabled={!title.trim() || !brief.trim()}>add bead</button></div>
    </form>
  );
}
