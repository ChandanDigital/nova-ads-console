import { env, exports } from "cloudflare:workers";

/** Sends a request through the real Worker entry point (fetch handler + ExecutionContext). */
export const workerFetch = (req: Request): Promise<Response> => (exports as any).default.fetch(req);
import { resetSchemaCacheForTests } from "../src/lib/db";
import worker from "../src/index";

export const ORIGIN = "https://nodi.example.workers.dev";
export const SETUP_SECRET = "test-setup-secret-0123456789abcdef0123456789";

const TABLES = [
  "admin", "sessions", "rate_limits", "used_setup_secrets", "settings", "api_tokens", "oauth_clients", "oauth_pending", "oauth_codes",
  "google_oauth_states", "google_connections", "accounts", "plans", "approvals", "executions", "evidence", "reports", "audit_log", "usage_daily", "legacy_import", "alerts",
];

/** Empties every table so each test starts from a fresh install (the schema itself stays). */
export const resetDb = async () => {
  resetSchemaCacheForTests();
  await env.DB.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const existing = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{ name: string }>();
  const have = new Set(existing.results.map((r) => r.name));
  for (const t of TABLES) if (have.has(t)) await env.DB.prepare(`DELETE FROM ${t}`).run();
};

export interface Session { cookie: string; csrf: string; credential?: string }

export const call = async (path: string, init: { method?: string; body?: unknown; session?: Session | null; headers?: Record<string, string>; origin?: string | null; raw?: boolean } = {}) => {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.session) { headers.cookie = init.session.cookie; if ((init.method ?? "GET") !== "GET") headers["x-csrf-token"] = init.session.csrf; }
  if ((init.method ?? "GET") !== "GET" && init.origin !== null) headers.origin = init.origin ?? ORIGIN;
  if (init.body !== undefined && !init.raw) headers["content-type"] = "application/json";
  const res = await workerFetch(
    new Request(ORIGIN + path, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : init.raw ? (init.body as string) : JSON.stringify(init.body), redirect: "manual" }),
  );
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, headers: res.headers };
};

const cookieFrom = (h: Headers): string => (h.get("set-cookie") ?? "").split(";")[0]!;

/** First-time setup through the real endpoint; returns a signed-in session. */
export const setupAdmin = async (): Promise<Session> => {
  const r = await call("/api/auth/setup", { method: "POST", body: { setup_secret: SETUP_SECRET } });
  if (r.status !== 201) throw new Error("setup failed: " + r.text);
  return { cookie: cookieFrom(r.headers), csrf: r.json.csrf, credential: r.json.credential };
};

export const loginWith = async (credential: string): Promise<Session> => {
  const r = await call("/api/auth/login", { method: "POST", body: { credential } });
  if (r.status !== 200) throw new Error("login failed: " + r.text);
  return { cookie: cookieFrom(r.headers), csrf: r.json.csrf, credential };
};

export const mcpCall = async (token: string, method: string, params?: unknown, id: number | string = 1) => {
  const res = await workerFetch(
    new Request(ORIGIN + "/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    }),
  );
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, json, headers: res.headers, text };
};

export const mcpTool = async (token: string, name: string, args: Record<string, unknown> = {}) => {
  const r = await mcpCall(token, "tools/call", { name, arguments: args });
  const result = r.json?.result;
  let body = result?.structuredContent ?? null;
  if (!body && result?.content?.[0]?.text) {
    try { body = JSON.parse(result.content[0].text); } catch { body = { status: "protocol_error", errors: [{ code: "mcp_validation", message: result.content[0].text }] }; }
  }
  return { status: r.status, isError: !!result?.isError, body, raw: r.json };
};

export const issueToken = async (session: Session, scopes: string[], extra: Record<string, unknown> = {}) => {
  const r = await call("/api/tokens", { method: "POST", session, body: { label: "test " + scopes.join("+"), scopes, days: 7, ...extra } });
  if (r.status !== 200) throw new Error("token failed: " + r.text);
  return r.json.token as string;
};

/** Calls the Worker directly with modified bindings (for example a rotated ADMIN_SETUP_SECRET). */
export const callWithEnv = async (override: Record<string, unknown>, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if ((init.method ?? "GET") !== "GET") headers.origin = ORIGIN;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const res = await worker.fetch(new Request(ORIGIN + path, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }), { ...env, ...override } as any, ctx);
  await Promise.allSettled(pending);
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, json, text, headers: res.headers };
};
