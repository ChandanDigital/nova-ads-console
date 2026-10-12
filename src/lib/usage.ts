import type { Env } from "../env";
import { num } from "../env";
import type { Db } from "./db";
import { dayKey } from "./db";
import { NovaError } from "./errors";

export type Metric = "requests" | "mcp_calls" | "ads_calls" | "d1_rows_read" | "d1_rows_written" | "dashboard_calls";

/** Documented Cloudflare Free-plan hard limits (verified against developers.cloudflare.com on 2026-10-11). */
export const FREE_PLAN_HARD_LIMITS = {
  worker_requests_per_day: 100_000,
  worker_cpu_ms_per_request: 10,
  worker_subrequests_per_request: 50,
  cron_triggers_per_account: 5,
  d1_rows_read_per_day: 5_000_000,
  d1_rows_written_per_day: 100_000,
  d1_storage_bytes_per_account: 5 * 1024 ** 3,
  d1_storage_bytes_per_database: 500 * 1024 ** 2,
  workers_builds_minutes_per_month: 3000,
} as const;

export const softLimits = (env: Env): Record<Metric, number> => ({
  requests: num(env.REQUESTS_SOFT_LIMIT, 70_000),
  mcp_calls: num(env.MCP_CALLS_PER_DAY, 3000),
  ads_calls: num(env.GOOGLE_ADS_CALLS_PER_DAY, 5000),
  d1_rows_read: num(env.D1_READS_SOFT_LIMIT, 3_000_000),
  d1_rows_written: num(env.D1_WRITES_SOFT_LIMIT, 60_000),
  dashboard_calls: 20_000,
});

export const addUsage = async (db: Db, metric: Metric, n = 1): Promise<void> => {
  if (n <= 0) return;
  await db.run(
    "INSERT INTO usage_daily (day, metric, value) VALUES (?,?,?) ON CONFLICT(day, metric) DO UPDATE SET value = value + excluded.value",
    dayKey(),
    metric,
    Math.round(n),
  );
};

export const usageToday = async (db: Db): Promise<Record<string, number>> => {
  const rows = await db.all<{ metric: string; value: number }>("SELECT metric, value FROM usage_daily WHERE day = ?", dayKey());
  return Object.fromEntries(rows.map((r) => [r.metric, r.value]));
};

/**
 * Refuses (never silently continues) once a self-imposed daily limit is reached.
 * The limits sit below Cloudflare's free-plan ceilings so the account never reaches a hard stop by surprise.
 */
export const enforceQuota = async (env: Env, db: Db, metric: Metric, extra: Metric[] = []): Promise<void> => {
  const limits = softLimits(env);
  const used = await usageToday(db);
  for (const m of [metric, ...extra]) {
    if ((used[m] ?? 0) >= limits[m]) {
      throw new NovaError(
        "quota_soft_limit",
        `The daily limit for ${m} (${limits[m]}) is used up. Nothing was switched to a paid service. It resets at 00:00 UTC; you can raise the limit in wrangler.jsonc if your Cloudflare plan allows it.`,
        429,
        { metric: m, used: used[m] ?? 0, limit: limits[m] },
      );
    }
  }
};

export const usageSummary = async (env: Env, db: Db) => {
  const limits = softLimits(env);
  const used = await usageToday(db);
  const hard: Partial<Record<Metric, number>> = {
    requests: FREE_PLAN_HARD_LIMITS.worker_requests_per_day,
    d1_rows_read: FREE_PLAN_HARD_LIMITS.d1_rows_read_per_day,
    d1_rows_written: FREE_PLAN_HARD_LIMITS.d1_rows_written_per_day,
  };
  const metrics = (Object.keys(limits) as Metric[]).map((m) => {
    const u = used[m] ?? 0;
    const pct = limits[m] ? Math.round((u / limits[m]) * 100) : 0;
    return { metric: m, used: u, soft_limit: limits[m], hard_limit: hard[m] ?? null, percent_of_soft_limit: pct, state: pct >= 100 ? "blocked" : pct >= 80 ? "warning" : "ok" };
  });
  const history = await db.all<{ day: string; metric: string; value: number }>(
    "SELECT day, metric, value FROM usage_daily WHERE day >= ? ORDER BY day",
    dayKey(Date.now() - 6 * 86400_000),
  );
  return { day: dayKey(), metrics, history, free_plan_hard_limits: FREE_PLAN_HARD_LIMITS };
};
