import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:workers";
import { call, resetDb, setupAdmin, workerFetch, ORIGIN, type Session } from "./helpers";
import { FakeGoogle, CUSTOMER, MANAGER, CHILD } from "./fake-google";
import { Db } from "../src/lib/db";
import { getAccessToken } from "../src/google/oauth";

const fake = new FakeGoogle();
let s: Session;

beforeEach(async () => {
  await resetDb();
  fake.reset();
  fake.install();
  s = await setupAdmin();
});
afterEach(() => fake.restore());

const startConnect = async () => {
  const r = await call("/api/google/connect", { method: "POST", session: s });
  expect(r.status).toBe(200);
  const u = new URL(r.json.url);
  fake.challenge = u.searchParams.get("code_challenge");
  return u;
};
const callback = (state: string, code: string, session: Session | null = s) =>
  workerFetch(new Request(`${ORIGIN}/oauth/google/callback?state=${encodeURIComponent(state)}&code=${code}`, { headers: session ? { cookie: session.cookie } : {}, redirect: "manual" }));

describe("Google OAuth (browser flow)", () => {
  it("builds a consent URL with PKCE S256, offline access and only the Ads scope", async () => {
    const u = await startConnect();
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("client_id")).toBe(env.GOOGLE_CLIENT_ID);
    expect(u.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/oauth/google/callback`);
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("scope")).toBe("openid email https://www.googleapis.com/auth/adwords");
    // The client secret and the PKCE verifier never reach the browser.
    expect(u.toString()).not.toContain(env.GOOGLE_CLIENT_SECRET);
    expect(u.toString()).not.toContain("code_verifier");
  });

  it("completes the exchange server-side, seals the refresh token and discovers accounts incl. manager children", async () => {
    const u = await startConnect();
    const res = await callback(u.searchParams.get("state")!, "good-code");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/#/accounts?connected=1");

    const row = await env.DB.prepare("SELECT * FROM google_connections").first<any>();
    expect(row.email).toBe("owner@example.com");
    expect(row.status).toBe("active");
    expect(row.refresh_sealed.startsWith("v1.")).toBe(true);
    expect(JSON.stringify(row)).not.toContain(fake.refreshToken);
    expect(JSON.stringify(row)).not.toContain("ya29.");

    // The token request carried the secret and the PKCE verifier (and nothing leaked to the browser).
    const tokenCall = fake.callsTo("oauth2.googleapis.com/token")[0]!;
    expect(tokenCall.body.client_secret).toBe("test-client-secret");
    expect(tokenCall.body.code_verifier).toBeTruthy();

    const accounts = (await call("/api/accounts", { session: s })).json as any[];
    const ids = accounts.map((a) => a.customer_id).sort();
    expect(ids).toEqual([CHILD, CUSTOMER, MANAGER].sort());
    const child = accounts.find((a) => a.customer_id === CHILD);
    expect(child.login_customer_id).toBe(MANAGER);
    expect(accounts.every((a) => a.allowed === false)).toBe(true); // nothing is AI-visible until the administrator allows it

    // Ads calls carry no developer token and use the manager as login-customer-id only for children.
    const ads = fake.calls.filter((c) => c.url.includes("googleads.googleapis.com"));
    expect(ads.every((c) => !("developer-token" in c.headers))).toBe(true);
    expect(ads.every((c) => c.url.includes("/v25/"))).toBe(true);
    expect(fake.callsTo("listAccessibleCustomers")[0]!.headers["login-customer-id"]).toBeUndefined();
  });

  it("state is single use", async () => {
    const u = await startConnect();
    expect((await callback(u.searchParams.get("state")!, "good-code")).status).toBe(302);
    const again = await callback(u.searchParams.get("state")!, "good-code");
    expect(again.headers.get("location")).toContain("google_error=invalid_oauth_state");
  });

  it("state from another browser session is refused", async () => {
    const u = await startConnect();
    const other = await call("/api/auth/login", { method: "POST", body: { credential: s.credential } });
    const cookie = other.headers.get("set-cookie")!.split(";")[0]!;
    const res = await callback(u.searchParams.get("state")!, "good-code", { cookie, csrf: "x" });
    expect(res.headers.get("location")).toContain("google_error=invalid_oauth_state");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM google_connections").first<{ n: number }>())!.n).toBe(0);
  });

  it("needs the dashboard session", async () => {
    const u = await startConnect();
    const res = await callback(u.searchParams.get("state")!, "good-code", null);
    expect(res.headers.get("location")).toContain("login");
  });

  it("refuses a connection without a refresh token or without the Ads scope", async () => {
    let u = await startConnect();
    expect((await callback(u.searchParams.get("state")!, "no-refresh")).headers.get("location")).toContain("missing_refresh_token");
    u = await startConnect();
    expect((await callback(u.searchParams.get("state")!, "no-ads-scope")).headers.get("location")).toContain("missing_ads_scope");
  });

  it("reports Google errors without crashing", async () => {
    const res = await workerFetch(new Request(`${ORIGIN}/oauth/google/callback?error=access_denied`, { headers: { cookie: s.cookie }, redirect: "manual" }));
    expect(res.headers.get("location")).toContain("google_error=access_denied");
  });

  it("explains missing OAuth client secrets", async () => {
    const { callWithEnv } = await import("./helpers");
    const r = await callWithEnv({ GOOGLE_CLIENT_SECRET: "" }, "/api/google/connect", { method: "POST", headers: { cookie: s.cookie, "x-csrf-token": s.csrf } });
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe("google_oauth_not_configured");
  });
});

describe("token renewal and health", () => {
  const connect = async () => {
    const u = await startConnect();
    await callback(u.searchParams.get("state")!, "good-code");
    return (await env.DB.prepare("SELECT id FROM google_connections").first<{ id: string }>())!.id;
  };

  it("reuses a valid cached access token and refreshes when it expires", async () => {
    const id = await connect();
    const db = new Db(env.DB);
    const t1 = await getAccessToken(env, db, id);
    const n = fake.callsTo("oauth2.googleapis.com/token").length;
    expect(await getAccessToken(env, db, id)).toBe(t1);
    expect(fake.callsTo("oauth2.googleapis.com/token").length).toBe(n);
    await env.DB.prepare("UPDATE google_connections SET access_expires_at = 1").run();
    const t2 = await getAccessToken(env, db, id);
    expect(t2).not.toBe(t1);
    expect(fake.callsTo("oauth2.googleapis.com/token").length).toBe(n + 1);
    expect(fake.callsTo("oauth2.googleapis.com/token").at(-1)!.body.grant_type).toBe("refresh_token");
  });

  it("marks the connection as failed when Google revokes the refresh token and tells the human how to fix it", async () => {
    const id = await connect();
    await env.DB.prepare("UPDATE google_connections SET access_expires_at = 1").run();
    fake.refreshOk = false;
    await expect(getAccessToken(env, new Db(env.DB), id)).rejects.toMatchObject({ code: "credentials_expired" });
    const row = await env.DB.prepare("SELECT status, last_error FROM google_connections").first<any>();
    expect(row.status).toBe("error");
    const diag = (await call("/api/diagnostics", { session: s })).json as any[];
    const c = diag.find((d) => d.id.startsWith("google.connection."));
    expect(c.status).toBe("fail");
    expect(c.fix).toMatch(/Production/);
  });

  it("disconnect revokes at Google, wipes the sealed token and blocks the accounts", async () => {
    const id = await connect();
    await call(`/api/accounts/${CUSTOMER}/allow`, { method: "POST", session: s, body: { allowed: true } });
    const r = await call(`/api/google/connections/${id}/disconnect`, { method: "POST", session: s });
    expect(r.json.google_revoked).toBe(true);
    expect(fake.callsTo("oauth2.googleapis.com/revoke").length).toBe(1);
    const row = await env.DB.prepare("SELECT status, refresh_sealed FROM google_connections").first<any>();
    expect(row).toEqual({ status: "revoked", refresh_sealed: "wiped" });
    expect((await env.DB.prepare("SELECT allowed FROM accounts WHERE customer_id = ?").bind(CUSTOMER).first<{ allowed: number }>())!.allowed).toBe(0);
  });
});
