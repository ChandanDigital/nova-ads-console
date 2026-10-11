import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { call, issueToken, mcpTool, resetDb, setupAdmin, type Session } from "./helpers";
import { FakeGoogle, CUSTOMER } from "./fake-google";
import { connectAndAllow, realMutates, validateMutates } from "./flow";
import { newPlan } from "../src/ads/plans";
import { PlanOperationSchema } from "../src/ads/plans";

const rn = (id: string) => `customers/${CUSTOMER}/recommendations/${id}`;
const account = { customer_id: CUSTOMER, name: "T", currency: "INR", timezone: "Asia/Kolkata", manager: false, login_customer_id: null };

describe("apply and dismiss Google recommendations", () => {
  const fake = new FakeGoogle();
  let s: Session;
  let draft: string;
  let apply: string;
  beforeEach(async () => {
    await resetDb(); fake.reset(); fake.install();
    s = await setupAdmin();
    await connectAndAllow(s, fake);
    draft = await issueToken(s, ["read", "draft"]);
    apply = await issueToken(s, ["read", "draft", "apply"]);
    fake.seed(rn("kw1"), { type: "KEYWORD", dismissed: false, campaign: `customers/${CUSTOMER}/campaigns/11` });
    fake.seed(rn("kw2"), { type: "RESPONSIVE_SEARCH_AD", dismissed: false, campaign: `customers/${CUSTOMER}/campaigns/11` });
    fake.seed(rn("bud"), { type: "CAMPAIGN_BUDGET", dismissed: false, campaign: `customers/${CUSTOMER}/campaigns/11` });
  });
  afterEach(() => fake.restore());

  const approve = async (planId: string, hash: string, perms: string[]) =>
    (await call(`/api/plans/${planId}/approve`, { method: "POST", session: s, body: { hash, permissions: perms, seconds: 3600, confirmation: "APPROVE" } })).status;

  it("apply: draft, re-check, human approval, one all-or-nothing Google call, verified", async () => {
    const r = await mcpTool(draft, "create_recommendation_plan", { account_id: CUSTOMER, action: "apply", recommendations: ["kw1", rn("kw2")], reason: "Google suggests better ads and I reviewed it" });
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    const { plan_id, plan_hash, required_permissions } = r.body.data;
    expect(required_permissions).toEqual(["apply_recommendation"]);
    const v = await mcpTool(draft, "validate_change_plan", { plan_id });
    expect(v.body.status).toBe("awaiting_approval");
    // Google has no validate-only mode here, so nothing may be sent to the mutate endpoint, and the data says so.
    expect(validateMutates(fake).length).toBe(0);
    expect(v.body.data.validation.google_validate_only).toBe(false);
    // Without a human approval the AI cannot run it.
    expect((await mcpTool(apply, "execute_authorised_plan", { plan_id })).body.status).toBe("awaiting_approval");
    expect(fake.callsTo("recommendations:apply").length).toBe(0);
    expect(await approve(plan_id, plan_hash, required_permissions)).toBe(200);
    const ex = await mcpTool(apply, "execute_authorised_plan", { plan_id });
    expect(ex.body.status, JSON.stringify(ex.body)).toBe("succeeded");
    const sent = fake.callsTo("recommendations:apply");
    expect(sent.length).toBe(1);
    expect(sent[0]!.body).toEqual({ operations: [{ resourceName: rn("kw1") }, { resourceName: rn("kw2") }], partialFailure: false });
    expect(realMutates(fake).length).toBe(0);
    expect(fake.resources.has(rn("kw1"))).toBe(false);
    // Running again never calls Google again.
    await mcpTool(apply, "execute_authorised_plan", { plan_id });
    expect(fake.callsTo("recommendations:apply").length).toBe(1);
  });

  it("dismiss needs its own permission class and verifies the dismissed flag", async () => {
    const r = await mcpTool(draft, "create_recommendation_plan", { account_id: CUSTOMER, action: "dismiss", recommendations: ["kw1"], reason: "Not relevant to this business" });
    const { plan_id, plan_hash, required_permissions } = r.body.data;
    expect(required_permissions).toEqual(["dismiss_recommendation"]);
    await mcpTool(draft, "validate_change_plan", { plan_id });
    // approving with the wrong class is refused
    expect(await approve(plan_id, plan_hash, ["apply_recommendation"])).toBe(400);
    expect(await approve(plan_id, plan_hash, required_permissions)).toBe(200);
    const ex = await mcpTool(apply, "execute_authorised_plan", { plan_id });
    expect(ex.body.status).toBe("succeeded");
    expect(fake.resources.get(rn("kw1"))!.dismissed).toBe(true);
  });

  it("budget recommendations are refused and point to the budget plan", async () => {
    const r = await mcpTool(draft, "create_recommendation_plan", { account_id: CUSTOMER, action: "apply", recommendations: ["bud"], reason: "Spend more" });
    expect(r.isError).toBe(true);
    expect(r.body.errors[0].code).toBe("use_budget_plan");
  });

  it("unknown, already dismissed and malformed recommendations are refused before any plan exists", async () => {
    const missing = await mcpTool(draft, "create_recommendation_plan", { account_id: CUSTOMER, action: "apply", recommendations: ["nope"], reason: "test reason" });
    expect(missing.body.errors[0].code).toBe("recommendation_not_found");
    fake.seed(rn("old"), { type: "KEYWORD", dismissed: true });
    const dismissed = await mcpTool(draft, "create_recommendation_plan", { account_id: CUSTOMER, action: "apply", recommendations: ["old"], reason: "test reason" });
    expect(dismissed.body.errors[0].code).toBe("recommendation_dismissed");
    const other = await mcpTool(draft, "create_recommendation_plan", { account_id: CUSTOMER, action: "apply", recommendations: ["customers/9999999999/recommendations/x"], reason: "test reason" });
    expect(other.body.errors[0].code).toBe("invalid_resource");
    const empty = await mcpTool(draft, "create_recommendation_plan", { account_id: CUSTOMER, action: "apply", recommendations: [], reason: "test reason" });
    expect(empty.isError).toBe(true);
  });

  it("a recommendation that disappears or changes before validation makes the plan stale", async () => {
    const r = await mcpTool(draft, "create_recommendation_plan", { account_id: CUSTOMER, action: "apply", recommendations: ["kw1"], reason: "test reason" });
    fake.resources.delete(rn("kw1"));
    const v = await mcpTool(draft, "validate_change_plan", { plan_id: r.body.data.plan_id });
    expect(v.isError).toBe(true);
    expect(v.body.errors[0].code).toBe("stale_plan");
  });

  it("Google accepting the call but changing nothing is reported as outcome_unknown, never as success", async () => {
    const r = await mcpTool(draft, "create_recommendation_plan", { account_id: CUSTOMER, action: "apply", recommendations: ["kw1"], reason: "test reason" });
    const { plan_id, plan_hash, required_permissions } = r.body.data;
    await mcpTool(draft, "validate_change_plan", { plan_id });
    await approve(plan_id, plan_hash, required_permissions);
    fake.recommendNoEffect = true;
    const ex = await mcpTool(apply, "execute_authorised_plan", { plan_id });
    expect(ex.body.status).toBe("outcome_unknown");
    expect(fake.callsTo("recommendations:apply").length).toBe(1);
    // Reconcile only inspects; once Google has caught up it reports the truth.
    fake.recommendNoEffect = false; fake.resources.delete(rn("kw1"));
    const rec = await mcpTool(draft, "reconcile_operation", { plan_id });
    expect(rec.body.status).toBe("succeeded");
    expect(fake.callsTo("recommendations:apply").length).toBe(1);
  });

  it("a Google error leaves the plan failed and is not retried", async () => {
    const r = await mcpTool(draft, "create_recommendation_plan", { account_id: CUSTOMER, action: "apply", recommendations: ["kw1"], reason: "test reason" });
    const { plan_id, plan_hash, required_permissions } = r.body.data;
    await mcpTool(draft, "validate_change_plan", { plan_id });
    await approve(plan_id, plan_hash, required_permissions);
    fake.recommendFailure = { status: 400, body: { error: { code: 400, message: "bad", details: [{ errors: [{ errorCode: { recommendationError: "INVALID_ARGUMENT" }, message: "cannot apply" }] }] } } };
    const ex = await mcpTool(apply, "execute_authorised_plan", { plan_id });
    expect(ex.body.status).toBe("failed");
    expect(fake.callsTo("recommendations:apply").length).toBe(1);
  });

  it("the global stop blocks it and recovery plans are not offered", async () => {
    const r = await mcpTool(draft, "create_recommendation_plan", { account_id: CUSTOMER, action: "apply", recommendations: ["kw1"], reason: "test reason" });
    const { plan_id, plan_hash, required_permissions } = r.body.data;
    await mcpTool(draft, "validate_change_plan", { plan_id });
    await approve(plan_id, plan_hash, required_permissions);
    await call("/api/settings/global-stop", { method: "POST", session: s, body: { stop: true } });
    const blocked = await mcpTool(apply, "execute_authorised_plan", { plan_id });
    expect(blocked.body.errors[0].code).toBe("stopped");
    expect(fake.callsTo("recommendations:apply").length).toBe(0);
    await call("/api/settings/global-stop", { method: "POST", session: s, body: { stop: false } });
    await mcpTool(apply, "execute_authorised_plan", { plan_id });
    const rec = await mcpTool(draft, "create_recovery_plan", { plan_id });
    expect(rec.body.errors[0].code).toBe("recovery_unavailable");
  });

  it("read-only tokens cannot draft, and an AI cannot approve", async () => {
    const read = await issueToken(s, ["read"]);
    const r = await mcpTool(read, "create_recommendation_plan", { account_id: CUSTOMER, action: "apply", recommendations: ["kw1"], reason: "test reason" });
    expect(r.isError).toBe(true);
    expect(r.body.errors[0].code).toBe("forbidden");
  });
});

describe("plan shape rules for recommendations", () => {
  const rec = (id: string, action: "apply" | "dismiss", name: string) => PlanOperationSchema.parse({ id, kind: "recommendation", action, resource_name: rn(name), payload: {}, reason: "reason text", spending_effect: "effect text", recovery: "recovery text", evidence: { type: "KEYWORD" } });
  it("cannot be mixed with other changes, with each other's action, or repeated", () => {
    const campaignOp = PlanOperationSchema.parse({ id: "c", kind: "campaign", action: "update", resource_name: `customers/${CUSTOMER}/campaigns/1`, field_mask: ["status"], payload: { status: "PAUSED" }, reason: "reason text", spending_effect: "effect text", recovery: "recovery text" });
    expect(() => newPlan("t", account, [rec("a", "apply", "x"), campaignOp], {})).toThrow(/cannot be mixed/);
    expect(() => newPlan("t", account, [rec("a", "apply", "x"), rec("b", "dismiss", "y")], {})).toThrow(/separate plans/);
    expect(() => newPlan("t", account, [rec("a", "apply", "x"), rec("b", "apply", "x")], {})).toThrow(/once per plan/);
    expect(() => newPlan("t", account, [campaignOp, { ...campaignOp, id: "d", action: "apply" as const }], {})).toThrow();
    expect(newPlan("t", account, [rec("a", "apply", "x"), rec("b", "apply", "y")], {}).required_permissions).toEqual(["apply_recommendation"]);
  });
});
