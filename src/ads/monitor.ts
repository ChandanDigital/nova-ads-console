import type { Ctx, Principal } from "../lib/context";
import { now } from "../lib/db";
import { NodiError } from "../lib/errors";
import { getSetting, setSetting } from "../lib/settings";
import { adsFor, listAccounts, type AccountRow } from "./accounts";

/**
 * Read-only health monitor. It RAISES alerts for a human to look at; it never pauses, enables or changes anything.
 * (Automatic pausing without a human approval would break the approval model, and a Free-plan Worker has only 10 ms of CPU.)
 * Alerts are deduplicated per account and subject, kept while the condition lasts and resolved automatically afterwards.
 */
export const DEFAULT_MIN_SPEND_MICROS = 20_000_000n;
const MAX_ACCOUNTS = 10;

interface Raised { key: string; account_id: string; kind: string; severity: "high" | "warn" | "info"; title: string; detail: Record<string, unknown> }

const minSpend = async (ctx: Ctx): Promise<bigint> => {
  const v = await getSetting(ctx.db, "alert_min_spend_micros");
  return v && /^\d+$/.test(v) ? BigInt(v) : DEFAULT_MIN_SPEND_MICROS;
};

const checkAccount = async (ctx: Ctx, a: AccountRow, threshold: bigint): Promise<Raised[]> => {
  const ads = adsFor(ctx, a);
  const out: Raised[] = [];
  const cur = a.currency ?? "";
  const camp = await ads.search(a.customer_id, "SELECT campaign.id, campaign.name, metrics.cost_micros, metrics.conversions FROM campaign WHERE campaign.status = 'ENABLED' AND segments.date DURING LAST_7_DAYS", 200);
  for (const r of camp.rows) {
    const cost = BigInt(String(r.metrics?.costMicros ?? "0"));
    const conv = Number(r.metrics?.conversions ?? 0);
    if (cost >= threshold && conv === 0) {
      const name = String(r.campaign?.name ?? "").slice(0, 100);
      out.push({
        key: `${a.customer_id}|spend_no_conversions|${r.campaign?.id}`, account_id: a.customer_id, kind: "spend_no_conversions", severity: "warn",
        title: `${name}: ${(Number(cost) / 1e6).toFixed(2)} ${cur} spent in 7 days with no conversions`,
        detail: { campaign_id: String(r.campaign?.id), campaign: name, cost_micros: cost.toString(), conversions: conv, window: "last 7 days", note: "Check conversion tracking before judging the campaign. Nothing was changed." },
      });
    }
  }
  const bad = await ads.search(a.customer_id, "SELECT campaign.name, ad_group_ad.ad.id, ad_group_ad.policy_summary.approval_status FROM ad_group_ad WHERE ad_group_ad.status = 'ENABLED' AND ad_group_ad.policy_summary.approval_status = 'DISAPPROVED' LIMIT 50", 50);
  if (bad.rows.length) {
    const names = [...new Set(bad.rows.map((r) => String(r.campaign?.name ?? "").slice(0, 80)))].slice(0, 5);
    out.push({
      key: `${a.customer_id}|disapproved_ads`, account_id: a.customer_id, kind: "disapproved_ads", severity: "high",
      title: `${bad.rows.length}${bad.truncated ? "+" : ""} enabled ad(s) are disapproved`,
      detail: { count: bad.rows.length, campaigns: names, note: "Open Google Ads, read the policy reason and fix or replace the ad. Nothing was changed." },
    });
  }
  return out;
};

export const runMonitors = async (ctx: Ctx): Promise<{ accounts: number; raised: number; resolved: number; errors: number }> => {
  const started = now();
  const threshold = await minSpend(ctx);
  const accounts = (await listAccounts(ctx)).filter((a) => a.allowed && a.connection_id && !a.manager).slice(0, MAX_ACCOUNTS);
  let raised = 0, resolved = 0, errors = 0;
  for (const a of accounts) {
    try {
      const found = await checkAccount(ctx, a, threshold);
      for (const f of found) {
        await ctx.db.run(
          `INSERT INTO alerts (dedupe_key, account_id, kind, severity, title, detail, first_seen, last_seen, resolved_at) VALUES (?,?,?,?,?,?,?,?,NULL)
           ON CONFLICT(dedupe_key) DO UPDATE SET severity = excluded.severity, title = excluded.title, detail = excluded.detail, last_seen = excluded.last_seen, resolved_at = NULL`,
          f.key, f.account_id, f.kind, f.severity, f.title, JSON.stringify(f.detail), started, started,
        );
      }
      raised += found.length;
      const keep = found.map((f) => f.key);
      resolved += await ctx.db.run(
        `UPDATE alerts SET resolved_at = ? WHERE account_id = ? AND resolved_at IS NULL AND kind != 'monitor_error'${keep.length ? ` AND dedupe_key NOT IN (${keep.map(() => "?").join(",")})` : ""}`,
        started, a.customer_id, ...keep,
      );
      await ctx.db.run("UPDATE alerts SET resolved_at = ? WHERE dedupe_key = ? AND resolved_at IS NULL", started, `${a.customer_id}|monitor_error`);
    } catch (e) {
      errors++;
      const code = e instanceof NodiError ? e.code : "error";
      await ctx.db.run(
        `INSERT INTO alerts (dedupe_key, account_id, kind, severity, title, detail, first_seen, last_seen, resolved_at) VALUES (?,?,?,?,?,?,?,?,NULL)
         ON CONFLICT(dedupe_key) DO UPDATE SET title = excluded.title, detail = excluded.detail, last_seen = excluded.last_seen, resolved_at = NULL`,
        `${a.customer_id}|monitor_error`, a.customer_id, "monitor_error", "info", `The daily check could not read this account (${code})`,
        JSON.stringify({ code, message: e instanceof NodiError ? e.message : "Unexpected error", request_id: e instanceof NodiError ? e.requestId ?? null : null }), started, started,
      );
    }
  }
  await ctx.db.run("DELETE FROM alerts WHERE resolved_at IS NOT NULL AND resolved_at < ?", started - 60 * 86400);
  const summary = { accounts: accounts.length, raised, resolved, errors };
  await setSetting(ctx.db, "last_monitor_at", String(started));
  await setSetting(ctx.db, "last_monitor_result", JSON.stringify(summary));
  return summary;
};

export interface AlertRow { id: number; account_id: string; kind: string; severity: string; title: string; detail: unknown; first_seen: number; last_seen: number; resolved_at: number | null }

/** Alerts visible to a caller: administrators see all; AI callers only see accounts allowed for them. */
export const listAlerts = async (ctx: Ctx, p: Principal | null, opts: { includeResolved?: boolean; accountId?: string } = {}): Promise<{ alerts: AlertRow[]; last_check_at: number | null; last_result: unknown }> => {
  const rows = await ctx.db.all<Omit<AlertRow, "detail"> & { detail: string; allowed: number | null }>(
    `SELECT l.id, l.account_id, l.kind, l.severity, l.title, l.detail, l.first_seen, l.last_seen, l.resolved_at, a.allowed FROM alerts l LEFT JOIN accounts a ON a.customer_id = l.account_id
     WHERE (? = 1 OR l.resolved_at IS NULL) ORDER BY (l.resolved_at IS NOT NULL), CASE l.severity WHEN 'high' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, l.last_seen DESC LIMIT 200`,
    opts.includeResolved ? 1 : 0,
  );
  const visible = rows.filter((r) => (!p || p.kind === "admin" || (r.allowed && (!p.accounts || p.accounts.includes(r.account_id)))) && (!opts.accountId || r.account_id === opts.accountId));
  const last = await getSetting(ctx.db, "last_monitor_at");
  const result = await getSetting(ctx.db, "last_monitor_result");
  return { alerts: visible.map(({ allowed: _a, detail, ...r }) => ({ ...r, detail: JSON.parse(detail) })), last_check_at: last ? Number(last) : null, last_result: result ? JSON.parse(result) : null };
};
