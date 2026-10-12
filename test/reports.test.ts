import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:workers";
import { call, issueToken, mcpTool, resetDb, setupAdmin, type Session } from "./helpers";
import { FakeGoogle, CUSTOMER } from "./fake-google";
import { connectAndAllow } from "./flow";
import worker from "../src/index";

const fake = new FakeGoogle();
let s: Session;
let ai: string;
beforeEach(async () => {
  await resetDb(); fake.reset(); fake.install();
  s = await setupAdmin();
  await connectAndAllow(s, fake);
  ai = await issueToken(s, ["read", "draft"]);
});
afterEach(() => fake.restore());

const W = { account_id: CUSTOMER, start: "2026-09-01", end: "2026-09-30" };
const lastSearch = () => fake.calls.filter((c) => c.url.endsWith("googleAds:search")).at(-1)!.body.query as string;

describe("reads", () => {
  it("performance sends bounded GAQL and returns the original snake_case shape", async () => {
    fake.cannedRows.campaign = [{ campaign: { id: "1", name: "A", status: "ENABLED", advertisingChannelType: "SEARCH", campaignBudget: "customers/1/campaignBudgets/2" }, metrics: { costMicros: "5000000", impressions: "100", clicks: "10", conversions: 2 } }];
    const r = await mcpTool(ai, "get_performance", W);
    expect(r.body.status).toBe("succeeded");
    expect(lastSearch()).toContain("segments.date BETWEEN '2026-09-01' AND '2026-09-30'");
    expect(lastSearch()).toMatch(/LIMIT 250 PARAMETERS omit_unselected_resource_names=true$/);
    const row = r.body.data.rows[0];
    expect(row.campaign.advertising_channel_type).toBe("SEARCH");
    expect(row.metrics.cost_micros).toBe("5000000");
    expect(r.body.data.account).toMatchObject({ customer_id: CUSTOMER, currency: "INR", timezone: "Asia/Kolkata" });
    expect(r.body.data.truncated).toBe(false);
  });
  it("marks truncated results", async () => {
    fake.cannedRows.campaign = Array.from({ length: 6 }, (_, i) => ({ campaign: { id: String(i) } }));
    const r = await mcpTool(ai, "get_performance", { ...W, limit: 5 });
    expect(r.body.data.row_count).toBe(5);
    expect(r.body.data.truncated).toBe(true);
  });
  it("keyword, ad, segment and impression-share reports", async () => {
    for (const [tool, extra, needle] of [["get_keyword_performance", {}, "FROM keyword_view"], ["get_ad_performance", {}, "FROM ad_group_ad"], ["get_segment_performance", { segment: "device" }, "segments.device"], ["get_impression_share", {}, "search_budget_lost_impression_share"]] as const) {
      const r = await mcpTool(ai, tool, { ...W, ...extra });
      expect(r.body.status, tool).toBe("succeeded");
      expect(lastSearch(), tool).toContain(needle);
    }
    expect((await mcpTool(ai, "get_segment_performance", { ...W, segment: "nonsense" })).isError).toBe(true);
  });
  it("official-compatible search builds GAQL from parts", async () => {
    await mcpTool(ai, "search", { customer_id: CUSTOMER, resource: "campaign", fields: ["campaign.id", "campaign.name"], conditions: ["campaign.status = 'ENABLED'"], orderings: ["campaign.id"], limit: 7 });
    expect(lastSearch()).toBe("SELECT campaign.id, campaign.name FROM campaign WHERE (campaign.status = 'ENABLED') ORDER BY campaign.id LIMIT 7 PARAMETERS omit_unselected_resource_names=true");
    const bad = await mcpTool(ai, "search", { customer_id: CUSTOMER, resource: "campaign", fields: ["campaign.id"], conditions: ["1=1; DROP"] });
    expect(bad.isError).toBe(true);
  });
  it("get_resource_metadata and list_accessible_customers", async () => {
    const m = await mcpTool(ai, "get_resource_metadata", { resource: "campaign" });
    expect(m.body.data.fields[0]).toMatchObject({ name: "campaign.id", selectable: true });
    expect(fake.callsTo("googleAdsFields:search")[0]!.body.query).toContain("LIKE 'campaign.%'");
    expect((await mcpTool(ai, "list_accessible_customers")).body.data.customer_ids).toEqual([CUSTOMER]);
  });
  it("keyword research and geo targets", async () => {
    const k = await mcpTool(ai, "research_keywords", { account_id: CUSTOMER, keywords: ["dentist"], geo_targets: ["geoTargetConstants/1007788"], language_id: "1000" });
    expect(k.body.data.results[0].text).toBe("dentist near me");
    expect(k.body.data.results[0].keyword_idea_metrics.avg_monthly_searches).toBe("1000");
    const g = await mcpTool(ai, "search_geo_targets", { account_id: CUSTOMER, names: ["Kolkata"], country_code: "IN" });
    expect(g.body.data.suggestions[0].geo_target_constant.resource_name).toBe("geoTargetConstants/1007788");
    expect((await mcpTool(ai, "research_keywords", { account_id: CUSTOMER, keywords: ["x"], geo_targets: ["Kolkata"], language_id: "1000" })).isError).toBe(true);
  });
  it("search terms are saved as evidence", async () => {
    fake.cannedRows.search_term_view = [{ searchTermView: { searchTerm: "free dentist" }, metrics: { costMicros: "1000000" } }];
    const r = await mcpTool(ai, "get_search_terms", W);
    const row = await env.DB.prepare("SELECT account_id, kind FROM evidence WHERE id = ?").bind(r.body.data.dataset_id).first();
    expect(row).toEqual({ account_id: CUSTOMER, kind: "search_terms" });
  });
  it("pacing combines spend with the account's local month", async () => {
    fake.cannedRows.campaign = [{ campaign: { id: "1", name: "A", status: "ENABLED" }, metrics: { costMicros: "100000000" } }];
    const r = await mcpTool(ai, "calculate_budget_pacing", { account_id: CUSTOMER, monthly_total: "1000", campaign_ids: ["1"] });
    expect(r.body.data.spent_micros).toBe("100000000");
    expect(r.body.data.google_billing_limit).toBe(false);
    expect((await mcpTool(ai, "calculate_budget_pacing", { account_id: CUSTOMER, monthly_total: "1000", campaign_ids: ["2"] })).body.errors[0].code).toBe("missing_campaign");
  });
  it("compare_periods reads both windows", async () => {
    const r = await mcpTool(ai, "compare_periods", { account_id: CUSTOMER, first_start: "2026-08-01", first_end: "2026-08-31", second_start: "2026-09-01", second_end: "2026-09-30" });
    expect(r.body.data.complete).toBe(true);
  });
  it("a Google permission error is explained and keeps the request id", async () => {
    fake.customers[CUSTOMER] = undefined as any;
    const r = await mcpTool(ai, "select_account", { account_id: CUSTOMER });
    expect(r.body.errors[0].code).toBe("account_inaccessible");
  });
});

describe("audit", () => {
  it("reports evidence-based findings, lists what it did not check, and never invents a score", async () => {
    fake.cannedRows.campaign = [
      { campaign: { id: "1", name: "Burner", status: "ENABLED", advertisingChannelType: "SEARCH" }, metrics: { costMicros: "800000000", impressions: "5000", clicks: "40", conversions: 0, searchBudgetLostImpressionShare: 0.4, searchRankLostImpressionShare: 0.5 } },
      { campaign: { id: "2", name: "Good", status: "ENABLED", advertisingChannelType: "SEARCH" }, metrics: { costMicros: "200000000", impressions: "2000", clicks: "100", conversions: 9 } },
      { campaign: { id: "3", name: "Silent", status: "ENABLED", advertisingChannelType: "SEARCH" }, metrics: { costMicros: "0", impressions: "0", clicks: "0", conversions: 0 } },
    ];
    fake.cannedRows.conversion_action = [{ conversionAction: { name: "Call", status: "ENABLED", primaryForGoal: true } }];
    fake.cannedRows.search_term_view = [{ searchTermView: { searchTerm: "free dentist" }, metrics: { costMicros: "300000000", clicks: "20", conversions: 0 } }];
    fake.cannedRows.keyword_view = [{ adGroupCriterion: { keyword: { text: "dentist" }, qualityInfo: { qualityScore: 3 } }, metrics: { costMicros: "50000000" } }];
    fake.cannedRows.ad_group_ad = [{ campaign: { name: "Burner" }, adGroup: { name: "AG" }, adGroupAd: { status: "ENABLED", ad: { id: "9" }, policySummary: { approvalStatus: "DISAPPROVED" } } }];
    const r = await mcpTool(ai, "audit_account", W);
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    const d = r.body.data;
    const by = Object.fromEntries(d.findings.map((f: any) => [f.id, f]));
    expect(by["tracking.enabled_actions"].status).toBe("pass");
    expect(by["campaigns.spend_without_conversions"].status).toBe("fail");
    expect(by["campaigns.spend_without_conversions"].evidence.campaigns[0].name).toBe("Burner");
    expect(by["campaigns.enabled_no_impressions"].status).toBe("fail");
    expect(by["search.budget_limited"].status).toBe("fail");
    expect(by["search_terms.zero_conversion_spend"].evidence.top_terms[0].term).toBe("free dentist");
    expect(by["keywords.low_quality_score"].status).toBe("fail");
    expect(by["ads.policy_issues"].status).toBe("fail");
    expect(d.scoring.health_score).toBeNull();
    expect(d.not_checked.length).toBeGreaterThan(3);
    expect(d.summary.fail).toBeGreaterThanOrEqual(6);

    const md = await mcpTool(ai, "export_report", { report_id: d.report_id, format: "markdown" });
    expect(md.body.data.content).toContain("[FAIL] Enabled campaigns spending with zero conversions");
    expect((await call(`/api/reports/${d.report_id}`, { session: s })).json.findings.length).toBe(d.findings.length);
  });
  it("with no conversion actions it flags tracking as the first problem", async () => {
    const r = await mcpTool(ai, "audit_account", W);
    expect(r.body.data.findings.find((f: any) => f.id === "tracking.enabled_actions").status).toBe("fail");
  });
});

describe("maintenance and diagnostics", () => {
  it("the daily cron purges only expired data and records its run", async () => {
    const t = Math.floor(Date.now() / 1000);
    await env.DB.prepare("INSERT INTO sessions (id_hash,admin_id,csrf,created_at,expires_at,last_seen_at) VALUES ('old','primary','c',1,2,1)").run();
    await env.DB.prepare("INSERT INTO api_tokens (id,kind,token_hash,label,scopes,created_at,expires_at) VALUES ('t-old','api','h1','x','[]',1,2)").run();
    await env.DB.prepare("INSERT INTO plans (id,account_id,status,hash,plan_json,created_by,created_at,expires_at,updated_at) VALUES ('11111111-1111-1111-1111-111111111111','1','succeeded','h','{}','x',1,2,1)").run();
    await env.DB.prepare("INSERT INTO audit_log (ts,actor_type,action,outcome) VALUES (1,'system','ancient','ok')").run();
    const pending: Promise<unknown>[] = [];
    await (worker as any).scheduled({}, env, { waitUntil: (p: Promise<unknown>) => pending.push(p) });
    await Promise.all(pending);
    const n = async (sql: string) => (await env.DB.prepare(sql).first<{ n: number }>())!.n;
    expect(await n("SELECT COUNT(*) AS n FROM sessions WHERE id_hash='old'")).toBe(0);
    expect(await n("SELECT COUNT(*) AS n FROM api_tokens WHERE id='t-old'")).toBe(0);
    expect(await n("SELECT COUNT(*) AS n FROM audit_log WHERE action='ancient'")).toBe(0);
    expect(await n("SELECT COUNT(*) AS n FROM plans")).toBe(1); // plan history is never purged
    expect(Number((await env.DB.prepare("SELECT value FROM settings WHERE name='last_cron_at'").first<any>()).value)).toBeGreaterThanOrEqual(t);
  });
  it("diagnostics cover secrets, origin, schema, Google, accounts and recent errors", async () => {
    const d = (await call("/api/diagnostics?deep=1", { session: s })).json as any[];
    const ids = d.map((x) => x.id);
    for (const id of ["secret.encryption_key", "secret.google_client", "secret.setup", "origin.https", "google.redirect", "db.schema", "ads.api", "accounts", "errors.recent"]) expect(ids).toContain(id);
    expect(d.find((x) => x.id === "google.redirect").detail).toBe("https://nova.example.workers.dev/oauth/google/callback");
    expect(d.find((x) => x.id.startsWith("google.connection.")).detail).toMatch(/Live token refresh succeeded/);
    expect(JSON.stringify(d)).not.toContain(env.GOOGLE_CLIENT_SECRET);
  });
});
