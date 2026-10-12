import type { Ctx } from "../lib/context";
import { AI_SCOPES } from "../lib/context";
import { now } from "../lib/db";
import { NovaError } from "../lib/errors";
import { b64uEncode, randomId, randomToken, sha256B64u, sha256Hex, timingSafeEqual } from "../lib/crypto";
import { audit } from "../lib/audit";
import { escapeHtml, json, redirect, SECURITY_HEADERS } from "../lib/http";
import { rateLimit } from "./admin";
import { parseAccounts, tokenHash } from "./tokens";

/**
 * Minimal OAuth 2.1 authorization server for MCP hosts (Claude, ChatGPT, Gemini CLI, Cursor...).
 *  - Dynamic client registration (RFC 7591), PKCE S256 required, exact redirect_uri match
 *  - Authorization codes: single use, 5 minutes. Access tokens 1 hour. Refresh tokens 30 days, rotated on every use;
 *    replaying a used refresh token revokes the whole grant.
 *  - The human consent step is the signed-in dashboard; AI scopes are read/draft/apply only (never credentials or settings).
 */
const ACCESS_TTL = 3600;
const REFRESH_TTL = 30 * 86400;
const CODE_TTL = 300;
const PENDING_TTL = 600;
const MAX_CLIENTS = 200;

export const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id, accept",
  "access-control-expose-headers": "www-authenticate, mcp-session-id",
  "access-control-max-age": "86400",
};

const oauthJson = (data: unknown, status = 200, extra: Record<string, string> = {}) => json(data, status, { ...CORS, ...extra });
const oauthError = (error: string, description: string, status = 400) => oauthJson({ error, error_description: description }, status);

export const mcpResource = (origin: string): string => `${origin}/mcp`;

export const protectedResourceMetadata = (origin: string) => ({
  resource: mcpResource(origin),
  authorization_servers: [origin],
  scopes_supported: [...AI_SCOPES],
  bearer_methods_supported: ["header"],
  resource_name: "Nova Ads Console MCP",
});

export const authServerMetadata = (origin: string) => ({
  issuer: origin,
  authorization_endpoint: `${origin}/oauth/authorize`,
  token_endpoint: `${origin}/oauth/token`,
  registration_endpoint: `${origin}/oauth/register`,
  revocation_endpoint: `${origin}/oauth/revoke`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
  scopes_supported: [...AI_SCOPES],
});

const BAD_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "blob:", "about:"]);
const isLoopback = (u: URL) => ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);

const validRedirect = (raw: unknown): string => {
  if (typeof raw !== "string" || raw.length > 500) throw new NovaError("invalid_redirect_uri", "Invalid redirect URI.", 400);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new NovaError("invalid_redirect_uri", "Redirect URIs must be absolute URLs.", 400);
  }
  if (u.hash || BAD_SCHEMES.has(u.protocol) || u.username || u.password) throw new NovaError("invalid_redirect_uri", "Redirect URI is not allowed.", 400);
  if (u.protocol === "http:" && !isLoopback(u)) throw new NovaError("invalid_redirect_uri", "http redirect URIs are allowed only for localhost.", 400);
  return raw;
};

export const registerClient = async (ctx: Ctx, body: Record<string, unknown>): Promise<Response> => {
  try {
    await rateLimit(ctx, "register:global", 30, 3600);
  } catch (e) {
    return oauthError("temporarily_unavailable", e instanceof Error ? e.message : "rate limited", 429);
  }
  const count = (await ctx.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM oauth_clients"))?.n ?? 0;
  if (count >= MAX_CLIENTS) return oauthError("invalid_client_metadata", "Too many registered clients. The administrator must clear unused ones.", 400);
  let redirects: string[];
  try {
    const list = body.redirect_uris;
    if (!Array.isArray(list) || list.length < 1 || list.length > 5) throw new NovaError("invalid_redirect_uri", "Send 1 to 5 redirect_uris.", 400);
    redirects = list.map(validRedirect);
  } catch (e) {
    return oauthError("invalid_redirect_uri", e instanceof NovaError ? e.message : "Invalid redirect URIs.");
  }
  const method = String(body.token_endpoint_auth_method ?? "none");
  if (!["none", "client_secret_post", "client_secret_basic"].includes(method)) return oauthError("invalid_client_metadata", "Unsupported token_endpoint_auth_method.");
  const name = String(body.client_name ?? "MCP client").replace(/[\u0000-\u001f<>]/g, "").slice(0, 80) || "MCP client";
  const clientId = "nova_c_" + randomToken(16);
  const secret = method === "none" ? null : "nova_cs_" + randomToken(32);
  const t = now();
  await ctx.db.run("INSERT INTO oauth_clients (client_id, secret_hash, name, redirect_uris, auth_method, created_at) VALUES (?,?,?,?,?,?)", clientId, secret ? await sha256Hex("client-secret:" + secret) : null, name, JSON.stringify(redirects), method, t);
  await audit(ctx.db, { actor_type: "oauth", actor_id: clientId, action: "oauth_client_registered", outcome: "ok", detail: { name }, ip_hash: ctx.ipHash });
  return oauthJson(
    { client_id: clientId, ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}), client_id_issued_at: t, client_name: name, redirect_uris: redirects, token_endpoint_auth_method: method, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: AI_SCOPES.join(" ") },
    201,
  );
};

interface ClientRow {
  client_id: string;
  secret_hash: string | null;
  name: string;
  redirect_uris: string;
  auth_method: string;
}
const getClient = (ctx: Ctx, id: string) => ctx.db.first<ClientRow>("SELECT * FROM oauth_clients WHERE client_id = ?", id);

const htmlError = (title: string, message: string): Response =>
  new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><body style="font-family:system-ui;max-width:34rem;margin:3rem auto;padding:0 1rem"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`, {
    status: 400,
    headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS, "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" },
  });

const errRedirect = (redirectUri: string, error: string, description: string, state: string | null): Response => {
  const u = new URL(redirectUri);
  u.searchParams.set("error", error);
  u.searchParams.set("error_description", description);
  if (state) u.searchParams.set("state", state);
  return redirect(u.toString());
};

/** GET /oauth/authorize: validates the request and parks it until the signed-in administrator decides. */
export const authorize = async (ctx: Ctx): Promise<Response> => {
  const q = ctx.url.searchParams;
  const client = await getClient(ctx, q.get("client_id") ?? "");
  const redirectUri = q.get("redirect_uri");
  if (!client) return htmlError("Unknown application", "This application is not registered. Register it first (clients do this automatically).");
  const allowed = JSON.parse(client.redirect_uris) as string[];
  if (!redirectUri || !allowed.includes(redirectUri)) return htmlError("Redirect not allowed", "The redirect address does not match what this application registered.");
  const state = q.get("state");
  if (q.get("response_type") !== "code") return errRedirect(redirectUri, "unsupported_response_type", "Only response_type=code is supported.", state);
  const challenge = q.get("code_challenge") ?? "";
  if (q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return errRedirect(redirectUri, "invalid_request", "PKCE with code_challenge_method=S256 is required.", state);
  const resource = q.get("resource");
  if (resource && resource.replace(/\/+$/, "") !== mcpResource(ctx.origin)) return errRedirect(redirectUri, "invalid_target", "resource must be the MCP endpoint of this server.", state);
  const requested = (q.get("scope") ?? "read").split(/\s+/).filter(Boolean);
  if (!requested.length || requested.some((s) => !(AI_SCOPES as readonly string[]).includes(s))) return errRedirect(redirectUri, "invalid_scope", "Scopes allowed: read, draft, apply.", state);
  const id = randomToken(32);
  const t = now();
  await ctx.db.run("DELETE FROM oauth_pending WHERE expires_at < ?", t);
  await ctx.db.run(
    "INSERT INTO oauth_pending (id_hash, client_id, redirect_uri, state, code_challenge, scopes, resource, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?)",
    await sha256Hex("pending:" + id), client.client_id, redirectUri, state, challenge, JSON.stringify([...new Set(requested)]), resource, t, t + PENDING_TTL,
  );
  return redirect(`/#/consent/${id}`);
};

// ------------------------------------------------------------------ consent (called by the dashboard, admin session + CSRF)
export const pendingDetails = async (ctx: Ctx, id: string) => {
  const row = await ctx.db.first<{ client_id: string; redirect_uri: string; scopes: string; expires_at: number }>("SELECT * FROM oauth_pending WHERE id_hash = ?", await sha256Hex("pending:" + id));
  if (!row || row.expires_at < now()) throw new NovaError("request_expired", "This connection request expired. Start again from your AI app.", 410);
  const client = await getClient(ctx, row.client_id);
  const accounts = await ctx.db.all<{ customer_id: string; name: string | null }>("SELECT customer_id, name FROM accounts WHERE allowed = 1 ORDER BY name");
  return {
    client: { name: client?.name ?? "Unknown", id: row.client_id, redirect_host: new URL(row.redirect_uri).host || new URL(row.redirect_uri).protocol },
    requested_scopes: JSON.parse(row.scopes) as string[],
    allowed_accounts: accounts,
    expires_at: row.expires_at,
  };
};

export const decide = async (ctx: Ctx, adminId: string, id: string, body: { approve?: unknown; scopes?: unknown; accounts?: unknown }): Promise<{ redirect: string }> => {
  const key = await sha256Hex("pending:" + id);
  const row = await ctx.db.first<{ client_id: string; redirect_uri: string; state: string | null; code_challenge: string; scopes: string; resource: string | null; expires_at: number }>(
    "DELETE FROM oauth_pending WHERE id_hash = ? RETURNING *",
    key,
  );
  if (!row || row.expires_at < now()) throw new NovaError("request_expired", "This connection request expired. Start again from your AI app.", 410);
  const target = new URL(row.redirect_uri);
  if (body.approve !== true) {
    target.searchParams.set("error", "access_denied");
    if (row.state) target.searchParams.set("state", row.state);
    await audit(ctx.db, { actor_type: "admin", actor_id: adminId, action: "oauth_consent", target: row.client_id, outcome: "denied", ip_hash: ctx.ipHash });
    return { redirect: target.toString() };
  }
  const requested = JSON.parse(row.scopes) as string[];
  const chosen = Array.isArray(body.scopes) ? (body.scopes as string[]).filter((s) => requested.includes(s)) : requested;
  if (!chosen.length) throw new NovaError("invalid_scope", "Choose at least one permission.", 400);
  const accounts = parseAccounts(body.accounts ?? null);
  const code = "nova_ac_" + randomToken(32);
  await ctx.db.run(
    "INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, scopes, resource, grant_id, accounts, expires_at) VALUES (?,?,?,?,?,?,?,?,?)",
    await tokenHash(code), row.client_id, row.redirect_uri, row.code_challenge, JSON.stringify(chosen), row.resource, randomId(), accounts ? JSON.stringify(accounts) : null, now() + CODE_TTL,
  );
  target.searchParams.set("code", code);
  if (row.state) target.searchParams.set("state", row.state);
  await audit(ctx.db, { actor_type: "admin", actor_id: adminId, action: "oauth_consent", target: row.client_id, outcome: "ok", detail: { scopes: chosen }, ip_hash: ctx.ipHash });
  return { redirect: target.toString() };
};

// ------------------------------------------------------------------ token endpoint
const readForm = async (request: Request): Promise<URLSearchParams> => {
  const ct = request.headers.get("content-type") ?? "";
  if (Number(request.headers.get("content-length") ?? "0") > 20_000) throw new NovaError("invalid_request", "Request too large.", 413);
  if (ct.includes("application/x-www-form-urlencoded")) {
    const fd = await request.formData();
    return new URLSearchParams([...fd.entries()].map(([k, v]) => [k, String(v)] as [string, string]));
  }
  const text = await request.text();
  if (text.length > 20_000) throw new NovaError("invalid_request", "Request too large.", 413);
  if (ct.includes("application/json")) {
    const o = JSON.parse(text || "{}") as Record<string, unknown>;
    return new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)] as [string, string]));
  }
  return new URLSearchParams(text);
};

const authenticateClient = async (ctx: Ctx, form: URLSearchParams): Promise<ClientRow | null> => {
  let id = form.get("client_id") ?? "";
  let secret = form.get("client_secret");
  const basic = /^Basic\s+(.+)$/i.exec(ctx.request.headers.get("authorization") ?? "");
  if (basic) {
    try {
      const [u, ...rest] = atob(basic[1]!).split(":");
      id = decodeURIComponent(u ?? "");
      secret = decodeURIComponent(rest.join(":"));
    } catch {
      return null;
    }
  }
  const client = await getClient(ctx, id);
  if (!client) return null;
  if (client.auth_method === "none") return client;
  if (!secret || !client.secret_hash) return null;
  return (await timingSafeEqual(await sha256Hex("client-secret:" + secret), client.secret_hash)) ? client : null;
};

const issuePair = async (ctx: Ctx, grantId: string, clientId: string, scopes: string[], accounts: string | null, label: string) => {
  const access = "nova_at_" + randomToken(32);
  const refresh = "nova_rt_" + randomToken(32);
  const t = now();
  await ctx.db.batch([
    { sql: "INSERT INTO api_tokens (id, kind, token_hash, label, client_id, grant_id, scopes, accounts, created_at, expires_at) VALUES (?, 'oauth_access', ?, ?, ?, ?, ?, ?, ?, ?)", params: [randomId(), await tokenHash(access), label, clientId, grantId, JSON.stringify(scopes), accounts, t, t + ACCESS_TTL] },
    { sql: "INSERT INTO api_tokens (id, kind, token_hash, label, client_id, grant_id, scopes, accounts, created_at, expires_at) VALUES (?, 'oauth_refresh', ?, ?, ?, ?, ?, ?, ?, ?)", params: [randomId(), await tokenHash(refresh), label, clientId, grantId, JSON.stringify(scopes), accounts, t, t + REFRESH_TTL] },
  ]);
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: refresh, scope: scopes.join(" ") };
};

export const token = async (ctx: Ctx): Promise<Response> => {
  let form: URLSearchParams;
  try {
    form = await readForm(ctx.request);
  } catch {
    return oauthError("invalid_request", "Unreadable request body.");
  }
  try {
    await rateLimit(ctx, "token:ip:" + ctx.ipHash, 60, 300);
  } catch {
    return oauthError("temporarily_unavailable", "Too many requests.", 429);
  }
  const client = await authenticateClient(ctx, form);
  if (!client) return oauthError("invalid_client", "Client authentication failed.", 401);
  const grant = form.get("grant_type");

  if (grant === "authorization_code") {
    const code = form.get("code") ?? "";
    const verifier = form.get("code_verifier") ?? "";
    const row = await ctx.db.first<{ client_id: string; redirect_uri: string; code_challenge: string; scopes: string; grant_id: string; accounts: string | null; expires_at: number; used_at: number | null }>(
      "SELECT * FROM oauth_codes WHERE code_hash = ?",
      await tokenHash(code),
    );
    if (!row || row.client_id !== client.client_id) return oauthError("invalid_grant", "Unknown authorization code.");
    if (row.used_at) {
      // A replayed code means someone else may hold tokens from it: cancel the whole grant.
      await ctx.db.run("UPDATE api_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL", now(), row.grant_id);
      return oauthError("invalid_grant", "This authorization code was already used.");
    }
    if (row.expires_at < now()) return oauthError("invalid_grant", "The authorization code expired.");
    if (form.get("redirect_uri") !== row.redirect_uri) return oauthError("invalid_grant", "redirect_uri does not match.");
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !(await timingSafeEqual(await sha256B64u(verifier), row.code_challenge))) return oauthError("invalid_grant", "PKCE verification failed.");
    const claimed = await ctx.db.run("UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL", now(), await tokenHash(code));
    if (claimed !== 1) return oauthError("invalid_grant", "This authorization code was already used.");
    await ctx.db.run("UPDATE oauth_clients SET last_used_at = ? WHERE client_id = ?", now(), client.client_id);
    return oauthJson(await issuePair(ctx, row.grant_id, client.client_id, JSON.parse(row.scopes), row.accounts, client.name), 200, { pragma: "no-cache" });
  }

  if (grant === "refresh_token") {
    const rt = form.get("refresh_token") ?? "";
    const hash = await tokenHash(rt);
    const row = await ctx.db.first<{ id: string; client_id: string; grant_id: string; scopes: string; accounts: string | null; expires_at: number; revoked_at: number | null; used_at: number | null }>(
      "SELECT id, client_id, grant_id, scopes, accounts, expires_at, revoked_at, used_at FROM api_tokens WHERE token_hash = ? AND kind = 'oauth_refresh'",
      hash,
    );
    if (!row || row.client_id !== client.client_id || row.revoked_at || row.expires_at < now()) return oauthError("invalid_grant", "Invalid refresh token.");
    if (row.used_at) {
      await ctx.db.run("UPDATE api_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL", now(), row.grant_id);
      await audit(ctx.db, { actor_type: "oauth", actor_id: client.client_id, action: "refresh_token_reuse_detected", target: row.grant_id, outcome: "denied", ip_hash: ctx.ipHash });
      return oauthError("invalid_grant", "This refresh token was already used; the connection was revoked for safety. Connect again.");
    }
    const scopes = JSON.parse(row.scopes) as string[];
    const requested = (form.get("scope") ?? "").split(/\s+/).filter(Boolean);
    if (requested.some((s) => !scopes.includes(s))) return oauthError("invalid_scope", "A refresh cannot widen permissions.");
    const claimed = await ctx.db.run("UPDATE api_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL", now(), row.id);
    if (claimed !== 1) return oauthError("invalid_grant", "This refresh token was already used.");
    return oauthJson(await issuePair(ctx, row.grant_id, client.client_id, requested.length ? requested : scopes, row.accounts, client.name), 200, { pragma: "no-cache" });
  }
  return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
};

export const revoke = async (ctx: Ctx): Promise<Response> => {
  const form = await readForm(ctx.request).catch(() => new URLSearchParams());
  const client = await authenticateClient(ctx, form);
  if (!client) return oauthError("invalid_client", "Client authentication failed.", 401);
  const row = await ctx.db.first<{ grant_id: string | null; client_id: string | null }>("SELECT grant_id, client_id FROM api_tokens WHERE token_hash = ?", await tokenHash(form.get("token") ?? ""));
  if (row && row.client_id === client.client_id && row.grant_id) await ctx.db.run("UPDATE api_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL", now(), row.grant_id);
  return oauthJson({}, 200); // RFC 7009: always 200
};

export const purgeOAuth = async (ctx: Ctx): Promise<void> => {
  const t = now();
  await ctx.db.run("DELETE FROM oauth_pending WHERE expires_at < ?", t);
  await ctx.db.run("DELETE FROM oauth_codes WHERE expires_at < ?", t - 3600);
  await ctx.db.run("DELETE FROM api_tokens WHERE expires_at < ?", t - 7 * 86400);
  await ctx.db.run("DELETE FROM oauth_clients WHERE last_used_at IS NULL AND created_at < ?", t - 30 * 86400);
};

export { b64uEncode };
