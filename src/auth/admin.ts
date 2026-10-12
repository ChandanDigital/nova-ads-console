import type { Ctx } from "../lib/context";
import { now } from "../lib/db";
import { audit } from "../lib/audit";
import { NodiError } from "../lib/errors";
import { randomToken, sha256Hex, timingSafeEqual } from "../lib/crypto";
import { parseCookies, sessionCookieName, sessionSetCookie, uaHash } from "../lib/http";

const SESSION_TTL = 8 * 3600;
const SESSION_IDLE = 2 * 3600;
const ADMIN_ID = "primary";
export const CREDENTIAL_PREFIX = "nova_admin_";

export interface AdminSession {
  adminId: string;
  csrf: string;
  sessionHash: string;
}

// ------------------------------------------------------------------ rate limiting (D1-backed)
/** Counts an attempt; throws 429 when more than `max` attempts happened within `windowSec`. */
export const rateLimit = async (ctx: Ctx, key: string, max: number, windowSec: number): Promise<void> => {
  const t = now();
  const row = await ctx.db.first<{ window_start: number; count: number }>("SELECT window_start, count FROM rate_limits WHERE key = ?", key);
  if (!row || t - row.window_start >= windowSec) {
    await ctx.db.run(
      "INSERT INTO rate_limits (key, window_start, count) VALUES (?,?,1) ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, count = 1",
      key,
      t,
    );
    return;
  }
  if (row.count >= max) {
    throw new NodiError("rate_limited", `Too many attempts. Try again in ${Math.max(1, windowSec - (t - row.window_start))} seconds.`, 429);
  }
  await ctx.db.run("UPDATE rate_limits SET count = count + 1 WHERE key = ?", key);
};

// ------------------------------------------------------------------ credential helpers
export const newCredential = (): string => CREDENTIAL_PREFIX + randomToken(32);
export const hashCredential = (credential: string): Promise<string> => sha256Hex("admin-credential:" + credential);

export const adminExists = async (ctx: Ctx): Promise<boolean> =>
  !!(await ctx.db.first("SELECT id FROM admin WHERE status = 'active' LIMIT 1"));

// ------------------------------------------------------------------ sessions
const createSession = async (ctx: Ctx, adminId: string): Promise<{ cookie: string; csrf: string }> => {
  const id = randomToken(32);
  const csrf = randomToken(24);
  const t = now();
  await ctx.db.run(
    "INSERT INTO sessions (id_hash, admin_id, csrf, created_at, expires_at, last_seen_at, ip_hash, ua_hash) VALUES (?,?,?,?,?,?,?,?)",
    await sha256Hex("session:" + id),
    adminId,
    csrf,
    t,
    t + SESSION_TTL,
    t,
    ctx.ipHash,
    await uaHash(ctx.request),
  );
  return { cookie: sessionSetCookie(ctx.origin, id, SESSION_TTL), csrf };
};

export const clearSessionCookie = (origin: string): string => sessionSetCookie(origin, "", 0);

export const sessionIdFromRequest = (ctx: Ctx): string | null => parseCookies(ctx.request.headers.get("cookie"))[sessionCookieName(ctx.origin)] ?? null;

/** Returns the session or null. Never throws for a missing or expired session. */
export const readSession = async (ctx: Ctx): Promise<AdminSession | null> => {
  const id = sessionIdFromRequest(ctx);
  if (!id) return null;
  const hash = await sha256Hex("session:" + id);
  const row = await ctx.db.first<{ admin_id: string; csrf: string; expires_at: number; last_seen_at: number }>(
    "SELECT s.admin_id, s.csrf, s.expires_at, s.last_seen_at FROM sessions s JOIN admin a ON a.id = s.admin_id WHERE s.id_hash = ? AND a.status = 'active'",
    hash,
  );
  const t = now();
  if (!row || row.expires_at <= t || row.last_seen_at < t - SESSION_IDLE) return null;
  if (t - row.last_seen_at > 300) ctx.exec.waitUntil(ctx.db.run("UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?", t, hash).then(() => undefined));
  return { adminId: row.admin_id, csrf: row.csrf, sessionHash: hash };
};

/**
 * Gate for every dashboard API route that touches accounts or settings.
 * Mutating methods additionally need the CSRF header and a same-origin Origin header.
 */
export const requireAdmin = async (ctx: Ctx): Promise<AdminSession> => {
  // An MCP/OAuth bearer token is never accepted on dashboard routes.
  if (ctx.request.headers.get("authorization")) {
    throw new NodiError("forbidden", "Dashboard routes accept a signed-in browser session only.", 403);
  }
  const s = await readSession(ctx);
  if (!s) throw new NodiError("unauthenticated", "Sign in first.", 401);
  const method = ctx.request.method;
  if (method !== "GET" && method !== "HEAD") {
    assertSameOrigin(ctx);
    const header = ctx.request.headers.get("x-csrf-token") ?? "";
    if (!(await timingSafeEqual(header, s.csrf))) throw new NodiError("csrf_failed", "Missing or wrong CSRF token. Reload the page.", 403);
  }
  return s;
};

export const assertSameOrigin = (ctx: Ctx): void => {
  const origin = ctx.request.headers.get("origin");
  if (origin !== ctx.origin) throw new NodiError("origin_denied", "Request origin does not match this dashboard.", 403);
};

// ------------------------------------------------------------------ setup / login / recovery
const requireSetupSecretConfigured = (secret: string | undefined): string => {
  if (!secret || secret.length < 24) {
    throw new NodiError(
      "setup_secret_missing",
      "ADMIN_SETUP_SECRET is not set (or shorter than 24 characters). Add it in Cloudflare: Workers > nova-ads-console > Settings > Variables and Secrets.",
      503,
    );
  }
  return secret;
};

/**
 * Verifies the Cloudflare-held setup/recovery secret. A given secret VALUE works once: its digest is recorded,
 * so using it again (setup, recovery or replay) requires the account owner to set a fresh value in Cloudflare.
 * The secret never exists in D1 and no MCP tool or OAuth scope reaches this code path.
 */
const verifySetupSecret = async (ctx: Ctx, provided: unknown): Promise<string> => {
  if (ctx.request.headers.get("authorization")) throw new NodiError("forbidden", "Recovery is not available to token holders.", 403);
  await rateLimit(ctx, "setup:ip:" + ctx.ipHash, 5, 900);
  await rateLimit(ctx, "setup:global", 20, 900);
  const configured = requireSetupSecretConfigured(ctx.env.ADMIN_SETUP_SECRET).trim(); const typed = typeof provided === "string" ? provided.trim() : "";
  if (!(await timingSafeEqual(typed, configured))) {
    await audit(ctx.db, { actor_type: "anonymous", action: "setup_secret_rejected", outcome: "denied", ip_hash: ctx.ipHash });
    // Length hint only (never the value) so a mistyped or stale Cloudflare secret can be diagnosed without exposing it.
    throw new NodiError("invalid_setup_secret", `That setup secret is not correct (the secret saved in Cloudflare is ${configured.length === typed.length ? "the same length as" : configured.length > typed.length ? "longer than" : "shorter than"} what you typed).`, 403);
  }
  const digest = await sha256Hex("setup-secret:" + configured);
  if (await ctx.db.first("SELECT digest FROM used_setup_secrets WHERE digest = ?", digest)) {
    throw new NodiError(
      "setup_secret_used",
      "This setup secret was already used. For safety each value works once: change ADMIN_SETUP_SECRET to a new random value in Cloudflare (Settings > Variables and Secrets), wait for it to apply, then try again.",
      409,
    );
  }
  return digest;
};

export interface IssueResult {
  credential: string;
  cookie: string;
  csrf: string;
}

const replaceAdminCredential = async (
  ctx: Ctx,
  digest: string | null,
  purpose: "setup" | "recovery" | "rotation",
  revokeAiTokens: boolean,
): Promise<IssueResult> => {
  const credential = newCredential();
  const hash = await hashCredential(credential);
  const t = now();
  const stmts: { sql: string; params?: unknown[] }[] = [];
  if (digest) stmts.push({ sql: "INSERT INTO used_setup_secrets (digest, used_at, purpose) VALUES (?,?,?)", params: [digest, t, purpose] });
  stmts.push({
    sql: "INSERT INTO admin (id, label, credential_hash, status, created_at, rotated_at) VALUES (?, 'owner', ?, 'active', ?, ?) ON CONFLICT(id) DO UPDATE SET credential_hash = excluded.credential_hash, status = 'active', rotated_at = excluded.rotated_at",
    params: [ADMIN_ID, hash, t, t],
  });
  // Every browser session signed in with the old credential ends now.
  stmts.push({ sql: "DELETE FROM sessions WHERE admin_id = ?", params: [ADMIN_ID] });
  if (revokeAiTokens) stmts.push({ sql: "UPDATE api_tokens SET revoked_at = ? WHERE revoked_at IS NULL", params: [t] });
  await ctx.db.batch(stmts);
  const session = await createSession(ctx, ADMIN_ID);
  return { credential, ...session };
};

export const setupFirstAdmin = async (ctx: Ctx, body: { setup_secret?: unknown }): Promise<IssueResult> => {
  if (await adminExists(ctx)) throw new NodiError("already_set_up", "An administrator already exists. Use sign-in, or the recovery option if the credential is lost.", 409);
  const digest = await verifySetupSecret(ctx, body.setup_secret);
  const r = await replaceAdminCredential(ctx, digest, "setup", false);
  await audit(ctx.db, { actor_type: "admin", actor_id: ADMIN_ID, action: "admin_setup", outcome: "ok", ip_hash: ctx.ipHash });
  return r;
};

/** Administrator-controlled replacement of a lost credential. Old hash is overwritten, never reversed. */
export const recoverAdmin = async (ctx: Ctx, body: { setup_secret?: unknown; revoke_ai_tokens?: unknown; confirmation?: unknown }): Promise<IssueResult> => {
  if (body.confirmation !== "REPLACE CREDENTIAL") throw new NodiError("needs_confirmation", "Type REPLACE CREDENTIAL to confirm.", 400);
  const digest = await verifySetupSecret(ctx, body.setup_secret);
  const revoke = body.revoke_ai_tokens !== false;
  const r = await replaceAdminCredential(ctx, digest, "recovery", revoke);
  await audit(ctx.db, { actor_type: "admin", actor_id: ADMIN_ID, action: "admin_credential_recovered", outcome: "ok", detail: { ai_tokens_revoked: revoke }, ip_hash: ctx.ipHash });
  return r;
};

export const login = async (ctx: Ctx, body: { credential?: unknown }): Promise<{ cookie: string; csrf: string }> => {
  if (ctx.request.headers.get("authorization")) throw new NodiError("forbidden", "Sign in from the browser; bearer tokens cannot sign in.", 403);
  await rateLimit(ctx, "login:ip:" + ctx.ipHash, 8, 900);
  await rateLimit(ctx, "login:global", 60, 900);
  const credential = typeof body.credential === "string" ? body.credential.trim() : "";
  // AI/OAuth tokens must never sign into the human dashboard.
  if (!credential.startsWith(CREDENTIAL_PREFIX)) {
    await audit(ctx.db, { actor_type: "anonymous", action: "login", outcome: "denied", ip_hash: ctx.ipHash });
    throw new NodiError("invalid_credential", "That credential is not correct.", 401);
  }
  const hash = await hashCredential(credential);
  const row = await ctx.db.first<{ id: string }>("SELECT id FROM admin WHERE credential_hash = ? AND status = 'active'", hash);
  if (!row) {
    await audit(ctx.db, { actor_type: "anonymous", action: "login", outcome: "denied", ip_hash: ctx.ipHash });
    throw new NodiError("invalid_credential", "That credential is not correct.", 401);
  }
  const session = await createSession(ctx, row.id);
  await ctx.db.run("UPDATE admin SET last_login_at = ? WHERE id = ?", now(), row.id);
  await audit(ctx.db, { actor_type: "admin", actor_id: row.id, action: "login", outcome: "ok", ip_hash: ctx.ipHash });
  return session;
};

export const logout = async (ctx: Ctx, s: AdminSession): Promise<void> => {
  await ctx.db.run("DELETE FROM sessions WHERE id_hash = ?", s.sessionHash);
  await audit(ctx.db, { actor_type: "admin", actor_id: s.adminId, action: "logout", outcome: "ok", ip_hash: ctx.ipHash });
};

/** Signed-in rotation: needs the current credential again, so a stolen session alone cannot lock the owner out. */
export const rotateCredential = async (ctx: Ctx, s: AdminSession, body: { credential?: unknown }): Promise<IssueResult> => {
  await rateLimit(ctx, "rotate:ip:" + ctx.ipHash, 5, 900);
  const credential = typeof body.credential === "string" ? body.credential.trim() : "";
  const row = await ctx.db.first<{ id: string }>("SELECT id FROM admin WHERE id = ? AND credential_hash = ?", s.adminId, await hashCredential(credential));
  if (!row) throw new NodiError("invalid_credential", "The current credential is not correct.", 401);
  const r = await replaceAdminCredential(ctx, null, "rotation", false);
  await audit(ctx.db, { actor_type: "admin", actor_id: s.adminId, action: "admin_credential_rotated", outcome: "ok", ip_hash: ctx.ipHash });
  return r;
};

export const purgeExpiredSessions = (ctx: Ctx) => ctx.db.run("DELETE FROM sessions WHERE expires_at < ?", now());
