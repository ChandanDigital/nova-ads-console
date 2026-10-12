import { NovaError } from "../lib/errors";

/**
 * Lightweight, read-only landing-page check. It fetches the public page once (https only, no credentials, no private hosts,
 * redirects revalidated, at most MAX_BYTES read) and extracts a handful of facts with simple patterns.
 * The Free Workers plan allows 10 ms of CPU per request, so there is deliberately no full HTML parser, no JavaScript
 * rendering and no speed test. Page text is untrusted data: it is clipped and returned as values, never as instructions.
 */
const MAX_BYTES = 100_000;
const MAX_REDIRECTS = 4;
const TIMEOUT_MS = 8000;

const privateHost = (h: string): boolean =>
  /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":") || h === "localhost" || /\.(local|localhost|internal|lan|home|corp|test|invalid|example)$/i.test(h) || !h.includes(".");

export const checkPublicUrl = (raw: string): URL => {
  let u: URL;
  try { u = new URL(raw); } catch { throw new NovaError("invalid_url", "Send an absolute https:// URL.", 400); }
  if (raw.length > 2000 || u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) throw new NovaError("invalid_url", "Only plain https:// URLs on the default port, without credentials, can be inspected.", 400);
  if (privateHost(u.hostname)) throw new NovaError("invalid_url", "Private, local and IP-address hosts cannot be inspected.", 400);
  return u;
};

const clip = (s: string | undefined | null, n = 200): string | null => (s ? s.replace(/\s+/g, " ").trim().slice(0, n) : null);
const decode = (s: string): string => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4] ?? null) : null;
};

export interface LandingReport {
  requested_url: string;
  final_url: string;
  redirects: { status: number; to: string }[];
  status: number;
  content_type: string | null;
  response_ms: number;
  bytes_read: number;
  truncated: boolean;
  title: string | null;
  meta_description: string | null;
  canonical: string | null;
  robots: string | null;
  lang: string | null;
  viewport: boolean;
  h1: string[];
  forms: number;
  tel_links: number;
  images: { total: number; missing_alt: number };
  checks: { id: string; status: "pass" | "warn" | "fail"; note: string }[];
  not_checked: string[];
}

export const inspectLandingPage = async (rawUrl: string): Promise<LandingReport> => {
  let url = checkPublicUrl(rawUrl);
  const redirects: LandingReport["redirects"] = [];
  const started = Date.now();
  let res: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    try {
      res = await fetch(url.toString(), { redirect: "manual", headers: { accept: "text/html,application/xhtml+xml", "user-agent": "NovaAdsLandingCheck/0.3 (+read-only)" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new NovaError("page_unreachable", "The page did not answer within 8 seconds or could not be reached.", 502);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      if (hop === MAX_REDIRECTS) throw new NovaError("too_many_redirects", "The page redirects more than 4 times.", 502);
      const next = checkPublicUrl(new URL(res.headers.get("location")!, url).toString());
      redirects.push({ status: res.status, to: next.toString() });
      await res.body?.cancel();
      url = next;
      continue;
    }
    break;
  }
  const r = res!;
  const ms = Date.now() - started;
  const type = r.headers.get("content-type");
  let html = "";
  let bytes = 0;
  let truncated = false;
  if (r.body && /html|xml/i.test(type ?? "")) {
    const reader = r.body.getReader();
    const chunks: Uint8Array[] = [];
    while (bytes < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      bytes += value.length;
    }
    if (bytes >= MAX_BYTES) { truncated = true; bytes = MAX_BYTES; await reader.cancel(); }
    const all = new Uint8Array(Math.min(bytes, MAX_BYTES));
    let off = 0;
    for (const c of chunks) { const part = c.subarray(0, all.length - off); all.set(part, off); off += part.length; if (off >= all.length) break; }
    html = new TextDecoder().decode(all);
  } else await r.body?.cancel();

  const head = html.slice(0, 60_000);
  const title = /<title[^>]*>([\s\S]{0,400}?)<\/title>/i.exec(head)?.[1];
  const metas = [...head.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]);
  const metaContent = (name: string) => { const m = metas.find((t) => (attr(t, "name") ?? attr(t, "property"))?.toLowerCase() === name); return m ? attr(m, "content") : null; };
  const canonical = /<link\b[^>]*rel\s*=\s*["']?canonical["']?[^>]*>/i.exec(head)?.[0];
  const lang = /<html\b[^>]*>/i.exec(head)?.[0];
  const body = html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ");
  const imgs = [...body.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const h1 = [...body.matchAll(/<h1\b[^>]*>([\s\S]{0,300}?)<\/h1>/gi)].slice(0, 3).map((m) => clip(decode(m[1]!.replace(/<[^>]*>/g, " "))) ?? "");
  const robots = [metaContent("robots"), r.headers.get("x-robots-tag")].filter(Boolean).join(" | ") || null;

  const report: LandingReport = {
    requested_url: rawUrl, final_url: url.toString(), redirects, status: r.status, content_type: clip(type, 100), response_ms: ms, bytes_read: bytes, truncated,
    title: clip(title ? decode(title) : null), meta_description: clip(metaContent("description") ? decode(metaContent("description")!) : null, 300),
    canonical: canonical ? clip(attr(canonical, "href"), 300) : null, robots, lang: lang ? clip(attr(lang, "lang"), 20) : null,
    viewport: metas.some((t) => attr(t, "name")?.toLowerCase() === "viewport"),
    h1, forms: (body.match(/<form\b/gi) ?? []).length, tel_links: (body.match(/href\s*=\s*["']tel:/gi) ?? []).length,
    images: { total: imgs.length, missing_alt: imgs.filter((t) => attr(t, "alt") === null).length },
    checks: [],
    not_checked: ["JavaScript-rendered content", "page speed and Core Web Vitals", "tracking tags and conversion events", "ad policy compliance", "content beyond the first 100 KB"],
  };
  const add = (id: string, ok: boolean, passNote: string, failNote: string, level: "warn" | "fail" = "warn") => report.checks.push({ id, status: ok ? "pass" : level, note: ok ? passNote : failNote });
  add("status_ok", r.status >= 200 && r.status < 300, `HTTP ${r.status}.`, `HTTP ${r.status}: ads sent here may be disapproved or wasted.`, "fail");
  add("is_html", /html/i.test(type ?? ""), "HTML page.", `Content type is ${type ?? "unknown"}; this check reads HTML only.`);
  add("redirects", redirects.length <= 1, redirects.length ? "One redirect." : "No redirect.", `${redirects.length} redirects before the page loads; each one slows ad clicks.`);
  add("response_time", ms < 2500, `Answered in ${ms} ms (single request from Cloudflare).`, `Answered in ${ms} ms, which is slow for ad traffic (this is not a full speed test).`);
  add("title", !!report.title, "Has a title.", "No <title> found in the first part of the page.");
  add("h1", h1.length === 1, "One H1.", h1.length ? "More than one H1." : "No H1 found (the page may be rendered by JavaScript).");
  add("viewport", report.viewport, "Mobile viewport tag present.", "No mobile viewport meta tag: the page may not be mobile friendly.");
  add("indexable", !/noindex/i.test(robots ?? ""), "Not marked noindex.", "The page is marked noindex.");
  add("contact_path", report.forms > 0 || report.tel_links > 0, "Has a form or a tel: link.", "No form or tel: link found. If this is a lead page, check how visitors contact you.");
  return report;
};
