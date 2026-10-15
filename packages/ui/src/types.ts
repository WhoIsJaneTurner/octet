export type BeadStatus = 'todo' | 'running' | 'in_review' | 'changes_requested' | 'conflict' | 'merged' | 'failed';

export interface Seat { id: string; title: string; job: string; kind: 'llm' | 'deterministic'; writesCode: boolean }
export interface Identity { id: string; ghUser: string; email: string }
export interface Project { name: string; path: string; identity: string; vault?: string; vaultGit?: boolean; vaultInRepo?: boolean; autonomy?: 'manual' | 'plan-gated' | 'auto-to-pr' }
export interface Goal { id: string; project: string; title: string; branch: string; worktree: string; status: string; paused: boolean; createdAt: string }
export interface Bead {
  id: string; goalId: string; title: string; brief: string; dependsOn: string[];
  status: BeadStatus; branch: string; worktree: string; planId: string | null; planItem: string | null; createdAt: string; updatedAt: string;
}
export interface OctetEvent {
  id: number; ts: string; kind: string; goalId: string | null; beadId: string | null; seat: string | null; data: unknown;
}
export interface State {
  seats: Seat[]; identities: Identity[]; projects: Project[]; goals: Goal[]; requests: Request[]; plans: PlanRecord[]; clarifications: Clarification[]; escalations: Escalation[]; planning: string[]; planAudit: { ok: boolean; checked: number; problems: { plan: string; problem: string }[] }; beads: Bead[];
  events: OctetEvent[]; running: string[];
  reviewing: string[]; review: { auto: boolean; autoMerge: boolean; maxRounds: number }; approvals: Approval[]; prs: PullRequest[]; limits: { maxEngineers: number; maxActiveGoals: number }; audit: ChainCheck;
  intake?: IntakeStatus;
  usage: UsageSummary; projectsError?: string;
}

export interface IntakeStatus {
  sources: { kind: string; enabled: boolean; detail: string; lastPollAt: string | null; lastError: string | null }[];
  held: string[];
}

export interface UsageTotals { runs: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; costUsd: number }
export interface UsageSummary {
  today: UsageTotals; byDay: (UsageTotals & { day: string })[]; byBead: Record<string, UsageTotals>; byGoal: Record<string, UsageTotals>; total: UsageTotals;
  ceiling: { dailyCostUsd?: number; dailyRuns?: number }; hold?: string;
}
export interface IdentityHealth { id: string; ghUser: string; sshUser: string | null; sshOk: boolean; tokenOk: boolean; ok: boolean }

export interface Request {
  id: string; source: string; externalRef: string | null; project: string | null; title: string; body: string;
  requester: string; status: 'new' | 'routed' | 'planning' | 'planned' | 'rejected'; rejectReason: string | null;
  goalId: string | null; createdAt: string;
}

export interface Approval {
  id: string; kind: string; goalId: string; summary: Record<string, unknown>;
  status: 'pending' | 'approved' | 'denied'; createdAt: string; decidedAt: string | null;
}
export interface ChainCheck { ok: boolean; checked: number; head: string; brokenAt?: number; reason?: string }

export interface PullRequest {
  goalId: string; url: string; number: number; state: 'OPEN' | 'MERGED' | 'CLOSED';
  reviewDecision: string; checks: 'passing' | 'failing' | 'pending' | 'none'; updatedAt: string;
}

export interface PlanRecord {
  id: string; goalId: string; requestId: string | null; version: number;
  status: 'draft' | 'awaiting_approval' | 'approved' | 'rejected' | 'superseded'; vaultPath: string; contentHash: string;
  createdAt: string; decidedAt: string | null;
}
export interface Escalation { id: string; goalId: string; beadId: string | null; reason: string; message: string; createdAt: string; resolvedAt: string | null }
export interface PlanBead { id: string; title: string; size: string; dependsOn: string[]; files: string[]; objective: string; acceptance: string[] }
export interface PlanSummary {
  planId: string; version: number; hash: string; approach: string; assumptions: string[]; notDoing: string[]; risks: string[];
  verification: string[]; warnings: string[]; beads: PlanBead[];
}
export interface Clarification { id: string; requestId: string; goalId: string; round: number; questions: string[]; answers: string[] | null; createdAt: string }
