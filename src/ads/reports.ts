import type { Ctx, Principal } from "../lib/context";
import { num } from "../env";
import { now } from "../lib/db";
import { NodiError } from "../lib/errors";
import { randomId } from "../lib/crypto";
import { adsFor, resolveAccount, type AccountRow } from "./accounts";
import { boundedGaql, camelToSnake, dateWindow, gaqlString } from "../google/gaql";
import { moneyMicros } from "../google/gaql";

export const maxRows = (ctx: Ctx): number => Math.min(5000, num(ctx.env.MAX_ROWS_PER_QUERY, 250));

const snakeCache = new Map<string, string>();
const snake = (k: string): string => {
  let r = snakeCache.get(k);
  if (r === undefined) { r = camelToSnake(k); snakeCache.set(k, r); }
  return r;
};
/**
 * Converts Google's camelCase JSON keys to the snake_case field names used by GAQL and by the original Nodi Ads tools.
 * Written as plain loops with a key cache: the Free plan allows only 10 ms of CPU per request (about 7x faster than the naive version).
 */
export const snakeKeys = (v: unknown): unknown => {
  if (Array.isArray(v)) {
    const out = new Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = snakeKeys(v[i]);
    return out;
  }
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k in v as Record<string, unknown>) out[snake(k)] = snakeKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
};

export interface QueryOut {
  rows: unknown[];
  row_count: number;
  truncated: boolean;
  limit: number;
  query: string;
  request_id?: string;
}

export const runQuery = async (ctx: Ctx, p: Principal, accountId: string, query: string, limit?: number): Promise<{ account: AccountRow; data: QueryOut }> => {
  const account = await resolveAccount(ctx, p, accountId, "read");
  const bounded = boundedGaql(query, maxRows(ctx), limit);
  const r = await adsFor(ctx, account).search(account.customer_id, bounded.query, bounded.limit);
  return {
    account,
    data: { rows: snakeKeys(r.rows) as unknown[], row_count: r.rows.length, truncated: r.truncated, limit: bounded.limit, query: bounded.query, request_id: r.requestId },
  };
};

export const identity = (a: AccountRow) => ({
  customer_id: a.customer_id,
  name: a.name,
  currency: a.currency,
  timezone: a.timezone,
  manager: !!a.manager,
  status: a.status,
  login_customer_id: a.login_customer_id,
});

// --------------------------------------------------------------------------- report queries (ported from the original tools)
export const Q = {
  performance: (w: string) =>
    `SELECT campaign.id, campaign.resource_name, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.campaign_budget, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value FROM campaign WHERE ${w} ORDER BY metrics.cost_micros DESC`,
  searchTerms: (w: string) =>
    `SELECT search_term_view.resource_name, search_term_view.search_term, search_term_view.status, campaign.id, ad_group.id, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM search_term_view WHERE ${w} ORDER BY metrics.cost_micros DESC`,
  keywords: (w: string) =>
    `SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group_criterion.resource_name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status, ad_group_criterion.quality_info.quality_score, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM keyword_view WHERE ${w} ORDER BY metrics.cost_micros DESC`,
  ads: (w: string) =>
    `SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group_ad.resource_name, ad_group_ad.status, ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.ad.final_urls, ad_group_ad.ad_strength, ad_group_ad.policy_summary.approval_status, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM ad_group_ad WHERE ${w} ORDER BY metrics.cost_micros DESC`,
  impressionShare: (w: string) =>
    `SELECT campaign.id, campaign.name, campaign.status, metrics.search_impression_share, metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share, metrics.search_top_impression_share, metrics.search_absolute_top_impression_share, metrics.cost_micros FROM campaign WHERE ${w} AND campaign.advertising_channel_type = 'SEARCH' ORDER BY metrics.cost_micros DESC`,
  conversionActions:
    "SELECT conversion_action.resource_name, conversion_action.name, conversion_action.status, conversion_action.type, conversion_action.category, conversion_action.primary_for_goal, conversion_action.counting_type, conversion_action.click_through_lookback_window_days FROM conversion_action",
  conversionGoals: "SELECT customer_conversion_goal.resource_name, customer_conversion_goal.category, customer_conversion_goal.origin, customer_conversion_goal.biddable FROM customer_conversion_goal",
};

const SEGMENTS: Record<string, [string, string]> = {
  device: ["campaign", "segments.device"],
  day_of_week: ["campaign", "segments.day_of_week"],
  hour: ["campaign", "segments.hour"],
  date: ["campaign", "segments.date"],
  week: ["campaign", "segments.week"],
  month: ["campaign", "segments.month"],
  network: ["campaign", "segments.ad_network_type"],
  geography: ["geographic_view", "geographic_view.country_criterion_id, geographic_view.location_type, segments.geo_target_city"],
};
export const SEGMENT_NAMES = Object.keys(SEGMENTS);

export const segmentQuery = (segment: string, w: string): string => {
  const s = SEGMENTS[segment];
  if (!s) throw new NodiError("invalid_segment", `Choose one of: ${SEGMENT_NAMES.join(", ")}.`, 400);
  return `SELECT campaign.id, campaign.name, ${s[1]}, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM ${s[0]} WHERE ${w} ORDER BY metrics.cost_micros DESC`;
};

const withWindow = (extra: { source: string; account: AccountRow; start: string; end: string }) => ({
  date_range: { start: extra.start, end: extra.end },
  account: identity(extra.account),
  refreshed_at: new Date().toISOString(),
  source: extra.source,
});

export const getPerformance = async (ctx: Ctx, p: Principal, id: string, start: string, end: string, limit?: number) => {
  const w = dateWindow(start, end);
  const r = await runQuery(ctx, p, id, Q.performance(w), limit);
  return { ...r.data, ...withWindow({ source: "Google Ads API", account: r.account, start, end }) };
};

export const getSearchTerms = async (ctx: Ctx, p: Principal, id: string, start: string, end: string, limit?: number) => {
  const w = dateWindow(start, end);
  const r = await runQuery(ctx, p, id, Q.searchTerms(w), limit);
  // Saved so a later negative-keyword plan can prove it rests on real searches (port of the original evidence rule).
  const evidenceId = randomId();
  const rows = JSON.stringify(r.data.rows).slice(0, 1_500_000);
  await ctx.db.run(
    "INSERT INTO evidence (id, account_id, kind, rows_json, window_json, created_at) VALUES (?,?,?,?,?,?)",
    evidenceId, r.account.customer_id, "search_terms", rows.length < 1_500_000 ? rows : JSON.stringify(r.data.rows.slice(0, 500)), JSON.stringify({ start, end }), now(),
  );
  return { ...r.data, evidence_id: evidenceId, dataset_id: evidenceId, ...withWindow({ source: "Google Ads API", account: r.account, start, end }) };
};

export const getConversionDiagnostics = async (ctx: Ctx, p: Principal, id: string) => {
  const actions = await runQuery(ctx, p, id, Q.conversionActions, 500);
  const goals = await runQuery(ctx, p, id, Q.conversionGoals, 500);
  return { actions: actions.data, goals: goals.data, website_events_verified: false, destination_diagnostics_verified: false };
};

export const comparePeriods = async (ctx: Ctx, p: Principal, id: string, a: [string, string], b: [string, string]) => {
  const first = await getPerformance(ctx, p, id, a[0], a[1], 1000);
  const second = await getPerformance(ctx, p, id, b[0], b[1], 1000);
  return { first, second, complete: !(first.truncated || second.truncated) };
};

/** Pure month-pacing math in the account's own timezone (ported from the original, covered by tests). */
export const pacingMath = (monthlyTotal: string, spentMicros: bigint, timezone: string, at: Date = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const get = (t: string) => Number(parts.find((x) => x.type === t)!.value);
  const [y, m, d] = [get("year"), get("month"), get("day")];
  const remainingDays = new Date(Date.UTC(y, m, 0)).getUTCDate() - d + 1;
  const total = moneyMicros(monthlyTotal);
  const remaining = total > spentMicros ? total - spentMicros : 0n;
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    first_of_month: `${y}-${pad(m)}-01`,
    account_local_date: `${y}-${pad(m)}-${pad(d)}`,
    remaining_days_including_today: remainingDays,
    spent_micros: spentMicros.toString(),
    remaining_micros: remaining.toString(),
    daily_pacing_micros: (remaining / BigInt(remainingDays)).toString(),
    monitor_threshold_only: true,
    google_billing_limit: false,
  };
};

/** Account-local month pacing against a monthly total, for the campaigns named in `campaignIds`. */
export const budgetPacing = async (ctx: Ctx, p: Principal, id: string, monthlyTotal: string, campaignIds: string[]) => {
  if (!campaignIds.length || campaignIds.some((c) => !/^\d+$/.test(c))) throw new NodiError("needs_budget_scope", "Name the numeric IDs of the campaigns that share the monthly amount.", 400);
  const account = await resolveAccount(ctx, p, id, "read");
  const tz = account.timezone ?? "UTC";
  const window = pacingMath(monthlyTotal, 0n, tz);
  const perf = await getPerformance(ctx, p, id, window.first_of_month, window.account_local_date, 1000);
  if (perf.truncated) throw new NodiError("incomplete_scope", "Pacing needs the complete campaign data.", 400);
  const rows = (perf.rows as any[]).filter((r) => campaignIds.includes(String(r.campaign?.id)));
  if (new Set(rows.map((r) => String(r.campaign.id))).size !== new Set(campaignIds).size) throw new NodiError("missing_campaign", "One or more scoped campaigns are unavailable.", 404);
  const spent = rows.reduce((s, r) => s + BigInt(r.metrics?.cost_micros ?? 0), 0n);
  return { ...pacingMath(monthlyTotal, spent, tz), currency: account.currency };
};

// --------------------------------------------------------------------------- non-GAQL reads
export const researchKeywords = async (
  ctx: Ctx, p: Principal, id: string,
  a: { keywords: string[]; geo_targets: string[]; language_id: string; url?: string; historical?: boolean },
) => {
  const account = await resolveAccount(ctx, p, id, "read");
  if (a.keywords.length < 1 || a.keywords.length > 20) throw new NodiError("invalid_keywords", "Send 1 to 20 seed keywords.", 400);
  if (a.geo_targets.length > 20 || a.geo_targets.some((g) => !/^geoTargetConstants\/\d+$/.test(g))) throw new NodiError("invalid_location", "Use verified geoTargetConstants/<id> values.", 400);
  if (!/^\d+$/.test(a.language_id)) throw new NodiError("invalid_language", "Use a numeric language constant ID.", 400);
  const ads = adsFor(ctx, account);
  const common = { language: `languageConstants/${a.language_id}`, geoTargetConstants: a.geo_targets, keywordPlanNetwork: "GOOGLE_SEARCH" };
  if (a.historical) {
    const r = await ads.post<{ results?: unknown[] }>(`customers/${account.customer_id}:generateKeywordHistoricalMetrics`, { ...common, keywords: a.keywords });
    return { kind: "historical_metrics", results: snakeKeys((r.results ?? []).slice(0, 500)) };
  }
  const body: Record<string, unknown> = { ...common, pageSize: 500 };
  if (a.url) {
    const { httpsUrl } = await import("./plans");
    body.keywordAndUrlSeed = { keywords: a.keywords, url: httpsUrl(a.url) };
  } else body.keywordSeed = { keywords: a.keywords };
  const r = await ads.post<{ results?: unknown[] }>(`customers/${account.customer_id}:generateKeywordIdeas`, body);
  return { kind: "keyword_ideas", results: snakeKeys((r.results ?? []).slice(0, 500)) };
};

export const searchGeoTargets = async (ctx: Ctx, p: Principal, id: string, names: string[], countryCode?: string, locale = "en") => {
  const account = await resolveAccount(ctx, p, id, "read");
  if (names.length < 1 || names.length > 25 || names.some((n) => !n.trim() || n.length > 80)) throw new NodiError("invalid_location", "Send 1 to 25 location names.", 400);
  const body: Record<string, unknown> = { locale, locationNames: { names } };
  if (countryCode) body.countryCode = countryCode;
  const r = await adsFor(ctx, account).post<{ geoTargetConstantSuggestions?: unknown[] }>("geoTargetConstants:suggest", body);
  return { suggestions: snakeKeys((r.geoTargetConstantSuggestions ?? []).slice(0, 100)) };
};

/** Field metadata (compatible with the official Google Ads MCP `get_resource_metadata`). Field metadata is global, so any active connection can answer. */
export const getResourceMetadata = async (ctx: Ctx, p: Principal, id: string | undefined, resource: string) => {
  if (!/^[a-z_]+$/.test(resource)) throw new NodiError("invalid_resource", "Use a resource name such as campaign.", 400);
  let ads;
  if (id) ads = adsFor(ctx, await resolveAccount(ctx, p, id, "read"));
  else {
    if (p.kind !== "admin" && !p.scopes.includes("read")) throw new NodiError("forbidden", "This credential lacks the read permission.", 403);
    const conn = await ctx.db.first<{ id: string }>("SELECT id FROM google_connections WHERE status = 'active' ORDER BY created_at LIMIT 1");
    if (!conn) throw new NodiError("not_connected", "Connect Google in the dashboard first.", 409);
    const { AdsClient } = await import("../google/ads");
    ads = new AdsClient(ctx.env, ctx.db, { connectionId: conn.id });
  }
  const q = `SELECT name, category, selectable, filterable, sortable, data_type, is_repeated, enum_values WHERE name LIKE ${gaqlString(resource + ".%")} OR name LIKE ${gaqlString("metrics.%")} OR name LIKE ${gaqlString("segments.%")}`;
  const r = await ads.post<{ results?: any[] }>("googleAdsFields:search", { query: q, pageSize: 1000 });
  const fields = (r.results ?? []).map((f) => ({ name: f.name, category: f.category, selectable: !!f.selectable, filterable: !!f.filterable, sortable: !!f.sortable, data_type: f.dataType, is_repeated: !!f.isRepeated, enum_values: f.enumValues }));
  return { resource, field_count: fields.length, fields: fields.slice(0, 800) };
};

export const listAccessible = async (ctx: Ctx, p: Principal, connectionId?: string) => {
  const conn = connectionId ?? (await ctx.db.first<{ id: string }>("SELECT id FROM google_connections WHERE status = 'active' ORDER BY created_at LIMIT 1"))?.id;
  if (!conn) throw new NodiError("not_connected", "Connect Google in the dashboard first.", 409);
  const { AdsClient } = await import("../google/ads");
  const ids = await new AdsClient(ctx.env, ctx.db, { connectionId: conn }).listAccessibleCustomers();
  // AI callers only learn about IDs the administrator allowed; the dashboard shows everything.
  if (p.kind === "admin") return { customer_ids: ids };
  const allowed = new Set((await ctx.db.all<{ customer_id: string }>("SELECT customer_id FROM accounts WHERE allowed = 1")).map((r) => r.customer_id));
  return { customer_ids: ids.filter((i) => allowed.has(i) && (!p.accounts || p.accounts.includes(i))) };
};
