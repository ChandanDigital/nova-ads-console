import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:workers";
import worker from "../src/index";
import { call, issueToken, mcpTool, resetDb, setupAdmin, type Session } from "./helpers";
import { FakeGoogle, CUSTOMER } from "./fake-google";
import { connectAndAllow, realMutates, validateMutates } from "./flow";

const campaign = (id: string, name: string, costMicros: string, conversions: number) => ({ campaign: { id, name }, metrics: { costMicros, conversions } });
const badAd = (name: string) => ({ campaign: { name }, adGroupAd: { ad: { id: "1" }, policySummary: { approvalStatus: "DISAPPROVED" } } });

describe("daily health monitor (alerts only)", () => {
  const fake = new FakeGoogle();
  let s: Session;
  beforeEach(async () => {
    await resetDb(); fake.reset(); fake.install();
    s = await setupAdmin();
    await connectAndAllow(s, fake);
  });
  afterEach(() => fake.restore());

  const run = async () => (await call("/api/alerts/run", { method: "POST", session: s })).json;
  const list = async (q = "") => (await call("/api/alerts" + q, { session: s })).json;

  it("raises spend-without-conversions and disapproved-ad alerts, and changes nothing in the account", async () => {
    fake.cannedRows = {
      campaign: [campaign("11", "Burning money", "75000000", 0), campaign("12", "Converting", "90000000", 4), campaign("13", "Tiny spend", "5000000", 0)],
      ad_group_ad: [badAd("Burning money"), badAd("Burning money")],
    };
    const r = await run();
    expect(r).toMatchObject({ accounts: 1, raised: 2, errors: 0 });
    const out = await list();
    expect(out.alerts.map((a: any) => a.kind).sort()).toEqual(["disapproved_ads", "spend_no_conversions"]);
    const spend = out.alerts.find((a: any) => a.kind === "spend_no_conversions");
    expect(spend.title).toMatch(/Burning money: 75\.00 INR spent in 7 days with no conversions/);
    expect(spend.severity).toBe("warn");
    expect(out.alerts.find((a: any) => a.kind === "disapproved_ads").severity).toBe("high");
    expect(out.last_check_at).toBeGreaterThan(0);
    // read-only: no mutation and no recommendation call, ever
    expect(realMutates(fake).length + validateMutates(fake).length).toBe(0);
    expect(fake.callsTo("recommendations").length).toBe(0);
  });

  it("keeps one alert per subject, then resolves it automatically when the condition ends", async () => {
    fake.cannedRows = { campaign: [campaign("11", "Burning money", "75000000", 0)], ad_group_ad: [] };
    await run(); await run();
    expect((await list()).alerts.length).toBe(1);
    fake.cannedRows = { campaign: [campaign("11", "Burning money", "75000000", 2)], ad_group_ad: [] };
    const r = await run();
    expect(r.resolved).toBe(1);
    expect((await list()).alerts.length).toBe(0);
    const all = await list("?resolved=1");
    expect(all.alerts.length).toBe(1);
    expect(all.alerts[0].resolved_at).toBeGreaterThan(0);
  });

  it("the spend threshold is configurable by the administrator only", async () => {
    fake.cannedRows = { campaign: [campaign("13", "Tiny spend", "5000000", 0)], ad_group_ad: [] };
    expect((await run()).raised).toBe(0);
    expect((await call("/api/settings/alerts", { method: "POST", session: s, body: { min_spend: "1" } })).status).toBe(200);
    expect((await run()).raised).toBe(1);
    expect((await call("/api/settings/alerts", { method: "POST", session: s, body: { min_spend: "abc" } })).status).toBe(400);
    expect((await call("/api/settings/alerts", { method: "POST", body: { min_spend: "1" } })).status).toBe(401);
    expect((await call("/api/alerts")).status).toBe(401);
  });

  it("an account Google will not let it read becomes an info alert with the reason, not a crash", async () => {
    fake.searchFailure = { status: 403, body: { error: { code: 403, message: "x", details: [{ errors: [{ errorCode: { authorizationError: "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION" }, message: "test access" }] }] } } };
    const r = await run();
    expect(r).toMatchObject({ errors: 1, raised: 0 });
    const a = (await list()).alerts[0];
    expect(a.kind).toBe("monitor_error");
    expect(a.severity).toBe("info");
    expect(a.detail.code).toBe("production_access_restricted");
    fake.searchFailure = null; fake.cannedRows = { campaign: [], ad_group_ad: [] };
    await run();
    expect((await list()).alerts.length).toBe(0);
  });

  it("AI tools see alerts only for accounts the administrator allowed for them", async () => {
    fake.cannedRows = { campaign: [campaign("11", "Burning money", "75000000", 0)], ad_group_ad: [] };
    await run();
    const read = await issueToken(s, ["read"]);
    const seen = await mcpTool(read, "get_alerts", {});
    expect(seen.isError, JSON.stringify(seen.body)).toBe(false);
    expect(seen.body.data.alerts.length).toBe(1);
    const other = await issueToken(s, ["read"], { accounts: ["1112223334"] });
    expect((await mcpTool(other, "get_alerts", {})).body.data.alerts.length).toBe(0);
    expect((await mcpTool(other, "get_alerts", { account_id: CUSTOMER })).isError).toBe(true);
    await call(`/api/accounts/${CUSTOMER}/allow`, { method: "POST", session: s, body: { allowed: false } });
    expect((await mcpTool(read, "get_alerts", {})).body.data.alerts.length).toBe(0);
  });

  it("the daily cron job runs the monitor and survives its failure", async () => {
    fake.cannedRows = { campaign: [campaign("11", "Burning money", "75000000", 0)], ad_group_ad: [] };
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
    await worker.scheduled({} as ScheduledController, env as any, ctx);
    expect((await list()).alerts.length).toBe(1);
    fake.searchFailure = { status: 500, body: { error: { code: 500, message: "boom" } } };
    await expect(worker.scheduled({} as ScheduledController, env as any, ctx)).resolves.toBeUndefined();
    const stamp = await env.DB.prepare("SELECT value FROM settings WHERE name = 'last_cron_at'").first<{ value: string }>();
    expect(Number(stamp!.value)).toBeGreaterThan(0);
  });
});
