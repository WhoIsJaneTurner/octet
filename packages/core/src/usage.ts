import type { Ctx } from './orchestrate.ts';

/** Token and cost data for one agent run. Every field is optional upstream, so a run can carry partial data. */
export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Claude Code's `total_cost_usd`: an estimate at list prices, not a bill (a subscription plan is not charged per token). */
  costUsd?: number;
  numTurns?: number;
  model?: string;
}

export interface UsageTotals {
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

export interface UsageSummary {
  /** Runs started on the current local day. */
  today: UsageTotals;
  /** Newest first, local dates, last 30 days that had runs. */
  byDay: (UsageTotals & { day: string })[];
  byBead: Record<string, UsageTotals>;
  byGoal: Record<string, UsageTotals>;
  total: UsageTotals;
  /** Set while a configured daily ceiling is holding the scheduler. */
  hold?: string;
}

export const emptyTotals = (): UsageTotals => ({ runs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 });

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/**
 * Reads usage out of the final `result` message of Claude Code's JSON output (`--output-format json`, or the last
 * line of `stream-json`): `usage.{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens}`,
 * `total_cost_usd`, `num_turns` and the model name from `modelUsage`. Missing or malformed fields are simply skipped;
 * returns undefined when there is nothing usable.
 */
export function parseUsage(result: unknown): RunUsage | undefined {
  const r = obj(result);
  if (!r) return undefined;
  const u = obj(r.usage) ?? {};
  const cost = num(r.total_cost_usd);
  const turns = num(r.num_turns);
  const model = Object.keys(obj(r.modelUsage) ?? {})[0];
  const out: RunUsage = {
    inputTokens: num(u.input_tokens) ?? 0, outputTokens: num(u.output_tokens) ?? 0,
    cacheReadTokens: num(u.cache_read_input_tokens) ?? 0, cacheCreationTokens: num(u.cache_creation_input_tokens) ?? 0,
    ...(cost !== undefined ? { costUsd: cost } : {}), ...(turns !== undefined ? { numTurns: turns } : {}), ...(model ? { model } : {}),
  };
  const any = out.inputTokens || out.outputTokens || out.cacheReadTokens || out.cacheCreationTokens || cost !== undefined;
  return any ? out : undefined;
}

const localDay = (iso: string): string => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Why the daily ceiling from `[usage]` is reached right now, or undefined. Pure: it logs nothing. */
export function usageCeiling(ctx: Pick<Ctx, 'store' | 'usage'>): string | undefined {
  const cfg = ctx.usage;
  if (!cfg || (cfg.dailyCostUsd === undefined && cfg.dailyRuns === undefined)) return undefined;
  const today = ctx.store.usageToday();
  if (cfg.dailyCostUsd !== undefined && today.costUsd >= cfg.dailyCostUsd) {
    return `Today's estimated cost $${today.costUsd.toFixed(2)} has reached the daily ceiling of $${cfg.dailyCostUsd.toFixed(2)}`;
  }
  if (cfg.dailyRuns !== undefined && today.runs >= cfg.dailyRuns) {
    return `${today.runs} agent runs today has reached the daily ceiling of ${cfg.dailyRuns}`;
  }
  return undefined;
}

/**
 * What the scheduler asks before starting work: returns why it must not start new work, or undefined when it may.
 * It only gates the scheduler; a run you start with the button is yours to decide. The first hit each day is logged.
 */
export function usageHold(ctx: Pick<Ctx, 'store' | 'usage'>): string | undefined {
  const reason = usageCeiling(ctx);
  if (reason) {
    const last = ctx.store.db.prepare("SELECT ts FROM events WHERE kind = 'usage.ceiling_reached' ORDER BY id DESC LIMIT 1").get() as { ts: string } | undefined;
    if (!last || localDay(last.ts) !== localDay(new Date().toISOString())) {
      ctx.store.log({ kind: 'usage.ceiling_reached', seat: 'marshal', data: { message: `${reason}. The scheduler starts no new work until tomorrow or you raise [usage] in config.toml.` } });
    }
  }
  return reason;
}
