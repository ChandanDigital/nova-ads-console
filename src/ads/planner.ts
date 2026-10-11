import type { Ctx, Principal } from "../lib/context";
import { now } from "../lib/db";
import { NodiError } from "../lib/errors";
import { audit } from "../lib/audit";
import { getSetting } from "../lib/settings";
import { adsFor, resolveAccount, type AccountRow } from "./accounts";
import {
  KINDS, PlanOperationSchema, SearchSpecSchema, camelKeys, camelPath, newPlan, planHash, searchCampaignOperations, rsaValidate, resourceValid,
  type Plan, type PlanAccount, type PlanOperation,
} from "./plans";
import { camelToSnake, gaqlString, moneyMicros, pathGet, snakeToCamel } from "../google/gaql";
import { rowsToObject } from "./util";

export const planAccount = (a: AccountRow): PlanAccount => ({
  customer_id: a.customer_id,
  name: a.name ?? "Unnamed account",
  currency: a.currency ?? "USD",
  timezone: a.timezone ?? "UTC",
  manager: !!a.manager,
  login_customer_id: a.login_customer_id,
});

/** Turns a plan into the JSON body entries for GoogleAdsService.Mutate. */
export const compile = (plan: Plan): unknown[] =>
  plan.operations.map((op) => {
    const info = KINDS[op.kind]!;
    if (op.action === "create") return { [info.op]: { create: op.payload } };
    return { [info.op]: { update: { ...op.payload, resourceName: op.resource_name }, updateMask: op.field_mask.join(",") } };
  });

/** Compares Google values loosely (int64 arrives as a string, numbers as numbers). */
export const normalize = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, normalize(x)]));
  if (typeof v === "number") return String(v);
  return v;
};

/** Reads the current value of every masked field for update operations, in as few Google calls as possible. */
export const fetchCurrent = async (ctx: Ctx, account: AccountRow, ops: PlanOperation[]): Promise<Map<string, Record<string, unknown>>> => {
  const ads = adsFor(ctx, account);
  const out = new Map<string, Record<string, unknown>>();
  const byKind = new Map<string, PlanOperation[]>();
  for (const op of ops.filter((o) => o.action === "update")) byKind.set(op.kind, [...(byKind.get(op.kind) ?? []), op]);
  for (const [kind, list] of byKind) {
    const paths = [...new Set(list.flatMap((o) => o.field_mask))];
    const names = [...new Set(list.map((o) => o.resource_name!))];
    for (let i = 0; i < names.length; i += 100) {
      const chunk = names.slice(i, i + 100);
      const select = [`${kind}.resource_name`, ...paths.map((p) => `${kind}.${p.split(".").map(camelToSnake).join(".")}`)].join(", ");
      const q = `SELECT ${select} FROM ${kind} WHERE ${kind}.resource_name IN (${chunk.map(gaqlString).join(", ")}) LIMIT ${chunk.length}`;
      const r = await ads.search(account.customer_id, q, chunk.length);
      const key = snakeToCamel(kind);
      for (const row of r.rows) {
        const res = row[key];
        if (res?.resourceName) out.set(res.resourceName, res);
      }
    }
  }
  return out;
};

export const attachBefore = async (ctx: Ctx, account: AccountRow, ops: PlanOperation[]): Promise<void> => {
  const current = await fetchCurrent(ctx, account, ops);
  for (const op of ops.filter((o) => o.action === "update")) {
    const res = current.get(op.resource_name!);
    if (!res) throw new NodiError("resource_missing", `Resource ${op.resource_name} was not found in this account.`, 404);
    op.before = Object.fromEntries(op.field_mask.map((f) => [f, pathGet(res, f) ?? null]));
  }
};

const guardrail = async (ctx: Ctx, ops: PlanOperation[], account: AccountRow): Promise<void> => {
  const cap = await getSetting(ctx.db, "max_daily_budget_micros");
  if (!cap) return;
  const limit = BigInt(cap);
  for (const op of ops) {
    if (op.kind !== "campaign_budget") continue;
    const v = op.payload.amountMicros;
    if (v !== undefined && BigInt(String(v)) > limit) {
      throw new NodiError("guardrail_budget_cap", `The administrator's daily budget cap is ${(Number(limit) / 1e6).toFixed(2)} ${account.currency}. This plan asks for ${(Number(BigInt(String(v))) / 1e6).toFixed(2)}.`, 422);
    }
  }
};

export const savePlan = async (ctx: Ctx, p: Principal, plan: Plan, account: AccountRow): Promise<{ plan_id: string; plan_hash: string; operation_count: number; required_permissions: string[]; status: string }> => {
  await guardrail(ctx, plan.operations, account);
  const hash = await planHash(plan);
  const t = now();
  await ctx.db.run(
    "INSERT INTO plans (id, account_id, status, hash, plan_json, created_by, created_at, expires_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    plan.id, plan.account.customer_id, "draft", hash, JSON.stringify(plan), `${p.kind}:${p.label}`, t, Math.floor(Date.parse(plan.expires_at) / 1000), t,
  );
  await audit(ctx.db, { actor_type: p.kind === "admin" ? "admin" : "mcp", actor_id: p.id, action: "plan_created", target: plan.id, outcome: "ok", detail: { account: plan.account.customer_id, operations: plan.operations.length } });
  return { plan_id: plan.id, plan_hash: hash, operation_count: plan.operations.length, required_permissions: plan.required_permissions, status: "draft" };
};

// --------------------------------------------------------------------------- campaign creation
export const createCampaignPlan = async (ctx: Ctx, p: Principal, id: string, specInput: unknown) => {
  const account = await resolveAccount(ctx, p, id, "draft");
  const parsed = SearchSpecSchema.safeParse(specInput);
  if (!parsed.success) {
    throw new NodiError("invalid_input", "Check the campaign fields.", 400, parsed.error.issues.slice(0, 20).map((i) => ({ field: i.path.join("."), problem: i.message })));
  }
  const planId = crypto.randomUUID();
  const ops = searchCampaignOperations(parsed.data, planAccount(account), planId.slice(0, 8));
  const plan = newPlan(`${p.kind}:${p.label}`, planAccount(account), ops, parsed.data.business_context);
  plan.id = planId; // the visible tag in the campaign name uses this ID
  return savePlan(ctx, p, plan, account);
};

// --------------------------------------------------------------------------- optimisation changes
const ChangeSchema = PlanOperationSchema.partial({ id: true, spending_effect: true, recovery: true, field_mask: true, before: true, depends_on: true, evidence: true });

const describeEffect = (op: PlanOperation, currency: string): string => {
  if (op.kind === "campaign_budget" && op.field_mask.includes("amountMicros")) {
    const before = op.before.amountMicros !== undefined && op.before.amountMicros !== null ? Number(op.before.amountMicros) : null;
    const after = Number(op.payload.amountMicros);
    const pct = before ? ` (${after >= before ? "+" : ""}${Math.round(((after - before) / before) * 100)}%)` : "";
    return `Daily budget changes from ${before === null ? "unknown" : (before / 1e6).toFixed(2)} to ${(after / 1e6).toFixed(2)} ${currency}${pct}.`;
  }
  if (op.payload.status === "ENABLED") return "Enabling lets this resource serve and spend. Money spent stays spent.";
  if (op.payload.status === "PAUSED") return "Pausing stops serving; no new spend from this resource.";
  if (op.action === "create") return "Creates a new resource; it can only spend once enabled and served.";
  return "Changes settings that can affect delivery and spend.";
};

export const createOptimisationPlan = async (ctx: Ctx, p: Principal, id: string, changes: unknown[], business: Record<string, unknown>) => {
  const account = await resolveAccount(ctx, p, id, "draft");
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > 100) throw new NodiError("invalid_input", "Send 1 to 100 changes.", 400);
  const ops: PlanOperation[] = [];
  for (let i = 0; i < changes.length; i++) {
    const raw = changes[i] as Record<string, unknown>;
    // The original Nodi Ads used snake_case field names; both spellings are accepted.
    const normalized = { ...raw, payload: camelKeys(raw?.payload ?? {}), field_mask: ((raw?.field_mask as string[]) ?? []).map(camelPath), resource_name: raw?.resource_name };
    const parsed = ChangeSchema.safeParse(normalized);
    if (!parsed.success) throw new NodiError("invalid_input", `Change ${i + 1} is not valid.`, 400, parsed.error.issues.slice(0, 10).map((x) => ({ field: x.path.join("."), problem: x.message })));
    const c = parsed.data;
    const op: PlanOperation = {
      ...c, id: c.id ?? `change${i}`, field_mask: c.field_mask ?? [], before: {}, depends_on: c.depends_on ?? [], evidence: c.evidence ?? {},
      spending_effect: c.spending_effect ?? "pending", recovery: c.recovery ?? "Restore the previous values through a new reviewed plan. Money already spent stays spent.",
    };
    if (op.action === "create" && ["campaign", "campaign_budget", "ad_group"].includes(op.kind)) {
      throw new NodiError("use_campaign_workflow", "Create campaigns, budgets and ad groups with create_campaign_plan so dependent resources stay consistent.", 400);
    }
    if (op.action === "create") {
      // New ads and keywords start paused unless the reviewer sees ENABLED.
      if ((op.kind === "ad_group_ad" || op.kind === "ad_group_criterion") && !op.payload.negative && op.payload.status === undefined) op.payload.status = "PAUSED";
      if (op.kind === "ad_group_ad") {
        const rsa = (op.payload.ad as any)?.responsiveSearchAd;
        if (rsa) rsaValidate((rsa.headlines ?? []).map((h: any) => h.text), (rsa.descriptions ?? []).map((d: any) => d.text));
      }
    }
    await negativeEvidence(ctx, account, op);
    ops.push(op);
  }
  await attachBefore(ctx, account, ops);
  for (const op of ops) {
    if (op.kind === "campaign_budget" && op.action === "update") {
      const camps = await adsFor(ctx, account).search(
        account.customer_id,
        `SELECT campaign.id, campaign.name, campaign.campaign_budget FROM campaign WHERE campaign.campaign_budget = ${gaqlString(op.resource_name!)} ORDER BY campaign.id LIMIT 200`,
        200,
      );
      if (camps.truncated) throw new NodiError("incomplete_scope", "Cannot review every campaign sharing this budget.", 400);
      op.evidence.shared_budget_campaigns = camps.rows.map((r) => ({ id: r.campaign?.id, name: r.campaign?.name }));
    }
    if (op.spending_effect === "pending") op.spending_effect = describeEffect(op, account.currency ?? "");
    if (op.kind === "campaign_budget" && op.action === "update" && (op.evidence.shared_budget_campaigns as unknown[] | undefined)?.length! > 1) {
      op.spending_effect += ` This budget is shared by ${(op.evidence.shared_budget_campaigns as unknown[]).length} campaigns.`;
    }
  }
  const plan = newPlan(`${p.kind}:${p.label}`, planAccount(account), ops.map((o) => PlanOperationSchema.parse(o)), business ?? {});
  return savePlan(ctx, p, plan, account);
};

/** Port of the original rule: a negative keyword needs real, recent, same-account search-term evidence. */
const negativeEvidence = async (ctx: Ctx, account: AccountRow, op: PlanOperation): Promise<void> => {
  const isNegative = op.action === "create" && (op.kind === "campaign_criterion" || op.kind === "ad_group_criterion") && op.payload.negative === true && op.payload.keyword;
  if (!isNegative) return;
  const e = op.evidence as Record<string, any>;
  if (!e.dataset_id) throw new NodiError("negative_needs_evidence", "Read real search terms first (get_search_terms) and include the saved dataset_id in evidence.", 400);
  const ds = await ctx.db.first<{ account_id: string; rows_json: string; created_at: number }>("SELECT account_id, rows_json, created_at FROM evidence WHERE id = ?", String(e.dataset_id));
  if (!ds || ds.account_id !== account.customer_id || ds.created_at < now() - 7 * 86400) throw new NodiError("stale_evidence", "Search-term evidence is missing, stale or belongs to another account.", 400);
  const rows = JSON.parse(ds.rows_json) as any[];
  const matches = rows.filter((r) => r.search_term_view?.search_term === e.search_term);
  if (!matches.length) throw new NodiError("negative_needs_evidence", "The evidence search term does not occur in that dataset.", 400);
  for (const f of ["business_relevance", "overblocking_review"]) {
    if (typeof e[f] !== "string" || e[f].trim().length < 10) throw new NodiError("negative_needs_evidence", `Explain ${f.replace("_", " ")} in at least 10 characters.`, 400);
  }
  const kw = op.payload.keyword as any;
  if (kw.matchType !== e.match_type) throw new NodiError("negative_needs_evidence", "Evidence and proposed match type differ.", 400);
  const scope = (op.payload.campaign ?? op.payload.adGroup) as string;
  if (e.scope?.resource_name !== scope) throw new NodiError("negative_needs_evidence", "Evidence scope must match the affected campaign or ad group.", 400);
  e.search_term_rows = matches.slice(0, 5);
};

// --------------------------------------------------------------------------- convenience planners
export const createBudgetChangePlan = async (ctx: Ctx, p: Principal, id: string, a: { campaign_id?: string; budget_resource?: string; new_daily_budget: string; reason: string }) => {
  const account = await resolveAccount(ctx, p, id, "draft");
  let budget = a.budget_resource;
  if (!budget) {
    if (!a.campaign_id || !/^\d+$/.test(a.campaign_id)) throw new NodiError("invalid_input", "Send campaign_id or budget_resource.", 400);
    const r = await adsFor(ctx, account).search(account.customer_id, `SELECT campaign.id, campaign.campaign_budget FROM campaign WHERE campaign.id = ${a.campaign_id} LIMIT 1`, 1);
    budget = r.rows[0]?.campaign?.campaignBudget;
    if (!budget) throw new NodiError("resource_missing", "Campaign not found in this account.", 404);
  }
  resourceValid(budget, account.customer_id, "campaign_budget");
  const micros = moneyMicros(a.new_daily_budget);
  if (micros <= 0n) throw new NodiError("invalid_budget", "Daily budget must be positive.", 400);
  return createOptimisationPlan(ctx, p, id, [{ kind: "campaign_budget", action: "update", resource_name: budget, field_mask: ["amountMicros"], payload: { amountMicros: micros.toString() }, reason: a.reason }], { source: "create_budget_change_plan" });
};

export const createStatusChangePlan = async (ctx: Ctx, p: Principal, id: string, a: { kind: "campaign" | "ad_group" | "ad_group_ad" | "ad_group_criterion"; resource_names: string[]; status: "ENABLED" | "PAUSED"; reason: string }) => {
  const account = await resolveAccount(ctx, p, id, "draft");
  if (!["campaign", "ad_group", "ad_group_ad", "ad_group_criterion"].includes(a.kind) || !["ENABLED", "PAUSED"].includes(a.status)) throw new NodiError("invalid_input", "Choose a supported kind and ENABLED or PAUSED.", 400);
  if (a.resource_names.length < 1 || a.resource_names.length > 50) throw new NodiError("invalid_input", "Send 1 to 50 resource names.", 400);
  for (const rn of a.resource_names) resourceValid(rn, account.customer_id, a.kind);
  const changes = a.resource_names.map((rn, i) => ({ id: `status${i}`, kind: a.kind, action: "update", resource_name: rn, field_mask: ["status"], payload: { status: a.status }, reason: a.reason }));
  return createOptimisationPlan(ctx, p, id, changes, { source: "create_status_change_plan" });
};
