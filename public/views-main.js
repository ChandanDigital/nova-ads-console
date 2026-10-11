import { api, bar, chip, confirmBox, copyButton, field, fmtInt, fmtNum, guard, h, micros, mount, sparkline, state, statusChip, table, t, toast, when } from "/core.js";

const section = (title, ...kids) => h("section", { class: "card stack" }, title ? h("h2", {}, title) : null, ...kids);
const page = (title, ...kids) => h("div", { class: "stack" }, h("h1", {}, title), ...kids);
const loading = () => h("div", { class: "stack" }, h("div", { class: "skeleton" }), h("div", { class: "skeleton" }), h("div", { class: "skeleton" }));
const callout = (kind, ...kids) => h("div", { class: "callout " + kind }, ...kids);
const go = (hash) => { location.hash = hash; };

/** Runs an async render, showing a skeleton first and an error callout on failure. */
const load = async (root, render) => {
  mount(root, loading());
  try { mount(root, await render()); } catch (e) { mount(root, callout("bad", e instanceof Error ? e.message : String(e))); }
};

const THREE_MONTHS = 90;
const iso = (d) => d.toISOString().slice(0, 10);
const rangeDays = (n) => { const e = new Date(); const s = new Date(Date.now() - (n - 1) * 86400_000); return [iso(s), iso(e)]; };

// ================================================================== overview
export const viewOverview = (root, nav) => load(root, async () => {
  const [o, diag] = await Promise.all([api("GET", "/api/overview"), api("GET", "/api/diagnostics")]);
  const tokens = await api("GET", "/api/tokens");
  const googleOk = o.connections.some((c) => c.status === "active");
  const steps = [
    [t("step_secrets"), o.secrets_ok && !diag.some((d) => d.id.startsWith("secret.") && d.status === "fail")],
    [t("step_google"), googleOk],
    [t("step_accounts"), (o.accounts?.allowed ?? 0) > 0],
    [t("step_ai"), tokens.some((k) => !k.revoked_at)],
  ];
  nav.setPending(o.pending_plans.length);
  const stop = h("input", { type: "checkbox", checked: o.global_stop, id: "stop", "aria-label": t("ov_globalStop"), onchange: guard(async (e) => { await api("POST", "/api/settings/global-stop", { stop: e.target.checked }); toast(e.target.checked ? "Global stop ON" : "Global stop off"); }) });
  const usage = o.usage.metrics.filter((m) => ["requests", "d1_rows_written", "mcp_calls", "ads_calls"].includes(m.metric));
  return page(t("ov_title"),
    h("div", { class: "grid cols-4" },
      kpi(t("nav_connections"), googleOk ? "Connected" : "Not connected", o.connections[0]?.email ?? "", googleOk ? "ok" : "warn"),
      kpi(t("nav_accounts"), `${o.accounts?.allowed ?? 0} / ${o.accounts?.total ?? 0}`, t("acc_allowed")),
      kpi(t("ov_pending"), String(o.pending_plans.length), "", o.pending_plans.length ? "warn" : ""),
      kpi("MCP", "Streamable HTTP", o.mcp_url)),
    h("div", { class: "grid cols-2" },
      section(t("ov_checklist"), h("ol", { class: "steps" }, steps.map(([label, done], i) => h("li", { class: done ? "done" : "" }, h("span", { class: "n" }, done ? "✓" : String(i + 1)), h("span", {}, label))))),
      section(t("ov_usage"), usage.map((m) => h("div", {}, h("div", { class: "row spread small" }, h("span", {}, m.metric.replaceAll("_", " ")), h("span", { class: "muted" }, `${fmtInt(m.used)} / ${fmtInt(m.soft_limit)}`)), bar(m.percent_of_soft_limit))), h("a", { href: "#/hosting" }, t("nav_hosting")))),
    h("div", { class: "grid cols-2" },
      section(t("ov_pending"), o.pending_plans.length ? table([{ label: "Plan", render: (r) => r.id.slice(0, 8) }, { label: t("perf_account"), key: "account_id" }, { label: "", render: (r) => h("button", { class: "small", onclick: () => go("#/approvals/" + r.id) }, t("open")) }], o.pending_plans) : h("p", { class: "muted" }, t("none_pending"))),
      section(t("ov_activity"), table([{ label: "", render: (r) => when(r.ts) }, { label: "", key: "action" }, { label: "", render: (r) => statusChip(r.outcome) }], o.recent_activity))),
    section(t("ov_globalStop"), h("div", { class: "row" }, h("label", { class: "switch" }, stop, h("span")), h("span", { class: "muted" }, t("ov_globalStopHelp")))));
});

const kpi = (label, value, sub, kind = "") => h("div", { class: "card kpi" }, h("div", { class: "label" }, label), h("div", { class: "value" }, kind ? chip(value, kind) : value), h("div", { class: "sub" }, sub || " "));

// ================================================================== Google connection
export const viewConnections = (root, query) => load(root, async () => {
  const conns = await api("GET", "/api/google/connections");
  const info = await api("GET", "/api/mcp-info");
  const connect = guard(async () => { const r = await api("POST", "/api/google/connect"); location.href = r.url; });
  const err = query.get("google_error");
  return page(t("con_title"),
    err ? callout("bad", "Google sign-in did not finish: " + err) : null,
    callout("info", t("con_noDevToken")),
    section(null, conns.length ? table([
      { label: "Google user", render: (c) => c.email ?? c.id.slice(0, 8) }, { label: "Status", render: (c) => statusChip(c.status) },
      { label: "Last OK", render: (c) => when(c.last_ok_at) }, { label: "Last error", render: (c) => c.last_error ?? "—" },
      { label: t("actions"), render: (c) => h("div", { class: "row" },
        c.status !== "revoked" ? h("button", { class: "small", onclick: guard(async () => { const r = await api("POST", `/api/google/connections/${c.id}/discover`); toast(`Discovered ${r.discovered} accounts`); go("#/accounts"); }) }, t("con_discover")) : null,
        c.status !== "revoked" ? h("button", { class: "small danger", onclick: guard(async () => { if (!confirmBox(t("con_disconnect") + "?")) return; await api("POST", `/api/google/connections/${c.id}/disconnect`); viewConnections(root, query); }) }, t("con_disconnect")) : null) },
    ], conns) : h("p", { class: "muted" }, t("con_none")),
    h("div", { class: "row" }, h("button", { class: "primary", onclick: connect }, conns.some((c) => c.status === "active") ? t("con_reconnect") : t("con_connect")))),
    section(t("con_redirect"), h("p", { class: "muted" }, t("con_redirectHelp")), h("div", { class: "row" }, h("code", {}, info.google_redirect_uri), copyButton(info.google_redirect_uri))),
    callout("warn", t("con_testing")));
});

// ================================================================== accounts
export const viewAccounts = (root) => load(root, async () => {
  const accounts = await api("GET", "/api/accounts");
  const cid = h("input", { inputmode: "numeric", placeholder: "3010086756", maxlength: 12, id: "add-id" });
  const login = h("input", { inputmode: "numeric", placeholder: "optional", maxlength: 12, id: "add-login" });
  const toggle = (a) => h("label", { class: "switch" }, h("input", { type: "checkbox", checked: a.allowed, "aria-label": `${t("acc_allowed")} ${a.customer_id}`, onchange: guard(async (e) => { await api("POST", `/api/accounts/${a.customer_id}/allow`, { allowed: e.target.checked }); toast(e.target.checked ? "Allowed" : "Blocked"); }) }), h("span"));
  return page(t("acc_title"), h("p", { class: "muted" }, t("acc_allowHelp")),
    accounts.length ? table([
      { label: "Name", render: (a) => h("div", {}, h("strong", {}, a.name ?? "—"), h("div", { class: "muted small mono" }, a.customer_id)) },
      { label: "Type", render: (a) => (a.manager ? chip("Manager", "info") : "Advertiser") }, { label: "Currency", key: "currency" }, { label: "Time zone", key: "timezone" },
      { label: "Status", render: (a) => statusChip(a.status ?? "UNKNOWN") }, { label: t("acc_login"), render: (a) => a.login_customer_id ?? "—" },
      { label: t("acc_allowed"), render: toggle },
      { label: "", render: (a) => (a.connection_id ? h("button", { class: "small", onclick: guard(async () => { await api("POST", `/api/accounts/${a.customer_id}/refresh`); toast("Refreshed"); viewAccounts(root); }) }, t("acc_refresh")) : null) },
    ], accounts) : callout("info", t("acc_discoverFirst")),
    section(t("acc_add"), h("p", { class: "muted small" }, t("acc_addHelp")),
      h("form", { class: "row", onsubmit: guard(async (e) => { e.preventDefault(); await api("POST", "/api/accounts/add", { customer_id: cid.value, login_customer_id: login.value || undefined, allow: true }); toast("Added"); viewAccounts(root); }) },
        field("Customer ID", cid), field(t("acc_login"), login), h("button", { class: "primary", type: "submit" }, t("save")))));
});

// ================================================================== performance, keywords, search terms, audit
export const viewPerformance = (root) => load(root, async () => {
  const accounts = (await api("GET", "/api/accounts")).filter((a) => a.connection_id && !a.manager);
  if (!accounts.length) return page(t("perf_title"), callout("info", t("perf_noaccount")));
  const select = h("select", { id: "perf-account", "aria-label": t("perf_account") }, accounts.map((a) => h("option", { value: a.customer_id }, `${a.name ?? ""} (${a.customer_id})`)));
  const days = h("select", { id: "perf-days", "aria-label": t("perf_range") }, [[7, t("last7")], [30, t("last30")], [90, t("last90")]].map(([v, l]) => h("option", { value: v, selected: v === 30 }, l)));
  const out = h("div", { class: "stack" });
  let tab = "campaigns";
  const tabs = h("div", { class: "tabs", role: "tablist" });
  const draw = () => {
    mount(tabs, ...[["campaigns", t("perf_campaigns")], ["keywords", t("perf_keywords")], ["terms", t("perf_terms")], ["audit", t("perf_audit")]].map(([k, l]) => h("button", { role: "tab", "aria-selected": String(k === tab), onclick: () => { tab = k; draw(); run(); } }, l)));
  };
  const run = async () => {
    mount(out, loading());
    const id = select.value;
    const [start, end] = rangeDays(Number(days.value));
    const q = `?start=${start}&end=${end}`;
    try {
      if (tab === "campaigns") mount(out, renderCampaigns(await api("GET", `/api/accounts/${id}/performance${q}`)));
      else if (tab === "keywords") mount(out, renderKeywords(await api("GET", `/api/accounts/${id}/keywords${q}`)));
      else if (tab === "terms") mount(out, renderTerms(await api("GET", `/api/accounts/${id}/search-terms${q}`)));
      else mount(out, h("div", { class: "stack" }, h("button", { class: "primary", onclick: guard(async () => { mount(out, loading()); mount(out, renderAudit(await api("POST", `/api/accounts/${id}/audit${q}`))); }) }, t("perf_run"))));
    } catch (e) { mount(out, callout("bad", e.message)); }
  };
  select.addEventListener("change", run); days.addEventListener("change", run);
  draw(); run();
  return page(t("perf_title"), h("div", { class: "row" }, field(t("perf_account"), select), field(t("perf_range"), days)), tabs, out);
});

const m = (r, k) => Number(r.metrics?.[k] ?? 0);
const renderCampaigns = (d) => {
  const rows = d.rows, cur = d.account.currency;
  const sum = (k) => rows.reduce((s, r) => s + m(r, k), 0);
  const cost = sum("cost_micros") / 1e6, clicks = sum("clicks"), imp = sum("impressions"), conv = sum("conversions");
  const max = Math.max(1, ...rows.map((r) => m(r, "cost_micros")));
  return h("div", { class: "stack" },
    d.truncated ? callout("warn", t("perf_truncated")) : null,
    h("div", { class: "grid cols-4" },
      kpi(t("cost"), `${fmtNum(cost)} ${cur}`), kpi(t("clicks"), fmtInt(clicks)), kpi(t("impressions"), fmtInt(imp)), kpi(t("conversions"), fmtNum(conv, 1)),
      kpi(t("ctr"), imp ? fmtNum((clicks / imp) * 100) + "%" : "—"), kpi(t("cpc"), clicks ? `${fmtNum(cost / clicks)} ${cur}` : "—"), kpi(t("cpa"), conv ? `${fmtNum(cost / conv)} ${cur}` : "—")),
    table([
      { label: "Campaign", render: (r) => h("div", {}, h("strong", {}, r.campaign.name), h("div", { class: "row small muted" }, statusChip(r.campaign.status), r.campaign.advertising_channel_type)) },
      { label: t("cost"), num: true, render: (r) => fmtNum(m(r, "cost_micros") / 1e6) }, { label: t("clicks"), num: true, render: (r) => fmtInt(m(r, "clicks")) },
      { label: t("impressions"), num: true, render: (r) => fmtInt(m(r, "impressions")) }, { label: t("conversions"), num: true, render: (r) => fmtNum(m(r, "conversions"), 1) },
      { label: "Share of spend", render: (r) => bar((m(r, "cost_micros") / max) * 100) },
    ], rows, { empty: "No campaign data in this period." }));
};
const renderKeywords = (d) => h("div", { class: "stack" }, d.truncated ? callout("warn", t("perf_truncated")) : null, table([
  { label: "Keyword", render: (r) => h("div", {}, h("strong", {}, r.ad_group_criterion.keyword?.text), h("div", { class: "small muted" }, `${r.ad_group_criterion.keyword?.match_type} · ${r.campaign.name} › ${r.ad_group.name}`)) },
  { label: "QS", num: true, render: (r) => r.ad_group_criterion.quality_info?.quality_score ?? "—" }, { label: t("cost"), num: true, render: (r) => fmtNum(m(r, "cost_micros") / 1e6) },
  { label: t("clicks"), num: true, render: (r) => fmtInt(m(r, "clicks")) }, { label: t("conversions"), num: true, render: (r) => fmtNum(m(r, "conversions"), 1) },
], d.rows, { empty: "No keyword data." }));
const renderTerms = (d) => h("div", { class: "stack" }, callout("info", `Saved as evidence ${d.evidence_id.slice(0, 8)} for negative-keyword plans (valid 7 days).`), d.truncated ? callout("warn", t("perf_truncated")) : null, table([
  { label: "Search term", render: (r) => r.search_term_view.search_term }, { label: t("cost"), num: true, render: (r) => fmtNum(m(r, "cost_micros") / 1e6) },
  { label: t("clicks"), num: true, render: (r) => fmtInt(m(r, "clicks")) }, { label: t("conversions"), num: true, render: (r) => fmtNum(m(r, "conversions"), 1) },
], d.rows, { empty: "No search-term data." }));
const renderAudit = (a) => h("div", { class: "stack" },
  h("div", { class: "grid cols-4" }, kpi("Failing checks", String(a.summary.fail), "", a.summary.fail ? "bad" : "ok"), kpi("Passing", String(a.summary.pass), "", "ok"), kpi("High severity", String(a.summary.high), "", a.summary.high ? "bad" : ""), kpi(t("cost"), a.totals.cost)),
  a.findings.map((f) => h("div", { class: "card flat stack" }, h("div", { class: "row spread" }, h("strong", {}, f.title), h("div", { class: "row" }, statusChip(f.status === "fail" ? "fail" : f.status === "pass" ? "ok" : "info"), chip(f.severity))), f.status === "fail" ? h("p", { class: "muted" }, f.recommendation) : null,
    f.status === "fail" ? h("details", {}, h("summary", {}, "Evidence"), h("pre", { class: "mono small" }, JSON.stringify(f.evidence, null, 2))) : null)),
  callout("info", `Not checked (never scored as passing): ${a.not_checked.join("; ")}. No health score is shown because no validated scoring method is enabled.`));

// ================================================================== approvals
export const viewApprovals = (root, id) => (id ? viewPlan(root, id) : load(root, async () => {
  const plans = await api("GET", "/api/plans");
  const waiting = plans.filter((p) => p.status === "awaiting_approval");
  const cols = [{ label: "Plan", render: (p) => h("span", { class: "mono" }, p.id.slice(0, 8)) }, { label: t("perf_account"), render: (p) => p.account_name ?? p.account_id }, { label: "Status", render: (p) => statusChip(p.status) }, { label: "By", key: "created_by" }, { label: "Created", render: (p) => when(p.created_at) }, { label: "Approved", render: (p) => (p.approved ? chip(t("yes"), "ok") : "—") }];
  return page(t("apr_title"), section(t("apr_queue"), waiting.length ? table(cols, waiting, { onRow: (p) => go("#/approvals/" + p.id) }) : h("p", { class: "muted" }, t("none_pending"))), section(t("apr_all"), table(cols, plans, { onRow: (p) => go("#/approvals/" + p.id), empty: "No plans yet." })));
}));

const describeOp = (op, currency) => {
  const p = op.payload;
  const bits = [];
  if (p.name) bits.push(`name: ${p.name}`);
  if (p.status) bits.push(`status: ${p.status}`);
  if (p.amountMicros) bits.push(`daily budget: ${micros(p.amountMicros, currency)}`);
  if (p.cpcBidMicros) bits.push(`CPC bid: ${micros(p.cpcBidMicros, currency)}`);
  if (p.keyword) bits.push(`${p.negative ? "NEGATIVE " : ""}keyword: ${p.keyword.text} [${p.keyword.matchType}]`);
  if (p.ad?.responsiveSearchAd) bits.push(`RSA: ${p.ad.responsiveSearchAd.headlines.map((x) => x.text).join(" | ")}`);
  if (p.location) bits.push(`${p.negative ? "exclude " : ""}location: ${p.location.geoTargetConstant}`);
  return bits;
};

const viewPlan = (root, id) => load(root, async () => {
  const d = await api("GET", `/api/plans/${id}`);
  const plan = d.plan, cur = plan.account.currency;
  const perms = plan.required_permissions;
  const boxes = perms.map((p) => h("input", { type: "checkbox", value: p, checked: true, id: "perm-" + p }));
  const typed = h("input", { id: "approve-typed", autocomplete: "off", placeholder: "APPROVE" });
  const secs = h("select", { id: "approve-secs" }, [[900, "15 min"], [3600, "1 hour"], [14400, "4 hours"], [86400, "24 hours"]].map(([v, l]) => h("option", { value: v, selected: v === 3600 }, l)));
  const act = (label, path, cls = "", body, then) => h("button", { class: cls, onclick: guard(async () => { await api("POST", `/api/plans/${id}/${path}`, body); toast("OK"); (then ?? (() => viewPlan(root, id)))(); }) }, label);
  const canApprove = d.status === "awaiting_approval";
  return page(t("apr_review"),
    h("div", { class: "row spread" }, h("div", { class: "row" }, statusChip(d.status), h("span", { class: "muted" }, `${plan.account.name} (${plan.account.customer_id}) · ${cur} · ${plan.account.timezone}`)), h("a", { href: "#/approvals" }, "← " + t("nav_approvals"))),
    h("div", { class: "row small" }, h("span", { class: "muted" }, t("apr_hash")), h("code", {}, d.plan_hash)),
    d.validation?.code ? callout("bad", `Validation failed: ${d.validation.message}`, h("pre", { class: "mono small" }, JSON.stringify(d.validation.details, null, 2))) : null,
    h("div", { class: "stack" }, plan.operations.map((op, i) => h("div", { class: "card flat stack" },
      h("div", { class: "row spread" }, h("strong", {}, `${i + 1}. ${op.kind.replaceAll("_", " ")} — ${op.action}`), h("span", { class: "mono small muted" }, op.resource_name ?? "new")),
      op.action === "update"
        ? op.field_mask.map((f) => h("div", {}, h("div", { class: "small muted" }, f), h("div", { class: "diff" }, h("div", { class: "before" }, `${t("apr_before")}: ${JSON.stringify(op.before[f])}`), h("div", { class: "after" }, `${t("apr_after")}: ${JSON.stringify(f.split(".").reduce((o, k) => o?.[k], op.payload))}`))))
        : h("ul", {}, describeOp(op, cur).map((b) => h("li", {}, b))),
      h("div", { class: "small" }, h("strong", {}, t("apr_effect") + ": "), op.spending_effect), h("div", { class: "small" }, h("strong", {}, t("apr_recovery") + ": "), op.recovery), h("div", { class: "small muted" }, op.reason),
      h("details", {}, h("summary", {}, "JSON"), h("pre", { class: "mono small" }, JSON.stringify(op, null, 2)))))),
    d.approval ? callout(d.approval.active ? "ok" : "warn", `Approved ${when(d.approval.approved_at)} · valid until ${when(d.approval.expires_at)} · ${d.approval.permissions.join(", ")}${d.approval.revoked ? " · REVOKED" : ""}`) : null,
    canApprove ? section(t("apr_approve"),
      h("div", { class: "checks" }, h("strong", {}, t("apr_permissions")), boxes.map((b, i) => h("label", {}, b, perms[i]))),
      field(t("apr_expiry"), secs), field(t("apr_type"), typed),
      callout("warn", t("apr_note")),
      h("div", { class: "row" }, h("button", { class: "primary", onclick: guard(async () => { await api("POST", `/api/plans/${id}/approve`, { hash: d.plan_hash, permissions: boxes.filter((b) => b.checked).map((b) => b.value), seconds: Number(secs.value), confirmation: typed.value }); toast("Approved"); viewPlan(root, id); }) }, t("apr_approve")), act(t("apr_reject"), "reject", "danger"))) : null,
    h("div", { class: "row" },
      ["draft", "validation_failed", "awaiting_approval"].includes(d.status) ? act(t("apr_validate"), "validate") : null,
      d.approval?.active ? act(t("apr_revoke"), "revoke-approval") : null,
      d.status === "awaiting_approval" && d.approval?.active ? act(t("apr_execute"), "execute", "primary") : null,
      ["outcome_unknown", "partially_succeeded", "running"].includes(d.status) ? act(t("apr_reconcile"), "reconcile") : null));
});

// ================================================================== activity
export const viewActivity = (root) => load(root, async () => {
  const rows = await api("GET", "/api/audit?limit=300");
  const f = h("input", { placeholder: "filter…", "aria-label": "filter", id: "act-filter" });
  const body = h("div");
  const draw = () => mount(body, table([{ label: "Time", render: (r) => when(r.ts) }, { label: "Who", render: (r) => `${r.actor_type}${r.actor_id ? ":" + String(r.actor_id).slice(0, 8) : ""}` }, { label: "Action", key: "action" }, { label: "Target", render: (r) => (r.target ? String(r.target).slice(0, 12) : "") }, { label: "Result", render: (r) => statusChip(r.outcome) }, { label: "Detail", render: (r) => h("span", { class: "mono small" }, r.detail ?? "") }], rows.filter((r) => !f.value || JSON.stringify(r).toLowerCase().includes(f.value.toLowerCase()))));
  f.addEventListener("input", draw); draw();
  return page(t("act_title"), f, body);
});

// ================================================================== AI access
export const viewAi = (root) => load(root, async () => {
  const [tokens, info] = await Promise.all([api("GET", "/api/tokens"), api("GET", "/api/mcp-info")]);
  const label = h("input", { id: "tok-label", placeholder: "Claude Code on my laptop" });
  const days = h("input", { type: "number", value: 30, min: 1, max: 365, id: "tok-days" });
  const scopes = ["read", "draft", "apply"].map((s) => h("input", { type: "checkbox", value: s, checked: s !== "apply", id: "sc-" + s }));
  const shown = h("div");
  const create = guard(async (e) => {
    e.preventDefault();
    const r = await api("POST", "/api/tokens", { label: label.value, scopes: scopes.filter((s) => s.checked).map((s) => s.value), days: Number(days.value) });
    mount(shown, callout("ok", h("strong", {}, t("ai_shownOnce")), h("div", { class: "secret-box" }, r.token), h("div", { class: "row" }, copyButton(r.token), copyButton(`claude mcp add --transport http nodi-ads ${info.mcp_url} --header "Authorization: Bearer ${r.token}"`, "Copy Claude Code command"))));
    viewAiList();
  });
  const listBox = h("div");
  const viewAiList = async () => {
    const list = await api("GET", "/api/tokens");
    mount(listBox, table([
      { label: t("ai_label"), render: (k) => h("div", {}, h("strong", {}, k.label), h("div", { class: "small muted" }, k.kind === "api" ? "API token" : "OAuth connection")) },
      { label: t("ai_scopes"), render: (k) => k.scopes.map((s) => chip(s)) }, { label: "Accounts", render: (k) => (k.accounts ? k.accounts.join(", ") : "all allowed") },
      { label: "Expires", render: (k) => when(k.expires_at) }, { label: "Last used", render: (k) => when(k.last_used_at) },
      { label: "", render: (k) => (k.revoked_at ? chip("revoked") : h("button", { class: "small danger", onclick: guard(async () => { await api("DELETE", `/api/tokens/${k.id}`); viewAiList(); }) }, t("ai_revoke"))) },
    ], list, { empty: t("none") }));
  };
  viewAiList();
  return page(t("ai_title"),
    section(t("ai_url"), h("div", { class: "row" }, h("code", {}, info.mcp_url), copyButton(info.mcp_url)), h("p", { class: "muted small" }, info.transport),
      h("details", { open: true }, h("summary", {}, "How to connect"), h("ul", {},
        h("li", {}, "Claude (web/desktop): Settings → Connectors → Add custom connector → paste the URL above → sign in here when asked and approve."),
        h("li", {}, "Claude Code: ", h("code", {}, `claude mcp add --transport http nodi-ads ${info.mcp_url}`), " then /mcp to sign in, or use a token below."),
        h("li", {}, "ChatGPT / Gemini CLI / others: add a remote MCP server with this URL. OAuth discovery: ", h("code", {}, info.discovery[0]))))),
    section(t("ai_newToken"), h("form", { class: "stack", onsubmit: create }, field(t("ai_label"), label), h("div", { class: "checks" }, h("strong", {}, t("ai_scopes")), scopes.map((s) => h("label", {}, s, s.value)), h("div", { class: "small muted" }, t("ai_scopeHelp"))), field(t("ai_days"), days), h("button", { class: "primary", type: "submit" }, t("ai_create"))), shown),
    section(t("ai_tokens"), listBox, h("div", { class: "row" }, h("button", { class: "danger", onclick: guard(async () => { if (!confirmBox(t("ai_revokeAll") + "?")) return; await api("POST", "/api/tokens/revoke-all"); viewAiList(); toast("Done"); }) }, t("ai_revokeAll")))));
});

// ================================================================== credential security
export const viewSecurity = (root, afterRotate) => load(root, async () => {
  const [settings, legacy] = await Promise.all([api("GET", "/api/settings"), api("GET", "/api/admin/legacy")]);
  const cur = h("input", { type: "password", id: "rot-cred", autocomplete: "current-password" });
  const shown = h("div");
  const cap = h("input", { id: "cap", inputmode: "decimal", placeholder: "e.g. 500.00", value: settings.max_daily_budget_micros ? String(Number(settings.max_daily_budget_micros) / 1e6) : "" });
  const file = h("input", { type: "file", accept: "application/json", id: "legacy-file" });
  const apply = h("input", { type: "checkbox", checked: true, id: "legacy-apply" });
  return page(t("sec_title"),
    section(t("sec_rotate"), h("p", { class: "muted" }, t("sec_rotateHelp")), field(t("credential"), cur),
      h("button", { class: "primary", onclick: guard(async () => { const r = await api("POST", "/api/auth/rotate", { credential: cur.value }); state.csrf = r.csrf; mount(shown, callout("warn", h("strong", {}, "New credential (shown once)"), h("div", { class: "secret-box" }, r.credential), copyButton(r.credential))); cur.value = ""; }) }, t("sec_rotate")), shown),
    section(t("sec_budgetCap"), h("p", { class: "muted" }, t("sec_budgetCapHelp")), field(t("perf_account") + " currency", cap),
      h("button", { onclick: guard(async () => { await api("POST", "/api/settings/budget-cap", { daily_budget: cap.value.trim() || null }); toast("Saved"); }) }, t("save"))),
    section(t("sec_legacy"), h("p", { class: "muted" }, t("sec_legacyHelp")), file, h("label", { class: "row checks" }, apply, "Allow the accounts from the old allowlist"),
      h("button", { onclick: guard(async () => { const f = file.files?.[0]; if (!f) return toast("Choose the JSON file first", true); const r = await api("POST", "/api/admin/import-legacy", { export: JSON.parse(await f.text()), apply_allowlist: apply.checked }); toast(`Imported: ${r.imported.plans} plans, ${r.imported.approvals} approvals`); viewSecurity(root, afterRotate); }) }, "Import"),
      Object.keys(legacy).length ? h("details", {}, h("summary", {}, "Imported archive (read-only)"), h("pre", { class: "mono small" }, JSON.stringify(Object.fromEntries(Object.entries(legacy).map(([k, v]) => [k, `${v.items.length ?? "settings"} items, imported ${when(v.imported_at)}`])), null, 2))) : null));
});

// ================================================================== diagnostics
export const viewDiagnostics = (root) => load(root, async () => {
  const run = async (deep) => { mount(list, loading()); mount(list, ...(await api("GET", "/api/diagnostics" + (deep ? "?deep=1" : ""))).map((c) => h("div", { class: "card flat stack" }, h("div", { class: "row spread" }, h("strong", {}, c.title), statusChip(c.status === "ok" ? "ok" : c.status)), h("div", {}, c.detail), c.fix ? h("div", { class: "small muted" }, "→ " + c.fix) : null))); };
  const list = h("div", { class: "stack" });
  await run(false);
  return page(t("diag_title"), h("div", { class: "row" }, h("button", { onclick: guard(() => run(false)) }, t("refresh")), h("button", { onclick: guard(() => run(true)) }, t("diag_deep"))), list);
});

// ================================================================== hosting & quotas
export const viewHosting = (root) => load(root, async () => {
  const [u, caps] = await Promise.all([api("GET", "/api/usage"), api("GET", "/api/capabilities")]);
  const days = [...new Set(u.history.map((x) => x.day))];
  const series = (metric) => days.map((d) => u.history.find((x) => x.day === d && x.metric === metric)?.value ?? 0);
  const hl = u.free_plan_hard_limits;
  const statusKind = { implemented: "ok", partial: "warn", not_ported: "warn", not_available_on_free_hosting: "bad" };
  return page(t("host_title"),
    callout("info", "This deployment stops at its own daily limits (below Cloudflare's) and never switches to a paid service. Google Ads spend and any AI subscription are separate costs."),
    h("div", { class: "grid cols-2" }, u.metrics.map((mm) => h("div", { class: "card stack" }, h("div", { class: "row spread" }, h("strong", {}, mm.metric.replaceAll("_", " ")), chip(mm.state, mm.state === "ok" ? "ok" : mm.state === "warning" ? "warn" : "bad")),
      h("div", { class: "kpi" }, h("div", { class: "value" }, fmtInt(mm.used)), h("div", { class: "sub" }, `soft limit ${fmtInt(mm.soft_limit)}${mm.hard_limit ? ` · Cloudflare free ceiling ${fmtInt(mm.hard_limit)}` : ""}`)), bar(mm.percent_of_soft_limit), series(mm.metric).length > 1 ? sparkline(series(mm.metric)) : null))),
    u.cloudflare.available ? section("Cloudflare analytics (live)", h("pre", { class: "mono small" }, JSON.stringify(u.cloudflare.data, null, 2))) : callout("info", "Platform-side numbers: " + (u.cloudflare.reason ?? "") + " The figures above are measured by this app (D1 row counts come from D1 itself)."),
    section(t("host_limits"), table([{ label: "Limit", key: "k" }, { label: "Free plan", num: true, key: "v" }], [
      { k: "Worker requests per day", v: fmtInt(hl.worker_requests_per_day) }, { k: "CPU time per request", v: hl.worker_cpu_ms_per_request + " ms" }, { k: "Subrequests per request", v: hl.worker_subrequests_per_request },
      { k: "D1 rows read per day", v: fmtInt(hl.d1_rows_read_per_day) }, { k: "D1 rows written per day", v: fmtInt(hl.d1_rows_written_per_day) }, { k: "D1 storage per database", v: "500 MB" }, { k: "Cron triggers per account", v: hl.cron_triggers_per_account }, { k: "Workers Builds minutes per month", v: fmtInt(hl.workers_builds_minutes_per_month) }])),
    section(t("host_matrix"), table([{ label: "Capability", key: "id" }, { label: "Status", render: (c) => chip(c.status.replaceAll("_", " "), statusKind[c.status] ?? "") }, { label: "Notes", render: (c) => c.note ?? c.implementation }], caps)));
});

// ================================================================== OAuth consent (AI app asks for access)
export const viewConsent = (root, id) => load(root, async () => {
  const d = await api("GET", `/api/oauth/pending/${id}`);
  const scopeBoxes = d.requested_scopes.map((s) => h("input", { type: "checkbox", value: s, checked: true, id: "cs-" + s }));
  const accBoxes = d.allowed_accounts.map((a) => h("input", { type: "checkbox", value: a.customer_id, checked: true, id: "ca-" + a.customer_id }));
  const decide = (approve) => guard(async () => {
    const accounts = accBoxes.every((b) => b.checked) ? null : accBoxes.filter((b) => b.checked).map((b) => b.value);
    const r = await api("POST", `/api/oauth/pending/${id}/decision`, { approve, scopes: scopeBoxes.filter((b) => b.checked).map((b) => b.value), accounts });
    location.href = r.redirect;
  });
  return h("div", { class: "auth" }, h("div", { class: "card stack" },
    h("h1", {}, h("span", { class: "logo" }, "N"), "Allow this AI app?"),
    callout("info", h("strong", {}, d.client.name), ` wants to connect to Nodi Ads. It will return to: `, h("code", {}, d.client.redirect_host)),
    h("div", { class: "checks" }, h("strong", {}, t("ai_scopes")), scopeBoxes.map((b, i) => h("label", {}, b, d.requested_scopes[i])), h("div", { class: "small muted" }, t("ai_scopeHelp"))),
    h("div", { class: "checks" }, h("strong", {}, t("nav_accounts")), accBoxes.length ? accBoxes.map((b, i) => h("label", {}, b, `${d.allowed_accounts[i].name ?? ""} (${d.allowed_accounts[i].customer_id})`)) : h("div", { class: "muted" }, "No account is allowed yet; the app will see none.")),
    h("div", { class: "row" }, h("button", { class: "primary", onclick: decide(true) }, "Allow"), h("button", { onclick: decide(false) }, "Deny"))));
});
