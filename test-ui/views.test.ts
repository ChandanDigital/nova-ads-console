import { describe, it, expect, beforeEach, vi } from "vitest";
// @ts-expect-error browser ES modules without type declarations
import { state } from "../public/core.js";
// @ts-expect-error browser ES modules without type declarations
import { viewAccounts, viewApprovals, viewConsent, viewAi, viewOverview } from "../public/views-main.js";
// @ts-expect-error browser ES modules without type declarations
import { viewLogin, viewSetup } from "../public/views-auth.js";

type Call = { method: string; path: string; body: any; headers: Record<string, string> };
let calls: Call[] = [];
let routes: Record<string, (body: any) => unknown> = {};

const tick = async (ms = 30) => { await new Promise((r) => setTimeout(r, ms)); };
const root = () => document.getElementById("root")!;
const click = async (el: Element | null | undefined) => { expect(el, "element to click").toBeTruthy(); (el as HTMLElement).click(); await tick(); };

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div><div id="toasts"></div>';
  calls = [];
  routes = {};
  state.csrf = "csrf-token-1";
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("fetch", async (path: string, init: any = {}) => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body, headers: init.headers ?? {} });
    const key = `${method} ${path.split("?")[0]}`;
    const handler = routes[key];
    if (!handler) return new Response(JSON.stringify({ error: { code: "no_route", message: "no route " + key } }), { status: 404 });
    return new Response(JSON.stringify(handler(body)), { status: 200 });
  });
});

const PLAN = {
  status: "awaiting_approval",
  plan_hash: "h".repeat(64),
  validated_at: 1,
  validation: { validate_only: true },
  approval: null,
  plan: {
    account: { name: "Clinic", customer_id: "3010086756", currency: "INR", timezone: "Asia/Kolkata" },
    required_permissions: ["optimisation", "budget_change"],
    operations: [
      { kind: "campaign_budget", action: "update", resource_name: "customers/3010086756/campaignBudgets/1", field_mask: ["amountMicros"], before: { amountMicros: "200000000" }, payload: { amountMicros: "300000000" }, spending_effect: "Daily budget changes from 200.00 to 300.00 INR (+50%).", recovery: "Restore previous values.", reason: "Profitable and budget-limited", evidence: {} },
    ],
  },
};

describe("approval screen", () => {
  it("shows exactly what changes and posts the approval with hash, permissions, expiry and typed word", async () => {
    routes["GET /api/plans/abc"] = () => PLAN;
    routes["POST /api/plans/abc/approve"] = () => ({ ok: true });
    await viewApprovals(root(), "abc");
    await tick();
    const text = root().textContent!;
    expect(text).toContain("200000000");
    expect(text).toContain("300000000");
    expect(text).toContain("+50%");
    expect(text).toContain("Profitable and budget-limited");
    expect(text).toContain("h".repeat(64));

    const approve = [...root().querySelectorAll("button")].find((b) => b.textContent === "Approve this exact plan")!;
    // Without the typed word the server must refuse; the UI still sends what the human typed, never a hard-coded value.
    (root().querySelector("#approve-typed") as HTMLInputElement).value = "APPROVE";
    (root().querySelector("#approve-secs") as HTMLSelectElement).value = "900";
    (root().querySelector("#perm-budget_change") as HTMLInputElement).checked = false;
    await click(approve);
    const post = calls.find((c) => c.path === "/api/plans/abc/approve")!;
    expect(post.method).toBe("POST");
    expect(post.headers["x-csrf-token"]).toBe("csrf-token-1");
    expect(post.body).toEqual({ hash: "h".repeat(64), permissions: ["optimisation"], seconds: 900, confirmation: "APPROVE" });
  });

  it("shows a recommendation action in plain words, with a print button that carries no inline script", async () => {
    const plan = { ...PLAN, plan: { ...PLAN.plan, required_permissions: ["apply_recommendation"], operations: [{ id: "rec0", kind: "recommendation", action: "apply", resource_name: "customers/3010086756/recommendations/kw1", field_mask: [], before: {}, payload: {}, evidence: { type: "KEYWORD", campaign: "customers/3010086756/campaigns/11" }, reason: "Google suggests it", spending_effect: "Google applies this KEYWORD recommendation as Google generated it.", recovery: "Nodi cannot undo it." }] } };
    routes["GET /api/plans/rec"] = () => plan;
    await viewApprovals(root(), "rec");
    await tick();
    expect(root().textContent).toContain("APPLY Google recommendation KEYWORD");
    expect(root().textContent).toContain("apply_recommendation");
    const print = root().querySelector("[data-print]") as HTMLButtonElement;
    expect(print.textContent).toBe("Print / Save as PDF");
    expect(print.hasAttribute("onclick")).toBe(false);
  });

  it("does not offer approval when the plan is not awaiting approval", async () => {
    routes["GET /api/plans/abc"] = () => ({ ...PLAN, status: "draft" });
    await viewApprovals(root(), "abc");
    await tick();
    expect([...root().querySelectorAll("button")].some((b) => b.textContent === "Approve this exact plan")).toBe(false);
    expect([...root().querySelectorAll("button")].some((b) => b.textContent === "Validate again with Google")).toBe(true);
  });

  it("offers 'run now' only when an approval is active", async () => {
    routes["GET /api/plans/abc"] = () => ({ ...PLAN, approval: { active: true, approved_at: 1, expires_at: 2, permissions: ["optimisation"], revoked: false } });
    await viewApprovals(root(), "abc");
    await tick();
    const labels = [...root().querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toContain("Run approved plan now");
    expect(labels).toContain("Revoke approval");
  });

  it("renders hostile text from Google or an AI as plain text, never as HTML", async () => {
    const evil = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>`;
    const plan = JSON.parse(JSON.stringify(PLAN));
    plan.plan.account.name = evil;
    plan.plan.operations[0].reason = evil;
    plan.plan.operations[0].spending_effect = evil;
    routes["GET /api/plans/abc"] = () => plan;
    await viewApprovals(root(), "abc");
    await tick();
    expect(root().querySelector("img")).toBeNull();
    expect(root().querySelector("script")).toBeNull();
    expect(root().textContent).toContain(evil);
    expect((window as any).__pwned).toBeUndefined();
  });
});

describe("accounts screen", () => {
  it("toggling an account sends the switch value with the CSRF token; names are plain text", async () => {
    const evil = `<b onclick="x()">Shop</b>`;
    routes["GET /api/accounts"] = () => [{ customer_id: "3010086756", name: evil, manager: false, allowed: false, currency: "INR", timezone: "Asia/Kolkata", status: "ENABLED", connection_id: "c1", login_customer_id: null }];
    routes["POST /api/accounts/3010086756/allow"] = () => ({ ok: true });
    await viewAccounts(root());
    await tick();
    expect(root().querySelector("b")).toBeNull();
    expect(root().textContent).toContain(evil);
    const toggle = root().querySelector('input[type="checkbox"]') as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    await tick();
    const post = calls.find((c) => c.path.endsWith("/allow"))!;
    expect(post.body).toEqual({ allowed: true });
    expect(post.headers["x-csrf-token"]).toBe("csrf-token-1");
  });
});

describe("consent screen for AI apps", () => {
  it("shows who is asking and where it returns, and submits only the scopes and accounts the human left ticked", async () => {
    routes["GET /api/oauth/pending/req1"] = () => ({ client: { name: "Claude", id: "nova_c_1", redirect_host: "claude.ai" }, requested_scopes: ["read", "draft", "apply"], allowed_accounts: [{ customer_id: "3010086756", name: "Clinic" }, { customer_id: "1112223334", name: "Other" }] });
    routes["POST /api/oauth/pending/req1/decision"] = () => ({ redirect: "about:blank#done" });
    await viewConsent(root(), "req1");
    await tick();
    expect(root().textContent).toContain("Claude");
    expect(root().textContent).toContain("claude.ai");
    (root().querySelector("#cs-apply") as HTMLInputElement).checked = false;
    (root().querySelector("#ca-1112223334") as HTMLInputElement).checked = false;
    await click([...root().querySelectorAll("button")].find((b) => b.textContent === "Allow"));
    const post = calls.find((c) => c.path.endsWith("/decision"))!;
    expect(post.body).toEqual({ approve: true, scopes: ["read", "draft"], accounts: ["3010086756"] });
  });
  it("Deny sends approve:false", async () => {
    routes["GET /api/oauth/pending/req1"] = () => ({ client: { name: "X", id: "i", redirect_host: "h" }, requested_scopes: ["read"], allowed_accounts: [] });
    routes["POST /api/oauth/pending/req1/decision"] = () => ({ redirect: "about:blank#denied" });
    await viewConsent(root(), "req1");
    await tick();
    await click([...root().querySelectorAll("button")].find((b) => b.textContent === "Deny"));
    expect(calls.find((c) => c.path.endsWith("/decision"))!.body.approve).toBe(false);
  });
});

describe("AI access screen", () => {
  it("creates a token with only the ticked scopes and shows it once", async () => {
    routes["GET /api/tokens"] = () => [];
    routes["GET /api/mcp-info"] = () => ({ mcp_url: "https://x.example/mcp", transport: "t", discovery: ["https://x.example/.well-known/oauth-protected-resource"] });
    routes["POST /api/tokens"] = (b) => ({ token: "nova_api_SECRET", scopes: b.scopes });
    await viewAi(root());
    await tick();
    (root().querySelector("#tok-label") as HTMLInputElement).value = "laptop";
    (root().querySelector("#sc-apply") as HTMLInputElement).checked = true;
    (root().querySelector("#sc-draft") as HTMLInputElement).checked = false;
    root().querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await tick(80);
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/tokens")!;
    expect(post.body).toEqual({ label: "laptop", scopes: ["read", "apply"], days: 30 });
    expect(root().textContent).toContain("nova_api_SECRET");
    expect(root().textContent).toContain("shown once");
  });
});

describe("sign-in screens", () => {
  it("setup: the credential is shown once and Continue stays disabled until the box is ticked", async () => {
    routes["POST /api/auth/setup"] = () => ({ credential: "nova_admin_ONLYONCE", csrf: "c2" });
    const done = vi.fn();
    viewSetup(root(), () => {}, done);
    (root().querySelector("#setup-secret") as HTMLInputElement).value = "my-setup-secret";
    root().querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await tick(60);
    expect(root().textContent).toContain("nova_admin_ONLYONCE");
    const go = [...root().querySelectorAll("button")].find((b) => b.textContent === "Continue") as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    const box = root().querySelector("#saved") as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    expect(go.disabled).toBe(false);
    go.click();
    expect(done).toHaveBeenCalled();
    expect(state.csrf).toBe("c2");
    expect(calls[0]!.body).toEqual({ setup_secret: "my-setup-secret" });
  });
  it("login posts the trimmed credential and moves on", async () => {
    routes["POST /api/auth/login"] = () => ({ ok: true, csrf: "c3" });
    const done = vi.fn();
    viewLogin(root(), () => {}, done, () => {});
    (root().querySelector("#credential") as HTMLInputElement).value = "  nova_admin_abc  ";
    root().querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await tick(60);
    expect(calls[0]!.body).toEqual({ credential: "nova_admin_abc" });
    expect(done).toHaveBeenCalled();
  });
  it("a failed login shows the server's message instead of crashing", async () => {
    viewLogin(root(), () => {}, () => {}, () => {});
    (root().querySelector("#credential") as HTMLInputElement).value = "bad";
    root().querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await tick(60);
    expect(document.getElementById("toasts")!.textContent).toMatch(/no route|not correct|HTTP/);
  });
});

describe("overview alerts", () => {
  const overview = { connections: [{ status: "active", email: "o@example.com" }], accounts: { total: 1, allowed: 1 }, pending_plans: [], recent_activity: [], usage: { metrics: [] }, global_stop: false, mcp_url: "https://x/mcp", secrets_ok: true };
  const setup = (alerts: unknown) => {
    routes["GET /api/overview"] = () => overview;
    routes["GET /api/diagnostics"] = () => [];
    routes["GET /api/tokens"] = () => [];
    routes["GET /api/alerts"] = () => alerts;
  };
  it("lists open alerts as plain text and can run the check", async () => {
    setup({ last_check_at: 1760000000, last_result: null, alerts: [{ id: 1, account_id: "3010086756", kind: "spend_no_conversions", severity: "warn", title: "<img src=x onerror=alert(1)> Burning money", detail: { note: "Check tracking." }, first_seen: 1760000000, last_seen: 1760000000, resolved_at: null }] });
    routes["POST /api/alerts/run"] = () => ({ accounts: 1, raised: 1, resolved: 0, errors: 0 });
    await viewOverview(root(), { setPending() {} });
    await tick();
    expect(root().textContent).toContain("Burning money");
    expect(root().textContent).toContain("Check tracking.");
    expect(root().querySelector("img")).toBeNull();
    await click(root().querySelector("#alerts-run"));
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/alerts/run" && c.headers["x-csrf-token"] === "csrf-token-1")).toBe(true);
  });
  it("says so when there are none", async () => {
    setup({ last_check_at: null, last_result: null, alerts: [] });
    await viewOverview(root(), { setPending() {} });
    await tick();
    expect(root().textContent).toContain("No open alerts.");
  });
});
