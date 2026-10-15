import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';

/** `delivered` = PR open and waiting on review; `done` = PR merged. Only `active` counts toward the goal cap. */
export type GoalStatus = 'active' | 'delivered' | 'done' | 'failed';
export type BeadStatus = 'todo' | 'running' | 'in_review' | 'changes_requested' | 'merged' | 'failed';

export interface Goal {
  id: string;
  project: string;
  title: string;
  branch: string;
  worktree: string;
  status: GoalStatus;
  createdAt: string;
}

export interface Bead {
  id: string;
  goalId: string;
  title: string;
  brief: string;
  dependsOn: string[];
  status: BeadStatus;
  branch: string;
  worktree: string;
  createdAt: string;
  updatedAt: string;
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied';
export type ApprovalKind = 'deliver' | 'comment';

export interface Approval {
  id: string;
  kind: ApprovalKind;
  goalId: string;
  /** Exactly what will happen if approved, shown to the human verbatim. */
  summary: Record<string, unknown>;
  status: ApprovalStatus;
  createdAt: string;
  decidedAt: string | null;
}

export interface PullRequest {
  goalId: string;
  url: string;
  number: number;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  /** GitHub's reviewDecision: APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or '' when no rule applies. */
  reviewDecision: string;
  checks: 'passing' | 'failing' | 'pending' | 'none';
  updatedAt: string;
}

/** One engineer run. The owning process refreshes `heartbeatAt`; a run with no fresh heartbeat is dead. */
export interface BeadRun {
  id: number;
  beadId: string;
  /** 1-based run number for the bead; also names the log file. */
  n: number;
  pid: number;
  host: string;
  startedAt: string;
  heartbeatAt: string;
  endedAt: string | null;
  endReason: string | null;
  cancelRequested: boolean;
}

export type RequestSource = 'ui' | 'cli' | 'github' | 'jira' | 'chat';
export type RequestStatus = 'new' | 'routed' | 'planning' | 'planned' | 'rejected';

/** A unit of asked-for work, normalized from any source. Nothing downstream cares where it came from. */
export interface Request {
  id: string;
  source: RequestSource;
  /** Issue URL, ticket key or message id; `(source, externalRef)` is unique. Null for typed requests. */
  externalRef: string | null;
  /** Null until routed. Routing is always explicit; it decides which identity acts. */
  project: string | null;
  title: string;
  body: string;
  /** Who asked, as the source reports it. Untrusted. */
  requester: string;
  status: RequestStatus;
  rejectReason: string | null;
  goalId: string | null;
  createdAt: string;
}

export interface ChainCheck {
  ok: boolean;
  checked: number;
  head: string;
  brokenAt?: number;
  reason?: string;
}

export interface OctetEvent {
  id: number;
  ts: string;
  kind: string;
  goalId: string | null;
  beadId: string | null;
  seat: string | null;
  data: unknown;
}

type Row = Record<string, unknown>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY, project TEXT NOT NULL, title TEXT NOT NULL, branch TEXT NOT NULL,
  worktree TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS beads (
  id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id), title TEXT NOT NULL,
  brief TEXT NOT NULL, depends_on TEXT NOT NULL, status TEXT NOT NULL, branch TEXT NOT NULL,
  worktree TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, kind TEXT NOT NULL,
  goal_id TEXT, bead_id TEXT, seat TEXT, data TEXT NOT NULL,
  prev_hash TEXT NOT NULL DEFAULT '', hash TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS pull_requests (
  goal_id TEXT PRIMARY KEY, url TEXT NOT NULL, number INTEGER NOT NULL, state TEXT NOT NULL,
  review_decision TEXT NOT NULL, checks TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bead_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, bead_id TEXT NOT NULL, n INTEGER NOT NULL,
  pid INTEGER NOT NULL, host TEXT NOT NULL, started_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL,
  ended_at TEXT, end_reason TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, external_ref TEXT, project TEXT, title TEXT NOT NULL,
  body TEXT NOT NULL, requester TEXT NOT NULL, status TEXT NOT NULL, reject_reason TEXT, goal_id TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS requests_ref ON requests(source, external_ref) WHERE external_ref IS NOT NULL;
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, goal_id TEXT NOT NULL, summary TEXT NOT NULL,
  status TEXT NOT NULL, created_at TEXT NOT NULL, decided_at TEXT
);
`;

/** Events are chained: each hash covers the previous hash plus the event's own fields. */
export function eventHash(prev: string, e: { ts: string; kind: string; goalId: string | null; beadId: string | null; seat: string | null; data: string }): string {
  return createHash('sha256').update(JSON.stringify([prev, e.ts, e.kind, e.goalId, e.beadId, e.seat, e.data])).digest('hex');
}

export const newId = (prefix: string): string => `${prefix}-${randomBytes(3).toString('hex')}`;
const now = (): string => new Date().toISOString();

const toGoal = (r: Row): Goal => ({
  id: r.id as string, project: r.project as string, title: r.title as string,
  branch: r.branch as string, worktree: r.worktree as string, status: r.status as GoalStatus,
  createdAt: r.created_at as string,
});
const toBead = (r: Row): Bead => ({
  id: r.id as string, goalId: r.goal_id as string, title: r.title as string, brief: r.brief as string,
  dependsOn: JSON.parse(r.depends_on as string) as string[], status: r.status as BeadStatus,
  branch: r.branch as string, worktree: r.worktree as string,
  createdAt: r.created_at as string, updatedAt: r.updated_at as string,
});

const toRun = (r: Row): BeadRun => ({
  id: r.id as number, beadId: r.bead_id as string, n: r.n as number, pid: r.pid as number, host: r.host as string,
  startedAt: r.started_at as string, heartbeatAt: r.heartbeat_at as string, endedAt: r.ended_at as string | null,
  endReason: r.end_reason as string | null, cancelRequested: r.cancel_requested === 1,
});

const toRequest = (r: Row): Request => ({
  id: r.id as string, source: r.source as RequestSource, externalRef: r.external_ref as string | null,
  project: r.project as string | null, title: r.title as string, body: r.body as string,
  requester: r.requester as string, status: r.status as RequestStatus, rejectReason: r.reject_reason as string | null,
  goalId: r.goal_id as string | null, createdAt: r.created_at as string,
});

const toPr = (r: Row): PullRequest => ({
  goalId: r.goal_id as string, url: r.url as string, number: Number(r.number), state: r.state as PullRequest['state'],
  reviewDecision: r.review_decision as string, checks: r.checks as PullRequest['checks'], updatedAt: r.updated_at as string,
});

const toApproval = (r: Row): Approval => ({
  id: r.id as string, kind: r.kind as ApprovalKind, goalId: r.goal_id as string,
  summary: JSON.parse(r.summary as string) as Record<string, unknown>, status: r.status as ApprovalStatus,
  createdAt: r.created_at as string, decidedAt: r.decided_at as string | null,
});

const toEvent = (r: Row): OctetEvent => ({
  id: r.id as number, ts: r.ts as string, kind: r.kind as string,
  goalId: r.goal_id as string | null, beadId: r.bead_id as string | null,
  seat: r.seat as string | null, data: JSON.parse(r.data as string) as unknown,
});

export class Store {
  readonly db: DatabaseSync;
  private readonly listeners = new Set<() => void>();

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    // Databases created before the audit chain existed lack these columns.
    const cols = (this.db.prepare('PRAGMA table_info(events)').all() as Row[]).map((c) => c.name);
    if (!cols.includes('hash')) {
      this.db.exec("ALTER TABLE events ADD COLUMN prev_hash TEXT NOT NULL DEFAULT ''");
      this.db.exec("ALTER TABLE events ADD COLUMN hash TEXT NOT NULL DEFAULT ''");
    }
  }

  close(): void {
    this.db.close();
  }

  /** Called after every mutation; the daemon uses this to push updates to the UI. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  insertGoal(g: Omit<Goal, 'createdAt' | 'status'>): Goal {
    const goal: Goal = { ...g, status: 'active', createdAt: now() };
    this.db
      .prepare('INSERT INTO goals VALUES (?,?,?,?,?,?,?)')
      .run(goal.id, goal.project, goal.title, goal.branch, goal.worktree, goal.status, goal.createdAt);
    this.changed();
    return goal;
  }

  getGoal(id: string): Goal | undefined {
    const r = this.db.prepare('SELECT * FROM goals WHERE id = ?').get(id) as Row | undefined;
    return r && toGoal(r);
  }

  listGoals(): Goal[] {
    return (this.db.prepare('SELECT * FROM goals ORDER BY created_at').all() as Row[]).map(toGoal);
  }

  setGoalStatus(id: string, status: GoalStatus): void {
    this.db.prepare('UPDATE goals SET status = ? WHERE id = ?').run(status, id);
    this.changed();
  }

  insertBead(b: Omit<Bead, 'createdAt' | 'updatedAt' | 'status'>): Bead {
    const t = now();
    const bead: Bead = { ...b, status: 'todo', createdAt: t, updatedAt: t };
    this.db
      .prepare('INSERT INTO beads VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(bead.id, bead.goalId, bead.title, bead.brief, JSON.stringify(bead.dependsOn), bead.status,
        bead.branch, bead.worktree, bead.createdAt, bead.updatedAt);
    this.changed();
    return bead;
  }

  getBead(id: string): Bead | undefined {
    const r = this.db.prepare('SELECT * FROM beads WHERE id = ?').get(id) as Row | undefined;
    return r && toBead(r);
  }

  listBeads(goalId?: string): Bead[] {
    const rows = goalId
      ? (this.db.prepare('SELECT * FROM beads WHERE goal_id = ? ORDER BY created_at').all(goalId) as Row[])
      : (this.db.prepare('SELECT * FROM beads ORDER BY created_at').all() as Row[]);
    return rows.map(toBead);
  }

  setBeadStatus(id: string, status: BeadStatus): void {
    this.db.prepare('UPDATE beads SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
    this.changed();
  }

  insertRequest(r: Omit<Request, 'id' | 'createdAt' | 'rejectReason' | 'goalId'>): Request {
    const req: Request = { ...r, id: newId('req'), rejectReason: null, goalId: null, createdAt: now() };
    this.db
      .prepare('INSERT INTO requests VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(req.id, req.source, req.externalRef, req.project, req.title, req.body, req.requester, req.status,
        null, null, req.createdAt);
    this.changed();
    return req;
  }

  getRequest(id: string): Request | undefined {
    const r = this.db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as Row | undefined;
    return r && toRequest(r);
  }

  findRequestByRef(source: RequestSource, externalRef: string): Request | undefined {
    const r = this.db.prepare('SELECT * FROM requests WHERE source = ? AND external_ref = ?').get(source, externalRef) as Row | undefined;
    return r && toRequest(r);
  }

  listRequests(): Request[] {
    return (this.db.prepare('SELECT * FROM requests ORDER BY created_at DESC, rowid DESC').all() as Row[]).map(toRequest);
  }

  updateRequest(id: string, patch: { project?: string; status?: RequestStatus; rejectReason?: string; goalId?: string }): void {
    const sets: string[] = [];
    const vals: (string | null)[] = [];
    if (patch.project !== undefined) { sets.push('project = ?'); vals.push(patch.project); }
    if (patch.status !== undefined) { sets.push('status = ?'); vals.push(patch.status); }
    if (patch.rejectReason !== undefined) { sets.push('reject_reason = ?'); vals.push(patch.rejectReason); }
    if (patch.goalId !== undefined) { sets.push('goal_id = ?'); vals.push(patch.goalId); }
    if (!sets.length) return;
    this.db.prepare(`UPDATE requests SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    this.changed();
  }

  /** Registers a run owned by this process. Returns it with its run number. */
  startRun(beadId: string, pid: number, host: string): BeadRun {
    const n = Number((this.db.prepare('SELECT COUNT(*) AS n FROM bead_runs WHERE bead_id = ?').get(beadId) as Row).n) + 1;
    const t = now();
    const res = this.db
      .prepare('INSERT INTO bead_runs (bead_id, n, pid, host, started_at, heartbeat_at) VALUES (?,?,?,?,?,?)')
      .run(beadId, n, pid, host, t, t);
    this.changed();
    return toRun(this.db.prepare('SELECT * FROM bead_runs WHERE id = ?').get(Number(res.lastInsertRowid)) as Row);
  }

  /** Refreshes the heartbeat; returns whether someone asked for this run to be cancelled. */
  heartbeat(runId: number): boolean {
    this.db.prepare('UPDATE bead_runs SET heartbeat_at = ? WHERE id = ? AND ended_at IS NULL').run(now(), runId);
    const r = this.db.prepare('SELECT cancel_requested FROM bead_runs WHERE id = ?').get(runId) as Row | undefined;
    return r?.cancel_requested === 1;
  }

  endRun(runId: number, reason: string): void {
    this.db.prepare('UPDATE bead_runs SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL').run(now(), reason, runId);
    this.changed();
  }

  /** Flags the bead's open run for cancellation. Returns false when it has none. */
  requestCancel(beadId: string): boolean {
    const res = this.db.prepare('UPDATE bead_runs SET cancel_requested = 1 WHERE bead_id = ? AND ended_at IS NULL').run(beadId);
    this.changed();
    return Number(res.changes) > 0;
  }

  /** Runs that have not ended, whether or not their owner is still alive. */
  openRuns(): BeadRun[] {
    return (this.db.prepare('SELECT * FROM bead_runs WHERE ended_at IS NULL ORDER BY id').all() as Row[]).map(toRun);
  }

  /** Latest run for a bead, if any. */
  lastRun(beadId: string): BeadRun | undefined {
    const r = this.db.prepare('SELECT * FROM bead_runs WHERE bead_id = ? ORDER BY id DESC LIMIT 1').get(beadId) as Row | undefined;
    return r && toRun(r);
  }

  /** Hash of the newest chained event, or '' if the chain is empty. */
  chainHead(): string {
    const r = this.db.prepare("SELECT hash FROM events WHERE hash != '' ORDER BY id DESC LIMIT 1").get() as Row | undefined;
    return (r?.hash as string | undefined) ?? '';
  }

  log(e: { kind: string; goalId?: string; beadId?: string; seat?: string; data?: unknown }): void {
    const row = {
      ts: now(), kind: e.kind, goalId: e.goalId ?? null, beadId: e.beadId ?? null,
      seat: e.seat ?? null, data: JSON.stringify(e.data ?? {}),
    };
    const prev = this.chainHead();
    this.db
      .prepare('INSERT INTO events (ts, kind, goal_id, bead_id, seat, data, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?)')
      .run(row.ts, row.kind, row.goalId, row.beadId, row.seat, row.data, prev, eventHash(prev, row));
    this.changed();
  }

  /** Recomputes the whole chain. Events written before chaining existed are skipped. */
  verifyChain(): ChainCheck {
    const rows = this.db.prepare("SELECT * FROM events WHERE hash != '' ORDER BY id").all() as Row[];
    let prev = '';
    for (const r of rows) {
      const expected = eventHash(prev, {
        ts: r.ts as string, kind: r.kind as string, goalId: r.goal_id as string | null,
        beadId: r.bead_id as string | null, seat: r.seat as string | null, data: r.data as string,
      });
      if (r.prev_hash !== prev) {
        return { ok: false, checked: rows.indexOf(r), head: prev, brokenAt: r.id as number, reason: 'chain link missing or reordered (an event was removed or inserted)' };
      }
      if (r.hash !== expected) {
        return { ok: false, checked: rows.indexOf(r), head: prev, brokenAt: r.id as number, reason: 'event contents were modified' };
      }
      prev = r.hash as string;
    }
    return { ok: true, checked: rows.length, head: prev };
  }

  upsertPr(pr: Omit<PullRequest, 'updatedAt'>): PullRequest {
    const row: PullRequest = { ...pr, updatedAt: now() };
    this.db
      .prepare(`INSERT INTO pull_requests VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(goal_id) DO UPDATE SET url=excluded.url, number=excluded.number, state=excluded.state,
        review_decision=excluded.review_decision, checks=excluded.checks, updated_at=excluded.updated_at`)
      .run(row.goalId, row.url, row.number, row.state, row.reviewDecision, row.checks, row.updatedAt);
    this.changed();
    return row;
  }

  getPr(goalId: string): PullRequest | undefined {
    const r = this.db.prepare('SELECT * FROM pull_requests WHERE goal_id = ?').get(goalId) as Row | undefined;
    return r && toPr(r);
  }

  listPrs(): PullRequest[] {
    return (this.db.prepare('SELECT * FROM pull_requests ORDER BY updated_at DESC').all() as Row[]).map(toPr);
  }

  insertApproval(a: { kind: ApprovalKind; goalId: string; summary: Record<string, unknown> }): Approval {
    const approval: Approval = { id: newId('appr'), ...a, status: 'pending', createdAt: now(), decidedAt: null };
    this.db
      .prepare('INSERT INTO approvals VALUES (?,?,?,?,?,?,?)')
      .run(approval.id, approval.kind, approval.goalId, JSON.stringify(approval.summary), approval.status, approval.createdAt, null);
    this.changed();
    return approval;
  }

  getApproval(id: string): Approval | undefined {
    const r = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Row | undefined;
    return r && toApproval(r);
  }

  listApprovals(): Approval[] {
    return (this.db.prepare('SELECT * FROM approvals ORDER BY created_at DESC').all() as Row[]).map(toApproval);
  }

  /** Only a pending approval can be decided, and only once. */
  decideApproval(id: string, status: 'approved' | 'denied'): boolean {
    const res = this.db
      .prepare("UPDATE approvals SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
      .run(status, now(), id);
    this.changed();
    return Number(res.changes) === 1;
  }

  eventsOfKind(kind: string): OctetEvent[] {
    return (this.db.prepare('SELECT * FROM events WHERE kind = ? ORDER BY id').all(kind) as Row[]).map(toEvent);
  }

  countEvents(kind: string, beadId: string): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE kind = ? AND bead_id = ?').get(kind, beadId) as Row;
    return Number(r.n);
  }

  /** Most recent event of a kind for a bead, e.g. the reviewer's last feedback. */
  lastEvent(kind: string, beadId: string): OctetEvent | undefined {
    const r = this.db
      .prepare('SELECT * FROM events WHERE kind = ? AND bead_id = ? ORDER BY id DESC LIMIT 1')
      .get(kind, beadId) as Row | undefined;
    return r && toEvent(r);
  }

  events(limit = 50): OctetEvent[] {
    const rows = this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit) as Row[];
    return rows.map(toEvent);
  }
}
