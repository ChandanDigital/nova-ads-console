import { z } from "zod";
import { NodiError } from "../lib/errors";
import { fingerprint, randomId } from "../lib/crypto";
import { customerId, moneyMicros, snakeToCamel } from "../google/gaql";

// ----------------------------------------------------------------------------- resource kinds
export interface KindInfo {
  /** Key inside a GoogleAdsService MutateOperation. */
  op: string;
  /** Collection segment of the resource name. */
  coll: string;
  /** update_mask paths (camelCase, as in the REST JSON) that plans may change. */
  updatable: string[];
}

export const KINDS: Record<string, KindInfo> = {
  campaign_budget: { op: "campaignBudgetOperation", coll: "campaignBudgets", updatable: ["amountMicros", "name"] },
  campaign: {
    op: "campaignOperation",
    coll: "campaigns",
    updatable: [
      "name", "status", "networkSettings.targetSearchNetwork", "networkSettings.targetContentNetwork",
      "geoTargetTypeSetting.positiveGeoTargetType", "targetCpa.targetCpaMicros", "maximizeConversions.targetCpaMicros",
      "maximizeConversionValue.targetRoas", "targetSpend.cpcBidCeilingMicros", "trackingUrlTemplate", "finalUrlSuffix",
      "startDateTime", "endDateTime",
    ],
  },
  ad_group: { op: "adGroupOperation", coll: "adGroups", updatable: ["name", "status", "cpcBidMicros", "targetCpaMicros", "trackingUrlTemplate", "finalUrlSuffix"] },
  ad_group_criterion: { op: "adGroupCriterionOperation", coll: "adGroupCriteria", updatable: ["status", "cpcBidMicros", "finalUrls", "trackingUrlTemplate", "finalUrlSuffix"] },
  ad_group_ad: { op: "adGroupAdOperation", coll: "adGroupAds", updatable: ["status"] },
  campaign_criterion: { op: "campaignCriterionOperation", coll: "campaignCriteria", updatable: ["bidModifier"] },
  asset: { op: "assetOperation", coll: "assets", updatable: [] },
  asset_group: { op: "assetGroupOperation", coll: "assetGroups", updatable: ["name", "status"] },
  asset_group_asset: { op: "assetGroupAssetOperation", coll: "assetGroupAssets", updatable: [] },
  campaign_asset: { op: "campaignAssetOperation", coll: "campaignAssets", updatable: [] },
  /** Not a mutate operation: applied or dismissed through RecommendationService (see recommendations.ts). */
  recommendation: { op: "recommendationOperation", coll: "recommendations", updatable: [] },
};
export const KIND_NAMES = Object.keys(KINDS) as [string, ...string[]];

const ENUM_ID_KINDS = new Set(["campaign_asset", "asset_group_asset"]);

export const resourceValid = (resource: string, account: string, kind: string): void => {
  const info = KINDS[kind];
  if (!info) throw new NodiError("invalid_resource", "Unsupported resource kind.", 400);
  const tail = kind === "recommendation" ? "[0-9A-Za-z_~=.-]+" : ENUM_ID_KINDS.has(kind) ? "[0-9A-Z_~-]+" : "[0-9~-]+";
  if (!new RegExp(`^customers/${account}/${info.coll}/${tail}$`).test(resource)) {
    throw new NodiError("invalid_resource", `Resource ${resource} does not belong to this account or kind ${kind}.`, 400);
  }
};

// ----------------------------------------------------------------------------- plan model
export const PlanOperationSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z][\w-]{0,63}$/),
    kind: z.enum(KIND_NAMES),
    action: z.enum(["create", "update", "apply", "dismiss"]),
    payload: z.record(z.string(), z.any()),
    resource_name: z.string().optional(),
    field_mask: z.array(z.string()).default([]),
    before: z.record(z.string(), z.any()).default({}),
    depends_on: z.array(z.string()).default([]),
    reason: z.string().min(3).max(2000),
    spending_effect: z.string().min(3).max(1000),
    recovery: z.string().min(3).max(1000),
    evidence: z.record(z.string(), z.any()).default({}),
  })
  .strict();
export type PlanOperation = z.infer<typeof PlanOperationSchema>;

export interface PlanAccount {
  customer_id: string;
  name: string;
  currency: string;
  timezone: string;
  manager: boolean;
  login_customer_id: string | null;
}

export interface Plan {
  schema_version: "3.0.0";
  id: string;
  version: 1;
  owner: string;
  account: PlanAccount;
  created_at: string;
  expires_at: string;
  operations: PlanOperation[];
  partial_failure: false;
  business_context: Record<string, unknown>;
  required_permissions: string[];
}

/** Hash of everything a human reviews. Statuses and approvals live outside it, so changing content invalidates approval. */
export const planHash = (plan: Plan): Promise<string> => fingerprint(plan);

const TEMP_ID = /\/-\d+$/;

const resourceRefs = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.flatMap(resourceRefs);
  if (v && typeof v === "object") return Object.values(v as object).flatMap(resourceRefs);
  return typeof v === "string" && v.startsWith("customers/") ? [v] : [];
};

/** Structural checks, ported from the original Plan/Operation guards. */
export const validatePlanShape = (plan: Plan): void => {
  const acct = plan.account.customer_id;
  const ids = plan.operations.map((o) => o.id);
  if (new Set(ids).size !== ids.length) throw new NodiError("invalid_plan", "Duplicate operation IDs.", 400);
  if (plan.operations.length < 1 || plan.operations.length > 200) throw new NodiError("invalid_plan", "A plan holds 1 to 200 operations.", 400);
  const seen = new Set<string>();
  const temporary = new Map<string, string>();
  const updated = new Set<string>();
  if (plan.operations.some((o) => o.kind === "recommendation") && plan.operations.some((o) => o.kind !== "recommendation")) {
    throw new NodiError("invalid_plan", "Recommendation actions cannot be mixed with other changes in one plan.", 400);
  }
  for (const op of plan.operations) {
    const info = KINDS[op.kind]!;
    if (op.depends_on.some((d) => !seen.has(d))) throw new NodiError("invalid_plan", `Operation ${op.id}: dependencies must precede it.`, 400);
    if (op.resource_name) resourceValid(op.resource_name, acct, op.kind);
    if ((op.kind === "recommendation") !== (op.action === "apply" || op.action === "dismiss")) {
      throw new NodiError("invalid_plan", `Operation ${op.id}: apply and dismiss are only for recommendations.`, 400);
    }
    if (op.kind === "recommendation") {
      if (!op.resource_name || op.field_mask.length || Object.keys(op.before).length || Object.keys(op.payload).length) throw new NodiError("invalid_plan", `Operation ${op.id}: a recommendation action names one recommendation and nothing else.`, 400);
      if (plan.operations.some((o) => o !== op && o.resource_name === op.resource_name)) throw new NodiError("invalid_plan", "A recommendation can appear once per plan.", 400);
      if (plan.operations.some((o) => o.action !== op.action)) throw new NodiError("invalid_plan", "Apply and dismiss must be separate plans.", 400);
      seen.add(op.id);
      continue;
    }
    const status = op.payload.status;
    if (status !== undefined && !["ENABLED", "PAUSED"].includes(String(status))) {
      throw new NodiError("invalid_plan", "Only ENABLED or PAUSED statuses are allowed. Removal is disabled because it cannot be undone.", 400);
    }
    const own = op.action === "create" ? (op.payload.resourceName as string | undefined) : undefined;
    for (const ref of resourceRefs(op.payload)) {
      if (!ref.startsWith(`customers/${acct}/`)) throw new NodiError("invalid_plan", `Operation ${op.id}: a nested resource belongs to another account.`, 400);
      if (ref === own) continue;
      if (TEMP_ID.test(ref) && (!temporary.has(ref) || !op.depends_on.includes(temporary.get(ref)!))) {
        throw new NodiError("invalid_plan", `Operation ${op.id}: temporary reference ${ref} needs an earlier declared dependency.`, 400);
      }
    }
    if (op.action === "create") {
      if (op.field_mask.length || Object.keys(op.before).length) throw new NodiError("invalid_plan", "A create operation cannot carry an update mask or previous values.", 400);
      if (own) {
        resourceValid(own, acct, op.kind);
        if (!TEMP_ID.test(own)) throw new NodiError("invalid_plan", "Creation resource names must use temporary negative IDs.", 400);
        if (temporary.has(own)) throw new NodiError("invalid_plan", "Duplicate temporary resource.", 400);
        temporary.set(own, op.id);
      }
    } else {
      if (!op.resource_name || !op.field_mask.length) throw new NodiError("invalid_plan", `Operation ${op.id}: an update needs a resource and a field mask.`, 400);
      if (op.field_mask.some((f) => !info.updatable.includes(f))) {
        throw new NodiError("invalid_plan", `Operation ${op.id}: field not updatable for ${op.kind}. Allowed: ${info.updatable.join(", ") || "none"}.`, 400);
      }
      if (new Set(op.field_mask).size !== op.field_mask.length) throw new NodiError("invalid_plan", "Duplicate field mask entries.", 400);
      // No unmasked changes may hide in the payload.
      const actual = new Set(flattenPaths(Object.fromEntries(Object.entries(op.payload).filter(([k]) => k !== "resourceName"))));
      if (actual.size !== op.field_mask.length || op.field_mask.some((f) => !actual.has(f))) {
        throw new NodiError("invalid_plan", `Operation ${op.id}: payload fields must exactly match the field mask.`, 400);
      }
      for (const f of op.field_mask) {
        const key = `${op.resource_name}|${f}`;
        if (updated.has(key)) throw new NodiError("invalid_plan", "Conflicting updates to one resource field.", 400);
        updated.add(key);
      }
    }
    seen.add(op.id);
  }
  for (const t of [plan.created_at, plan.expires_at]) if (Number.isNaN(Date.parse(t))) throw new NodiError("invalid_plan", "Invalid timestamps.", 400);
  if (Date.parse(plan.expires_at) <= Date.parse(plan.created_at)) throw new NodiError("invalid_plan", "Invalid plan expiry.", 400);
};

export const flattenPaths = (value: Record<string, unknown>, prefix = ""): string[] =>
  Object.entries(value).flatMap(([k, v]) => {
    const p = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length ? flattenPaths(v as Record<string, unknown>, p) : [p];
  });

export const setPath = (target: Record<string, any>, path: string, value: unknown): void => {
  const parts = path.split(".");
  let cur = target;
  for (const part of parts.slice(0, -1)) cur = cur[part] ??= {};
  cur[parts[parts.length - 1]!] = value;
};

/** Converts snake_case keys (the original Nodi Ads style) to the camelCase used by the REST API. Values are untouched. */
export const camelKeys = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(camelKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [/^customers\//.test(k) ? k : snakeToCamel(k), camelKeys(x)]));
  return v;
};
export const camelPath = (p: string): string => p.split(".").map(snakeToCamel).join(".");

/**
 * Permissions a human approval must name (ported permission classes).
 * Children created inside a brand-new campaign ride on that campaign's own approval; they are not extra "launch" or "optimisation" actions.
 */
export const requiredPermissions = (ops: PlanOperation[]): string[] => {
  const perms = new Set<string>();
  const created = new Set(ops.filter((o) => o.action === "create" && o.kind === "campaign").map((o) => o.id));
  const underNew = new Set<string>();
  for (const o of ops) if (o.depends_on.some((d) => created.has(d) || underNew.has(d))) underNew.add(o.id);
  for (const o of ops) {
    if (o.kind === "recommendation") {
      perms.add(o.action === "apply" ? "apply_recommendation" : "dismiss_recommendation");
      continue;
    }
    const structural = o.action === "create" && (o.kind === "campaign" || o.kind === "campaign_budget");
    if (structural) perms.add("create_campaign");
    else if (o.action === "update" || (!underNew.has(o.id) && !(o.kind === "asset" && created.size > 0))) perms.add("optimisation");
    if (o.payload.status === "ENABLED" && (o.action === "update" || o.kind === "campaign" || !underNew.has(o.id))) perms.add("launch");
    if (o.kind === "campaign_budget" && o.action === "update" && o.field_mask.includes("amountMicros")) perms.add("budget_change");
  }
  return [...perms];
};

export const newPlan = (owner: string, account: PlanAccount, operations: PlanOperation[], business: Record<string, unknown>): Plan => {
  const created = new Date();
  const plan: Plan = {
    schema_version: "3.0.0",
    id: randomId(),
    version: 1,
    owner,
    account,
    created_at: created.toISOString(),
    expires_at: new Date(created.getTime() + 24 * 3600_000).toISOString(),
    operations,
    partial_failure: false,
    business_context: business,
    required_permissions: requiredPermissions(operations),
  };
  validatePlanShape(plan);
  return plan;
};

// ----------------------------------------------------------------------------- RSA text rules
const textUnits = (s: string): number => [...s].reduce((n, ch) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch) ? 2 : 1), 0);
export const rsaValidate = (headlines: string[], descriptions: string[]): void => {
  if (headlines.length < 3 || headlines.length > 15 || descriptions.length < 2 || descriptions.length > 4) {
    throw new NodiError("invalid_rsa", "Supply 3 to 15 headlines and 2 to 4 descriptions.", 400);
  }
  for (const [values, limit, label] of [[headlines, 30, "headline"], [descriptions, 90, "description"]] as const) {
    if (new Set(values.map((v) => v.trim().toLowerCase())).size !== values.length) throw new NodiError("invalid_rsa", `Use distinct ${label} text.`, 400);
    if (values.some((v) => !v.trim() || textUnits(v) > limit || v.includes("\n"))) {
      throw new NodiError("invalid_rsa", `Each ${label} must have 1 to ${limit} text units on one line (Bengali counts one unit per character).`, 400);
    }
  }
};

export const httpsUrl = (u: string): string => {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    throw new NodiError("invalid_url", "Final URLs must be absolute https:// URLs.", 400);
  }
  if (url.protocol !== "https:" || url.username || url.password) throw new NodiError("invalid_url", "Final URLs must be https:// without credentials.", 400);
  return url.toString();
};

// ----------------------------------------------------------------------------- Search campaign builder
const Keyword = z.object({ text: z.string().min(1).max(80), match_type: z.enum(["EXACT", "PHRASE", "BROAD"]) }).strict();

export const SearchSpecSchema = z
  .object({
    name: z.string().min(1).max(100),
    daily_budget: z.string(),
    bidding: z.enum(["MANUAL_CPC", "MAXIMIZE_CLICKS", "MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE"]).default("MANUAL_CPC"),
    target_cpa: z.string().optional(),
    target_roas: z.string().optional(),
    cpc_bid_ceiling: z.string().optional(),
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    locations: z.array(z.string()).max(100).default([]),
    excluded_locations: z.array(z.string()).max(100).default([]),
    proximities: z
      .array(z.object({ radius_km: z.number().min(1).max(800), latitude: z.number().min(-90).max(90).optional(), longitude: z.number().min(-180).max(180).optional(), address: z.record(z.string(), z.string()).optional() }).strict())
      .max(50)
      .default([]),
    presence_only: z.boolean().default(false),
    search_partners: z.boolean().default(false),
    negative_keywords: z.array(Keyword).max(200).default([]),
    schedules: z.array(z.object({ day_of_week: z.string(), start_hour: z.number().int().min(0).max(24), start_minute: z.enum(["ZERO", "FIFTEEN", "THIRTY", "FORTY_FIVE"]).default("ZERO"), end_hour: z.number().int().min(0).max(24), end_minute: z.enum(["ZERO", "FIFTEEN", "THIRTY", "FORTY_FIVE"]).default("ZERO") }).strict()).max(50).default([]),
    devices: z.array(z.object({ type: z.enum(["MOBILE", "DESKTOP", "TABLET", "CONNECTED_TV"]), bid_modifier: z.number().min(0).max(10).default(1) }).strict()).max(4).default([]),
    ai_max: z.boolean().default(false),
    ai_max_text_customization: z.boolean().default(true),
    ai_max_final_url_expansion: z.boolean().default(false),
    sitelinks: z.array(z.object({ link_text: z.string(), final_url: z.string(), description1: z.string().optional(), description2: z.string().optional() }).strict()).max(20).default([]),
    callouts: z.array(z.string()).max(20).default([]),
    groups: z
      .array(
        z
          .object({
            name: z.string().min(1).max(255),
            cpc_bid: z.string().optional(),
            keywords: z.array(Keyword).min(1).max(100),
            headlines: z.array(z.string()),
            descriptions: z.array(z.string()),
            final_url: z.string(),
            path1: z.string().max(15).default(""),
            path2: z.string().max(15).default(""),
            tracking_url_template: z.string().optional(),
            final_url_suffix: z.string().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
    contains_eu_political_advertising: z.boolean(),
    launch: z.boolean().default(false),
    business_context: z.record(z.string(), z.any()),
  })
  .strict();
export type SearchSpec = z.infer<typeof SearchSpecSchema>;

const reasonCreate = "Create the campaign from the reviewed business settings.";
const recoveryCreate = "Pause serving resources. Creation leaves account records; removal is disabled.";

export const searchCampaignOperations = (spec: SearchSpec, account: PlanAccount, planTag: string): PlanOperation[] => {
  if (!spec.locations.length && !spec.proximities.length) throw new NodiError("invalid_location", "Choose at least one location or one radius.", 400);
  const cid = account.customer_id;
  const base = `customers/${cid}`;
  const budgetRn = `${base}/campaignBudgets/-1`;
  const campaignRn = `${base}/campaigns/-2`;
  const ops: PlanOperation[] = [];
  const add = (id: string, kind: string, payload: Record<string, unknown>, deps: string[] = [], effect = "No spend while the campaign stays paused.") =>
    ops.push(PlanOperationSchema.parse({ id, kind, action: "create", payload, depends_on: deps, reason: reasonCreate, spending_effect: effect, recovery: recoveryCreate }));

  const amount = moneyMicros(spec.daily_budget);
  if (amount <= 0n) throw new NodiError("invalid_budget", "Daily budget must be positive.", 400);
  const name = `${spec.name} [Nova ${planTag}]`;
  add("budget", "campaign_budget", { resourceName: budgetRn, name: `${name} budget`, amountMicros: amount.toString(), deliveryMethod: "STANDARD", explicitlyShared: false });

  const cp: Record<string, any> = {
    resourceName: campaignRn,
    name,
    advertisingChannelType: "SEARCH",
    status: spec.launch ? "ENABLED" : "PAUSED",
    campaignBudget: budgetRn,
    networkSettings: { targetGoogleSearch: true, targetSearchNetwork: spec.search_partners, targetContentNetwork: false },
    containsEuPoliticalAdvertising: spec.contains_eu_political_advertising ? "CONTAINS_EU_POLITICAL_ADVERTISING" : "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
  };
  if (spec.presence_only) cp.geoTargetTypeSetting = { positiveGeoTargetType: "PRESENCE" };
  if (spec.ai_max) {
    if (!["MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE"].includes(spec.bidding)) {
      throw new NodiError("unsupported_bid", "AI Max for Search needs MAXIMIZE_CONVERSIONS or MAXIMIZE_CONVERSION_VALUE bidding.", 400);
    }
    cp.aiMaxSetting = { enableAiMax: true };
    cp.assetAutomationSettings = [
      { assetAutomationType: "TEXT_ASSET_AUTOMATION", assetAutomationStatus: spec.ai_max_text_customization ? "OPTED_IN" : "OPTED_OUT" },
      { assetAutomationType: "FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION", assetAutomationStatus: spec.ai_max_final_url_expansion ? "OPTED_IN" : "OPTED_OUT" },
    ];
  }
  switch (spec.bidding) {
    case "MANUAL_CPC":
      cp.manualCpc = {};
      break;
    case "MAXIMIZE_CONVERSIONS":
      cp.maximizeConversions = spec.target_cpa ? { targetCpaMicros: moneyMicros(spec.target_cpa).toString() } : {};
      break;
    case "MAXIMIZE_CONVERSION_VALUE":
      if (spec.target_roas !== undefined && !(Number(spec.target_roas) > 0)) throw new NodiError("invalid_bid", "ROAS target must be positive.", 400);
      cp.maximizeConversionValue = spec.target_roas ? { targetRoas: Number(spec.target_roas) } : {};
      break;
    case "MAXIMIZE_CLICKS":
      cp.targetSpend = spec.cpc_bid_ceiling ? { cpcBidCeilingMicros: moneyMicros(spec.cpc_bid_ceiling).toString() } : {};
      break;
  }
  if (spec.start_date) cp.startDateTime = `${spec.start_date} 00:00:00`;
  if (spec.end_date) {
    if (spec.start_date && spec.end_date < spec.start_date) throw new NodiError("invalid_dates", "End date precedes start date.", 400);
    cp.endDateTime = `${spec.end_date} 23:59:59`;
  }
  add("campaign", "campaign", cp, ["budget"], `Average daily budget ${spec.daily_budget} ${account.currency}. Launch ${spec.launch ? "is included." : "needs a separate approval."}`);

  const geo = (loc: string) => {
    if (!/^geoTargetConstants\/\d+$/.test(loc)) throw new NodiError("invalid_location", "Use verified geoTargetConstants/<id> resources (see search_geo_targets).", 400);
    return loc;
  };
  [...spec.locations.map((l) => [l, false] as const), ...spec.excluded_locations.map((l) => [l, true] as const)].forEach(([loc, neg], i) =>
    add(`location${i}`, "campaign_criterion", { campaign: campaignRn, negative: neg, location: { geoTargetConstant: geo(loc) } }, ["campaign"]),
  );
  spec.proximities.forEach((p, i) => {
    const info: Record<string, unknown> = { radius: p.radius_km, radiusUnits: "KILOMETERS" };
    if (p.latitude !== undefined || p.longitude !== undefined) {
      if (p.latitude === undefined || p.longitude === undefined || p.address) throw new NodiError("invalid_location", "Use either one coordinate (latitude and longitude) or one address.", 400);
      info.geoPoint = { latitudeInMicroDegrees: Math.round(p.latitude * 1e6), longitudeInMicroDegrees: Math.round(p.longitude * 1e6) };
    } else {
      if (!p.address || !p.address.country_code) throw new NodiError("invalid_location", "An address needs country_code plus city, postal code, province or street.", 400);
      info.address = Object.fromEntries(Object.entries(p.address).map(([k, v]) => [snakeToCamel(k), v]));
    }
    add(`proximity${i}`, "campaign_criterion", { campaign: campaignRn, proximity: info }, ["campaign"]);
  });
  spec.negative_keywords.forEach((k, i) =>
    add(`negative${i}`, "campaign_criterion", { campaign: campaignRn, negative: true, keyword: { text: k.text, matchType: k.match_type } }, ["campaign"]),
  );
  spec.schedules.forEach((s, i) =>
    add(`schedule${i}`, "campaign_criterion", { campaign: campaignRn, adSchedule: { dayOfWeek: s.day_of_week, startHour: s.start_hour, startMinute: s.start_minute, endHour: s.end_hour, endMinute: s.end_minute } }, ["campaign"]),
  );
  spec.devices.forEach((d, i) => add(`device${i}`, "campaign_criterion", { campaign: campaignRn, device: { type: d.type }, bidModifier: d.bid_modifier }, ["campaign"]));

  spec.groups.forEach((g, i) => {
    const groupRn = `${base}/adGroups/${-10 - i}`;
    const gid = `group${i}`;
    const gp: Record<string, any> = { resourceName: groupRn, campaign: campaignRn, name: g.name, type: "SEARCH_STANDARD", status: "ENABLED" };
    if (spec.bidding === "MANUAL_CPC") {
      if (!g.cpc_bid) throw new NodiError("missing_bid", "Each manual-CPC ad group needs a cpc_bid.", 400);
      gp.cpcBidMicros = moneyMicros(g.cpc_bid).toString();
    }
    add(gid, "ad_group", gp, ["campaign"]);
    g.keywords.forEach((k, j) => add(`${gid}keyword${j}`, "ad_group_criterion", { adGroup: groupRn, status: "ENABLED", keyword: { text: k.text, matchType: k.match_type } }, [gid]));
    rsaValidate(g.headlines, g.descriptions);
    const finalUrl = httpsUrl(g.final_url);
    const ad: Record<string, any> = {
      finalUrls: [finalUrl],
      responsiveSearchAd: { headlines: g.headlines.map((text) => ({ text })), descriptions: g.descriptions.map((text) => ({ text })), path1: g.path1, path2: g.path2 },
    };
    if (g.tracking_url_template) ad.trackingUrlTemplate = g.tracking_url_template;
    if (g.final_url_suffix) ad.finalUrlSuffix = g.final_url_suffix;
    add(`${gid}rsa`, "ad_group_ad", { adGroup: groupRn, status: "ENABLED", ad }, [gid]);
  });

  let assetSeq = -1000;
  const newAsset = (id: string, payload: Record<string, unknown>, fieldType: string) => {
    const rn = `${base}/assets/${assetSeq--}`;
    add(id, "asset", { resourceName: rn, ...payload });
    add(`${id}link`, "campaign_asset", { campaign: campaignRn, asset: rn, fieldType }, ["campaign", id]);
  };
  spec.sitelinks.forEach((s, i) => {
    if (!!s.description1 !== !!s.description2) throw new NodiError("invalid_asset", "Send both sitelink descriptions or neither.", 400);
    if (textUnits(s.link_text) > 25 || [s.description1, s.description2].some((d) => d && textUnits(d) > 35)) throw new NodiError("invalid_asset", "Sitelink text allows 25 units; each description 35.", 400);
    newAsset(`sitelink${i}`, { finalUrls: [httpsUrl(s.final_url)], sitelinkAsset: { linkText: s.link_text, ...(s.description1 ? { description1: s.description1, description2: s.description2 } : {}) } }, "SITELINK");
  });
  spec.callouts.forEach((c, i) => {
    if (!c.trim() || textUnits(c) > 25) throw new NodiError("invalid_asset", "A callout holds 1 to 25 text units.", 400);
    newAsset(`callout${i}`, { calloutAsset: { calloutText: c } }, "CALLOUT");
  });
  return ops;
};
