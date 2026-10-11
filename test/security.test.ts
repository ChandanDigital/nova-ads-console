import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:workers";
import { call, callWithEnv, issueToken, mcpTool, resetDb, setupAdmin, workerFetch, ORIGIN, type Session } from "./helpers";
import { FakeGoogle, CUSTOMER } from "./fake-google";
import { connectAndAllow, searchSpec } from "./flow";
import { routeTable } from "../src/api/routes";

const fake = new FakeGoogle();
let s: Session;
beforeEach(async () => { await resetDb(); fake.reset(); fake.install(); s = await setupAdmin(); });
afterEach(() => fake.restore());

const PUBLIC = new Set(["GET ^\\/api\\/state\\/?$", "POST ^\\/api\\/auth\\/setup\\/?$", "POST ^\\/api\\/auth\\/login\\/?$", "POST ^\\/api\\/auth\\/recover\\/?$"]);

describe("every dashboard API route is protected", () => {
  it("answers 401 without a session (all registered routes except setup/login/recover/state)", async () => {
    const table = routeTable();
    expect(table.length).toBeGreaterThan(40);
    const unprotected: string[] = [];
    for (const r of table) {
      if (PUBLIC.has(`${r.method} ${r.path}`)) continue;
      const path = r.path.replace(/^\^/, "").replace(/\\\/\?\$$/, "").replace(/\\\//g, "/").replace(/\(\[\^\/\]\+\)/g, "3010086756");
      const res = await workerFetch(new Request(ORIGIN + path, { method: r.method, headers: { origin: ORIGIN, "content-type": "application/json" }, body: r.method === "GET" ? undefined : "{}" }));
      if (res.status !== 401) unprotected.push(`${r.method} ${path} -> ${res.status}`);
    }
    expect(unprotected).toEqual([]);
  });
  it("answers 403 to a bearer token on every secured route, even with a valid session cookie", async () => {
    const token = await issueToken(s, ["read", "draft", "apply"]);
    for (const path of ["/api/overview", "/api/accounts", "/api/plans", "/api/tokens", "/api/audit", "/api/diagnostics", "/api/usage"]) {
      const r = await call(path, { session: s, headers: { authorization: "Bearer " + token } });
      expect(r.status, path).toBe(403);
    }
  });
  it("unknown API routes do not leak anything", async () => {
    const r = await call("/api/nope", { session: s });
    expect(r.status).toBe(404);
  });
});

describe("headers", () => {
  it("API responses are never cached and carry hardening headers", async () => {
    const r = await call("/api/state");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("strict-transport-security")).toContain("max-age");
    const csp = r.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
  });
  it("health endpoint reveals nothing sensitive", async () => {
    const r = await call("/healthz");
    expect(Object.keys(r.json).sort()).toEqual(["ok", "service", "version"]);
  });
});

describe("secrets never leak", () => {
  it("no API response, audit entry or log row contains stored tokens or secrets", async () => {
    await connectAndAllow(s, fake);
    const ai = await issueToken(s, ["read", "draft", "apply"]);
    await mcpTool(ai, "list_accounts");
    await mcpTool(ai, "create_campaign_plan", { account_id: CUSTOMER, spec: searchSpec() });
    const dump = JSON.stringify([
      (await call("/api/overview", { session: s })).json, (await call("/api/audit?limit=500", { session: s })).json, (await call("/api/diagnostics", { session: s })).json,
      (await call("/api/google/connections", { session: s })).json, (await call("/api/tokens", { session: s })).json, (await call("/api/mcp-info", { session: s })).json,
      (await call("/api/accounts", { session: s })).json,
    ]);
    for (const secret of [fake.refreshToken, "ya29.", s.credential!, ai, env.GOOGLE_CLIENT_SECRET, env.TOKEN_ENCRYPTION_KEY, env.ADMIN_SETUP_SECRET]) expect(dump, secret.slice(0, 12)).not.toContain(secret);
    const all = JSON.stringify(await env.DB.prepare("SELECT * FROM audit_log").all());
    expect(all).not.toContain(ai);
    expect(all).not.toContain(s.credential!);
  });
  it("Google refresh/access tokens are only ever stored sealed", async () => {
    await connectAndAllow(s, fake);
    const rows = JSON.stringify(await env.DB.prepare("SELECT * FROM google_connections").all());
    expect(rows).not.toContain(fake.refreshToken);
    expect(rows).not.toMatch(/ya29\./);
    const state = JSON.stringify(await env.DB.prepare("SELECT * FROM google_oauth_states").all());
    expect(state).not.toMatch(/code_verifier|verifier":/);
  });
  it("setup secret is never stored in D1, only the digest of a used value", async () => {
    const dump = JSON.stringify(await env.DB.prepare("SELECT * FROM used_setup_secrets").all());
    expect(dump).not.toContain(env.ADMIN_SETUP_SECRET);
  });
});

describe("AI agents cannot reach administrator functions", () => {
  it("MCP exposes no tool for credentials, approval, recovery, tokens or settings", async () => {
    const ai = await issueToken(s, ["read", "draft", "apply"]);
    const { mcpCall } = await import("./helpers");
    const names = ((await mcpCall(ai, "tools/list")).json.result.tools as { name: string }[]).map((t) => t.name);
    for (const bad of [/approv/i, /credential/i, /recover(?!y_plan)/i, /token/i, /setting/i, /stop/i, /admin/i, /password/i, /secret/i, /disconnect/i]) expect(names.filter((n) => bad.test(n)), String(bad)).toEqual([]);
  });
  it("an AI token cannot hit recovery, setup, login, token management or settings", async () => {
    const ai = await issueToken(s, ["read", "draft", "apply"]);
    const h = { authorization: "Bearer " + ai };
    for (const [path, body] of [["/api/auth/recover", { setup_secret: env.ADMIN_SETUP_SECRET, confirmation: "REPLACE CREDENTIAL" }], ["/api/auth/setup", { setup_secret: env.ADMIN_SETUP_SECRET }], ["/api/auth/login", { credential: s.credential }], ["/api/tokens", { label: "x", scopes: ["read"] }], ["/api/settings/global-stop", { stop: false }], ["/api/plans/x/approve", {}]] as const) {
      const r = await call(path, { method: "POST", headers: h, body });
      expect([401, 403, 409], path).toContain(r.status);
      expect(r.status, path).not.toBe(200);
      expect(r.status, path).not.toBe(201);
    }
  });
  it("tool arguments cannot smuggle approval into execution", async () => {
    await connectAndAllow(s, fake);
    const ai = await issueToken(s, ["read", "draft", "apply"]);
    const p = (await mcpTool(ai, "create_campaign_plan", { account_id: CUSTOMER, spec: searchSpec() })).body.data;
    await mcpTool(ai, "validate_change_plan", { plan_id: p.plan_id });
    const r = await mcpTool(ai, "execute_authorised_plan", { plan_id: p.plan_id, approved: true, approval: { human: "me" }, hash: p.plan_hash });
    expect(r.body.status).toBe("awaiting_approval");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM executions").first<{ n: number }>())!.n).toBe(0);
  });
  it("personal-data GAQL and the manager hierarchy are denied to AI callers", async () => {
    await connectAndAllow(s, fake);
    const ai = await issueToken(s, ["read"]);
    const before = fake.calls.length; // discovery (done by the dashboard during connect) legitimately reads the hierarchy
    for (const q of ["SELECT customer_client.id FROM customer_client", "SELECT customer.email FROM customer", "SELECT campaign.id FROM campaign; DROP TABLE x"]) {
      const r = await mcpTool(ai, "query_account", { account_id: CUSTOMER, query: q });
      expect(r.isError, q).toBe(true);
    }
    expect(fake.calls.slice(before).filter((c) => c.url.endsWith("googleAds:search") && /customer_client|email/.test(String(c.body?.query))).length).toBe(0);
  });
  it("an unallowed account is invisible to AI even if its ID is guessed", async () => {
    await connectAndAllow(s, fake, []);
    const ai = await issueToken(s, ["read"]);
    expect((await mcpTool(ai, "list_accounts")).body.data.accounts).toEqual([]);
    expect((await mcpTool(ai, "get_performance", { account_id: CUSTOMER, start: "2026-09-01", end: "2026-09-30" })).body.errors[0].code).toBe("account_not_allowed");
    expect((await mcpTool(ai, "list_accessible_customers")).body.data.customer_ids).toEqual([]);
  });
});

describe("kill switches", () => {
  it("revoke-all ends every AI token at once", async () => {
    const a = await issueToken(s, ["read"]);
    const b = await issueToken(s, ["read", "draft"]);
    await call("/api/tokens/revoke-all", { method: "POST", session: s });
    const { mcpCall } = await import("./helpers");
    expect((await mcpCall(a, "tools/list")).status).toBe(401);
    expect((await mcpCall(b, "tools/list")).status).toBe(401);
  });
  it("token validation: scopes limited to read/draft/apply, expiry bounded", async () => {
    expect((await call("/api/tokens", { method: "POST", session: s, body: { label: "x", scopes: ["admin"], days: 1 } })).status).toBe(400);
    expect((await call("/api/tokens", { method: "POST", session: s, body: { label: "x", scopes: ["human_approve"], days: 1 } })).status).toBe(400);
    expect((await call("/api/tokens", { method: "POST", session: s, body: { label: "x", scopes: ["read"], days: 4000 } })).status).toBe(400);
    expect((await call("/api/tokens", { method: "POST", session: s, body: { label: "", scopes: ["read"], days: 1 } })).status).toBe(400);
  });
  it("expired tokens stop working", async () => {
    const t = await issueToken(s, ["read"]);
    await env.DB.prepare("UPDATE api_tokens SET expires_at = 1").run();
    const { mcpCall } = await import("./helpers");
    expect((await mcpCall(t, "tools/list")).status).toBe(401);
  });
});

describe("hosting limits are enforced, not just displayed", () => {
  it("stops MCP calls at the daily soft limit with a clear message and no paid fallback", async () => {
    const t = await issueToken(s, ["read"]);
    const over = { MCP_CALLS_PER_DAY: "3" };
    const { callWithEnv: cwe } = await import("./helpers");
    const call1 = async () => {
      const r = await cwe(over, "/mcp", { method: "POST", headers: { authorization: "Bearer " + t, accept: "application/json, text/event-stream" }, body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_capabilities", arguments: {} } } });
      return r.json.result.structuredContent ?? JSON.parse(r.json.result.content[0].text);
    };
    for (let i = 0; i < 3; i++) expect((await call1()).status).toBe("succeeded");
    const blocked = await call1();
    expect(blocked.status).toBe("failed");
    expect(blocked.errors[0].code).toBe("quota_soft_limit");
    expect(blocked.errors[0].message).toMatch(/Nothing was switched to a paid service/);
  });
  it("stops the whole API at the request ceiling, but keeps sign-in reachable", async () => {
    await env.DB.prepare("INSERT INTO usage_daily (day, metric, value) VALUES (?, 'requests', 99999) ON CONFLICT(day, metric) DO UPDATE SET value = 99999").bind(new Date().toISOString().slice(0, 10)).run();
    const r = await callWithEnv({ REQUESTS_SOFT_LIMIT: "100" }, "/api/overview", { headers: { cookie: s.cookie } });
    expect(r.status).toBe(429);
    expect(r.json.error.code).toBe("quota_soft_limit");
    const login = await callWithEnv({ REQUESTS_SOFT_LIMIT: "100" }, "/api/auth/login", { method: "POST", body: { credential: s.credential } });
    expect(login.status).toBe(200);
  });
  it("measures D1 rows from D1 itself and reports them with free-plan ceilings", async () => {
    await call("/api/overview", { session: s });
    await new Promise((r) => setTimeout(r, 50));
    const usage = (await call("/api/usage", { session: s })).json;
    const byName = Object.fromEntries(usage.metrics.map((m: any) => [m.metric, m]));
    expect(byName.d1_rows_written.used).toBeGreaterThan(0);
    expect(byName.d1_rows_read.used).toBeGreaterThan(0);
    expect(byName.requests.used).toBeGreaterThan(0);
    expect(byName.d1_rows_written.hard_limit).toBe(100000);
    expect(byName.requests.hard_limit).toBe(100000);
    expect(usage.free_plan_hard_limits.worker_cpu_ms_per_request).toBe(10);
    expect(usage.cloudflare.available).toBe(false);
  });
});
