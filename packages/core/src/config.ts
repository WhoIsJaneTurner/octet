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
