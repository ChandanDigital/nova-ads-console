import { api, clear, h, icon, mount, setTheme, state, t, toast } from "/core.js";
import { viewLogin, viewRecover, viewSetup } from "/views-auth.js";
import { viewAccounts, viewActivity, viewAi, viewApprovals, viewConnections, viewConsent, viewDiagnostics, viewHosting, viewOverview, viewPerformance, viewSecurity } from "/views-main.js";

const root = document.getElementById("root");
// CSP forbids inline handlers, so printing is wired once here for every [data-print] button.
document.addEventListener("click", (e) => { if (e.target instanceof Element && e.target.closest("[data-print]")) window.print(); });

const NAV = [
  ["overview", "nav_overview", "M3 12l9-8 9 8M5 10v10h5v-6h4v6h5V10"],
  ["connections", "nav_connections", "M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"],
  ["accounts", "nav_accounts", "M4 6h16M4 12h16M4 18h10"],
  ["performance", "nav_performance", "M4 20V10M10 20V4M16 20v-8M22 20H2"],
  ["approvals", "nav_approvals", "M5 13l4 4L19 7"],
  ["activity", "nav_activity", "M12 8v5l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z"],
  ["ai", "nav_ai", "M8 9l-4 3 4 3M16 9l4 3-4 3M13 6l-2 12"],
  ["security", "nav_security", "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"],
  ["diagnostics", "nav_diagnostics", "M3 12h4l2-6 4 12 2-6h6"],
  ["hosting", "nav_hosting", "M4 7h16v4H4zM4 13h16v4H4zM8 9h.01M8 15h.01"],
];

const parseHash = () => {
  const raw = location.hash.replace(/^#\/?/, "");
  const [path, qs] = raw.split("?");
  const parts = (path || "overview").split("/");
  return { page: parts[0] || "overview", arg: parts[1], query: new URLSearchParams(qs || "") };
};

const nav = { setPending: () => {} };

const shell = () => {
  const main = h("main", { class: "main", id: "main", tabindex: "-1" });
  const side = h("aside", { class: "side", id: "side", "aria-label": "Main" });
  const scrim = h("div", { class: "scrim hidden" });
  const close = () => { side.classList.remove("open"); scrim.classList.add("hidden"); };
  scrim.addEventListener("click", close);
  const links = NAV.map(([key, label, d]) => h("a", { href: `#/${key}`, dataset: { key }, onclick: close }, icon(d), t(label)));
  const pending = h("span", { class: "badge-count hidden" }, "0");
  links.find((a) => a.dataset.key === "approvals").append(pending);
  nav.setPending = (n) => { pending.textContent = String(n); pending.classList.toggle("hidden", !n); };
  const themeBtn = h("button", { class: "small", type: "button", onclick: () => { const cur = document.documentElement.getAttribute("data-theme"); setTheme(cur === "dark" ? "light" : cur === "light" ? "auto" : "dark"); toast("Theme: " + (document.documentElement.getAttribute("data-theme") ?? "auto")); } }, t("theme"));
  const signOut = h("button", { class: "small", type: "button", onclick: async () => { try { await api("POST", "/api/auth/logout"); } catch { /* already signed out */ } state.signedIn = false; state.csrf = null; location.hash = "#/login"; } }, t("signOut"));
  mount(side, h("div", { class: "brand" }, h("span", { class: "logo" }, "N"), t("appName")), h("nav", { class: "nav" }, links), h("div", { class: "side-foot stack" }, h("div", { class: "row" }, themeBtn, signOut), h("div", { class: "muted small" }, "v0.3.0 · free-tier edition")));
  const top = h("div", { class: "topbar" }, h("button", { class: "small", "aria-label": t("menu"), "aria-controls": "side", onclick: () => { side.classList.add("open"); scrim.classList.remove("hidden"); } }, "☰"), h("strong", {}, t("appName")));
  mount(root, h("div", { class: "app" }, side, h("div", {}, top, main), scrim));
  return main;
};

let main = null;
const route = async () => {
  const { page, arg, query } = parseHash();
  if (page === "consent" && arg && state.signedIn) { mount(root); return viewConsent(root, arg); }
  if (!state.signedIn || page === "login") return showAuth();
  if (!main || !document.body.contains(main)) main = shell();
  for (const a of document.querySelectorAll(".nav a")) { if (a.dataset.key === page) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); }
  document.title = `${t("nav_" + page) === "nav_" + page ? page : t("nav_" + page)} · Nodi Ads`;
  const views = {
    overview: () => viewOverview(main, nav), connections: () => viewConnections(main, query), accounts: () => viewAccounts(main), performance: () => viewPerformance(main),
    approvals: () => viewApprovals(main, arg), activity: () => viewActivity(main), ai: () => viewAi(main), security: () => viewSecurity(main, () => {}),
    diagnostics: () => viewDiagnostics(main), hosting: () => viewHosting(main),
  };
  await (views[page] ?? views.overview)();
  window.scrollTo(0, 0);
};

const afterAuth = () => {
  main = null;
  const p = parseHash().page;
  if (p === "login" || p === "recover" || !location.hash) { if (location.hash !== "#/overview") { location.hash = "#/overview"; return; } }
  route();
};

const showAuth = () => {
  main = null;
  if (state.needsSetup) return viewSetup(root, showAuth, afterAuth);
  if (location.hash.startsWith("#/recover")) return viewRecover(root, showAuth, afterAuth, () => { location.hash = "#/login"; });
  return viewLogin(root, showAuth, afterAuth, () => { location.hash = "#/recover"; showAuth(); });
};

const boot = async () => {
  try {
    const s = await api("GET", "/api/state");
    Object.assign(state, { needsSetup: s.needs_setup, signedIn: s.signed_in, csrf: s.csrf, origin: s.origin, mcpUrl: s.mcp_url });
  } catch (e) {
    clear(root).append(h("div", { class: "auth" }, h("div", { class: "card" }, h("h1", {}, t("appName")), h("div", { class: "callout bad" }, "Could not reach the server: " + (e instanceof Error ? e.message : "error")))));
    return;
  }
  if (state.signedIn && (!location.hash || location.hash === "#/login")) location.hash = "#/overview";
  route();
};

window.addEventListener("hashchange", () => (location.hash.startsWith("#/recover") ? showAuth() : route()));
boot();
