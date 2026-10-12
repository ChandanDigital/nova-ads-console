import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:workers";
import { call, issueToken, mcpTool, resetDb, setupAdmin, type Session } from "./helpers";
import { FakeGoogle, CUSTOMER } from "./fake-google";
import { connectAndAllow, realMutates, searchSpec, validateMutates } from "./flow";

const fake = new FakeGoogle();
let s: Session;
let draft: string; // AI token with read+draft
let apply: string; // AI token with read+draft+apply

beforeEach(async () => {
  await resetDb();
  fake.reset();
  fake.install();
  s = await setupAdmin();
  await connectAndAllow(s, fake);
  draft = await issueToken(s, ["read", "draft"]);
  apply = await issueToken(s, ["read", "draft", "apply"]);
});
afterEach(() => {
  expect(fake.mutateSchemaErrors).toEqual([]); // every mutate body conformed to Google's schema
  fake.restore();
});

const BUDGET = `customers/${CUSTOMER}/campaignBudgets/777`;
const CAMPAIGN = `customers/${CUSTOMER}/campaigns/888`;
const seedExisting = () => {
  fake.seed(BUDGET, { name: "Existing budget", amountMicros: "200000000" });
  fake.seed(CAMPAIGN, { name: "Existing", status: "ENABLED", campaignBudget: BUDGET, networkSettings: { targetSearchNetwork: true } });
};

const newCampaignPlan = async (token = draft) => {
  const r = await mcpTool(token, "create_campaign_plan", { account_id: CUSTOMER, spec: searchSpec() });
  expect(r.isError, JSON.stringify(r.body)).toBe(false);
  return r.body.data as { plan_id: string; plan_hash: string; required_permissions: string[] };
};
const approve = (id: string, hash: string, perms: string[], extra: Record<string, unknown> = {}) =>
  call(`/api/plans/${id}/approve`, { method: "POST", session: s, body: { hash, permissions: perms, seconds: 3600, confirmation: "APPROVE", ...extra } });

describe("campaign creation workflow", () => {
  it("draft -> validate -> human approval -> execute, paused by default", async () => {
    const p = await newCampaignPlan();
    expect(p.required_permissions).toEqual(["create_campaign"]);

    // Cannot execute before validation or approval.
    let r = await mcpTool(apply, "execute_authorised_plan", { plan_id: p.plan_id });
    expect(r.isError).toBe(true);
    expect(r.body.errors[0].code).toBe("validate_first");

    r = await mcpTool(draft, "validate_change_plan", { plan_id: p.plan_id });
    expect(r.body.status).toBe("awaiting_approval");
    expect(validateMutates(fake).length).toBeGreaterThanOrEqual(1);
    expect(realMutates(fake).length).toBe(0);

    r = await mcpTool(apply, "execute_authorised_plan", { plan_id: p.plan_id });
    expect(r.isError).toBe(true);
    expect(r.body.status).toBe("awaiting_approval");
    expect(r.body.errors[0].message).toMatch(/human must approve/i);
    expect(realMutates(fake).length).toBe(0);

    expect((await approve(p.plan_id, p.plan_hash, p.required_permissions)).status).toBe(200);

    r = await mcpTool(apply, "execute_authorised_plan", { plan_id: p.plan_id });
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    expect(r.body.data.status).toBe("succeeded");
    expect(realMutates(fake).length).toBe(1);

    const campaign = [...fake.resources.values()].find((x) => x.name?.startsWith("Clinic Search [Nova") && !x.name.endsWith("budget"))!;
    expect(campaign.status).toBe("PAUSED"); // nothing launched automatically
    expect(campaign.campaignBudget).toMatch(/campaignBudgets\/\d+$/); // temp IDs were resolved
    const budget = [...fake.resources.values()].find((x) => x.name?.endsWith("budget"))!;
    expect(budget.amountMicros).toBe("250000000");
  });

  it("a plan can never run twice", async () => {
    const p = await newCampaignPlan();
    await mcpTool(draft, "validate_change_plan", { plan_id: p.plan_id });
    await approve(p.plan_id, p.plan_hash, p.required_permissions);
    await mcpTool(apply, "execute_authorised_plan", { plan_id: p.plan_id });
    const again = await mcpTool(apply, "execute_authorised_plan", { plan_id: p.plan_id });
    expect(again.body.data.status).toBe("succeeded");
    expect(realMutates(fake).length).toBe(1);
  });

  it("concurrent executions dispatch exactly once", async () => {
    const p = await newCampaignPlan();
    await mcpTool(draft, "validate_change_plan", { plan_id: p.plan_id });
    await approve(p.plan_id, p.plan_hash, p.required_permissions);
    await Promise.all([1, 2, 3].map(() => mcpTool(apply, "execute_authorised_plan", { plan_id: p.plan_id })));
    expect(realMutates(fake).length).toBe(1);
  });
});

describe("only a human can approve", () => {
  it("no MCP tool approves; AI tokens cannot call the approval route", async () => {
    const list = await (await import("./helpers")).mcpCall(apply, "tools/list");
    const names = list.json.result.tools.map((t: any) => t.name) as string[];
    expect(names.some((n) => /approv/i.test(n))).toBe(false);
    expect(names).toContain("execute_authorised_plan");
    const p = await newCampaignPlan();
    await mcpTool(draft, "validate_change_plan", { plan_id: p.plan_id });
    const viaToken = await call(`/api/plans/${p.plan_id}/approve`, { method: "POST", headers: { authorization: "Bearer " + apply }, body: { hash: p.plan_hash, permissions: p.required_permissions, confirmation: "APPROVE" } });
    expect(viaToken.status).toBe(403);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM approvals").first<{ n: number }>())!.n).toBe(0);
  });

  it("approval needs the typed word, the exact hash, every permission class and a fresh validation", async () => {
    const p = await newCampaignPlan();
    expect((await approve(p.plan_id, p.plan_hash, p.required_permissions)).json.error.code).toBe("validate_first");
    await mcpTool(draft, "validate_change_plan", { plan_id: p.plan_id });
    expect((await approve(p.plan_id, p.plan_hash, p.required_permissions, { confirmation: "yes" })).json.error.code).toBe("needs_confirmation");
    expect((await approve(p.plan_id, "0".repeat(64), p.required_permissions)).json.error.code).toBe("changed_plan");
    expect((await approve(p.plan_id, p.plan_hash, [])).json.error.code).toBe("incomplete_approval");
    expect((await approve(p.plan_id, p.plan_hash, p.required_permissions, { seconds: 5 })).json.error.code).toBe("invalid_expiry");
    await env.DB.prepare("UPDATE plans SET validated_at = validated_at - 4000").run();
    expect((await approve(p.plan_id, p.plan_hash, p.required_permissions)).json.error.code).toBe("validate_first");
  });

  it("an edited plan row invalidates the approval", async () => {
    const p = await newCampaignPlan();
    await mcpTool(draft, "validate_change_plan", { plan_id: p.plan_id });
    await approve(p.plan_id, p.plan_hash, p.required_permissions);
    const row = await env.DB.prepare("SELECT plan_json FROM plans WHERE id = ?").bind(p.plan_id).first<{ plan_json: string }>();
    await env.DB.prepare("UPDATE plans SET plan_json = ? WHERE id = ?").bind(row!.plan_json.replace("25000", "99000").replace("250000000", "990000000"), p.plan_id).run();
    const r = await mcpTool(apply, "execute_authorised_plan", { plan_id: p.plan_id });
    expect(r.isError).toBe(true);
    expect(r.body.errors[0].code).toBe("plan_tampered");
    expect(realMutates(fake).length).toBe(0);
  });

  it("expired and revoked approvals do not run", async () => {
    const p = await newCampaignPlan();
    await mcpTool(draft, "validate_change_plan", { plan_id: p.plan_id });
    await approve(p.plan_id, p.plan_hash, p.required_permissions);
    await env.DB.prepare("UPDATE approvals SET expires_at = 1").run();
    expect((await mcpTool(apply, "execute_authorised_plan", { plan_id: p.plan_id })).body.errors[0].code).toBe("approval_expired");
    await approve(p.plan_id, p.plan_hash, p.required_permissions);
    await call(`/api/plans/${p.plan_id}/revoke-approval`, { method: "POST", session: s });
    expect((await mcpTool(apply, "execute_authorised_plan", { plan_id: p.plan_id })).body.status).toBe("awaiting_approval");
    expect(realMutates(fake).length).toBe(0);
  });

  it("global stop blocks execution", async () => {
    const p = await newCampaignPlan();
    await mcpTool(draft, "validate_change_plan", { plan_id: p.plan_id });
    await approve(p.plan_id, p.plan_hash, p.required_permissions);
    await call("/api/settings/global-stop", { method: "POST", session: s, body: { stop: true } });
    const r = await mcpTool(apply, "execute_authorised_plan", { plan_id: p.plan_id });
    expect(r.body.errors[0].code).toBe("stopped");
    expect(realMutates(fake).length).toBe(0);
  });
});

describe("scopes and account permissions", () => {
  it("read tokens cannot draft; draft tokens cannot execute", async () => {
    const read = await issueToken(s, ["read"]);
    expect((await mcpTool(read, "create_campaign_plan", { account_id: CUSTOMER, spec: searchSpec() })).body.errors[0].code).toBe("forbidden");
    const p = await newCampaignPlan();
    expect((await mcpTool(draft, "execute_authorised_plan", { plan_id: p.plan_id })).body.errors[0].code).toBe("forbidden");
  });
  it("a block on the account stops AI access immediately", async () => {
    await call(`/api/accounts/${CUSTOMER}/allow`, { method: "POST", session: s, body: { allowed: false } });
    const r = await mcpTool(draft, "get_performance", { account_id: CUSTOMER, start: "2026-09-01", end: "2026-09-30" });
    expect(r.body.errors[0].code).toBe("account_not_allowed");
  });
  it("tokens can be restricted to specific accounts", async () => {
    await call("/api/accounts/add", { method: "POST", session: s, body: { customer_id: "1112223334", login_customer_id: "9998887776" } });
    const narrow = await issueToken(s, ["read"], { accounts: ["1112223334"] });
    const r = await mcpTool(narrow, "get_performance", { account_id: CUSTOMER, start: "2026-09-01", end: "2026-09-30" });
    expect(r.body.errors[0].code).toBe("account_not_allowed");
  });
  it("a plan from one account cannot be used through a token limited to another", async () => {
    const p = await newCampaignPlan();
    await call("/api/accounts/add", { method: "POST", session: s, body: { customer_id: "1112223334" } });
    const narrow = await issueToken(s, ["read", "draft", "apply"], { accounts: ["1112223334"] });
    expect((await mcpTool(narrow, "preview_change_plan", { plan_id: p.plan_id })).body.errors[0].code).toBe("account_not_allowed");
  });
});

describe("changing existing campaigns", () => {
  it("budget change shows the previous value and percentage, and executes only after approval", async () => {
    seedExisting();
    const r = await mcpTool(draft, "create_budget_change_plan", { account_id: CUSTOMER, budget_resource: BUDGET, new_daily_budget: "300", reason: "Campaign is budget-limited and profitable" });
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    const { plan_id, plan_hash, required_permissions } = r.body.data;
    expect(required_permissions).toEqual(["optimisation", "budget_change"]);
    const prev = await mcpTool(draft, "preview_change_plan", { plan_id });
    const op = prev.body.data.plan.operations[0];
    expect(op.before).toEqual({ amountMicros: "200000000" });
    expect(op.spending_effect).toMatch(/200\.00 to 300\.00 INR \(\+50%\)/);
    await mcpTool(draft, "validate_change_plan", { plan_id });
    await approve(plan_id, plan_hash, required_permissions);
    const ex = await mcpTool(apply, "execute_authorised_plan", { plan_id });
    expect(ex.body.data.status).toBe("succeeded");
    expect(fake.resources.get(BUDGET)!.amountMicros).toBe("300000000");
  });

  it("pause and enable go through the same gates; enabling needs the launch permission", async () => {
    seedExisting();
    const r = await mcpTool(draft, "create_status_change_plan", { account_id: CUSTOMER, kind: "campaign", resource_names: [CAMPAIGN], status: "PAUSED", reason: "Pause during review" });
    const { plan_id, plan_hash, required_permissions } = r.body.data;
    expect(required_permissions).toEqual(["optimisation"]);
    await mcpTool(draft, "validate_change_plan", { plan_id });
    await approve(plan_id, plan_hash, required_permissions);
    expect((await mcpTool(apply, "execute_authorised_plan", { plan_id })).body.data.status).toBe("succeeded");
    expect(fake.resources.get(CAMPAIGN)!.status).toBe("PAUSED");

    const en = await mcpTool(draft, "create_status_change_plan", { account_id: CUSTOMER, kind: "campaign", resource_names: [CAMPAIGN], status: "ENABLED", reason: "Resume" });
    expect(en.body.data.required_permissions).toEqual(["optimisation", "launch"]);
  });

  it("ad group bid and keyword status updates", async () => {
    const ag = `customers/${CUSTOMER}/adGroups/31`;
    const kw = `customers/${CUSTOMER}/adGroupCriteria/31~41`;
    fake.seed(ag, { name: "AG", status: "ENABLED", cpcBidMicros: "5000000" });
    fake.seed(kw, { status: "ENABLED", cpcBidMicros: "4000000" });
    const r = await mcpTool(draft, "create_optimisation_plan", {
      account_id: CUSTOMER,
      changes: [
        { kind: "ad_group", action: "update", resource_name: ag, field_mask: ["cpc_bid_micros"], payload: { cpc_bid_micros: "6000000" }, reason: "Raise bid for converting group" },
        { kind: "ad_group_criterion", action: "update", resource_name: kw, field_mask: ["status"], payload: { status: "PAUSED" }, reason: "Keyword spends without converting" },
      ],
    });
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    const { plan_id, plan_hash, required_permissions } = r.body.data;
    await mcpTool(draft, "validate_change_plan", { plan_id });
    await approve(plan_id, plan_hash, required_permissions);
    expect((await mcpTool(apply, "execute_authorised_plan", { plan_id })).body.data.status).toBe("succeeded");
    expect(fake.resources.get(ag)!.cpcBidMicros).toBe("6000000");
    expect(fake.resources.get(kw)!.status).toBe("PAUSED");
  });

  it("a change in Google after drafting is detected before anything is sent", async () => {
    seedExisting();
    const r = await mcpTool(draft, "create_budget_change_plan", { account_id: CUSTOMER, budget_resource: BUDGET, new_daily_budget: "300", reason: "Raise" });
    const { plan_id, plan_hash, required_permissions } = r.body.data;
    await mcpTool(draft, "validate_change_plan", { plan_id });
    await approve(plan_id, plan_hash, required_permissions);
    fake.resources.get(BUDGET)!.amountMicros = "250000000"; // someone edited it in Google Ads
    const ex = await mcpTool(apply, "execute_authorised_plan", { plan_id });
    expect(ex.body.errors[0].code).toBe("stale_plan");
    expect(realMutates(fake).length).toBe(0);
  });

  it("shared budgets list every campaign they affect", async () => {
    seedExisting();
    fake.seed(`customers/${CUSTOMER}/campaigns/889`, { name: "Second", status: "ENABLED", campaignBudget: BUDGET });
    const r = await mcpTool(draft, "create_budget_change_plan", { account_id: CUSTOMER, budget_resource: BUDGET, new_daily_budget: "300", reason: "Raise" });
    const prev = await mcpTool(draft, "preview_change_plan", { plan_id: r.body.data.plan_id });
    expect(prev.body.data.plan.operations[0].evidence.shared_budget_campaigns).toHaveLength(2);
    expect(prev.body.data.plan.operations[0].spending_effect).toMatch(/shared by 2 campaigns/);
  });

  it("the administrator's daily budget cap is enforced when drafting", async () => {
    seedExisting();
    await call("/api/settings/budget-cap", { method: "POST", session: s, body: { daily_budget: "280" } });
    const r = await mcpTool(draft, "create_budget_change_plan", { account_id: CUSTOMER, budget_resource: BUDGET, new_daily_budget: "300", reason: "Raise" });
    expect(r.body.errors[0].code).toBe("guardrail_budget_cap");
  });

  it("removal and unlisted fields cannot be drafted", async () => {
    seedExisting();
    const bad = await mcpTool(draft, "create_optimisation_plan", { account_id: CUSTOMER, changes: [{ kind: "campaign", action: "update", resource_name: CAMPAIGN, field_mask: ["status"], payload: { status: "REMOVED" }, reason: "delete it" }] });
    expect(bad.isError).toBe(true);
    const bad2 = await mcpTool(draft, "create_optimisation_plan", { account_id: CUSTOMER, changes: [{ kind: "campaign", action: "update", resource_name: CAMPAIGN, field_mask: ["advertising_channel_type"], payload: { advertising_channel_type: "DISPLAY" }, reason: "switch type" }] });
    expect(bad2.isError).toBe(true);
    expect(JSON.stringify(bad2.body)).toMatch(/not updatable/);
  });
});

describe("negative keywords need real evidence", () => {
  const change = (evidence: Record<string, unknown>) => ({
    kind: "campaign_criterion", action: "create", payload: { campaign: CAMPAIGN, negative: true, keyword: { text: "free dentist", match_type: "PHRASE" } },
    reason: "Irrelevant searches", evidence,
  });
  it("refuses without a saved search-term dataset, accepts with matching evidence", async () => {
    seedExisting();
    const none = await mcpTool(draft, "create_optimisation_plan", { account_id: CUSTOMER, changes: [change({})] });
    expect(none.body.errors[0].code).toBe("negative_needs_evidence");

    fake.cannedRows.search_term_view = [{ searchTermView: { searchTerm: "free dentist", status: "NONE" }, campaign: { id: "888" }, metrics: { clicks: "9", costMicros: "9000000", conversions: 0 } }];
    const terms = await mcpTool(draft, "get_search_terms", { account_id: CUSTOMER, start: "2026-09-01", end: "2026-09-30" });
    const dataset_id = terms.body.data.dataset_id;
    const ok = await mcpTool(draft, "create_optimisation_plan", {
      account_id: CUSTOMER,
      changes: [change({ dataset_id, search_term: "free dentist", match_type: "PHRASE", scope: { resource_name: CAMPAIGN }, business_relevance: "Clinic charges fees; free seekers never book", overblocking_review: "Could block 'free consultation' searches which we do offer" })],
    });
    expect(ok.isError, JSON.stringify(ok.body)).toBe(false);
    const wrongTerm = await mcpTool(draft, "create_optimisation_plan", {
      account_id: CUSTOMER,
      changes: [change({ dataset_id, search_term: "not in data", match_type: "PHRASE", scope: { resource_name: CAMPAIGN }, business_relevance: "long enough text", overblocking_review: "long enough text" })],
    });
    expect(wrongTerm.body.errors[0].code).toBe("negative_needs_evidence");
  });
});

describe("failure handling", () => {
  const readyPlan = async () => {
    const p = await newCampaignPlan();
    await mcpTool(draft, "validate_change_plan", { plan_id: p.plan_id });
    await approve(p.plan_id, p.plan_hash, p.required_permissions);
    return p;
  };
  it("a timeout after dispatch is outcome_unknown and is never retried", async () => {
    const p = await readyPlan();
    fake.mutateFailure = "timeout";
    const r = await mcpTool(apply, "execute_authorised_plan", { plan_id: p.plan_id });
    expect(r.body.data.status).toBe("outcome_unknown");
    expect(realMutates(fake).length).toBe(1);
    const again = await mcpTool(apply, "execute_authorised_plan", { plan_id: p.plan_id });
    expect(again.body.data.status).toBe("outcome_unknown");
    expect(realMutates(fake).length).toBe(1); // no automatic retry
  });
  it("a 5xx after dispatch is also outcome_unknown", async () => {
    const p = await readyPlan();
    fake.mutateFailure = "server_error";
    expect((await mcpTool(apply, "execute_authorised_plan", { plan_id: p.plan_id })).body.data.status).toBe("outcome_unknown");
  });
  it("reconcile finds resources that were created even though the response was lost", async () => {
    const p = await readyPlan();
    // Google applied the change but the answer never arrived: apply it to the fake, then lose the response.
    fake.mutateFailure = "timeout";
    await mcpTool(apply, "execute_authorised_plan", { plan_id: p.plan_id });
    fake.mutateFailure = null;
    const plan = JSON.parse((await env.DB.prepare("SELECT plan_json FROM plans WHERE id = ?").bind(p.plan_id).first<any>()).plan_json);
    fake.seed(`customers/${CUSTOMER}/campaigns/9001`, { name: `Clinic Search [Nova ${plan.id.slice(0, 8)}]`, status: "PAUSED" });
    fake.seed(`customers/${CUSTOMER}/campaignBudgets/9000`, { name: `Clinic Search [Nova ${plan.id.slice(0, 8)}] budget` });
    const r = await mcpTool(draft, "reconcile_operation", { plan_id: p.plan_id });
    const byOp = Object.fromEntries(r.body.data.results.map((x: any) => [x.operation_id, x]));
    expect(byOp.campaign.resource_name).toBe(`customers/${CUSTOMER}/campaigns/9001`);
    expect(byOp.campaign.status).toBe("succeeded");
    expect(r.body.data.status).toBe("outcome_unknown"); // children could not be located, so the plan is not claimed as complete
  });
  it("Google validation errors are reported with their field path and block approval", async () => {
    const p = await newCampaignPlan();
    fake.validateFailure = { status: 400, body: { error: { code: 400, message: "bad", details: [{ requestId: "r-9", errors: [{ errorCode: { campaignError: "DUPLICATE_CAMPAIGN_NAME" }, message: "dup", location: { fieldPathElements: [{ fieldName: "mutate_operations", index: 1 }, { fieldName: "campaign_operation" }] } }] }] } } };
    const v = await mcpTool(draft, "validate_change_plan", { plan_id: p.plan_id });
    expect(v.isError).toBe(true);
    expect(v.body.errors[0].details[0].field_path).toBe("mutate_operations[1].campaign_operation");
    expect(v.body.request_id).toBe("r-9");
    expect((await approve(p.plan_id, p.plan_hash, p.required_permissions)).status).toBe(409);
  });
  it("recovery restores previous values through a new plan that needs its own approval", async () => {
    seedExisting();
    const r = await mcpTool(draft, "create_budget_change_plan", { account_id: CUSTOMER, budget_resource: BUDGET, new_daily_budget: "300", reason: "Raise" });
    const { plan_id, plan_hash, required_permissions } = r.body.data;
    await mcpTool(draft, "validate_change_plan", { plan_id });
    await approve(plan_id, plan_hash, required_permissions);
    await mcpTool(apply, "execute_authorised_plan", { plan_id });
    const rec = await mcpTool(draft, "create_recovery_plan", { plan_id });
    expect(rec.isError, JSON.stringify(rec.body)).toBe(false);
    const prev = await mcpTool(draft, "preview_change_plan", { plan_id: rec.body.data.plan_id });
    expect(prev.body.data.plan.operations[0].payload).toEqual({ amountMicros: "200000000" });
    const exec = await mcpTool(apply, "execute_authorised_plan", { plan_id: rec.body.data.plan_id });
    expect(exec.body.errors[0].code).toBe("validate_first"); // the recovery plan is not even validated, let alone approved
    expect(fake.resources.get(BUDGET)!.amountMicros).toBe("300000000");
  });
  it("history lists plans with their outcome", async () => {
    const p = await readyPlan();
    await mcpTool(apply, "execute_authorised_plan", { plan_id: p.plan_id });
    const h = await mcpTool(draft, "get_change_history", { account_id: CUSTOMER });
    expect(h.body.data[0]).toMatchObject({ plan_id: p.plan_id, status: "succeeded" });
  });
});
