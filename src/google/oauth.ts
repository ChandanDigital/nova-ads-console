import type { Env } from "../env";
import type { Ctx } from "../lib/context";
import type { Db } from "../lib/db";
import { now } from "../lib/db";
import { NodiError } from "../lib/errors";
import { b64uDecode, decryptText, encryptText, randomId, randomToken, sha256B64u, sha256Hex } from "../lib/crypto";
import { audit } from "../lib/audit";
import { sessionIdFromRequest } from "../auth/admin";

export const ADS_SCOPE = "https://www.googleapis.com/auth/adwords";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_CALLBACK_PATH = "/oauth/google/callback";

const need = (env: Env) => {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new NodiError(
      "google_oauth_not_configured",
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set. Create a Web OAuth client in Google Cloud and add both as Cloudflare secrets.",
      503,
    );
  }
};

export const googleRedirectUri = (origin: string): string => origin + GOOGLE_CALLBACK_PATH;

const timeout = () => AbortSignal.timeout(25_000);

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

const postForm = async (url: string, form: Record<string, string>): Promise<{ status: number; body: TokenResponse }> => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    signal: timeout(),
  });
  let body: TokenResponse = {};
  try {
    body = (await res.json()) as TokenResponse;
  } catch {
    /* non-JSON error body */
  }
  return { status: res.status, body };
};

/** Step 1: build the Google consent URL. The PKCE verifier is sealed in D1; the browser only gets `state`. */
export const startGoogleConnect = async (ctx: Ctx): Promise<string> => {
  need(ctx.env);
  const sessionId = sessionIdFromRequest(ctx);
  if (!sessionId) throw new NodiError("unauthenticated", "Sign in first.", 401);
  const state = randomToken(32);
  const verifier = randomToken(48);
  const t = now();
  await ctx.db.run("DELETE FROM google_oauth_states WHERE expires_at < ?", t);
  await ctx.db.run(
    "INSERT INTO google_oauth_states (state_hash, session_hash, verifier_sealed, created_at, expires_at) VALUES (?,?,?,?,?)",
    await sha256Hex("gstate:" + state),
    await sha256Hex("session:" + sessionId),
    await encryptText(ctx.env, verifier, "gstate:" + state),
    t,
    t + 600,
  );
  const params = new URLSearchParams({
    client_id: ctx.env.GOOGLE_CLIENT_ID,
    redirect_uri: googleRedirectUri(ctx.origin),
    response_type: "code",
    scope: `openid email ${ADS_SCOPE}`,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state,
    code_challenge: await sha256B64u(verifier),
    code_challenge_method: "S256",
  });
  return `${AUTH_URL}?${params}`;
};

const parseIdToken = (idToken: string | undefined): { sub?: string; email?: string } => {
  // Received straight from Google's token endpoint over TLS, used only to label the connection.
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64uDecode(idToken!.split(".")[1]!)));
    return { sub: typeof payload.sub === "string" ? payload.sub : undefined, email: typeof payload.email === "string" ? payload.email : undefined };
  } catch {
    return {};
  }
};

/** Step 2: Google redirects back here. State must exist, be unexpired, single-use and bound to this browser session. */
export const finishGoogleConnect = async (ctx: Ctx, state: string, code: string): Promise<{ id: string; email?: string }> => {
  need(ctx.env);
  const sessionId = sessionIdFromRequest(ctx);
  if (!sessionId) throw new NodiError("unauthenticated", "Sign in to the dashboard first, then connect Google again.", 401);
  const row = await ctx.db.first<{ session_hash: string; verifier_sealed: string; expires_at: number }>(
    "DELETE FROM google_oauth_states WHERE state_hash = ? RETURNING session_hash, verifier_sealed, expires_at",
    await sha256Hex("gstate:" + state),
  );
  if (!row || row.expires_at < now() || row.session_hash !== (await sha256Hex("session:" + sessionId))) {
    throw new NodiError("invalid_oauth_state", "The Google sign-in expired or came from another browser session. Start it again from the dashboard.", 400);
  }
  const verifier = await decryptText(ctx.env, row.verifier_sealed, "gstate:" + state);
  const { status, body } = await postForm(TOKEN_URL, {
    code,
    client_id: ctx.env.GOOGLE_CLIENT_ID,
    client_secret: ctx.env.GOOGLE_CLIENT_SECRET,
    redirect_uri: googleRedirectUri(ctx.origin),
    grant_type: "authorization_code",
    code_verifier: verifier,
  });
  if (status !== 200 || !body.access_token) {
    await audit(ctx.db, { actor_type: "admin", action: "google_connect", outcome: "error", detail: { status, error: body.error }, ip_hash: ctx.ipHash });
    throw new NodiError("google_exchange_failed", `Google refused the sign-in (${body.error ?? status}). Check the OAuth client, redirect URI and consent screen.`, 502);
  }
  if (!body.refresh_token) {
    throw new NodiError(
      "missing_refresh_token",
      "Google did not issue a refresh token. Remove this app at myaccount.google.com/permissions and connect again.",
      400,
    );
  }
  const scopes = (body.scope ?? "").split(" ").filter(Boolean);
  if (!scopes.includes(ADS_SCOPE)) {
    throw new NodiError("missing_ads_scope", "Google Ads permission was not granted. Tick the Google Ads checkbox on the consent screen.", 400);
  }
  const who = parseIdToken(body.id_token);
  const t = now();
  const existing = who.sub ? await ctx.db.first<{ id: string }>("SELECT id FROM google_connections WHERE google_sub = ?", who.sub) : null;
  const id = existing?.id ?? randomId();
  const refreshSealed = await encryptText(ctx.env, body.refresh_token, "gconn:" + id + ":refresh");
  const accessSealed = await encryptText(ctx.env, body.access_token, "gconn:" + id + ":access");
  await ctx.db.run(
    `INSERT INTO google_connections (id, google_sub, email, refresh_sealed, access_sealed, access_expires_at, scopes, status, created_at, last_refresh_at, last_ok_at)
     VALUES (?,?,?,?,?,?,?, 'active', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET refresh_sealed = excluded.refresh_sealed, access_sealed = excluded.access_sealed, access_expires_at = excluded.access_expires_at,
       scopes = excluded.scopes, status = 'active', last_error = NULL, email = excluded.email, last_refresh_at = excluded.last_refresh_at`,
    id,
    who.sub ?? null,
    who.email ?? null,
    refreshSealed,
    accessSealed,
    t + (body.expires_in ?? 3600),
    JSON.stringify(scopes),
    t,
    t,
    t,
  );
  await audit(ctx.db, { actor_type: "admin", action: "google_connect", target: id, outcome: "ok", detail: { email: who.email }, ip_hash: ctx.ipHash });
  return { id, email: who.email };
};

interface ConnRow {
  id: string;
  refresh_sealed: string;
  access_sealed: string | null;
  access_expires_at: number | null;
  status: string;
}

/** Returns a valid Google access token, refreshing (and re-sealing) when needed. */
export const getAccessToken = async (env: Env, db: Db, connectionId: string): Promise<string> => {
  need(env);
  const c = await db.first<ConnRow>(
    "SELECT id, refresh_sealed, access_sealed, access_expires_at, status FROM google_connections WHERE id = ?",
    connectionId,
  );
  if (!c) throw new NodiError("not_connected", "This Google connection no longer exists. Connect Google in the dashboard.", 409);
  if (c.status === "revoked") throw new NodiError("connection_revoked", "This Google connection was disconnected.", 409);
  const t = now();
  if (c.status === "active" && c.access_sealed && (c.access_expires_at ?? 0) > t + 60) {
    return decryptText(env, c.access_sealed, "gconn:" + c.id + ":access");
  }
  const refreshToken = await decryptText(env, c.refresh_sealed, "gconn:" + c.id + ":refresh");
  const { status, body } = await postForm(TOKEN_URL, {
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  if (status !== 200 || !body.access_token) {
    const reason = body.error ?? String(status);
    const fatal = reason === "invalid_grant" || reason === "invalid_client" || reason === "unauthorized_client";
    await db.run("UPDATE google_connections SET status = ?, last_error = ? WHERE id = ?", fatal ? "error" : c.status, `refresh_failed:${reason}`, c.id);
    throw new NodiError(
      fatal ? "credentials_expired" : "google_token_unavailable",
      fatal
        ? "Google rejected the stored refresh token (it was revoked, or the OAuth consent screen is still in Testing mode, which expires tokens after 7 days). Reconnect Google in the dashboard."
        : "Google's token service did not answer correctly. Try again shortly.",
      fatal ? 401 : 502,
      { google_error: reason },
    );
  }
  const expires = t + (body.expires_in ?? 3600);
  await db.run(
    "UPDATE google_connections SET access_sealed = ?, access_expires_at = ?, last_refresh_at = ?, status = 'active', last_error = NULL WHERE id = ?",
    await encryptText(env, body.access_token, "gconn:" + c.id + ":access"),
    expires,
    t,
    c.id,
  );
  return body.access_token;
};

/** Revokes the grant at Google and marks the connection revoked (the sealed tokens are wiped). */
export const disconnectGoogle = async (ctx: Ctx, id: string): Promise<{ google_revoked: boolean }> => {
  const c = await ctx.db.first<ConnRow>("SELECT id, refresh_sealed, access_sealed, access_expires_at, status FROM google_connections WHERE id = ?", id);
  if (!c) throw new NodiError("not_found", "No such Google connection.", 404);
  let revoked = false;
  try {
    const token = await decryptText(ctx.env, c.refresh_sealed, "gconn:" + c.id + ":refresh");
    const res = await fetch(REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
      signal: timeout(),
    });
    revoked = res.status === 200 || res.status === 400; // 400 = already invalid
  } catch {
    revoked = false;
  }
  await ctx.db.run("UPDATE google_connections SET status = 'revoked', refresh_sealed = 'wiped', access_sealed = NULL, access_expires_at = NULL WHERE id = ?", id);
  await ctx.db.run("UPDATE accounts SET allowed = 0 WHERE connection_id = ?", id);
  await audit(ctx.db, { actor_type: "admin", action: "google_disconnect", target: id, outcome: revoked ? "ok" : "error", detail: { google_revoked: revoked }, ip_hash: ctx.ipHash });
  return { google_revoked: revoked };
};
