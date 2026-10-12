import type { Env } from "../env";
import { NodiError, toErrorBody } from "./errors";
import { sha256Hex } from "./crypto";

export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS, ...headers },
  });

export const errorResponse = (e: unknown): Response => {
  if (e instanceof NodiError) return json({ error: toErrorBody(e) }, e.status);
  console.error("unhandled", e instanceof Error ? e.message : String(e));
  return json({ error: toErrorBody(e) }, 500);
};

export const withSecurityHeaders = (res: Response): Response => {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!out.headers.has(k)) out.headers.set(k, v);
  if (!out.headers.has("cache-control")) out.headers.set("cache-control", "no-store");
  return out;
};

export const redirect = (location: string, status = 302, headers: Record<string, string> = {}): Response =>
  new Response(null, { status, headers: { location, "cache-control": "no-store", ...SECURITY_HEADERS, ...headers } });

export const parseCookies = (header: string | null): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
};

/** The public origin used for OAuth redirect URIs and the CSRF Origin check. */
export const publicOrigin = (env: Env, request: Request): string => {
  const configured = env.PUBLIC_ORIGIN?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  return new URL(request.url).origin;
};

export const isSecure = (origin: string): boolean => origin.startsWith("https://");
export const SESSION_COOKIE_SECURE = "__Host-nova_session";
export const SESSION_COOKIE_PLAIN = "nova_session";
export const sessionCookieName = (origin: string): string => (isSecure(origin) ? SESSION_COOKIE_SECURE : SESSION_COOKIE_PLAIN);

export const sessionSetCookie = (origin: string, value: string, maxAge: number): string =>
  `${sessionCookieName(origin)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isSecure(origin) ? "; Secure" : ""}`;

export const ipHash = async (request: Request): Promise<string> => {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  return (await sha256Hex("ip:" + ip)).slice(0, 16);
};
export const uaHash = async (request: Request): Promise<string> =>
  (await sha256Hex("ua:" + (request.headers.get("user-agent") ?? ""))).slice(0, 16);

export const readJson = async <T = Record<string, unknown>>(request: Request, maxBytes = 256_000): Promise<T> => {
  const len = Number(request.headers.get("content-length") ?? "0");
  if (len > maxBytes) throw new NodiError("payload_too_large", "Request body is too large.", 413);
  const text = await request.text();
  if (text.length > maxBytes) throw new NodiError("payload_too_large", "Request body is too large.", 413);
  if (!text) return {} as T;
  try {
    const v = JSON.parse(text);
    if (v === null || typeof v !== "object") throw new Error("not an object");
    return v as T;
  } catch {
    throw new NodiError("invalid_json", "Send a JSON object.", 400);
  }
};

export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
