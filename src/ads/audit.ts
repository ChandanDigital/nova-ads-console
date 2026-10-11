import type { Ctx, Principal } from "../lib/context";
import { randomId } from "../lib/crypto";
import { now } from "../lib/db";
import { dateWindow } from "../google/gaql";
import { Q, getConversionDiagnostics, identity, runQuery } from "./reports";

export type Severity = "high" | "medium" | "low" | "info";
export interface Finding {
  id: string;
  title: string;
  severity: Severity;
  status: "fail" | "pass" | "unknown";
  evidence: Record<string, unknown>;
  recommendation: string;
}

const n = (v: unknown): number => Number(v ?? 0);
const money = (micros: unknown, cur: string | null) => `${(n(micros) / 1e6).toFixed(2)} ${cur ?? ""}`.trim();

/**
 * Evidence-based audit. Each rule reads real account data and reports pass/fail/unknown.
 * This reimplements a focused subset of the original 97-control Python catalogue: everything it does
 * not check is listed under `not_checked`, never scored as passing.
 */
export const auditAccount = async (ctx: Ctx, p: Principal, id: string, start: string, end: string) => {
  const w = dateWindow(start, end);
  const findings: Finding[] = [];
  const unknown: string[] = [];
  const add = (f: Finding) => findings.push(f);

  const perf = await runQuery(ctx, p, id, Q.performance(w), 200);
  const account = perf.account;
  const cur = account.currency;
  const camps = perf.data.rows as any[];
  const totalCost = camps.reduce((s, r) => s + n(r.metrics?.cost_micros), 0);
  const totalConv = camps.reduce((s, r) => s + n(r.metrics?.conversions), 0);

  // 1. Conversion tracking present
  let tracking: Awaited<ReturnType<typeof getConversionDiagnostics>> | null = null;
  try {
    tracking = await getConversionDiagnostics(ctx, p, id);
  } catch {
    unknown.push("conversion_tracking (read failed)");
  }
  if (tracking) {
    const actions = tracking.actions.rows as any[];
    const enabled = actions.filter((a) => a.conversion_action?.status === "ENABLED");
    const primary = enabled.filter((a) => a.conversion_action?.primary_for_goal);
    add({
      id: "tracking.enabled_actions", title: "At least one enabled conversion action", severity: "high",
      status: enabled.length ? "pass" : "fail", evidence: { enabled: enabled.length, total: actions.length },
      recommendation: "Create and verify a conversion action. Bidding and every efficiency metric depend on it.",
    });
    add({
      id: "tracking.primary_action", title: "A primary conversion action exists", severity: "medium",
      status: primary.length ? "pass" : "fail", evidence: { primary: primary.length },
      recommendation: "Mark the conversion actions that matter to the business as primary so bidding can optimise for them.",
    });
    unknown.push("conversion_tracking.events_firing (configuration does not prove website events arrive)");
  }

  // 2. Spend without conversions
  if (tracking && tracking.actions.rows.length) {
    const wasteful = camps.filter((r) => n(r.metrics?.cost_micros) > 0 && n(r.metrics?.conversions) === 0 && r.campaign?.status === "ENABLED");
    add({
      id: "campaigns.spend_without_conversions", title: "Enabled campaigns spending with zero conversions", severity: wasteful.length ? "high" : "info",
      status: wasteful.length ? "fail" : "pass",
      evidence: { campaigns: wasteful.slice(0, 10).map((r) => ({ id: r.campaign.id, name: r.campaign.name, cost: money(r.metrics.cost_micros, cur), clicks: r.metrics.clicks })), share_of_spend_pct: totalCost ? Math.round((wasteful.reduce((s, r) => s + n(r.metrics.cost_micros), 0) / totalCost) * 100) : 0 },
      recommendation: "Check tracking first. If tracking is sound, review search terms and keywords, tighten targeting or pause after review.",
    });
  }

  // 3. Enabled campaigns with no impressions
  const silent = camps.filter((r) => r.campaign?.status === "ENABLED" && n(r.metrics?.impressions) === 0);
  add({
    id: "campaigns.enabled_no_impressions", title: "Enabled campaigns with no impressions", severity: silent.length ? "medium" : "info", status: silent.length ? "fail" : "pass",
    evidence: { campaigns: silent.slice(0, 10).map((r) => ({ id: r.campaign.id, name: r.campaign.name })) },
    recommendation: "Look for disapproved ads, a too-low budget or bid, exhausted dates or narrow targeting.",
  });

  // 4. Impression share and budget limits (Search)
  try {
    const is = await runQuery(ctx, p, id, Q.impressionShare(w), 200);
    const rows = is.data.rows as any[];
    const budgetLimited = rows.filter((r) => n(r.metrics?.search_budget_lost_impression_share) > 0.2 && r.campaign?.status === "ENABLED");
    const rankLimited = rows.filter((r) => n(r.metrics?.search_rank_lost_impression_share) > 0.4 && r.campaign?.status === "ENABLED");
    add({
      id: "search.budget_limited", title: "Search campaigns losing >20% impression share to budget", severity: "medium", status: budgetLimited.length ? "fail" : "pass",
      evidence: { campaigns: budgetLimited.slice(0, 10).map((r) => ({ id: r.campaign.id, name: r.campaign.name, lost_to_budget: r.metrics.search_budget_lost_impression_share })) },
      recommendation: "If these campaigns are profitable, consider a budget increase through a reviewed plan; otherwise leave them.",
    });
    add({
      id: "search.rank_limited", title: "Search campaigns losing >40% impression share to rank", severity: "medium", status: rankLimited.length ? "fail" : "pass",
      evidence: { campaigns: rankLimited.slice(0, 10).map((r) => ({ id: r.campaign.id, name: r.campaign.name, lost_to_rank: r.metrics.search_rank_lost_impression_share })) },
      recommendation: "Improve ad relevance, landing page and quality score before raising bids.",
    });
  } catch {
    unknown.push("search.impression_share (read failed)");
  }

  // 5. CTR
  const lowCtr = camps.filter((r) => n(r.metrics?.impressions) >= 1000 && n(r.metrics?.clicks) / n(r.metrics?.impressions) < 0.02 && r.campaign?.advertising_channel_type === "SEARCH");
  add({
    id: "search.low_ctr", title: "Search campaigns with CTR under 2% (1,000+ impressions)", severity: "low", status: lowCtr.length ? "fail" : "pass",
    evidence: { campaigns: lowCtr.slice(0, 10).map((r) => ({ id: r.campaign.id, name: r.campaign.name, ctr_pct: +((n(r.metrics.clicks) / n(r.metrics.impressions)) * 100).toFixed(2) })) },
    recommendation: "Review ad copy relevance and match types. A low CTR is a signal, not proof of waste.",
  });

  // 6. Search terms with spend and no conversions
  try {
    const st = await runQuery(ctx, p, id, Q.searchTerms(w), 200);
    const rows = st.data.rows as any[];
    const waste = rows.filter((r) => n(r.metrics?.cost_micros) > 0 && n(r.metrics?.conversions) === 0).slice(0, 15);
    const wasteCost = rows.filter((r) => n(r.metrics?.conversions) === 0).reduce((s, r) => s + n(r.metrics?.cost_micros), 0);
    add({
      id: "search_terms.zero_conversion_spend", title: "Search terms that spent money without converting", severity: waste.length && totalCost && wasteCost / totalCost > 0.2 ? "high" : "medium",
      status: waste.length ? "fail" : "pass",
      evidence: { top_terms: waste.map((r) => ({ term: r.search_term_view.search_term, cost: money(r.metrics.cost_micros, cur), clicks: r.metrics.clicks })), zero_conversion_share_of_term_spend_pct: totalCost ? Math.round((wasteCost / totalCost) * 100) : null, truncated: st.data.truncated },
      recommendation: "Review these terms. Add negatives only for terms clearly irrelevant to the business, using get_search_terms evidence in a reviewed plan.",
    });
  } catch {
    unknown.push("search_terms (read failed)");
  }

  // 7. Low quality score keywords
  try {
    const kw = await runQuery(ctx, p, id, Q.keywords(w), 200);
    const low = (kw.data.rows as any[]).filter((r) => n(r.ad_group_criterion?.quality_info?.quality_score) > 0 && n(r.ad_group_criterion.quality_info.quality_score) <= 4 && n(r.metrics?.cost_micros) > 0);
    add({
      id: "keywords.low_quality_score", title: "Spending keywords with quality score 4 or lower", severity: "medium", status: low.length ? "fail" : "pass",
      evidence: { keywords: low.slice(0, 15).map((r) => ({ text: r.ad_group_criterion.keyword?.text, qs: r.ad_group_criterion.quality_info.quality_score, cost: money(r.metrics.cost_micros, cur) })) },
      recommendation: "Tighten ad groups, align ad copy and landing page with the keyword, or pause keywords that stay low after review.",
    });
  } catch {
    unknown.push("keywords.quality_score (read failed)");
  }

  // 8. Ad policy
  try {
    const ads = await runQuery(ctx, p, id, Q.ads(w), 200);
    const bad = (ads.data.rows as any[]).filter((r) => ["DISAPPROVED", "AREA_OF_INTEREST_ONLY"].includes(r.ad_group_ad?.policy_summary?.approval_status) && r.ad_group_ad.status === "ENABLED");
    add({
      id: "ads.policy_issues", title: "Enabled ads that are disapproved or limited by policy", severity: bad.length ? "high" : "info", status: bad.length ? "fail" : "pass",
      evidence: { ads: bad.slice(0, 10).map((r) => ({ campaign: r.campaign.name, ad_group: r.ad_group.name, ad_id: r.ad_group_ad.ad?.id, approval: r.ad_group_ad.policy_summary.approval_status })) },
      recommendation: "Open the ad in Google Ads to read the exact policy topic, then create a corrected ad through a reviewed plan.",
    });
  } catch {
    unknown.push("ads.policy (read failed)");
  }

  const failing = findings.filter((f) => f.status === "fail");
  const bundle = {
    account: identity(account),
    window: { start, end },
    generated_at: new Date().toISOString(),
    totals: { cost: money(totalCost, cur), conversions: totalConv, campaigns: camps.length },
    findings,
    summary: { fail: failing.length, pass: findings.filter((f) => f.status === "pass").length, high: failing.filter((f) => f.severity === "high").length },
    not_checked: [
      ...unknown,
      "account structure and naming", "bidding strategy suitability", "audience and remarketing setup", "negative keyword lists coverage", "asset (sitelink/callout) coverage",
      "landing page quality", "policy and regulatory compliance beyond ad approval status", "creative testing cadence",
    ],
    scoring: { health_score: null, reason: "No validated scoring method is enabled. Findings are listed with evidence; unchecked areas are not scored as passing." },
  };
  const reportId = randomId();
  await ctx.db.run("INSERT INTO reports (id, account_id, report_json, created_at) VALUES (?,?,?,?)", reportId, account.customer_id, JSON.stringify(bundle), now());
  return { report_id: reportId, ...bundle };
};
