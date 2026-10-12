import { z } from "zod";
import type { Ctx, Principal } from "../lib/context";
import { NovaError } from "../lib/errors";
import { gaqlString } from "../google/gaql";
import { adsFor, resolveAccount, type AccountRow } from "./accounts";
import { PlanOperationSchema, newPlan, resourceValid, type Plan } from "./plans";
import { planAccount, savePlan } from "./planner";

/**
 * Apply or dismiss Google's own recommendations through the normal plan -> validate -> execute path.
 * Google's RecommendationService has no validate-only mode, so "validate" here re-reads each recommendation (still open, same type)
 * instead of asking Google to rehearse the change. Budget recommendations are refused: use create_budget_change_plan, which shows the
 * exact amounts and enforces the administrator's budget cap.
 */
export const BUDGET_TYPES = new Set(["CAMPAIGN_BUDGET", "FORECASTING_CAMPAIGN_BUDGET", "MARGINAL_ROI_CAMPAIGN_BUDGET", "MOVE_UNUSED_BUDGET"]);

export const RecommendationInputSchema = z
  .object({
    action: z.enum(["apply", "dismiss"]),
    recommendations: z.array(z.string().min(1).max(200)).min(1).max(20),
    reason: z.string().min(3).max(1000),
  })
  .strict();

export const isRecommendationPlan = (plan: Plan): boolean => plan.operations.length > 0 && plan.operations.every((o) => o.kind === "recommendation");

interface RecInfo {
  type: string;
  dismissed: boolean;
  campaign: string | null;
  ad_group: string | null;
}

const readRecommendations = async (ctx: Ctx, account: AccountRow, names: string[]): Promise<Map<string, RecInfo>> => {
  const out = new Map<string, RecInfo>();
  const q = `SELECT recommendation.resource_name, recommendation.type, recommendation.dismissed, recommendation.campaign, recommendation.ad_group FROM recommendation WHERE recommendation.resource_name IN (${names.map(gaqlString).join(", ")}) LIMIT ${names.length}`;
  const r = await adsFor(ctx, account).search(account.customer_id, q, names.length);
  for (const row of r.rows) {
    const x = row.recommendation;
    if (x?.resourceName) out.set(x.resourceName, { type: String(x.type ?? "UNKNOWN"), dismissed: x.dismissed === true, campaign: x.campaign ?? null, ad_group: x.adGroup ?? null });
  }
  return out;
};

export const createRecommendationPlan = async (ctx: Ctx, p: Principal, accountId: string, input: unknown) => {
  const account = await resolveAccount(ctx, p, accountId, "draft");
  const parsed = RecommendationInputSchema.safeParse(input);
  if (!parsed.success) throw new NovaError("invalid_input", "Check the recommendation fields.", 400, parsed.error.issues.slice(0, 10).map((i) => ({ field: i.path.join("."), problem: i.message })));
  const { action, reason } = parsed.data;
  const names = [...new Set(parsed.data.recommendations.map((r) => (r.startsWith("customers/") ? r : `customers/${account.customer_id}/recommendations/${r}`)))];
  for (const n of names) resourceValid(n, account.customer_id, "recommendation");
  const found = await readRecommendations(ctx, account, names);
  const ops = names.map((name, i) => {
    const info = found.get(name);
    if (!info) throw new NovaError("recommendation_not_found", `Recommendation ${name} was not found in this account (it may already have been applied or may have expired).`, 404);
    if (info.dismissed) throw new NovaError("recommendation_dismissed", `Recommendation ${name} is already dismissed.`, 409);
    if (action === "apply" && BUDGET_TYPES.has(info.type)) {
      throw new NovaError("use_budget_plan", `${info.type} changes the daily budget. Use create_budget_change_plan so the exact amount and your budget cap are shown.`, 422);
    }
    const effect = action === "apply"
      ? `Google applies this ${info.type} recommendation as Google generated it. Depending on the type it can change ads, keywords, bids or settings and may change spend. Google offers no validate-only check for this action.`
      : "Hides this recommendation. No change to ads, bids or spend. Google may suggest it again later.";
    return PlanOperationSchema.parse({
      id: `rec${i}`, kind: "recommendation", action, resource_name: name, payload: {},
      reason, spending_effect: effect,
      recovery: action === "apply" ? "Nova Ads cannot undo an applied recommendation. Review Google Ads change history and draft a new reviewed plan to adjust." : "Not needed. Dismissed recommendations can reappear.",
      evidence: { type: info.type, campaign: info.campaign, ad_group: info.ad_group },
    });
  });
  const plan = newPlan(`${p.kind}:${p.label}`, planAccount(account), ops, { reason, recommendation_action: action });
  return savePlan(ctx, p, plan, account);
};

/** Re-reads every recommendation: each must still be open and of the type the human saw. */
export const validateRecommendations = async (ctx: Ctx, account: AccountRow, plan: Plan) => {
  const names = plan.operations.map((o) => o.resource_name!);
  const found = await readRecommendations(ctx, account, names);
  for (const op of plan.operations) {
    const info = found.get(op.resource_name!);
    if (!info || info.dismissed) throw new NovaError("stale_plan", `Recommendation ${op.resource_name} is no longer open. Draft a new plan.`, 409);
    if (info.type !== op.evidence.type) throw new NovaError("stale_plan", `Recommendation ${op.resource_name} changed type after the draft.`, 409);
  }
  return { validated_operations: plan.operations.length, google_validate_only: false, checked: "Each recommendation is still open and unchanged. Google offers no validate-only mode for apply or dismiss." };
};

type OpResult = { operation_id: string; status: "succeeded" | "failed" | "outcome_unknown"; resource_name: string | null; observed?: unknown };

/** After the action: an applied recommendation disappears; a dismissed one is flagged dismissed (or also disappears). */
export const verifyRecommendations = async (ctx: Ctx, account: AccountRow, plan: Plan): Promise<OpResult[]> => {
  const found = await readRecommendations(ctx, account, plan.operations.map((o) => o.resource_name!));
  return plan.operations.map((op) => {
    const info = found.get(op.resource_name!);
    const done = !info || (op.action === "dismiss" && info.dismissed);
    return { operation_id: op.id, status: done ? "succeeded" : "outcome_unknown", resource_name: op.resource_name ?? null, observed: info ? { dismissed: info.dismissed } : { present: false } };
  });
};

/** Sends the one apply or dismiss request, then verifies. `persist` records the API acceptance before verification runs. */
export const runRecommendations = async (ctx: Ctx, account: AccountRow, plan: Plan, persist: (names: string[]) => Promise<void>): Promise<OpResult[]> => {
  const names = plan.operations.map((o) => o.resource_name!);
  await adsFor(ctx, account).recommendations(account.customer_id, plan.operations[0]!.action as "apply" | "dismiss", names);
  await persist(names);
  return verifyRecommendations(ctx, account, plan);
};
