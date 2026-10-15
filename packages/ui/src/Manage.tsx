import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from './api';
import type { Bead, Goal, IdentityHealth, Project, State, UsageTotals } from './types';
import { Box, IdentityTag } from './ui';

const AUTONOMY: { id: NonNullable<Project['autonomy']>; note: string }[] = [
  { id: 'manual', note: 'the scheduler does nothing; you run every step' },
  { id: 'plan-gated', note: 'after you approve a plan the scheduler builds and reviews; you merge each bead' },
  { id: 'auto-to-pr', note: 'the scheduler also merges approved beads; it still stops at the delivery approval' },
];

const money = (n: number): string => `$${n.toFixed(2)}`;
export const tokens = (n: number): string => (n < 1000 ? String(n) : n < 1e6 ? `${(n / 1e3).toFixed(1)}k` : `${(n / 1e6).toFixed(2)}M`);

/** One line of usage: runs, estimated cost and token counts. */
export function usageLine(t: UsageTotals | undefined): string {
  if (!t || t.runs === 0) return 'no runs yet';
  return `${t.runs} run${t.runs === 1 ? '' : 's'} · ${money(t.costUsd)} est. · in ${tokens(t.inputTokens)} · out ${tokens(t.outputTokens)} · cache ${tokens(t.cacheReadTokens + t.cacheCreationTokens)}`;
}

/** Projects: the ones the daemon knows (it re-reads projects.toml when the file changes), and a form to add one. */
export function ProjectsPanel({ s, order, onDone, setError }: {
  s: State; order: string[]; onDone: () => void; setError: (m: string | null) => void;
}) {
  const empty = { name: '', path: '', identity: '', vault: '', autonomy: 'plan-gated', vaultGit: false, vaultInRepo: false };
  const [f, setF] = useState(empty);
  const [busy, setBusy] = useState(false);
  const identity = f.identity || s.identities[0]?.id || '';
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      await api('/api/projects', { name: f.name.trim(), path: f.path.trim(), identity, vault: f.vault.trim(), autonomy: f.autonomy, vaultGit: f.vaultGit, vaultInRepo: f.vaultInRepo });
      setF(empty);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); onDone(); }
  };
  const setAutonomy = async (name: string, autonomy: string) => {
    setError(null);
    try { await api(`/api/projects/${encodeURIComponent(name)}`, { autonomy }); } catch (err) { setError((err as Error).message); } finally { onDone(); }
  };
  return (
    <>
      <Box title={`Projects (${s.projects.length})`}>
        {s.projectsError && <div className="err" role="alert">projects.toml could not be read, showing the last good list: {s.projectsError}</div>}
        {s.projects.length === 0 && <span className="faint">No projects yet. Add one below, or run: octet project add</span>}
        {s.projects.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Identity</th><th>Autonomy</th><th>Vault</th><th>Path</th></tr></thead>
              <tbody>
                {s.projects.map((p) => (
                  <tr key={p.name}>
                    <td><b>{p.name}</b></td>
                    <td><IdentityTag id={p.identity} order={order} /></td>
                    <td>
                      <select aria-label={`Autonomy for ${p.name}`} value={p.autonomy ?? 'plan-gated'} onChange={(e) => void setAutonomy(p.name, e.target.value)}>
                        {AUTONOMY.map((a) => <option key={a.id}>{a.id}</option>)}
                      </select>
                    </td>
                    <td className="dim">{p.vault ?? <span className="faint">none: planning is off</span>}</td>
                    <td className="faint">{p.path}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="faint">{AUTONOMY.map((a) => `${a.id}: ${a.note}`).join('. ')}. No level skips the plan gate or the delivery approval.</p>
      </Box>
      <Box title="Add a project">
        <form onSubmit={(e) => void submit(e)}>
          <label htmlFor="pj-name">Name</label>
          <input id="pj-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="my-app" />
          <label htmlFor="pj-path">Path to the git repository</label>
          <input id="pj-path" style={{ width: '100%' }} value={f.path} onChange={(e) => setF({ ...f, path: e.target.value })} placeholder="~/code/my-app" />
          <label htmlFor="pj-id">Identity (who commits and pushes; there is no default)</label>
          <select id="pj-id" value={identity} onChange={(e) => setF({ ...f, identity: e.target.value })}>
            {s.identities.length === 0 && <option value="">(no identities: add one to identities.toml)</option>}
            {s.identities.map((i) => <option key={i.id} value={i.id}>{i.id} ({i.ghUser})</option>)}
          </select>
          <label htmlFor="pj-vault">Vault directory (optional; plans live here, and planning is off without it)</label>
          <input id="pj-vault" style={{ width: '100%' }} value={f.vault} onChange={(e) => setF({ ...f, vault: e.target.value })} placeholder="~/octet-vaults/my-app" />
          <div className="row">
            <label><input type="checkbox" checked={f.vaultGit} onChange={(e) => setF({ ...f, vaultGit: e.target.checked })} /> commit vault changes</label>
            <label><input type="checkbox" checked={f.vaultInRepo} onChange={(e) => setF({ ...f, vaultInRepo: e.target.checked })} /> copy approved plans into the repo</label>
          </div>
          <label htmlFor="pj-auto">Autonomy</label>
          <select id="pj-auto" value={f.autonomy} onChange={(e) => setF({ ...f, autonomy: e.target.value })}>
            {AUTONOMY.map((a) => <option key={a.id}>{a.id}</option>)}
          </select>
          <div className="row"><button type="submit" disabled={busy || !f.name.trim() || !f.path.trim() || !identity}>ADD PROJECT</button></div>
        </form>
      </Box>
    </>
  );
}

/** Checks each identity's SSH key and `gh` login on demand. It talks to GitHub, so it never runs by itself. */
export function DoctorPanel({ order, setError }: { order: string[]; setError: (m: string | null) => void }) {
  const [res, setRes] = useState<{ results: IdentityHealth[]; at: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true); setError(null);
    try { setRes(await api<{ results: IdentityHealth[]; at: string }>('/api/identities/doctor', {})); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Box title="Identity check">
      <p className="dim">Does each identity's SSH key reach the GitHub account it claims, and does <code>gh</code> hold a login for it? This contacts GitHub, so it runs only when you press the button.</p>
      <div className="row"><button disabled={busy} onClick={() => void run()}>{busy ? 'CHECKING…' : 'RUN IDENTITY CHECK'}</button></div>
      <div aria-live="polite">
        {res && (
          <table>
            <thead><tr><th>Result</th><th>Identity</th><th>SSH key reaches</th><th>gh login</th></tr></thead>
            <tbody>
              {res.results.map((h) => (
                <tr key={h.id}>
                  <td className={h.ok ? '' : 'red'}>{h.ok ? '✔ ok' : '✖ FAIL'}</td>
                  <td><IdentityTag id={h.id} order={order} /></td>
                  <td className={h.sshOk ? '' : 'red'}>{h.sshUser ?? 'no auth'} <span className="faint">(want {h.ghUser})</span></td>
                  <td className={h.tokenOk ? '' : 'red'}>{h.tokenOk ? 'yes' : 'missing: run gh auth login'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {res && <div className="faint">checked {res.at.slice(11, 19)} UTC</div>}
      </div>
    </Box>
  );
}

/** Tokens and estimated cost per day, goal and bead. The numbers are Claude Code's own estimate, not a bill. */
export function UsagePanel({ s }: { s: State }) {
  const u = s.usage;
  const c = u.ceiling;
  const titleOf = (id: string) => s.goals.find((g) => g.id === id)?.title ?? id;
  const goalIds = Object.keys(u.byGoal).sort((a, b) => (u.byGoal[b]?.costUsd ?? 0) - (u.byGoal[a]?.costUsd ?? 0));
  return (
    <>
      <Box title="Today">
        <div>{usageLine(u.today)}</div>
        {(c.dailyCostUsd !== undefined || c.dailyRuns !== undefined)
          ? <div className={u.hold ? 'amber' : 'dim'}>
            {u.hold ? `! ${u.hold}. The scheduler is not starting new work.` : `Daily ceiling: ${c.dailyCostUsd !== undefined ? money(c.dailyCostUsd) : 'no cost limit'}, ${c.dailyRuns ?? 'no'} runs. The scheduler stops starting work when it is reached.`}
          </div>
          : <div className="faint">No daily ceiling. Set one under [usage] in config.toml (daily_cost_usd, daily_runs).</div>}
        <div className="faint">Costs are Claude Code's estimate at list prices; on a subscription plan they are not what you are charged.</div>
      </Box>
      <Box title="By day">
        {u.byDay.length === 0 ? <span className="faint">No runs recorded yet.</span> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Day</th><th>Runs</th><th>Est. cost</th><th>Input</th><th>Output</th><th>Cache</th></tr></thead>
              <tbody>
                {u.byDay.map((d) => (
                  <tr key={d.day}><td>{d.day}</td><td>{d.runs}</td><td>{money(d.costUsd)}</td><td>{tokens(d.inputTokens)}</td><td>{tokens(d.outputTokens)}</td><td>{tokens(d.cacheReadTokens + d.cacheCreationTokens)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Box>
      <Box title="By goal and bead">
        {goalIds.length === 0 ? <span className="faint">No runs recorded yet.</span> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Goal / bead</th><th>Runs</th><th>Est. cost</th><th>Input</th><th>Output</th><th>Cache</th></tr></thead>
              <tbody>
                {goalIds.flatMap((gid) => {
                  const g = u.byGoal[gid]!;
                  return [
                    <tr key={gid}><td><b>{titleOf(gid)}</b></td><td>{g.runs}</td><td>{money(g.costUsd)}</td><td>{tokens(g.inputTokens)}</td><td>{tokens(g.outputTokens)}</td><td>{tokens(g.cacheReadTokens + g.cacheCreationTokens)}</td></tr>,
                    ...s.beads.filter((b) => b.goalId === gid && u.byBead[b.id]).map((b) => {
                      const t = u.byBead[b.id]!;
                      return <tr key={b.id} className="dim"><td>&nbsp;&nbsp;{b.title}</td><td>{t.runs}</td><td>{money(t.costUsd)}</td><td>{tokens(t.inputTokens)}</td><td>{tokens(t.outputTokens)}</td><td>{tokens(t.cacheReadTokens + t.cacheCreationTokens)}</td></tr>;
                    }),
                  ];
                })}
              </tbody>
            </table>
          </div>
        )}
      </Box>
    </>
  );
}

const KEYS: [string, string][] = [
  ['1 2 3 4 5 6', 'council, board, inbox, log, usage, setup'],
  ['j / k', 'next / previous bead'],
  ['r', 'run the selected bead (or re-run after changes)'],
  ['x', 'cancel the running engineer, or the running review'],
  ['v', 'AI review of the selected bead'],
  ['a', 'approve and merge the selected bead'],
  ['c', 'focus the request-changes box'],
  ['d', 'toggle diff / output'],
  ['?', 'show or hide this help'],
  ['Esc', 'close this help'],
];

/** The keyboard shortcuts, as a modal dialog. Esc or ? closes it and focus returns to where it was. */
export function HelpOverlay({ onClose }: { onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    close.current?.focus();
    return () => before?.focus?.();
  }, []);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="help-title" onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Tab') { e.preventDefault(); close.current?.focus(); } }}>
        <h2 id="help-title">Keyboard</h2>
        <table>
          <tbody>{KEYS.map(([k, d]) => <tr key={k}><td><kbd>{k}</kbd></td><td>{d}</td></tr>)}</tbody>
        </table>
        <p className="faint">Shortcuts are off while you are typing in a box.</p>
        <div className="row"><button ref={close} onClick={onClose}>CLOSE</button></div>
      </div>
    </div>
  );
}

/** Edit or delete a bead that has not started. The daemon enforces the rules; this only offers the buttons. */
export function BeadEditor({ bead, goal, beads, onDone, setError }: {
  bead: Bead; goal: Goal; beads: Bead[]; onDone: () => void; setError: (m: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(bead.title);
  const [brief, setBrief] = useState(bead.brief);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setEditing(false); setTitle(bead.title); setBrief(bead.brief); }, [bead.id, bead.title, bead.brief]);
  if (goal.status !== 'active' || (bead.status !== 'todo' && bead.status !== 'failed')) return null;
  const dependents = beads.filter((b) => b.dependsOn.includes(bead.id));
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); setEditing(false); } catch (e) { setError((e as Error).message); } finally { setBusy(false); onDone(); }
  };
  if (!editing) {
    return (
      <div className="row">
        <button disabled={busy} onClick={() => setEditing(true)}>EDIT BRIEF</button>
        {bead.status === 'todo' && (
          <button disabled={busy || dependents.length > 0} title={dependents.length ? `Waited on by ${dependents.map((b) => b.title).join(', ')}` : 'Delete this bead'}
            onClick={() => { if (window.confirm(`Delete the bead "${bead.title}"? It has not run yet.`)) void run(() => api(`/api/beads/${bead.id}`, undefined, 'DELETE')); }}>DELETE</button>
        )}
      </div>
    );
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); void run(() => api(`/api/beads/${bead.id}/edit`, { title, brief })); }}>
      <label htmlFor="eb-title">Title</label>
      <input id="eb-title" style={{ width: '100%' }} value={title} onChange={(e) => setTitle(e.target.value)} />
      <label htmlFor="eb-brief">Brief for the Engineer</label>
      <textarea id="eb-brief" rows={6} value={brief} onChange={(e) => setBrief(e.target.value)} />
      <div className="row">
        <button type="submit" disabled={busy || !title.trim() || !brief.trim()}>SAVE</button>
        <button type="button" onClick={() => { setEditing(false); setTitle(bead.title); setBrief(bead.brief); }}>CANCEL</button>
      </div>
    </form>
  );
}
