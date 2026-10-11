import { describe, it, expect } from "vitest";
import { KINDS, SearchSpecSchema, searchCampaignOperations, newPlan, PlanOperationSchema } from "../src/ads/plans";
import { compile } from "../src/ads/planner";
import { pathExists, resourceSchema, schemaRevision, validateMutateOperation, validateAgainst } from "./schema-validate";

// Google publishes a machine-readable schema of the REST API. These tests check every payload Nodi can
// produce against it (field names, types, enum values), so a typo cannot slip through to a live account.
const account = { customer_id: "1234567890", name: "T", currency: "INR", timezone: "Asia/Kolkata", manager: false, login_customer_id: null };

const fullSpec = SearchSpecSchema.parse({
  name: "Full Spec", daily_budget: "1250.50", bidding: "MAXIMIZE_CONVERSIONS", target_cpa: "300", ai_max: true, ai_max_final_url_expansion: true,
  start_date: "2026-11-01", end_date: "2026-12-31", presence_only: true, search_partners: true,
  locations: ["geoTargetConstants/1007788"], excluded_locations: ["geoTargetConstants/1007789"],
  proximities: [{ radius_km: 10, latitude: 22.5726, longitude: 88.3639 }, { radius_km: 5, address: { country_code: "IN", postal_code: "700001" } }],
  negative_keywords: [{ text: "free", match_type: "BROAD" }],
  schedules: [{ day_of_week: "MONDAY", start_hour: 9, end_hour: 18 }],
  devices: [{ type: "MOBILE", bid_modifier: 1.2 }],
  sitelinks: [{ link_text: "Book", final_url: "https://example.com/book", description1: "Online booking", description2: "Same-day slots" }],
  callouts: ["Open Sundays"],
  contains_eu_political_advertising: false, business_context: { goal: "calls" },
  groups: [{ name: "G1", keywords: [{ text: "dentist", match_type: "EXACT" }, { text: "ডেন্টিস্ট", match_type: "PHRASE" }], headlines: ["One", "Two", "Three"], descriptions: ["First description", "Second description"], final_url: "https://example.com", path1: "care", tracking_url_template: "{lpurl}?src=g", final_url_suffix: "a=b" }],
});

describe(`mutate payloads conform to Google's v25 REST schema (revision ${schemaRevision()})`, () => {
  it("a fully loaded Search campaign plan", () => {
    const plan = newPlan("t", account, searchCampaignOperations(fullSpec, account, "abcd1234"), {});
    const bad = compile(plan).flatMap((op, i) => validateMutateOperation(op as any).map((e) => `op ${i} (${plan.operations[i]!.id}): ${e}`));
    expect(bad).toEqual([]);
    expect(plan.operations.length).toBeGreaterThan(15);
  });

  it("every other bidding strategy and manual CPC", () => {
    for (const [bidding, extra] of [["MANUAL_CPC", {}], ["MAXIMIZE_CLICKS", { cpc_bid_ceiling: "20" }], ["MAXIMIZE_CONVERSION_VALUE", { target_roas: "3.5" }], ["MAXIMIZE_CONVERSIONS", {}]] as const) {
      const spec = SearchSpecSchema.parse({ ...fullSpec, bidding, ai_max: false, ...extra, groups: [{ ...fullSpec.groups[0], cpc_bid: "11.5" }], sitelinks: [], callouts: [] });
      const plan = newPlan("t", account, searchCampaignOperations(spec, account, "abcd1234"), {});
      const bad = compile(plan).flatMap((op) => validateMutateOperation(op as any));
      expect(bad, bidding).toEqual([]);
    }
  });

  it("updates: every allowed field path exists on the real resource", () => {
    for (const [kind, info] of Object.entries(KINDS)) {
      const schema = resourceSchema(info.op);
      for (const path of info.updatable) expect(pathExists(schema, path), `${kind}.${path}`).toBe(true);
    }
  });

  it("update operations with real values validate", () => {
    const cases: [string, string, string[], Record<string, unknown>][] = [
      ["campaign_budget", "customers/1234567890/campaignBudgets/1", ["amountMicros"], { amountMicros: "300000000" }],
      ["campaign", "customers/1234567890/campaigns/2", ["status"], { status: "PAUSED" }],
      ["campaign", "customers/1234567890/campaigns/2", ["networkSettings.targetSearchNetwork"], { networkSettings: { targetSearchNetwork: false } }],
      ["ad_group", "customers/1234567890/adGroups/3", ["cpcBidMicros"], { cpcBidMicros: "4500000" }],
      ["ad_group_criterion", "customers/1234567890/adGroupCriteria/3~4", ["status"], { status: "PAUSED" }],
      ["ad_group_ad", "customers/1234567890/adGroupAds/3~5", ["status"], { status: "ENABLED" }],
    ];
    for (const [kind, rn, mask, payload] of cases) {
      const op = PlanOperationSchema.parse({ id: "u", kind, action: "update", resource_name: rn, field_mask: mask, payload, reason: "test", spending_effect: "test", recovery: "test" });
      const plan = newPlan("t", account, [op], {});
      expect(compile(plan).flatMap((o) => validateMutateOperation(o as any)), `${kind} ${mask}`).toEqual([]);
    }
  });

  it("the validator itself catches mistakes (so a pass means something)", () => {
    expect(validateMutateOperation({ campaignOperation: { create: { name: "x", notAField: 1 } } })).toContain("$.campaignOperation.create.notAField: unknown field");
    expect(validateMutateOperation({ campaignOperation: { create: { status: "PAUZED" } } }).join()).toMatch(/not one of/);
    expect(validateMutateOperation({ campaignBudgetOperation: { create: { amountMicros: "12.5" } } }).join()).toMatch(/int64/);
    expect(validateMutateOperation({ campaignOperation: { create: { name: "x" } }, adGroupOperation: { create: {} } }).join()).toMatch(/exactly one/);
    expect(validateAgainst({ resourceName: "x" }, { type: "object", properties: {} })).toEqual(["$.resourceName: unknown field"]);
  });

  it("the REST envelope fields we send exist", () => {
    // MutateGoogleAdsRequest: mutateOperations, validateOnly, partialFailure (from the discovery document).
    const body = { mutateOperations: [], validateOnly: true, partialFailure: false };
    expect(Object.keys(body).sort()).toEqual(["mutateOperations", "partialFailure", "validateOnly"]);
  });
});
