// GitHub-only alternative: a READ-ONLY scheduled report that runs inside GitHub Actions (free quota).
// There is no server, no MCP endpoint and no dashboard in this mode, and it never changes the Google Ads account.
//
// Inputs (GitHub repository secrets, passed as environment variables):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN   OAuth client + a refresh token with the Google Ads scope
//   GOOGLE_ADS_CUSTOMER_ID                                          10 digits (no dashes)
//   GOOGLE_ADS_LOGIN_CUSTOMER_ID                                    optional manager account ID
//   REPORT_DAYS                                                     optional, default 7
// No developer token is needed (retired 9 Sep 2026).

const API_VERSION = "v25";

const need = (env, name) => {
  const v = env[name];
  if (!v) throw new Error(`Missing secret ${name}. Add it under Settings > Secrets and variables > Actions.`);
  return v;
};

export const accessToken = async (env, fetchImpl = fetch) => {
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: need(env, "GOOGLE_CLIENT_ID"), client_secret: need(env, "GOOGLE_CLIENT_SECRET"), refresh_token: need(env, "GOOGLE_REFRESH_TOKEN"), grant_type: "refresh_token" }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`Google refused the refresh token (${body.error ?? res.status}). If your OAuth consent screen is in Testing mode the token expires after 7 days: publish it to Production and create a new refresh token.`);
  }
  return body.access_token;
};

const gaql = async (env, token, query, fetchImpl) => {
  const customer = need(env, "GOOGLE_ADS_CUSTOMER_ID").replace(/-/g, "");
  if (!/^\d{10}$/.test(customer)) throw new Error("GOOGLE_ADS_CUSTOMER_ID must be 10 digits.");
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  if (env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) headers["login-customer-id"] = env.GOOGLE_ADS_LOGIN_CUSTOMER_ID.replace(/-/g, "");
  const res = await fetchImpl(`https://googleads.googleapis.com/${API_VERSION}/customers/${customer}/googleAds:search`, {
    method: "POST", headers, body: JSON.stringify({ query: `${query} PARAMETERS omit_unselected_resource_names=true` }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = JSON.stringify(body?.error?.details?.[0]?.errors?.[0]?.errorCode ?? body?.error?.status ?? res.status);
    throw new Error(`Google Ads API error ${code}`);
  }
  return body.results ?? [];
};

const isoDay = (d) => d.toISOString().slice(0, 10);
const n = (v) => Number(v ?? 0);
const money = (micros) => (n(micros) / 1e6).toFixed(2);

export const runReport = async (env, fetchImpl = fetch, now = new Date()) => {
  const days = Math.min(90, Math.max(1, Number(env.REPORT_DAYS ?? 7) || 7));
  const end = isoDay(now);
  const start = isoDay(new Date(now.getTime() - (days - 1) * 86400_000));
  const where = `segments.date BETWEEN '${start}' AND '${end}'`;
  const token = await accessToken(env, fetchImpl);
  const [camps, terms, convs] = await Promise.all([
    gaql(env, token, `SELECT campaign.id, campaign.name, campaign.status, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions FROM campaign WHERE ${where} AND campaign.status != 'REMOVED' ORDER BY metrics.cost_micros DESC LIMIT 50`, fetchImpl),
    gaql(env, token, `SELECT search_term_view.search_term, metrics.cost_micros, metrics.clicks, metrics.conversions FROM search_term_view WHERE ${where} AND metrics.conversions = 0 ORDER BY metrics.cost_micros DESC LIMIT 15`, fetchImpl),
    gaql(env, token, "SELECT conversion_action.name, conversion_action.status, conversion_action.primary_for_goal FROM conversion_action LIMIT 50", fetchImpl),
  ]);
  const total = camps.reduce((a, r) => ({ cost: a.cost + n(r.metrics?.costMicros), clicks: a.clicks + n(r.metrics?.clicks), imp: a.imp + n(r.metrics?.impressions), conv: a.conv + n(r.metrics?.conversions) }), { cost: 0, clicks: 0, imp: 0, conv: 0 });
  const enabledConv = convs.filter((r) => r.conversionAction?.status === "ENABLED").length;
  const lines = [
    `# Google Ads report ${start} to ${end}`,
    "",
    `Read-only report from the GitHub-only mode of Nova Ads Console. Generated ${now.toISOString()}.`,
    "",
    `| Cost | Clicks | Impressions | Conversions | CTR | Cost / conversion |`,
    `|---:|---:|---:|---:|---:|---:|`,
    `| ${money(total.cost)} | ${total.clicks} | ${total.imp} | ${total.conv.toFixed(1)} | ${total.imp ? ((total.clicks / total.imp) * 100).toFixed(2) + "%" : "n/a"} | ${total.conv ? (total.cost / 1e6 / total.conv).toFixed(2) : "n/a"} |`,
    "",
    "## Campaigns by cost",
    "",
    "| Campaign | Status | Cost | Clicks | Conversions |",
    "|---|---|---:|---:|---:|",
    ...camps.map((r) => `| ${String(r.campaign?.name).replace(/\|/g, "\\|")} | ${r.campaign?.status} | ${money(r.metrics?.costMicros)} | ${n(r.metrics?.clicks)} | ${n(r.metrics?.conversions).toFixed(1)} |`),
    "",
    "## Search terms that cost money without converting",
    "",
    terms.length ? "| Search term | Cost | Clicks |\n|---|---:|---:|\n" + terms.map((r) => `| ${String(r.searchTermView?.searchTerm).replace(/\|/g, "\\|")} | ${money(r.metrics?.costMicros)} | ${n(r.metrics?.clicks)} |`).join("\n") : "None in this period.",
    "",
    "## Checks",
    "",
    `- Enabled conversion actions: **${enabledConv}** ${enabledConv ? "" : "(none: fix tracking before judging results)"}`,
    camps.some((r) => r.campaign?.status === "ENABLED" && n(r.metrics?.costMicros) > 0 && n(r.metrics?.conversions) === 0) ? "- Some enabled campaigns spent money with zero conversions in this period." : "- No enabled campaign spent without converting.",
    "",
    "_Amounts are in the account currency. This report does not change anything in Google Ads._",
  ];
  return { markdown: lines.join("\n"), json: { start, end, total, campaigns: camps.length, wasted_terms: terms.length, enabled_conversion_actions: enabledConv } };
};

// CLI entry (GitHub Actions). Skipped when imported by the tests.
if (typeof process !== "undefined" && process.argv?.[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  const { writeFileSync, appendFileSync } = await import("node:fs");
  try {
    const { markdown, json } = await runReport(process.env);
    writeFileSync("report.md", markdown + "\n");
    writeFileSync("report.json", JSON.stringify(json, null, 2) + "\n");
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + "\n");
    console.log("Report written to report.md and report.json");
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
