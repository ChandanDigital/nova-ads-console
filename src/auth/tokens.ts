import type { Ctx, Principal } from "../lib/context";
import { AI_SCOPES } from "../lib/context";
import { now } from "../lib/db";
import { NodiError } from "../lib/errors";
import { randomId, randomToken, sha256Hex } from "../lib/crypto";
import { audit } from "../lib/audit";
import { customerId } from "../google/gaql";

export const tokenHash = (token: string): Promise<string> => sha256Hex("bearer:" + token);

export interface TokenInfo {
  id: string;
  kind: string;
  label: string;
  scopes: string[];
  accounts: string[] | null;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
  client_id: string | null;
  grant_id: string | null;
}

const parseScopes = (input: unknown): string[] => {
  const scopes = Array.isArray(input) ? input.map(String) : String(input ?? "read").split(/[\s,]+/).filter(Boolean);
  if (!scopes.length || scopes.some((s) => !(AI_SCOPES as readonly string[]).includes(s))) {
    throw new NodiError("invalid_scope", "AI tokens may hold only read, draft and apply. No token can approve plans or manage credentials.", 400);
  }
  return [...new Set(scopes)];
};

export const parseAccounts = (input: unknown): string[] | null => {
  if (input === null || input === undefined) return null;
  if (!Array.isArray(input)) throw new NodiError("invalid_input", "accounts must be a list of customer IDs.", 400);
  return [...new Set(input.map(customerId))];
};

/** Issues a manually created API token (for hosts that accept a pasted Authorization header, e.g. Claude Code). Shown once. */
export const issueApiToken = async (ctx: Ctx, adminId: string, input: { label?: unknown; scopes?: unknown; accounts?: unknown; days?: unknown }) => {
  const label = String(input.label ?? "").trim().slice(0, 60);
  if (!label) throw new NodiError("invalid_input", "Give the token a label.", 400);
  const scopes = parseScopes(input.scopes);
  const days = Number(input.days ?? 30);
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new NodiError("invalid_expiry", "Choose 1 to 365 days.", 400);
  const accounts = parseAccounts(input.accounts);
  const token = "nova_api_" + randomToken(32);
  const id = randomId();
  const t = now();
  await ctx.db.run(
    "INSERT INTO api_tokens (id, kind, token_hash, label, scopes, accounts, created_at, expires_at) VALUES (?, 'api', ?, ?, ?, ?, ?, ?)",
    id, await tokenHash(token), label, JSON.stringify(scopes), accounts ? JSON.stringify(accounts) : null, t, t + days * 86400,
  );
  await audit(ctx.db, { actor_type: "admin", actor_id: adminId, action: "token_issued", target: id, outcome: "ok", detail: { label, scopes, days }, ip_hash: ctx.ipHash });
  return { id, token, scopes, accounts, expires_at: t + days * 86400 };
};

export const listTokens = async (ctx: Ctx): Promise<TokenInfo[]> => {
  const rows = await ctx.db.all<Omit<TokenInfo, "scopes" | "accounts"> & { scopes: string; accounts: string | null }>(
    "SELECT id, kind, label, scopes, accounts, created_at, expires_at, revoked_at, last_used_at, client_id, grant_id FROM api_tokens WHERE kind IN ('api','oauth_access') AND (revoked_at IS NULL OR revoked_at > ?) ORDER BY created_at DESC LIMIT 200",
    now() - 7 * 86400,
  );
  return rows.map((r) => ({ ...r, scopes: JSON.parse(r.scopes), accounts: r.accounts ? JSON.parse(r.accounts) : null }));
};

export const revokeToken = async (ctx: Ctx, adminId: string, id: string): Promise<{ revoked: number }> => {
  const row = await ctx.db.first<{ grant_id: string | null }>("SELECT grant_id FROM api_tokens WHERE id = ?", id);
  if (!row) throw new NodiError("not_found", "No such token.", 404);
  const t = now();
  const n = row.grant_id
    ? await ctx.db.run("UPDATE api_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL", t, row.grant_id)
    : await ctx.db.run("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", t, id);
  await audit(ctx.db, { actor_type: "admin", actor_id: adminId, action: "token_revoked", target: id, outcome: "ok", ip_hash: ctx.ipHash });
  return { revoked: n };
};

export const revokeAllTokens = async (ctx: Ctx, adminId: string): Promise<{ revoked: number }> => {
  const n = await ctx.db.run("UPDATE api_tokens SET revoked_at = ? WHERE revoked_at IS NULL", now());
  await audit(ctx.db, { actor_type: "admin", actor_id: adminId, action: "tokens_revoked_all", outcome: "ok", detail: { count: n }, ip_hash: ctx.ipHash });
  return { revoked: n };
};

/** Resolves an `Authorization: Bearer` header to an AI principal. Returns null for anything invalid, expired or revoked. */
export const authenticateBearer = async (ctx: Ctx): Promise<Principal | null> => {
  const header = ctx.request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+([A-Za-z0-9._~+/=-]{20,300})$/.exec(header);
  if (!m) return null;
  const token = m[1]!;
  if (token.startsWith("nova_admin_")) return null; // the human credential never works as an AI token
  const row = await ctx.db.first<{ id: string; kind: string; label: string; scopes: string; accounts: string | null; expires_at: number; revoked_at: number | null; last_used_at: number | null }>(
    "SELECT id, kind, label, scopes, accounts, expires_at, revoked_at, last_used_at FROM api_tokens WHERE token_hash = ? AND kind IN ('api','oauth_access')",
    await tokenHash(token),
  );
  const t = now();
  if (!row || row.revoked_at || row.expires_at <= t) return null;
  if ((row.last_used_at ?? 0) < t - 600) ctx.exec.waitUntil(ctx.db.run("UPDATE api_tokens SET last_used_at = ? WHERE id = ?", t, row.id).then(() => undefined));
  return {
    kind: row.kind === "api" ? "api" : "oauth",
    id: row.id,
    label: row.label,
    scopes: JSON.parse(row.scopes),
    accounts: row.accounts ? JSON.parse(row.accounts) : null,
  };
};
