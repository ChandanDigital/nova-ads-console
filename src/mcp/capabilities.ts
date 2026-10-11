import { adsVersion, type Env } from "../env";

export type CapStatus = "implemented" | "partial" | "not_available_on_free_hosting" | "not_ported";

export interface Capability {
  id: string;
  status: CapStatus;
  implementation: string;
  note?: string;
  live_verified: false;
}

/** Honest capability matrix. `live_verified` stays false until someone runs the live checks in docs/live-checks.md. */
export const capabilityList = (): Capability[] => {
  const c = (id: string, status: CapStatus, implementation: string, note?: string): Capability => ({ id, status, implementation, note, live_verified: false });
  return [
    c("account_discovery", "implemented", "customers:listAccessibleCustomers + GoogleAdsService.search (customer, customer_client)"),
    c("gaql_reads", "implemented", "GoogleAdsService.search, bounded, read-only; personal-data fields denied"),
    c("official_mcp_compat", "implemented", "tools search, get_resource_metadata, list_accessible_customers mirror googleads/google-ads-mcp", "Reimplemented in TypeScript over the REST API; the official Python package is not run inside Workers."),
    c("reporting", "implemented", "performance, keywords, ads, search terms, segments, impression share, conversion diagnostics, period comparison, pacing"),
    c("audit", "implemented", "evidence rules over live data; unchecked areas listed, no health score"),
    c("keyword_research", "implemented", "KeywordPlanIdeaService generateKeywordIdeas / generateKeywordHistoricalMetrics"),
    c("geo_targets", "implemented", "GeoTargetConstantService suggest"),
    c("search_campaign_creation", "implemented", "GoogleAdsService.mutate: budget, campaign, locations, ad groups, keywords, RSA, sitelinks, callouts. Paused by default."),
    c("campaign_updates", "implemented", "mutate with exact update masks: status, budget, bids, names, tracking templates"),
    c("keyword_and_ad_group_updates", "implemented", "mutate: ad group status/bid, keyword status/bid/final URLs, new keywords and negatives (with evidence)"),
    c("validation", "implemented", "mutate validateOnly=true before approval and again before execution"),
    c("human_approval", "implemented", "separate authenticated dashboard screen; no MCP tool or token scope can approve"),
    c("recovery_plans", "implemented", "new reviewed plan restoring previous values or pausing created resources"),
    c("remote_https_mcp", "implemented", "Streamable HTTP at /mcp on Cloudflare Workers; OAuth 2.1 + PKCE or pasted API token"),
    c("display_shopping_pmax_demandgen_app_creation", "implemented", "mutate: responsive Display, Standard Shopping, Performance Max (non-retail), Demand Gen (multi-asset), App installs; paused by default", "Needs an eligible account, existing image/video assets (no file upload), a linked Merchant feed or app listing. General Video campaign creation is not supported by the API."),
    c("search_campaign_duplication", "implemented", "create_duplicate_campaign_plan reads a Search campaign and drafts a new paused copy through the normal plan and approval path", "Search campaigns only. Sitelinks, callouts, schedules, devices, radius targets, AI Max, shared lists and extra ads are not copied (the plan lists what was skipped)."),
    c("experiments", "not_ported", "Campaign experiments are available in the local Python backend (v0.2.0)"),
    c("recommendations_apply_dismiss", "implemented", "create_recommendation_plan: apply or dismiss open recommendations through plan, human approval and execute", "Google has no validate-only mode for this call, so validation re-checks that each recommendation is still open. Budget recommendations are refused (use create_budget_change_plan)."),
    c("customer_match_and_conversion_uploads", "not_ported", "Data Manager uploads stay in the local Python backend", "Private customer data is deliberately not stored on the free cloud database."),
    c("ga4_gtm_merchant_reads", "not_ported", "Local Python backend only"),
    c("alerts", "implemented", "A daily read-only check raises alerts (spend with no conversions, disapproved ads, unreadable accounts); get_alerts and the dashboard show them", "Alerts only. Nothing is paused or changed automatically."),
    c("monitors_and_auto_pause", "not_available_on_free_hosting", "Automatic pausing is intentionally not implemented", "It would bypass human approval, and a Free-plan Worker has 10 ms of CPU per run. Use alerts and approved status-change plans."),
    c("landing_page_inspection", "partial", "inspect_landing_page: one public https fetch, simple pattern checks", "No JavaScript rendering, speed test, tracking-tag or policy check; reads at most 100 KB."),
    c("pdf_reports", "partial", "Dashboard Print / Save as PDF button on plans and reports (browser print)", "No server-generated PDF files."),
    c("removal_of_resources", "not_ported", "Disabled by design in the original and here: removal cannot be undone"),
  ];
};

export const capabilitySummary = (env: Env) => ({
  product: "nodi-ads-cloud",
  version: "0.3.0",
  release_state: "release candidate; no live Google account verification",
  api: { transport: "Google Ads REST API", version: adsVersion(env), developer_token: "not required (retired 9 Sep 2026); access follows the OAuth client's Google Cloud project" },
  capabilities: capabilityList(),
  health_score: null,
});
