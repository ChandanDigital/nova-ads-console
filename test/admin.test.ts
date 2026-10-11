import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { call, callWithEnv, loginWith, resetDb, setupAdmin, SETUP_SECRET, ORIGIN } from "./helpers";

beforeEach(resetDb);

describe("first-time setup", () => {
  it("reports that setup is needed, then creates the administrator with the Cloudflare-held secret", async () => {
    expect((await call("/api/state")).json.needs_setup).toBe(true);
    const s = await setupAdmin();
    expect(s.credential).toMatch(/^nodi_admin_[A-Za-z0-9_-]{40,}$/);
    expect((await call("/api/state")).json.needs_setup).toBe(false);
  });
  it("refuses a wrong setup secret", async () => {
    const r = await call("/api/auth/setup", { method: "POST", body: { setup_secret: "wrong-wrong-wrong-wrong-wrong-wrong" } });
    expect(r.status).toBe(403);
    expect((await call("/api/state")).json.needs_setup).toBe(true);
  });
  it("refuses setup when ADMIN_SETUP_SECRET is not configured", async () => {
    const r = await callWithEnv({ ADMIN_SETUP_SECRET: "" }, "/api/auth/setup", { method: "POST", body: { setup_secret: "" } });
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe("setup_secret_missing");
  });
  it("cannot be run twice", async () => {
    await setupAdmin();
    const r = await call("/api/auth/setup", { method: "POST", body: { setup_secret: SETUP_SECRET } });
    expect(r.status).toBe(409);
  });
  it("stores only a hash of the credential", async () => {
    const s = await setupAdmin();
    const row = await env.DB.prepare("SELECT credential_hash FROM admin").first<{ credential_hash: string }>();
    expect(row!.credential_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(s.credential!);
  });
});

describe("setup secret tolerance and diagnostics", () => {
  it("ignores accidental spaces or line breaks around the typed secret", async () => {
    const r = await call("/api/auth/setup", { method: "POST", body: { setup_secret: "  " + SETUP_SECRET + "\n" } });
    expect(r.status).toBe(201);
  });
  it("tolerates a secret saved in Cloudflare with a trailing newline", async () => {
    const r = await callWithEnv({ ADMIN_SETUP_SECRET: SETUP_SECRET + "\n" },"/api/auth/setup", { method: "POST", body: { setup_secret: SETUP_SECRET } });
    expect(r.status).toBe(201);
  });
  it("says whether the saved secret is shorter, longer or the same length, without revealing it", async () => {
    const shorter = await call("/api/auth/setup", { method: "POST", body: { setup_secret: SETUP_SECRET + "xyz" } });
    expect(shorter.status).toBe(403);
    expect(shorter.json.error.message).toContain("shorter than what you typed");
    const longer = await call("/api/auth/setup", { method: "POST", body: { setup_secret: "short" } });
    expect(longer.json.error.message).toContain("longer than what you typed");
    const same = await call("/api/auth/setup", { method: "POST", body: { setup_secret: SETUP_SECRET.replace(/.$/, "#") } });
    expect(same.json.error.message).toContain("the same length as what you typed");
    for (const r of [shorter, longer, same]) {
      expect(r.text).not.toContain(SETUP_SECRET);
      expect(r.text).not.toMatch(/\d{2} characters/);
    }
  });
});

describe("login, sessions and CSRF", () => {
  it("signs in with the credential and rejects others", async () => {
    const s = await setupAdmin();
    await expect(loginWith(s.credential!)).resolves.toBeTruthy();
    const bad = await call("/api/auth/login", { method: "POST", body: { credential: "nodi_admin_" + "x".repeat(43) } });
    expect(bad.status).toBe(401);
  });
  it("sets an HttpOnly, Secure, SameSite cookie", async () => {
    const r = await call("/api/auth/setup", { method: "POST", body: { setup_secret: SETUP_SECRET } });
    const c = r.headers.get("set-cookie")!;
    expect(c).toContain("__Host-nodi_session=");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Secure");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Path=/");
  });
  it("requires the CSRF header and same-origin Origin for every mutating call", async () => {
    const s = await setupAdmin();
    const noCsrf = await call("/api/settings/global-stop", { method: "POST", body: { stop: true }, session: { ...s, csrf: "wrong" } });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.json.error.code).toBe("csrf_failed");
    const evil = await call("/api/settings/global-stop", { method: "POST", body: { stop: true }, session: s, origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    expect(evil.json.error.code).toBe("origin_denied");
    const none = await call("/api/settings/global-stop", { method: "POST", body: { stop: true }, session: s, origin: null });
    expect(none.status).toBe(403);
    const ok = await call("/api/settings/global-stop", { method: "POST", body: { stop: true }, session: s });
    expect(ok.status).toBe(200);
  });
  it("rate-limits repeated bad credentials", async () => {
    await setupAdmin();
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await call("/api/auth/login", { method: "POST", body: { credential: "nodi_admin_" + String(i).padStart(43, "y") } })).status;
    expect(last).toBe(429);
  });
  it("logout ends the session", async () => {
    const s = await setupAdmin();
    expect((await call("/api/overview", { session: s })).status).toBe(200);
    await call("/api/auth/logout", { method: "POST", session: s });
    expect((await call("/api/overview", { session: s })).status).toBe(401);
  });
  it("AI/OAuth bearer tokens never work as a dashboard credential", async () => {
    const s = await setupAdmin();
    const t = await call("/api/tokens", { method: "POST", session: s, body: { label: "x", scopes: ["read"], days: 1 } });
    const bad = await call("/api/auth/login", { method: "POST", body: { credential: t.json.token } });
    expect(bad.status).toBe(401);
    const viaHeader = await call("/api/overview", { headers: { authorization: "Bearer " + t.json.token } });
    expect(viaHeader.status).toBe(403); // dashboard routes refuse bearer tokens outright
  });
});

describe("credential replacement when the original is lost", () => {
  const NEW_SECRET = "second-setup-secret-abcdefghijklmnopqrstuvwxyz";
  const recover = (secret: string, extra: Record<string, unknown> = {}) =>
    callWithEnv({ ADMIN_SETUP_SECRET: secret }, "/api/auth/recover", { method: "POST", body: { setup_secret: secret, confirmation: "REPLACE CREDENTIAL", ...extra } });

  it("a used setup secret cannot be used again until the owner rotates it in Cloudflare", async () => {
    await setupAdmin();
    const r = await call("/api/auth/recover", { method: "POST", body: { setup_secret: SETUP_SECRET, confirmation: "REPLACE CREDENTIAL" } });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("setup_secret_used");
  });
  it("replaces the credential: the old one stops working, sessions end, the new one works", async () => {
    const first = await setupAdmin();
    const rec = await recover(NEW_SECRET);
    expect(rec.status).toBe(200);
    const fresh = rec.json.credential as string;
    expect(fresh).not.toBe(first.credential);
    expect((await call("/api/overview", { session: first })).status).toBe(401);
    expect((await call("/api/auth/login", { method: "POST", body: { credential: first.credential } })).status).toBe(401);
    await expect(loginWith(fresh)).resolves.toBeTruthy();
  });
  it("the new secret value is also single-use", async () => {
    await setupAdmin();
    expect((await recover(NEW_SECRET)).status).toBe(200);
    expect((await recover(NEW_SECRET)).status).toBe(409);
  });
  it("needs the typed confirmation", async () => {
    await setupAdmin();
    const r = await callWithEnv({ ADMIN_SETUP_SECRET: NEW_SECRET }, "/api/auth/recover", { method: "POST", body: { setup_secret: NEW_SECRET } });
    expect(r.status).toBe(400);
  });
  it("revokes AI tokens by default and keeps plans and approvals", async () => {
    const s = await setupAdmin();
    await call("/api/tokens", { method: "POST", session: s, body: { label: "ai", scopes: ["read"], days: 1 } });
    await env.DB.prepare("INSERT INTO plans (id,account_id,status,hash,plan_json,created_by,created_at,expires_at,updated_at) VALUES ('p1','3010086756','awaiting_approval','h','{}','x',1,9999999999,1)").run();
    await env.DB.prepare("INSERT INTO approvals (plan_id,plan_hash,admin_id,permissions,approved_at,expires_at) VALUES ('p1','h','primary','[]',1,9999999999)").run();
    await recover(NEW_SECRET);
    const tok = await env.DB.prepare("SELECT revoked_at FROM api_tokens").first<{ revoked_at: number | null }>();
    expect(tok!.revoked_at).not.toBeNull();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM plans").first<{ n: number }>())!.n).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM approvals").first<{ n: number }>())!.n).toBe(1);
  });
  it("is unreachable with an AI bearer token", async () => {
    const s = await setupAdmin();
    const t = await call("/api/tokens", { method: "POST", session: s, body: { label: "ai", scopes: ["read", "draft", "apply"], days: 1 } });
    const r = await callWithEnv({ ADMIN_SETUP_SECRET: NEW_SECRET }, "/api/auth/recover", { method: "POST", body: { setup_secret: NEW_SECRET, confirmation: "REPLACE CREDENTIAL" }, headers: { authorization: "Bearer " + t.json.token } });
    expect(r.status).toBe(403);
  });
  it("rate-limits guessing of the setup secret", async () => {
    await setupAdmin();
    let last = 0;
    for (let i = 0; i < 8; i++) last = (await call("/api/auth/recover", { method: "POST", body: { setup_secret: "guess-" + i + "-".repeat(30), confirmation: "REPLACE CREDENTIAL" } })).status;
    expect(last).toBe(429);
  });
  it("signed-in rotation needs the current credential", async () => {
    const s = await setupAdmin();
    const bad = await call("/api/auth/rotate", { method: "POST", session: s, body: { credential: "nodi_admin_" + "z".repeat(43) } });
    expect(bad.status).toBe(401);
    const ok = await call("/api/auth/rotate", { method: "POST", session: s, body: { credential: s.credential } });
    expect(ok.status).toBe(200);
    expect(ok.json.credential).not.toBe(s.credential);
  });
});

it("exposes the public origin", async () => {
  expect((await call("/api/state")).json.origin).toBe(ORIGIN);
});
