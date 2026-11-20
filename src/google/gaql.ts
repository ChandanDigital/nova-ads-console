import { NovaError } from "../lib/errors";

/** Resources AI callers may read. Ported from the original Python plugin read allowlist. customer_client is excluded on purpose (see gaqlFor). */
export const READ_RESOURCES = new Set([
  "customer", "campaign", "campaign_budget", "ad_group", "ad_group_ad", "ad_group_criterion", "campaign_criterion", "asset",
  "campaign_asset", "ad_group_asset", "asset_group", "asset_group_asset", "conversion_action", "customer_conversion_goal",
  "campaign_conversion_goal", "search_term_view", "keyword_view", "recommendation", "change_event", "change_status", "label",
  "campaign_label", "geographic_view", "experiment", "experiment_arm", "asset_group_signal", "managed_placement_view",
  "ad_group_ad_asset_view", "asset_field_type_view", "customer_asset", "landing_page_view", "expanded_landing_page_view",
  "gender_view", "age_range_view", "location_view", "user_location_view", "distance_view", "ad_schedule_view", "shared_set",
  "shared_criterion", "campaign_shared_set", "bidding_strategy", "ad_group_bid_modifier", "campaign_bid_modifier", "audience",
  "campaign_audience_view", "ad_group_audience_view", "shopping_performance_view", "product_group_view",
  "asset_group_product_group_view", "asset_group_top_combination_view", "campaign_simulation", "ad_group_criterion_simulation",
  "detail_placement_view", "group_placement_view", "display_keyword_view", "topic_view", "video", "conversion_value_rule",
  "geo_target_constant", "language_constant", "account_budget", "campaign_search_term_view",
]);

const PERSONAL = ["email", "phone", "user_identifier", "customer_match", "user_ip", "change_event.old_resource", "change_event.new_resource"];

/**
 * Validates a caller-supplied GAQL query and returns it bounded by LIMIT.
 * Rejects comments/semicolons, PARAMETERS, unknown resources, malformed fields and personal-data fields.
 */
export const boundedGaql = (query: string, maxRows: number, requested?: number): { query: string; limit: number } => {
  const cap = Math.max(1, Math.min(maxRows, requested ?? maxRows));
  if (typeof query !== "string" || query.length > 12_000 || /;|--|\/\*|\*\/|\0/.test(query)) {
    throw new NovaError("invalid_query", "Invalid GAQL syntax.", 400);
  }
  const m = /^\s*SELECT\s+([\w.,\s]+?)\s+FROM\s+(\w+)(.*)$/is.exec(query);
  if (!m || !READ_RESOURCES.has(m[2]!.toLowerCase())) {
    throw new NovaError("invalid_query", "This reporting resource is unavailable. customer_client is available only through account discovery.", 400);
  }
  const fields = m[1]!.split(",").map((x) => x.trim().toLowerCase());
  if (fields.length > 60 || fields.some((f) => !/^[a-z_]+\.[a-z_0-9]+(\.[a-z_0-9]+)*$/.test(f))) {
    throw new NovaError("invalid_query", "Invalid report fields.", 400);
  }
  const joined = fields.join(" ");
  if (PERSONAL.some((p) => joined.includes(p))) {
    throw new NovaError("privacy_denied", "Personal data and raw change payloads cannot be read through AI tools.", 403);
  }
  const tail = m[3]!;
  if (/\bPARAMETERS\b/i.test(tail)) throw new NovaError("invalid_query", "GAQL parameters are disabled.", 400);
  const lm = /\bLIMIT\s+(\d+)\s*$/i.exec(tail);
  if (lm) {
    const bound = Number(lm[1]);
    if (bound < 1 || bound > cap) throw new NovaError("invalid_query", `LIMIT must be between 1 and ${cap}.`, 400);
    return { query: query.trim(), limit: bound };
  }
  return { query: `${query.trim()} LIMIT ${cap}`, limit: cap };
};

/** Escapes a value for use inside a single-quoted GAQL string literal. */
export const gaqlString = (v: string): string => "'" + v.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";

/** A LIKE pattern "contains <literal>". GAQL treats [ ] % _ as wildcards; a literal one is wrapped in brackets, e.g. "[[]". */
export const gaqlContains = (literal: string): string => gaqlString("%" + literal.replace(/[[\]%_]/g, "[$&]") + "%");

export const isIsoDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));

export const dateWindow = (start: unknown, end: unknown): string => {
  if (!isIsoDate(start) || !isIsoDate(end)) throw new NovaError("invalid_dates", "Use YYYY-MM-DD dates.", 400);
  const a = Date.parse(start + "T00:00:00Z");
  const b = Date.parse(end + "T00:00:00Z");
  if (b < a || (b - a) / 86_400_000 > 366) throw new NovaError("invalid_dates", "Choose an ordered range of at most 367 days.", 400);
  return `segments.date BETWEEN '${start}' AND '${end}'`;
};

export const customerId = (v: unknown): string => {
  const s = String(v ?? "").replace(/-/g, "");
  if (!/^\d{10}$/.test(s)) throw new NovaError("invalid_account", "Use a 10-digit Google Ads customer ID.", 400);
  return s;
};

/** Decimal string -> integer micros. Floats are rejected so money never passes through binary floating point. */
export const moneyMicros = (v: unknown): bigint => {
  if (typeof v === "number" || typeof v === "boolean") throw new NovaError("invalid_money", "Send money as a decimal string such as \"250.00\", not a number.", 400);
  const s = String(v ?? "").trim();
  const m = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) throw new NovaError("invalid_money", "Money needs digits with at most six decimal places.", 400);
  return BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
};

export const camelToSnake = (s: string): string => s.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
export const snakeToCamel = (s: string): string => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
export const pathGet = (obj: unknown, path: string): unknown => {
  let v = obj;
  for (const part of path.split(".")) {
    if (v === null || typeof v !== "object" || !(part in (v as object))) return undefined;
    v = (v as Record<string, unknown>)[part];
  }
  return v;
};
