import type { Ctx, Principal } from "../lib/context";
import { now } from "../lib/db";
import { NovaError } from "../lib/errors";
import { audit } from "../lib/audit";
import { isGlobalStop } from "../lib/settings";
import { adsFor, getAccountRow, resolveAccount, type AccountRow } from "./accounts";
import { KINDS, newPlan, planHash, setPath, validatePlanShape, PlanOperationSchema, type Plan, type PlanOperation } from "./plans";
import { attachBefore, compile, fetchCurrent, normalize, planAccount, savePlan } from "./planner";
import { camelToSnake, gaqlContains, gaqlString, pathGet, snakeToCamel } from "../google/gaql";
import { isRecommendationPlan, runRecommendations, validateRecommendations, verifyRecommendations } from "./recommendations";

interface PlanRow {
  id: string;
  account_id: string;
  status: string;
  hash: string;
  plan_json: string;
  created_by: string;
  created_at: number;
  expires_at: number;
  validated_at: number | null;
  validation_json: string | null;
}

/** A plan runs only after a Google validation of this exact content in the last 30 minutes. */
const VALIDATION_SECONDS = 1800;
const READY = ["ready", "awaiting_approval"]; // "awaiting_approval" is the name older databases used for the same state
const isReady = (row: { status: string; validated_at: number | null }): boolean => READY.includes(row.status) && !!row.validated_at && now() - row.validated_at <= VALIDATION_SECONDS;

export const loadPlan = async (ctx: Ctx, id: string): Promise<{ row: PlanRow; plan: Plan }> => {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new NovaError("invalid_input", "Invalid plan ID.", 400);
  const row = await ctx.db.first<PlanRow>("SELECT * FROM plans WHERE id = ?", id);
  if (!row) throw new NovaError("plan_not_found", "No such plan.", 404);
  return { row, plan: JSON.parse(row.plan_json) as Plan };
};

/** Plans are visible to AI callers only for accounts the administrator allowed. */
export const loadPlanFor = async (ctx: Ctx, p: Principal, id: string, scope: "read" | "draft" | "apply") => {
  const { row, plan } = await loadPlan(ctx, id);
  const account = await resolveAccount(ctx, p, row.account_id, scope);
  // The stored text must still hash to the stored hash; otherwise someone edited the row.
  if ((await planHash(plan)) !== row.hash) throw new NovaError("plan_tampered", "The stored plan no longer matches its hash. Create a new plan.", 409);
  return { row, plan, account };
};

const setStatus = (ctx: Ctx, id: string, status: string, extra: { validated_at?: number; validation_json?: string } = {}) =>
  ctx.db.run(
    "UPDATE plans SET status = ?, updated_at = ?, validated_at = COALESCE(?, validated_at), validation_json = COALESCE(?, validation_json) WHERE id = ?",
    status, now(), extra.validated_at ?? null, extra.validation_json ?? null, id,
  );

export const previewPlan = async (ctx: Ctx, p: Principal, id: string) => {
  const { row, plan } = await loadPlanFor(ctx, p, id, "read");
  const ready = isReady(row);
  return {
    status: row.status, plan, plan_hash: row.hash, validated_at: row.validated_at, validation: row.validation_json ? JSON.parse(row.validation_json) : null,
    ready_to_run: ready, validation_valid_until: row.validated_at ? row.validated_at + VALIDATION_SECONDS : null,
    plan_screen: `/#/plans/${id}`,
    warnings: ["Recovery cannot undo money already spent. Removal is disabled."],
    next_action: ready ? "Run execute_authorised_plan (needs the apply permission) or run it from the dashboard." : ["draft", "validation_failed"].includes(row.status) ? "Run validate_change_plan first." : undefined,
  };
};

// ----------------------------------------------------------------------- freshness
const IDENTITY = "SELECT customer.id, customer.currency_code, customer.time_zone, customer.manager, customer.status FROM customer LIMIT 1";

export const freshCheck = async (ctx: Ctx, account: AccountRow, plan: Plan): Promise<void> => {
  if (Date.parse(plan.expires_at) <= Date.now()) throw new NovaError("plan_expired", "This plan expired. Create a fresh one.", 409);
  const ads = adsFor(ctx, account);
  const r = await ads.search(account.customer_id, IDENTITY, 1);
  const c = r.rows[0]?.customer;
  if (!c || c.currencyCode !== plan.account.currency || c.timeZone !== plan.account.timezone || (c.manager === true) !== plan.account.manager) {
    throw new NovaError("stale_account", "Account identity (currency, timezone or type) changed after the draft.", 409);
  }
  if (c.status && c.status !== "ENABLED") throw new NovaError("account_not_enabled", `The Google Ads account status is ${c.status}.`, 409);
  const updates = plan.operations.filter((o) => o.action === "update");
  if (updates.length) {
    const current = await fetchCurrent(ctx, account, updates);
    for (const op of updates) {
      const res = current.get(op.resource_name!);
      const now_ = Object.fromEntries(op.field_mask.map((f) => [f, res ? (pathGet(res, f) ?? null) : undefined]));
      if (!res || JSON.stringify(normalize(now_)) !== JSON.stringify(normalize(op.before))) {
        throw new NovaError("stale_plan", `A field of ${op.resource_name} changed after the draft. Rebuild and review the plan.`, 409);
      }
    }
  }
  for (const op of plan.operations.filter((o) => o.kind === "campaign_budget" && o.action === "update")) {
    const camps = await ads.search(account.customer_id, `SELECT campaign.id, campaign.name, campaign.campaign_budget FROM campaign WHERE campaign.campaign_budget = ${gaqlString(op.resource_name!)} ORDER BY campaign.id LIMIT 200`, 200);
    const expected = (op.evidence.shared_budget_campaigns as { id: string }[] | undefined) ?? [];
    if (camps.truncated || JSON.stringify(camps.rows.map((x) => String(x.campaign?.id))) !== JSON.stringify(expected.map((x) => String(x.id)))) {
      throw new NovaError("stale_plan", "Campaigns sharing this budget changed. Review the full scope again.", 409);
    }
  }
};

// ----------------------------------------------------------------------- validate
export const validatePlan = async (ctx: Ctx, p: Principal, id: string) => {
  const { row, plan, account } = await loadPlanFor(ctx, p, id, "draft");
  if (["running", "succeeded", "partially_succeeded", "outcome_unknown", "failed", "cancelled", "rejected"].includes(row.status)) {
    throw new NovaError("already_final", `This plan is ${row.status}; validate a new plan instead.`, 409);
  }
  try {
    await freshCheck(ctx, account, plan);
    let validation: Record<string, unknown>;
    if (isRecommendationPlan(plan)) validation = await validateRecommendations(ctx, account, plan);
    else {
      const res = await adsFor(ctx, account).mutate(account.customer_id, compile(plan), { validateOnly: true });
      validation = { validated_operations: plan.operations.length, google_responses: (res.mutateOperationResponses ?? []).length, validate_only: true };
    }
    await setStatus(ctx, id, "ready", { validated_at: now(), validation_json: JSON.stringify(validation) });
    await audit(ctx.db, { actor_type: p.kind === "admin" ? "admin" : "mcp", actor_id: p.id, action: "plan_validated", target: id, outcome: "ok" });
    return { status: "ready", plan_hash: row.hash, validation, next_action: "Validated. Run execute_authorised_plan within 30 minutes (needs the apply permission), or run it from the dashboard." };
  } catch (e) {
    if (e instanceof NovaError) {
      await setStatus(ctx, id, "validation_failed", { validation_json: JSON.stringify({ code: e.code, message: e.message, details: e.details, request_id: e.requestId }) });
      await audit(ctx.db, { actor_type: p.kind === "admin" ? "admin" : "mcp", actor_id: p.id, action: "plan_validated", target: id, outcome: "error", detail: { code: e.code } });
    }
    throw e;
  }
};

// ----------------------------------------------------------------------- cancel (administrator)
export const cancelPlan = async (ctx: Ctx, adminId: string, id: string) => {
  const { row } = await loadPlan(ctx, id);
  if (["running", "succeeded", "partially_succeeded", "outcome_unknown", "failed"].includes(row.status)) throw new NovaError("already_final", `This plan is ${row.status}.`, 409);
  await setStatus(ctx, id, "cancelled");
  await audit(ctx.db, { actor_type: "admin", actor_id: adminId, action: "plan_cancelled", target: id, outcome: "ok", ip_hash: ctx.ipHash });
  return { status: "cancelled" };
};

// ----------------------------------------------------------------------- execute
type OpResult = { operation_id: string; status: "succeeded" | "failed" | "outcome_unknown"; resource_name: string | null; observed?: unknown; errors?: unknown[] };

const resourceOf = (response: Record<string, any> | undefined): string | null => {
  if (!response) return null;
  for (const v of Object.values(response)) if (v && typeof v === "object" && typeof (v as any).resourceName === "string") return (v as any).resourceName;
  return null;
};

export const verify = async (ctx: Ctx, account: AccountRow, plan: Plan, resources: (string | null)[]): Promise<OpResult[]> => {
  const ads = adsFor(ctx, account);
  const results: OpResult[] = [];
  const updates = plan.operations.filter((o) => o.action === "update");
  const current = updates.length ? await fetchCurrent(ctx, account, updates) : new Map();
  // Creates: batch an existence read per kind.
  const exists = new Set<string>();
  const byKind = new Map<string, string[]>();
  plan.operations.forEach((op, i) => { if (op.action === "create" && resources[i]) byKind.set(op.kind, [...(byKind.get(op.kind) ?? []), resources[i]!]); });
  for (const [kind, names] of byKind) {
    for (let i = 0; i < names.length; i += 100) {
      const chunk = names.slice(i, i + 100);
      const r = await ads.search(account.customer_id, `SELECT ${kind}.resource_name FROM ${kind} WHERE ${kind}.resource_name IN (${chunk.map(gaqlString).join(", ")}) LIMIT ${chunk.length}`, chunk.length);
      for (const row of r.rows) { const v = row[snakeToCamel(kind)]?.resourceName; if (v) exists.add(v); }
    }
  }
  plan.operations.forEach((op, i) => {
    const rn = resources[i] ?? op.resource_name ?? null;
    if (op.action === "update") {
      const res = current.get(op.resource_name!);
      const expectedPayload = op.payload;
      const observed = Object.fromEntries(op.field_mask.map((f) => [f, res ? (pathGet(res, f) ?? null) : null]));
      const expected = Object.fromEntries(op.field_mask.map((f) => [f, pathGet(expectedPayload, f)]));
      results.push({ operation_id: op.id, status: res && JSON.stringify(normalize(observed)) === JSON.stringify(normalize(expected)) ? "succeeded" : "outcome_unknown", resource_name: rn, observed });
    } else {
      results.push({ operation_id: op.id, status: rn && exists.has(rn) ? "succeeded" : "outcome_unknown", resource_name: rn });
    }
  });
  return results;
};

const overall = (results: OpResult[]): string => {
  const s = new Set(results.map((r) => r.status));
  return s.has("outcome_unknown") ? "outcome_unknown" : s.size === 1 && s.has("succeeded") ? "succeeded" : s.has("succeeded") ? "partially_succeeded" : "failed";
};

export const executePlan = async (ctx: Ctx, p: Principal, id: string) => {
  const { row, plan, account } = await loadPlanFor(ctx, p, id, "apply");
  if (["running", "succeeded", "partially_succeeded", "failed", "outcome_unknown"].includes(row.status)) return getOperationStatus(ctx, p, id);
  if (await isGlobalStop(ctx.db)) throw new NovaError("stopped", "The administrator's global stop blocks all account writes.", 423);
  if (!isReady(row)) throw new NovaError("validate_first", "Run validate_change_plan for this exact plan first. A Google validation is good for 30 minutes.", 409);
  if (row.expires_at <= now()) throw new NovaError("plan_expired", "This plan expired.", 409);

  const ads = adsFor(ctx, account);
  // Read-only pre-flight: nothing has been sent to Google that can change the account yet.
  await freshCheck(ctx, account, plan);
  if (isRecommendationPlan(plan)) await validateRecommendations(ctx, account, plan);
  else await ads.mutate(account.customer_id, compile(plan), { validateOnly: true });
  if (await isGlobalStop(ctx.db)) throw new NovaError("stopped", "Global stop changed before dispatch.", 423);

  // Compare-and-set: exactly one caller can move ready -> running, so a plan can never be dispatched twice.
  const claimed = await ctx.db.run("UPDATE plans SET status = 'running', updated_at = ? WHERE id = ? AND status IN ('ready', 'awaiting_approval')", now(), id);
  if (claimed !== 1) return getOperationStatus(ctx, p, id);
  await ctx.db.run("INSERT INTO executions (plan_id, status, started_at, executed_by) VALUES (?, 'running', ?, ?) ON CONFLICT(plan_id) DO NOTHING", id, now(), `${p.kind}:${p.label}`);
  await audit(ctx.db, { actor_type: p.kind === "admin" ? "admin" : "mcp", actor_id: p.id, action: "plan_execute_started", target: id, outcome: "ok" });

  let status = "failed";
  let results: OpResult[] = [];
  let errors: unknown[] = [];
  let requestId: string | undefined;
  try {
    if (isRecommendationPlan(plan)) {
      results = await runRecommendations(ctx, account, plan, (names) =>
        ctx.db.run("UPDATE executions SET results_json = ? WHERE plan_id = ?", JSON.stringify(names.map((r, i) => ({ operation_id: plan.operations[i]!.id, resource_name: r, status: "api_accepted" }))), id).then(() => undefined));
      status = overall(results);
    } else {
      const response = await ads.mutate(account.customer_id, compile(plan), { validateOnly: false });
      const resources = plan.operations.map((_, i) => resourceOf(response.mutateOperationResponses?.[i]));
      // Persist the API result before verification: a crash after this point still leaves the resource IDs.
      await ctx.db.run("UPDATE executions SET results_json = ? WHERE plan_id = ?", JSON.stringify(resources.map((r, i) => ({ operation_id: plan.operations[i]!.id, resource_name: r, status: "api_accepted" }))), id);
      results = await verify(ctx, account, plan, resources);
      status = overall(results);
    }
  } catch (e) {
    if (e instanceof NovaError) {
      status = e.code === "outcome_unknown" ? "outcome_unknown" : "failed";
      errors = [{ code: e.code, message: e.message, details: e.details }];
      requestId = e.requestId;
    } else {
      // An exception after dispatch cannot prove that nothing happened.
      status = "outcome_unknown";
      errors = [{ code: "unexpected_error" }];
    }
  }
  await ctx.db.run("UPDATE executions SET status = ?, finished_at = ?, results_json = COALESCE(?, results_json), errors_json = ?, request_id = ? WHERE plan_id = ?", status, now(), results.length ? JSON.stringify(results) : null, JSON.stringify(errors), requestId ?? null, id);
  await setStatus(ctx, id, status);
  await audit(ctx.db, { actor_type: p.kind === "admin" ? "admin" : "mcp", actor_id: p.id, action: "plan_executed", target: id, outcome: status === "succeeded" ? "ok" : "error", detail: { status } });
  return getOperationStatus(ctx, p, id);
};

export const getOperationStatus = async (ctx: Ctx, p: Principal, id: string) => {
  const { row } = await loadPlanFor(ctx, p, id, "read");
  const ex = await ctx.db.first<{ status: string; started_at: number; finished_at: number | null; results_json: string | null; errors_json: string | null; request_id: string | null; executed_by: string | null }>("SELECT * FROM executions WHERE plan_id = ?", id);
  let status = ex?.status ?? row.status;
  let next: string | undefined;
  // A crash or timeout can leave "running" behind; it needs inspection, never an automatic retry.
  if (status === "running" && ex && now() - ex.started_at > 300) { status = "outcome_unknown"; next = "Reconcile remote state. Execution may still have been applied."; }
  const results = ex?.results_json ? JSON.parse(ex.results_json) : [];
  return { plan_id: id, status, started_at: ex?.started_at ?? null, finished_at: ex?.finished_at ?? null, results, errors: ex?.errors_json ? JSON.parse(ex.errors_json) : [], request_id: ex?.request_id ?? null, executed_by: ex?.executed_by ?? null, next_action: next };
};

export const reconcilePlan = async (ctx: Ctx, p: Principal, id: string) => {
  const { row, plan, account } = await loadPlanFor(ctx, p, id, "draft");
  const ex = await ctx.db.first<{ status: string; results_json: string | null }>("SELECT status, results_json FROM executions WHERE plan_id = ?", id);
  if (!ex) throw new NovaError("nothing_to_reconcile", "This plan was never executed.", 409);
  if (isRecommendationPlan(plan)) {
    const results = await verifyRecommendations(ctx, account, plan);
    const status = overall(results);
    await ctx.db.run("UPDATE executions SET status = ?, results_json = ?, finished_at = COALESCE(finished_at, ?) WHERE plan_id = ?", status, JSON.stringify(results), now(), id);
    await setStatus(ctx, id, status);
    await audit(ctx.db, { actor_type: p.kind === "admin" ? "admin" : "mcp", actor_id: p.id, action: "plan_reconciled", target: id, outcome: "ok", detail: { status } });
    return getOperationStatus(ctx, p, id);
  }
  const prior = ex.results_json ? (JSON.parse(ex.results_json) as { resource_name: string | null }[]) : [];
  let resources: (string | null)[] = plan.operations.map((_, i) => prior[i]?.resource_name ?? null);
  // The response was lost (or an earlier reconcile saved only empty results): find creations by their unique plan tag in the name.
  const tag = plan.id.slice(0, 8);
  for (const kind of ["campaign", "campaign_budget"]) {
    const idx = plan.operations.findIndex((o) => o.kind === kind && o.action === "create");
    if (idx < 0 || resources[idx]) continue;
    const r = await adsFor(ctx, account).search(account.customer_id, `SELECT ${kind}.resource_name, ${kind}.name FROM ${kind} WHERE ${kind}.name LIKE ${gaqlContains(`[Nova ${tag}]`)} LIMIT 5`, 5);
    if (r.rows.length === 1) resources[idx] = r.rows[0]![snakeToCamel(kind)]?.resourceName ?? null;
  }
  const results = await verify(ctx, account, plan, resources);
  const status = overall(results);
  await ctx.db.run("UPDATE executions SET status = ?, results_json = ?, finished_at = COALESCE(finished_at, ?) WHERE plan_id = ?", status, JSON.stringify(results), now(), id);
  await setStatus(ctx, id, status);
  await audit(ctx.db, { actor_type: p.kind === "admin" ? "admin" : "mcp", actor_id: p.id, action: "plan_reconciled", target: id, outcome: "ok", detail: { status } });
  return getOperationStatus(ctx, p, id);
};

export const getChangeHistory = async (ctx: Ctx, p: Principal, accountId: string) => {
  const account = await resolveAccount(ctx, p, accountId, "read");
  const rows = await ctx.db.all<{ id: string; status: string; created_at: number; created_by: string; ex_status: string | null; finished_at: number | null }>(
    "SELECT p.id, p.status, p.created_at, p.created_by, e.status AS ex_status, e.finished_at FROM plans p LEFT JOIN executions e ON e.plan_id = p.id WHERE p.account_id = ? ORDER BY p.created_at DESC LIMIT 100",
    account.customer_id,
  );
  return rows.map((r) => ({ plan_id: r.id, status: r.ex_status ?? r.status, created_at: r.created_at, created_by: r.created_by, finished_at: r.finished_at }));
};

// ----------------------------------------------------------------------- recovery
export const createRecoveryPlan = async (ctx: Ctx, p: Principal, id: string) => {
  const { plan, account } = await loadPlanFor(ctx, p, id, "draft");
  const ex = await ctx.db.first<{ status: string; results_json: string | null }>("SELECT status, results_json FROM executions WHERE plan_id = ?", id);
  if (!ex || !["succeeded", "partially_succeeded"].includes(ex.status)) throw new NovaError("inspect_first", "Resolve uncertain or failed outcomes before drafting recovery.", 409);
  if (isRecommendationPlan(plan)) throw new NovaError("recovery_unavailable", "Nova Ads cannot undo an applied or dismissed recommendation. Review Google Ads change history and draft a new reviewed plan.", 409);
  const results = JSON.parse(ex.results_json ?? "[]") as OpResult[];
  const ops: PlanOperation[] = [];
  plan.operations.forEach((op, i) => {
    const r = results[i];
    if (!r || r.status !== "succeeded") return;
    if (op.action === "update") {
      if (Object.values(op.before).some((v) => v === null || v === undefined)) throw new NovaError("recovery_unavailable", "A previous value was unavailable; recovery needs manual review.", 409);
      const payload: Record<string, any> = {};
      for (const [k, v] of Object.entries(op.before)) setPath(payload, k, v);
      ops.push(PlanOperationSchema.parse({ id: `recover${op.id}`, kind: op.kind, action: "update", resource_name: op.resource_name, field_mask: op.field_mask, payload, reason: "Restore the previous reviewed field values.", spending_effect: "Previously spent money remains spent.", recovery: "Review a new plan to change settings again." }));
    } else if (["campaign", "ad_group", "ad_group_ad", "ad_group_criterion"].includes(op.kind) && r.resource_name) {
      ops.push(PlanOperationSchema.parse({ id: `recover${op.id}`, kind: op.kind, action: "update", resource_name: r.resource_name, field_mask: ["status"], payload: { status: "PAUSED" }, reason: "Pause the successfully created serving resource.", spending_effect: "Pauses future serving; existing charges remain.", recovery: "A separate launch approval can re-enable it." }));
    }
  });
  if (!ops.length) throw new NovaError("recovery_unavailable", "No supported reversible setting exists in this operation.", 409);
  await attachBefore(ctx, account, ops);
  const recovery = newPlan(`${p.kind}:${p.label}`, planAccount(account), ops, { recovery_of: id });
  validatePlanShape(recovery);
  return savePlan(ctx, p, recovery, account);
};

export { getAccountRow };
