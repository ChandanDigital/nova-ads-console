import { describe, it, expect } from "vitest";
// @ts-expect-error plain ES module without type declarations
import { runReport, accessToken } from "../github-only/report.mjs";

const env = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "sec", GOOGLE_REFRESH_TOKEN: "1//r", GOOGLE_ADS_CUSTOMER_ID: "301-008-6756", GOOGLE_ADS_LOGIN_CUSTOMER_ID: "999-888-7776" };

const fakeFetch = (log: { url: string; init: any }[], failToken = false) => async (url: string, init: any) => {
  log.push({ url, init });
  const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  if (url.includes("oauth2.googleapis.com")) return failToken ? j({ error: "invalid_grant" }, 400) : j({ access_token: "ya29.x", expires_in: 3600 });
  const q = JSON.parse(init.body).query as string;
  if (q.includes("FROM campaign")) return j({ results: [{ campaign: { name: "A|B", status: "ENABLED" }, metrics: { costMicros: "5000000", clicks: "10", impressions: "100", conversions: 0 } }] });
  if (q.includes("search_term_view")) return j({ results: [{ searchTermView: { searchTerm: "free" }, metrics: { costMicros: "2000000", clicks: "4" } }] });
  return j({ results: [{ conversionAction: { name: "Call", status: "ENABLED" } }] });
};

describe("GitHub-only scheduled report (no server, read-only)", () => {
  it("produces a Markdown report from three read queries and never mutates", async () => {
    const log: any[] = [];
    const r = await runReport(env, fakeFetch(log), new Date("2026-10-11T00:00:00Z"));
    expect(r.markdown).toContain("# Google Ads report 2026-10-05 to 2026-10-11");
    expect(r.markdown).toContain("A\\|B");
    expect(r.markdown).toContain("Some enabled campaigns spent money with zero conversions");
    const ads = log.filter((c) => c.url.includes("googleads.googleapis.com"));
    expect(ads).toHaveLength(3);
    expect(ads.every((c) => c.url.endsWith("/v25/customers/3010086756/googleAds:search"))).toBe(true);
    expect(ads.every((c) => c.init.headers["login-customer-id"] === "9998887776" && !("developer-token" in c.init.headers))).toBe(true);
    expect(log.some((c) => /mutate/i.test(c.url))).toBe(false);
  });
  it("explains an expired refresh token", async () => {
    await expect(accessToken(env, fakeFetch([], true))).rejects.toThrow(/Testing mode.*7 days/);
  });
  it("names the missing secret", async () => {
    await expect(runReport({}, fakeFetch([]))).rejects.toThrow(/GOOGLE_CLIENT_ID/);
  });
});
