import type { Ctx, Principal } from "../lib/context";
import { now } from "../lib/db";
import { NodiError } from "../lib/errors";
import { json, readJson, redirect } from "../lib/http";
import { audit } from "../lib/audit";
import { getSetting, setSetting } from "../lib/settings";
import { usageSummary } from "../lib/usage";
import { encryptionKeyProblem } from "../lib/crypto";
import { adminExists, clearSessionCookie, login, logout, readSession, recoverAdmin, requireAdmin, rotateCredential, setupFirstAdmin, type AdminSession } from "../auth/admin";
import { issueApiToken, listTokens, revokeAllTokens, revokeToken } from "../auth/tokens";
import { decide, pendingDetails } from "../auth/oauth-server";
import { disconnectGoogle, finishGoogleConnect, startGoogleConnect } from "../google/oauth";
import { addAccount, discoverAccounts, listAccounts, setAllowed, refreshIdentity, resolveAccount } from "../ads/accounts";
import * as R from "../ads/reports";
import { auditAccount } from "../ads/audit";
import { listAlerts, runMonitors } from "../ads/monitor";
import * as X from "../ads/execute";
import { runDiagnostics } from "./diagnostics";
import { cloudflareUsage } from "./cf-usage";
import { importLegacy, legacyArchive } from "./legacy-import";
import { capabilityList } from "../mcp/capabilities";
import { MIGRATIONS } from "../lib/schema";
import { dateWindow } from "../google/gaql";

type Handler = (ctx: Ctx, params: Record<string, string>) => Promise<Response>;
interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

const routes: Route[] = [];
const route = (method: string, path: string, handler: Handler) => {
  const keys: string[] = [];
  const pattern = new RegExp("^" + path.replace(/:([a-z_]+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "/?$");
  routes.push({ method, pattern, keys, handler });
};

const adminPrincipal = (s: AdminSession): Principal => ({ kind: "admin", id: s.adminId, label: "dashboard", scopes: ["read", "draft", "apply"], accounts: null });

/** Registers a route that needs a signed-in administrator (and CSRF for mutating methods). */
const secured = (method: string, path: string, h: (ctx: Ctx, params: Record<string, string>, s: AdminSession, p: Principal) => Promise<unknown>) =>
  route(method, path, async (ctx, params) => {
    const s = await requireAdmin(ctx);
    const out = await h(ctx, params, s, adminPrincipal(s));
    return out instanceof Response ? out : json(out ?? { ok: true });
  });

const q = (ctx: Ctx, name: string) => ctx.url.searchParams.get(name) ?? undefined;

// ---------------------------------------------------------------- public (no account data)
route("GET", "/api/state", async (ctx) => {
  const s = await readSession(ctx);
  return json({
    needs_setup: !(await adminExists(ctx)),
    signed_in: !!s,
    csrf: s?.csrf ?? null,
    origin: ctx.origin,
    mcp_url: `${ctx.origin}/mcp`,
    version: "0.3.0",
  });
});

route("POST", "/api/auth/setup", async (ctx) => {
  const { assertSameOrigin } = await import("../auth/admin");
  assertSameOrigin(ctx);
  const r = await setupFirstAdmin(ctx, await readJson(ctx.request));
  return json({ credential: r.credential, csrf: r.csrf, notice: "Save this credential now. It is shown once and cannot be recovered; only replaced." }, 201, { "set-cookie": r.cookie });
});
route("POST", "/api/auth/login", async (ctx) => {
  const { assertSameOrigin } = await import("../auth/admin");
  assertSameOrigin(ctx);
  const r = await login(ctx, await readJson(ctx.request));
  return json({ ok: true, csrf: r.csrf }, 200, { "set-cookie": r.cookie });
});
route("POST", "/api/auth/recover", async (ctx) => {
  const { assertSameOrigin } = await import("../auth/admin");
  assertSameOrigin(ctx);
  const r = await recoverAdmin(ctx, await readJson(ctx.request));
  return json({ credential: r.credential, csrf: r.csrf, notice: "The previous credential no longer works. Save this one now; it is shown once." }, 200, { "set-cookie": r.cookie });
});
secured("POST", "/api/auth/logout", async (ctx, _p, s) => {
  await logout(ctx, s);
  return json({ ok: true }, 200, { "set-cookie": clearSessionCookie(ctx.origin) });
});
route("POST", "/api/auth/rotate", async (ctx) => {
  const s = await requireAdmin(ctx);
  const r = await rotateCredential(ctx, s, await readJson(ctx.request));
  return json({ credential: r.credential, csrf: r.csrf, notice: "The previous credential no longer works. Save this one now." }, 200, { "set-cookie": r.cookie });
});

// ---------------------------------------------------------------- overview
secured("GET", "/api/overview", async (ctx) => {
  const [conns, accounts, pending, recent, usage, stop] = await Promise.all([
    ctx.db.all<{ id: string; email: string | null; status: string; last_ok_at: number | null; last_error: string | null; created_at: number }>("SELECT id, email, status, last_ok_at, last_error, created_at FROM google_connections WHERE status != 'revoked'"),
    ctx.db.first<{ total: number; allowed: number }>("SELECT COUNT(*) AS total, COALESCE(SUM(allowed),0) AS allowed FROM accounts"),
    ctx.db.all<{ id: string; account_id: string; created_at: number }>("SELECT id, account_id, created_at FROM plans WHERE status = 'awaiting_approval' ORDER BY created_at DESC LIMIT 20"),
    ctx.db.all<{ ts: number; action: string; outcome: string; target: string | null }>("SELECT ts, action, outcome, target FROM audit_log ORDER BY id DESC LIMIT 8"),
    usageSummary(ctx.env, ctx.db),
    getSetting(ctx.db, "global_stop"),
  ]);
  return { connections: conns, accounts, pending_plans: pending, recent_activity: recent, usage, global_stop: stop === "1", mcp_url: `${ctx.origin}/mcp`, secrets_ok: !(await encryptionKeyProblem(ctx.env)) };
});

// ---------------------------------------------------------------- Google connection
secured("POST", "/api/google/connect", async (ctx) => ({ url: await startGoogleConnect(ctx) }));
secured("POST", "/api/google/connections/:id/disconnect", async (ctx, p) => disconnectGoogle(ctx, p.id!));
secured("POST", "/api/google/connections/:id/discover", async (ctx, p) => discoverAccounts(ctx, p.id!));
secured("GET", "/api/google/connections", async (ctx) =>
  ctx.db.all("SELECT id, email, status, scopes, last_error, created_at, last_refresh_at, last_ok_at FROM google_connections ORDER BY created_at"),
);

/** Google redirects the browser here. Needs the dashboard session cookie; state is single-use and session-bound. */
export const googleCallback = async (ctx: Ctx): Promise<Response> => {
  const sp = ctx.url.searchParams;
  const s = await readSession(ctx);
  if (!s) return redirect("/#/login?reason=session");
  if (sp.get("error")) return redirect(`/#/connections?google_error=${encodeURIComponent(sp.get("error")!.slice(0, 60))}`);
  const state = sp.get("state");
  const code = sp.get("code");
  if (!state || !code) return redirect("/#/connections?google_error=missing_code");
  try {
    const r = await finishGoogleConnect(ctx, state, code);
    // Immediately discover accounts so the dashboard has something to show.
    try { await discoverAccounts(ctx, r.id); } catch { /* the dashboard shows discovery errors on demand */ }
    return redirect("/#/accounts?connected=1");
  } catch (e) {
    const codeName = e instanceof NodiError ? e.code : "error";
    return redirect(`/#/connections?google_error=${encodeURIComponent(codeName)}`);
  }
};

// ---------------------------------------------------------------- accounts and reports
secured("GET", "/api/accounts", async (ctx) => (await listAccounts(ctx)).map((a) => ({ ...a, manager: !!a.manager, allowed: !!a.allowed, manager_path: a.manager_path ? JSON.parse(a.manager_path) : [] })));
secured("POST", "/api/accounts/add", async (ctx) => {
  const b = await readJson<{ customer_id?: string; login_customer_id?: string; allow?: boolean }>(ctx.request);
  await addAccount(ctx, String(b.customer_id ?? ""), b.login_customer_id ? String(b.login_customer_id) : null, null);
  if (b.allow !== false) await setAllowed(ctx, String(b.customer_id), true);
  return { ok: true };
});
secured("POST", "/api/accounts/:id/allow", async (ctx, p) => {
  const b = await readJson<{ allowed?: boolean }>(ctx.request);
  await setAllowed(ctx, p.id!, b.allowed === true);
  return { ok: true };
});
secured("POST", "/api/accounts/:id/refresh", async (ctx, p, _s, pr) => R.identity(await refreshIdentity(ctx, await resolveAccount(ctx, pr, p.id!))));

const dates = (ctx: Ctx): [string, string] => {
  const end = q(ctx, "end") ?? new Date().toISOString().slice(0, 10);
  const start = q(ctx, "start") ?? new Date(Date.now() - 29 * 86400_000).toISOString().slice(0, 10);
  dateWindow(start, end);
  return [start, end];
};
const lim = (ctx: Ctx) => (q(ctx, "limit") ? Number(q(ctx, "limit")) : undefined);
secured("GET", "/api/accounts/:id/performance", async (ctx, p, _s, pr) => R.getPerformance(ctx, pr, p.id!, ...dates(ctx), lim(ctx)));
secured("GET", "/api/accounts/:id/keywords", async (ctx, p, _s, pr) => (await R.runQuery(ctx, pr, p.id!, R.Q.keywords(dateWindow(...dates(ctx))), lim(ctx))).data);
secured("GET", "/api/accounts/:id/search-terms", async (ctx, p, _s, pr) => R.getSearchTerms(ctx, pr, p.id!, ...dates(ctx), lim(ctx)));
secured("POST", "/api/accounts/:id/audit", async (ctx, p, _s, pr) => auditAccount(ctx, pr, p.id!, ...dates(ctx)));
secured("GET", "/api/accounts/:id/reports", async (ctx, p) =>
  (await ctx.db.all<{ id: string; created_at: number }>("SELECT id, created_at FROM reports WHERE account_id = ? ORDER BY created_at DESC LIMIT 20", p.id!)),
);
secured("GET", "/api/reports/:id", async (ctx, p) => {
  const row = await ctx.db.first<{ report_json: string }>("SELECT report_json FROM reports WHERE id = ?", p.id!);
  if (!row) throw new NodiError("not_found", "No such report.", 404);
  return JSON.parse(row.report_json);
});

// ---------------------------------------------------------------- plans and approval
secured("GET", "/api/plans", async (ctx) =>
  ctx.db.all("SELECT p.id, p.account_id, a.name AS account_name, p.status, p.created_by, p.created_at, p.expires_at, p.validated_at, (SELECT COUNT(*) FROM approvals x WHERE x.plan_id = p.id AND x.revoked_at IS NULL AND x.expires_at > ?) AS approved FROM plans p LEFT JOIN accounts a ON a.customer_id = p.account_id ORDER BY p.created_at DESC LIMIT 100", now()),
);
secured("GET", "/api/plans/:id", async (ctx, p, _s, pr) => X.previewPlan(ctx, pr, p.id!));
secured("POST", "/api/plans/:id/validate", async (ctx, p, _s, pr) => X.validatePlan(ctx, pr, p.id!));
secured("POST", "/api/plans/:id/approve", async (ctx, p, s) => X.approvePlan(ctx, s.adminId, p.id!, await readJson(ctx.request)));
secured("POST", "/api/plans/:id/reject", async (ctx, p, s) => X.rejectPlan(ctx, s.adminId, p.id!));
secured("POST", "/api/plans/:id/revoke-approval", async (ctx, p, s) => X.revokeApproval(ctx, s.adminId, p.id!));
secured("POST", "/api/plans/:id/execute", async (ctx, p, _s, pr) => X.executePlan(ctx, pr, p.id!));
secured("POST", "/api/plans/:id/reconcile", async (ctx, p, _s, pr) => X.reconcilePlan(ctx, pr, p.id!));

// ---------------------------------------------------------------- AI access (tokens, OAuth grants)
secured("GET", "/api/tokens", async (ctx) => listTokens(ctx));
secured("POST", "/api/tokens", async (ctx, _p, s) => issueApiToken(ctx, s.adminId, await readJson(ctx.request)));
secured("DELETE", "/api/tokens/:id", async (ctx, p, s) => revokeToken(ctx, s.adminId, p.id!));
secured("POST", "/api/tokens/revoke-all", async (ctx, _p, s) => revokeAllTokens(ctx, s.adminId));
secured("GET", "/api/oauth/pending/:id", async (ctx, p) => pendingDetails(ctx, p.id!));
secured("POST", "/api/oauth/pending/:id/decision", async (ctx, p, s) => decide(ctx, s.adminId, p.id!, await readJson(ctx.request)));

// ---------------------------------------------------------------- settings, audit, diagnostics, usage
secured("GET", "/api/settings", async (ctx) => ({
  global_stop: (await getSetting(ctx.db, "global_stop")) === "1",
  max_daily_budget_micros: await getSetting(ctx.db, "max_daily_budget_micros"),
  alert_min_spend_micros: await getSetting(ctx.db, "alert_min_spend_micros"),
}));
secured("POST", "/api/settings/global-stop", async (ctx, _p, s) => {
  const b = await readJson<{ stop?: boolean }>(ctx.request);
  await setSetting(ctx.db, "global_stop", b.stop ? "1" : "0");
  await audit(ctx.db, { actor_type: "admin", actor_id: s.adminId, action: b.stop ? "global_stop_on" : "global_stop_off", outcome: "ok", ip_hash: ctx.ipHash });
  return { global_stop: !!b.stop };
});
secured("POST", "/api/settings/budget-cap", async (ctx, _p, s) => {
  const b = await readJson<{ daily_budget?: string | null }>(ctx.request);
  if (b.daily_budget === null || b.daily_budget === "") await setSetting(ctx.db, "max_daily_budget_micros", "");
  else {
    const { moneyMicros } = await import("../google/gaql");
    await setSetting(ctx.db, "max_daily_budget_micros", moneyMicros(b.daily_budget).toString());
  }
  await audit(ctx.db, { actor_type: "admin", actor_id: s.adminId, action: "budget_cap_set", outcome: "ok", detail: { daily_budget: b.daily_budget }, ip_hash: ctx.ipHash });
  return { ok: true };
});
secured("GET", "/api/audit", async (ctx) => {
  const limit = Math.min(500, Number(q(ctx, "limit") ?? 100));
  return ctx.db.all("SELECT id, ts, actor_type, actor_id, action, target, outcome, detail FROM audit_log ORDER BY id DESC LIMIT ?", limit);
});
secured("GET", "/api/diagnostics", async (ctx) => runDiagnostics(ctx, q(ctx, "deep") === "1"));
secured("GET", "/api/usage", async (ctx) => ({ ...(await usageSummary(ctx.env, ctx.db)), cloudflare: await cloudflareUsage(ctx.env) }));
secured("GET", "/api/alerts", async (ctx) => listAlerts(ctx, null, { includeResolved: q(ctx, "resolved") === "1" }));
secured("POST", "/api/alerts/run", async (ctx, _p, s) => {
  const r = await runMonitors(ctx);
  await audit(ctx.db, { actor_type: "admin", actor_id: s.adminId, action: "alerts_run", outcome: "ok", detail: r, ip_hash: ctx.ipHash });
  return r;
});
secured("POST", "/api/settings/alerts", async (ctx, _p, s) => {
  const b = await readJson<{ min_spend?: string | null }>(ctx.request);
  if (b.min_spend === null || b.min_spend === "") await setSetting(ctx.db, "alert_min_spend_micros", "");
  else {
    const { moneyMicros } = await import("../google/gaql");
    await setSetting(ctx.db, "alert_min_spend_micros", moneyMicros(b.min_spend).toString());
  }
  await audit(ctx.db, { actor_type: "admin", actor_id: s.adminId, action: "alert_threshold_set", outcome: "ok", detail: { min_spend: b.min_spend }, ip_hash: ctx.ipHash });
  return { ok: true };
});
secured("GET", "/api/capabilities", async () => capabilityList());
secured("GET", "/api/mcp-info", async (ctx) => ({
  mcp_url: `${ctx.origin}/mcp`,
  transport: "Streamable HTTP (stateless, JSON responses)",
  auth: ["OAuth 2.1 + PKCE with dynamic client registration (Claude, ChatGPT, Gemini CLI)", "Authorization: Bearer nova_api_... token created on the Tokens screen"],
  discovery: [`${ctx.origin}/.well-known/oauth-protected-resource`, `${ctx.origin}/.well-known/oauth-authorization-server`],
  migrations: MIGRATIONS.map((m) => m.id),
  google_redirect_uri: `${ctx.origin}/oauth/google/callback`,
}));

// ---------------------------------------------------------------- legacy import
secured("POST", "/api/admin/import-legacy", async (ctx, _p, s) => {
  const body = await readJson<Record<string, unknown>>(ctx.request, 2_000_000);
  return importLegacy(ctx, s.adminId, body.export ?? body, body.apply_allowlist !== false);
});
secured("GET", "/api/admin/legacy", async (ctx) => legacyArchive(ctx));

/** Registered routes, for tests that prove every account-specific endpoint is protected. */
export const routeTable = (): { method: string; path: string }[] => routes.map((r) => ({ method: r.method, path: r.pattern.source }));

export const handleApi = async (ctx: Ctx): Promise<Response | null> => {
  const path = ctx.url.pathname;
  for (const r of routes) {
    if (r.method !== ctx.request.method) continue;
    const m = r.pattern.exec(path);
    if (!m) continue;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)]));
    return r.handler(ctx, params);
  }
  return null;
};
