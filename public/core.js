import { TEXT } from "/i18n.js";

// ------------------------------------------------------------------ state
export const state = { csrf: null, signedIn: false, needsSetup: false, origin: location.origin, mcpUrl: location.origin + "/mcp", lang: "en" };

const safeGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const safeSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage may be blocked */ } };
state.lang = "en";
export const setLang = (l) => { state.lang = l; safeSet("nodi.lang", l); document.documentElement.lang = l; };
export const t = (k) => TEXT[state.lang]?.[k] ?? TEXT.en[k] ?? k;
document.documentElement.lang = state.lang;

export const setTheme = (th) => { safeSet("nodi.theme", th); if (th === "auto") document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", th); };
setTheme(safeGet("nodi.theme") || "auto");

// ------------------------------------------------------------------ DOM builder (text only: nothing is ever parsed as HTML)
export const h = (tag, attrs, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  const add = (c) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  kids.forEach(add);
  return el;
};

const SVG = "http://www.w3.org/2000/svg";
export const svg = (tag, attrs, ...kids) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
  kids.forEach((c) => c && el.append(c));
  return el;
};
export const icon = (path) => svg("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" }, svg("path", { d: path }));

export const clear = (el) => { while (el.firstChild) el.firstChild.remove(); return el; };
export const mount = (el, ...kids) => { clear(el); kids.forEach((k) => k && el.append(k)); return el; };

export const toast = (msg, bad = false) => {
  const host = document.getElementById("toasts");
  const el = h("div", { class: "toast" + (bad ? " bad" : "") }, msg);
  host.append(el);
  setTimeout(() => el.remove(), bad ? 7000 : 3500);
};

// ------------------------------------------------------------------ API
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `HTTP ${status}`);
    this.status = status;
    this.code = body?.error?.code;
    this.details = body?.error?.details;
  }
}

export const api = async (method, path, body) => {
  const headers = {};
  if (method !== "GET") { headers["content-type"] = "application/json"; if (state.csrf) headers["x-csrf-token"] = state.csrf; }
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin" });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    if (res.status === 401 && path !== "/api/auth/login" && !path.startsWith("/api/auth/")) { state.signedIn = false; location.hash = "#/login"; }
    throw new ApiError(res.status, data);
  }
  return data;
};

export const guard = (fn) => async (...a) => {
  try { return await fn(...a); } catch (e) { toast(e instanceof Error ? e.message : t("toastError"), true); return undefined; }
};

// ------------------------------------------------------------------ formatting
export const fmtInt = (n) => new Intl.NumberFormat("en-US").format(Math.round(Number(n || 0)));
export const fmtNum = (n, d = 2) => new Intl.NumberFormat("en-US", { maximumFractionDigits: d, minimumFractionDigits: d }).format(Number(n || 0));
export const micros = (m, cur) => `${fmtNum(Number(BigInt(m || 0) / 10000n) / 100)} ${cur || ""}`.trim();
export const when = (sec) => (sec ? new Date(sec * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—");
export const chip = (text, kind = "") => h("span", { class: "chip " + kind }, h("span", { class: "dot" }), text);
export const statusChip = (s) => {
  const kind = { succeeded: "ok", active: "ok", ok: "ok", awaiting_approval: "warn", draft: "", validation_failed: "bad", failed: "bad", outcome_unknown: "bad", rejected: "", running: "info", error: "bad", revoked: "", partially_succeeded: "warn", warn: "warn", fail: "bad", info: "info" }[s] ?? "";
  return chip(String(s).replaceAll("_", " "), kind);
};

export const copyButton = (text, label) =>
  h("button", { class: "small", type: "button", onclick: async (e) => { try { await navigator.clipboard.writeText(text); const b = e.currentTarget; const old = b.textContent; b.textContent = t("copied"); setTimeout(() => (b.textContent = old), 1500); } catch { toast("Select the text and copy it manually.", true); } } }, label || t("copy"));

export const field = (label, input, hint) => h("div", { class: "field" }, h("label", {}, label), input, hint ? h("div", { class: "hint" }, hint) : null);

export const table = (cols, rows, opts = {}) => {
  const body = rows.length ? rows.map((r) => h("tr", { class: opts.onRow ? "clickable" : "", onclick: opts.onRow ? () => opts.onRow(r) : null }, cols.map((c) => h("td", { class: c.num ? "num" : "" }, c.render ? c.render(r) : r[c.key] ?? "")))) : [h("tr", {}, h("td", { colspan: cols.length, class: "empty" }, opts.empty || "—"))];
  return h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, cols.map((c) => h("th", { class: c.num ? "num" : "" }, c.label)))), h("tbody", {}, body)));
};

export const bar = (pct) => {
  const fill = h("i");
  fill.style.setProperty("width", Math.min(100, Math.max(0, pct)) + "%");
  return h("div", { class: "bar" + (pct >= 100 ? " bad" : pct >= 80 ? " warn" : ""), role: "progressbar", "aria-valuenow": Math.round(pct), "aria-valuemin": 0, "aria-valuemax": 100 }, fill);
};

export const sparkline = (values) => {
  const W = 200, H = 50, max = Math.max(1, ...values);
  const pts = values.map((v, i) => [(i / Math.max(1, values.length - 1)) * W, H - (v / max) * (H - 6) - 3]);
  const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  return svg("svg", { class: "spark", viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", role: "img", "aria-label": "trend" }, svg("path", { class: "area", d: `${line} L${W} ${H} L0 ${H} Z` }), svg("path", { class: "line", d: line }));
};

export const confirmBox = (message) => window.confirm(message);
