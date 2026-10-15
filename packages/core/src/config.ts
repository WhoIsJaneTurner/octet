import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readConfigFile } from './configcheck.ts';
import { octetHome } from './paths.ts';

export interface Limits {
  /** Engineers that may run at the same time, across all goals. */
  maxEngineers: number;
  /** Goals that may be active at the same time. */
  maxActiveGoals: number;
  /** An engineer run is killed after this long. */
  runTimeoutMs: number;
}

export interface ReviewConfig {
  /** Run the Reviewer automatically when a bead reaches review. */
  auto: boolean;
  /** Let the Marshal merge a bead the Reviewer approved. Off by default: you still merge. */
  autoMerge: boolean;
  /** After this many "changes requested" verdicts on one bead, stop looping and ask the human. */
  maxRounds: number;
  /** Before delivery, the Reviewer reads the whole goal diff and can send work back. Applies to scheduler-managed goals. */
  goalReview?: boolean;
}

export const DEFAULT_REVIEW: ReviewConfig = { auto: false, autoMerge: false, maxRounds: 2 };

export const DEFAULT_LIMITS: Limits = { maxEngineers: 3, maxActiveGoals: 3, runTimeoutMs: 20 * 60_000 };

const positive = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : fallback;

export function loadReview(file: string = join(octetHome(), 'config.toml')): ReviewConfig {
  if (!existsSync(file)) return { ...DEFAULT_REVIEW };
  const r = (readConfigFile('config', file) as { review?: Record<string, unknown> }).review ?? {};
  return {
    auto: r.auto === true,
    autoMerge: r.auto_merge === true,
    maxRounds: positive(r.max_rounds, DEFAULT_REVIEW.maxRounds),
    goalReview: r.goal_review !== false,
  };
}

/** Reads `[limits]` from ~/.config/octet/config.toml. Missing file or keys use defaults. */
export function loadLimits(file: string = join(octetHome(), 'config.toml')): Limits {
  if (!existsSync(file)) return { ...DEFAULT_LIMITS };
  const doc = readConfigFile('config', file) as { limits?: Record<string, unknown> };
  return {
    maxEngineers: positive(doc.limits?.max_engineers, DEFAULT_LIMITS.maxEngineers),
    maxActiveGoals: positive(doc.limits?.max_active_goals, DEFAULT_LIMITS.maxActiveGoals),
    runTimeoutMs: positive(doc.limits?.run_timeout_minutes, DEFAULT_LIMITS.runTimeoutMs / 60_000) * 60_000,
  };
}

export interface PlanningConfig {
  /** Most beads one plan may contain. */
  maxBeads: number;
  /** Sum of bead sizes (xs=1, s=2, m=4) one goal may reach. */
  maxPoints: number;
  /** Agent runs one goal may use, as a multiple of its bead count, before the scheduler escalates. */
  maxRunsFactor: number;
  /** Times a failed bead is retried before the scheduler asks you. */
  maxRetries: number;
  /** Minutes a runnable bead may wait on the engineer cap before the scheduler escalates. */
  capWaitMinutes: number;
  /** A request naming more files than this is planned one size larger than the Chair judged. */
  bumpFiles: number;
}

export const DEFAULT_PLANNING: PlanningConfig = { maxBeads: 12, maxPoints: 36, maxRunsFactor: 3, maxRetries: 2, capWaitMinutes: 30, bumpFiles: 3 };

/** Reads `[planning]` from config.toml. Missing file or keys use defaults. */
export function loadPlanning(file: string = join(octetHome(), 'config.toml')): PlanningConfig {
  if (!existsSync(file)) return { ...DEFAULT_PLANNING };
  const t = (readConfigFile('config', file) as { planning?: Record<string, unknown> }).planning ?? {};
  return {
    maxBeads: positive(t.max_beads, DEFAULT_PLANNING.maxBeads),
    maxPoints: positive(t.max_points, DEFAULT_PLANNING.maxPoints),
    maxRunsFactor: positive(t.max_runs_factor, DEFAULT_PLANNING.maxRunsFactor),
    maxRetries: typeof t.max_retries === 'number' && Number.isInteger(t.max_retries) && t.max_retries >= 0 ? t.max_retries : DEFAULT_PLANNING.maxRetries,
    capWaitMinutes: positive(t.cap_wait_minutes, DEFAULT_PLANNING.capWaitMinutes),
    bumpFiles: positive(t.bump_files, DEFAULT_PLANNING.bumpFiles),
  };
}

/** Reads `[github] hosts` (GitHub Enterprise hostnames) from config.toml. */
export function loadGithubHosts(file: string = join(octetHome(), 'config.toml')): string[] {
  if (!existsSync(file)) return [];
  const g = (readConfigFile('config', file) as { github?: { hosts?: unknown } }).github;
  return Array.isArray(g?.hosts) ? g.hosts.filter((h): h is string => typeof h === 'string') : [];
}
