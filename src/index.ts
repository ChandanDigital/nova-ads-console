import type { Env } from "./env";
import { Db, ensureSchema, now } from "./lib/db";
import type { Ctx } from "./lib/context";
import { NodiError, toErrorBody } from "./lib/errors";
import { errorResponse, ipHash, json, publicOrigin, withSecurityHeaders } from "./lib/http";
import { enforceQuota } from "./lib/usage";
import { setSetting } from "./lib/settings";
import { authenticateBearer } from "./auth/tokens";
import { purgeExpiredSessions } from "./auth/admin";
import { CORS, authServerMetadata, authorize, protectedResourceMetadata, purgeOAuth, registerClient, revoke, token } from "./auth/oauth-server";
import { handleApi, googleCallback } from "./api/routes";
import { handleMcp } from "./mcp/server";
import { getAccessToken } from "./google/oauth";
import { runMonitors } from "./ads/monitor";

const wellKnown = (ctx: Ctx): Response | null => {
  const p = ctx.url.pathname;
  const send = (body: unknown) => json(body, 200, { ...CORS, "cache-control": "public, max-age=300" });
  if (p === "/.well-known/oauth-protected-resource" || p === "/.well-known/oauth-protected-resource/mcp") return send(protectedResourceMetadata(ctx.origin));
  if (p === "/.well-known/oauth-authorization-server" || p === "/.well-known/oauth-authorization-server/mcp" || p === "/.well-known/openid-configuration") return send(authServerMetadata(ctx.origin));
  return null;
};

const unauthorizedMcp = (ctx: Ctx): Response =>
  new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Authorization required. Connect through OAuth or send a Nova Ads API token." }, id: null }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "www-authenticate": `Bearer resource_metadata="${ctx.origin}/.well-known/oauth-protected-resource"`,
      "cache-control": "no-store",
      ...CORS,
    },
  });

/** Writes this request's measured D1 usage to the daily counters, after the response has been sent. */
const flushMeter = async (ctx: Ctx, db: Db): Promise<void> => {
  const m = db.meter;
  const day = new Date().toISOString().slice(0, 10);
  const rows: [string, number][] = [["requests", 1], ["d1_rows_read", m.rowsRead], ["d1_rows_written", m.rowsWritten + 3]];
  if (ctx.url.pathname.startsWith("/api/")) rows.push(["dashboard_calls", 1]);
  await new Db(ctx.env.DB).batch(
    rows.filter(([, v]) => v > 0).map(([metric, v]) => ({
      sql: "INSERT INTO usage_daily (day, metric, value) VALUES (?,?,?) ON CONFLICT(day, metric) DO UPDATE SET value = value + excluded.value",
      params: [day, metric, v],
    })),
  );
};

export default {
  async fetch(request: Request, env: Env, exec: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/healthz") return json({ ok: true, service: "nodi-ads", version: "0.3.0" });

    const dynamic = path.startsWith("/api/") || path.startsWith("/oauth/") || path.startsWith("/.well-known/") || path === "/mcp" || path.startsWith("/mcp/");
    if (!dynamic) return withSecurityHeaders(await env.ASSETS.fetch(request));

    const db = new Db(env.DB);
    const ctx: Ctx = { env, db, exec, request, url, origin: publicOrigin(env, request), ipHash: await ipHash(request) };
    const finish = (res: Response): Response => {
      exec.waitUntil(flushMeter(ctx, db).catch((e) => console.error("meter flush failed", e instanceof Error ? e.message : String(e))));
      return res;
    };
    try {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      await ensureSchema(env, db);
      const meta = wellKnown(ctx);
      if (meta) return finish(meta);

      // Self-imposed daily request ceiling (below Cloudflare's own free-plan ceiling). Sign-in and usage stay reachable.
      if (!path.startsWith("/api/auth/") && path !== "/api/usage") {
        try {
          await enforceQuota(env, db, "requests");
        } catch (e) {
          if (e instanceof NodiError) return finish(json({ error: toErrorBody(e) }, 429, { "retry-after": "3600", ...CORS }));
          throw e;
        }
      }

      let res: Response;
      if (path === "/mcp") {
        const principal = await authenticateBearer(ctx);
        res = principal ? await handleMcp(ctx, principal) : unauthorizedMcp(ctx);
      } else if (path === "/oauth/register" && request.method === "POST") {
        res = await registerClient(ctx, (await request.json().catch(() => ({}))) as Record<string, unknown>);
      } else if (path === "/oauth/token" && request.method === "POST") res = await token(ctx);
      else if (path === "/oauth/revoke" && request.method === "POST") res = await revoke(ctx);
      else if (path === "/oauth/authorize" && request.method === "GET") res = await authorize(ctx);
      else if (path === "/oauth/google/callback" && request.method === "GET") res = await googleCallback(ctx);
      else if (path.startsWith("/api/")) res = (await handleApi(ctx)) ?? json({ error: { code: "not_found", message: "No such API route." } }, 404);
      else res = json({ error: { code: "not_found", message: "Not found." } }, 404);
      return finish(res);
    } catch (e) {
      return finish(errorResponse(e));
    }
  },

  /** Daily maintenance (one cron trigger). Deletes only expired or aged-out rows and refreshes Google token health. */
  async scheduled(_event: ScheduledController, env: Env, exec: ExecutionContext): Promise<void> {
    const db = new Db(env.DB);
    await ensureSchema(env, db);
    const t = now();
    const fake = new Request("https://cron.invalid/");
    const ctx = { env, db, exec, request: fake, url: new URL(fake.url), origin: publicOrigin(env, fake), ipHash: "cron" } as Ctx;
    await purgeExpiredSessions(ctx);
    await purgeOAuth(ctx);
    await db.run("DELETE FROM rate_limits WHERE window_start < ?", t - 86400);
    await db.run("DELETE FROM audit_log WHERE ts < ?", t - 180 * 86400);
    await db.run("DELETE FROM usage_daily WHERE day < ?", new Date(Date.now() - 60 * 86400_000).toISOString().slice(0, 10));
    await db.run("DELETE FROM evidence WHERE created_at < ?", t - 30 * 86400);
    await db.run("DELETE FROM reports WHERE created_at < ?", t - 90 * 86400);
    const conns = await db.all<{ id: string }>("SELECT id FROM google_connections WHERE status = 'active'");
    for (const c of conns) {
      try {
        await getAccessToken(env, db, c.id);
      } catch {
        /* getAccessToken records the failure on the connection; the dashboard shows it */
      }
    }
    // Read-only health alerts. A failure here must never stop the maintenance above.
    try {
      await runMonitors(ctx);
    } catch (e) {
      console.error("monitor failed", e instanceof Error ? e.message : String(e));
    }
    await setSetting(db, "last_cron_at", String(t));
  },
} satisfies ExportedHandler<Env>;
