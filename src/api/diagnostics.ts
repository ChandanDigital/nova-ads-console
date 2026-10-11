import type { Ctx } from "../lib/context";
import { encryptionKeyProblem } from "../lib/crypto";
import { now } from "../lib/db";
import { MIGRATIONS } from "../lib/schema";
import { googleRedirectUri, getAccessToken } from "../google/oauth";
import { adsVersion } from "../env";

export interface Check {
  id: string;
  status: "ok" | "warn" | "fail" | "info";
  title: string;
  detail: string;
  fix?: string;
}

/** Self-check shown on the dashboard. Never prints secret values, only whether they are usable. */
export const runDiagnostics = async (ctx: Ctx, deep = false): Promise<Check[]> => {
  const { env } = ctx;
  const out: Check[] = [];
  const add = (c: Check) => out.push(c);

  const keyProblem = await encryptionKeyProblem(env);
  add(keyProblem
    ? { id: "secret.encryption_key", status: "fail", title: "TOKEN_ENCRYPTION_KEY", detail: keyProblem, fix: "Create 32 random bytes encoded as base64 (see the setup guide) and save them as the secret TOKEN_ENCRYPTION_KEY." }
    : { id: "secret.encryption_key", status: "ok", title: "TOKEN_ENCRYPTION_KEY", detail: "Present and valid (32 bytes). Google refresh tokens are sealed with AES-256-GCM." });

  add(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
    ? { id: "secret.google_client", status: "ok", title: "Google OAuth client", detail: "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set (the secret never leaves the Worker)." }
    : { id: "secret.google_client", status: "fail", title: "Google OAuth client", detail: "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing.", fix: "Create a Web OAuth client in Google Cloud Console and add both values as Cloudflare secrets." });

  const used = await ctx.db.first("SELECT digest FROM used_setup_secrets LIMIT 1");
  add(!env.ADMIN_SETUP_SECRET || env.ADMIN_SETUP_SECRET.length < 24
    ? { id: "secret.setup", status: "warn", title: "ADMIN_SETUP_SECRET", detail: "Not set (or shorter than 24 characters). Recovery of a lost administrator credential is not possible without it.", fix: "Set a long random ADMIN_SETUP_SECRET in Cloudflare. Only the Cloudflare account owner should know it." }
    : { id: "secret.setup", status: "ok", title: "ADMIN_SETUP_SECRET", detail: used ? "Set. It has been used once; to recover a lost credential later, change it to a new value first." : "Set and not used yet." });

  add(ctx.origin.startsWith("https://")
    ? { id: "origin.https", status: "ok", title: "HTTPS origin", detail: ctx.origin }
    : { id: "origin.https", status: "warn", title: "HTTPS origin", detail: `${ctx.origin} is not HTTPS. Session cookies lose the Secure flag and remote MCP hosts will refuse it.` });
  add({ id: "google.redirect", status: "info", title: "Redirect URI to register in Google Cloud", detail: googleRedirectUri(ctx.origin), fix: "Add exactly this URL under Authorized redirect URIs of your Web OAuth client." });

  const applied = (await ctx.db.all<{ id: string }>("SELECT id FROM schema_migrations")).map((r) => r.id);
  const missing = MIGRATIONS.map((m) => m.id).filter((id) => !applied.includes(id));
  add({ id: "db.schema", status: missing.length ? "fail" : "ok", title: "Database schema", detail: missing.length ? `Missing: ${missing.join(", ")}` : `Applied: ${applied.join(", ")}` });

  const conns = await ctx.db.all<{ id: string; email: string | null; status: string; last_error: string | null; last_ok_at: number | null; created_at: number }>("SELECT id, email, status, last_error, last_ok_at, created_at FROM google_connections WHERE status != 'revoked'");
  if (!conns.length) add({ id: "google.connection", status: "warn", title: "Google connection", detail: "No Google account is connected yet.", fix: "Open Connections and press Connect Google Ads." });
  for (const c of conns) {
    let status: Check["status"] = c.status === "active" ? "ok" : "fail";
    let detail = c.status === "active" ? `Stored token present${c.last_ok_at ? `; last successful Google call ${new Date(c.last_ok_at * 1000).toISOString()}` : "; no Google call has succeeded yet"}.` : `Status ${c.status}: ${c.last_error ?? "unknown error"}.`;
    let fix = c.status === "active" ? undefined : "Press Reconnect. If it keeps failing after about 7 days, publish the OAuth consent screen to Production (Testing mode expires refresh tokens after 7 days).";
    if (deep && c.status === "active") {
      try {
        await getAccessToken(env, ctx.db, c.id);
        detail += " Live token refresh succeeded.";
      } catch (e) {
        status = "fail";
        detail = `Live token refresh failed: ${e instanceof Error ? e.message : "error"}`;
        fix = "Reconnect Google in Connections.";
      }
    }
    add({ id: `google.connection.${c.id}`, status, title: `Google connection ${c.email ?? c.id.slice(0, 8)}`, detail, fix });
  }

  add({ id: "ads.api", status: "info", title: "Google Ads API", detail: `REST ${adsVersion(env)}. No developer token is needed since 9 Sep 2026; access follows the Google Cloud project that owns your OAuth client (Test vs Basic/Standard access).` });
  if (env.GOOGLE_ADS_DEVELOPER_TOKEN) add({ id: "ads.dev_token", status: "warn", title: "Developer token secret is set", detail: "Google ignores developer tokens now and will reject them in a future major version.", fix: "Delete GOOGLE_ADS_DEVELOPER_TOKEN from the Worker secrets." });

  const accounts = await ctx.db.first<{ total: number; allowed: number }>("SELECT COUNT(*) AS total, COALESCE(SUM(allowed),0) AS allowed FROM accounts");
  add({ id: "accounts", status: accounts && accounts.allowed ? "ok" : "warn", title: "Accounts allowed for AI", detail: `${accounts?.allowed ?? 0} of ${accounts?.total ?? 0} discovered accounts are allowed.`, fix: accounts?.allowed ? undefined : "Open Accounts, run discovery and switch on the accounts AI tools may use." });

  const cron = await ctx.db.first<{ value: string }>("SELECT value FROM settings WHERE name = 'last_cron_at'");
  add({ id: "cron", status: cron ? (now() - Number(cron.value) < 3 * 86400 ? "ok" : "warn") : "info", title: "Daily maintenance", detail: cron ? `Last run ${new Date(Number(cron.value) * 1000).toISOString()}.` : "Has not run yet (runs once a day after the first deploy)." });

  const errors = await ctx.db.all<{ ts: number; action: string; detail: string | null }>("SELECT ts, action, detail FROM audit_log WHERE outcome = 'error' ORDER BY id DESC LIMIT 5");
  add({ id: "errors.recent", status: errors.length ? "warn" : "ok", title: "Recent errors", detail: errors.length ? errors.map((e) => `${new Date(e.ts * 1000).toISOString()} ${e.action} ${e.detail ?? ""}`).join(" | ") : "None recorded." });
  return out;
};
