import type { ReactNode } from 'react';
import type { BeadStatus } from './types';

const PALETTE = ['var(--amber)', 'var(--cyan)', 'var(--magenta)', '#b8ff6a', '#ff9d5c'];

/** Each identity gets a stable color, but the tag always spells the name too. */
export function IdentityTag({ id, order }: { id: string; order: string[] }) {
  const i = Math.max(0, order.indexOf(id));
  return <span className="tag" style={{ color: PALETTE[i % PALETTE.length] }}>{id}</span>;
}

export function Box({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="box">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

export const STATUS: Record<BeadStatus, { glyph: string; label: string; cls: string }> = {
  todo: { glyph: '○', label: 'todo', cls: 'dim' },
  running: { glyph: '▶', label: 'running', cls: 'amber' },
  in_review: { glyph: '◆', label: 'in review', cls: 'cyan' },
  changes_requested: { glyph: '↺', label: 'changes requested', cls: 'amber' },
  conflict: { glyph: '⚡', label: 'merge conflict', cls: 'amber' },
  merged: { glyph: '✔', label: 'merged', cls: '' },
  failed: { glyph: '✖', label: 'failed', cls: 'red' },
};

export function StatusMark({ status }: { status: BeadStatus }) {
  const s = STATUS[status];
  return <span className={s.cls} title={s.label}>{s.glyph} {s.label}</span>;
}

export function Diff({ text }: { text: string }) {
  if (!text) return <span className="faint">(no changes yet)</span>;
  return (
    <pre className="diff">
      {text.split('\n').map((line, i) => {
        const cls = line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')
          ? 'meta' : line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : '';
        return <div key={i} className={cls}>{line || ' '}</div>;
      })}
    </pre>
  );
}
