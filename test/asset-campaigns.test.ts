import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AssetCampaignSpecSchema, assetCampaignOperations, pmaxRepeatedTexts } from "../src/ads/asset-campaigns";
import { newPlan } from "../src/ads/plans";
import { compile } from "../src/ads/planner";
import { validateMutateOperation } from "./schema-validate";
import { call, issueToken, mcpTool, resetDb, setupAdmin, type Session } from "./helpers";
import { FakeGoogle, CUSTOMER } from "./fake-google";
import { connectAndAllow, realMutates } from "./flow";

const account = { customer_id: "1234567890", name: "T", currency: "INR", timezone: "Asia/Kolkata", manager: false, login_customer_id: null };
const A = (n: number) => `customers/1234567890/assets/${n}`;
const base = { name: "Spring", daily_budget: "500", contains_eu_political_advertising: false, business_context: { goal: "leads" }, locations: ["geoTargetConstants/1007788"] };
const images = { marketing_images: [A(11)], square_images: [A(12)], logos: [A(13)] };

const SPECS: Record<string, Record<string, unknown>> = {
  DISPLAY: { ...base, campaign_type: "DISPLAY", final_url: "https://example.com", business_name: "Pradhan Clinic", headlines: ["Smile", "Care"], descriptions: ["Gentle dentistry for families"], long_headline: "Gentle dentistry for the whole family", ...images, target_cpa: "200" },
  DEMAND_GEN: { ...base, campaign_type: "DEMAND_GEN", final_url: "https://example.com", business_name: "Pradhan Clinic", headlines: ["Smile", "Care"], descriptions: ["Gentle dentistry for families"], ...images },
  PERFORMANCE_MAX: { ...base, campaign_type: "PERFORMANCE_MAX", final_url: "https://example.com", business_name: "Pradhan Clinic", headlines: ["One", "Two", "Three"], descriptions: ["First text", "Second text"], long_headline: "A long headline that explains the offer", ...images, videos: [A(14)], target_roas: "3.5" },
  SHOPPING: { ...base, campaign_type: "SHOPPING", merchant_id: "123456789", feed_label: "IN", cpc_bid: "8.5" },
  APP: { ...base, campaign_type: "APP", app_id: "com.example.app", app_store: "GOOGLE_APP_STORE", target_cpa: "120", headlines: ["Install now", "Free app"], descriptions: ["Book appointments faster", "Reminders included"], marketing_images: [A(11)] },
};
const build = (type: string, over: Record<string, unknown> = {}) => {
  const spec = AssetCampaignSpecSchema.parse({ ...SPECS[type], ...over });
  const existing = new Map(pmaxRepeatedTexts(spec).map((t, i) => [t, A(900 + i)])); // PMax links text assets that already exist
  return newPlan("t", account, assetCampaignOperations(spec, account, "abcd1234", existing), {});
};

describe("every supported campaign type conforms to Google's v25 schema", () => {
  for (const type of Object.keys(SPECS)) {
    it(type, () => {
      const plan = build(type);
      const errors = compile(plan).flatMap((op, i) => validateMutateOperation(op as any).map((e) => `${plan.operations[i]!.id}: ${e}`));
      expect(errors).toEqual([]);
      expect(plan.operations.find((o) => o.id === "campaign")!.payload.status).toBe("PAUSED");
      expect(plan.required_permissions).toEqual(["create_campaign"]);
    });
  }
  it("launch is flagged as a launch change", () => expect(build("DISPLAY", { launch: true }).required_permissions).toContain("launch"));
  it("uses the right channel types", () => {
    const channel = (t: string) => build(t).operations.find((o) => o.id === "campaign")!.payload.advertisingChannelType;
    expect([channel("DISPLAY"), channel("DEMAND_GEN"), channel("PERFORMANCE_MAX"), channel("SHOPPING"), channel("APP")]).toEqual(["DISPLAY", "DEMAND_GEN", "PERFORMANCE_MAX", "SHOPPING", "MULTI_CHANNEL"]);
  });
  it("Performance Max builds a full asset group with text and existing image assets", () => {
    const ops = build("PERFORMANCE_MAX").operations;
    const kinds = ops.map((o) => o.kind);
    expect(kinds).toContain("asset_group");
    expect(kinds.filter((k) => k === "asset").length).toBe(1 + 1); // long headline, business name; headlines and descriptions already exist
    expect(ops.filter((o) => o.kind === "asset_group_asset" && ["HEADLINE", "DESCRIPTION"].includes(o.payload.fieldType)).every((o) => !/\/-\d+$/.test(o.payload.asset))).toBe(true);
    const fields = ops.filter((o) => o.kind === "asset_group_asset").map((o) => o.payload.fieldType).sort();
    expect(fields).toEqual(["DESCRIPTION", "DESCRIPTION", "HEADLINE", "HEADLINE", "HEADLINE", "LONG_HEADLINE", "MARKETING_IMAGE", "SQUARE_MARKETING_IMAGE", "YOUTUBE_VIDEO"]);
    expect(ops.find((o) => o.kind === "campaign_asset" && o.payload.fieldType === "LOGO")).toBeTruthy();
  });
});

describe("missing or invalid inputs are refused before anything reaches Google", () => {
  it.each([
    ["PERFORMANCE_MAX", { marketing_images: [] }, /needs 3 headlines/],
    ["PERFORMANCE_MAX", { headlines: ["a", "b"] }, /needs 3 headlines/],
    ["PERFORMANCE_MAX", { descriptions: ["d".repeat(61), "e".repeat(70)] }, /60 text units/],
    ["DISPLAY", { long_headline: undefined }, /long headline/],
    ["DISPLAY", { logos: [] }, /logo/],
    ["DEMAND_GEN", { final_url: undefined }, /final URL/],
    ["SHOPPING", { merchant_id: undefined }, /Merchant ID/],
    ["SHOPPING", { cpc_bid: undefined }, /CPC bid/],
    ["APP", { app_id: undefined }, /app ID/],
    ["APP", { target_cpa: undefined }, /target install cost/],
    ["DISPLAY", { daily_budget: "0" }, /positive/],
    ["DISPLAY", { final_url: "http://example.com" }, /https/],
    ["DISPLAY", { locations: ["Kolkata"] }, /geoTargetConstants/],
    ["DISPLAY", { marketing_images: ["customers/9999999999/assets/1"] }, /another account|does not belong/],
    ["DISPLAY", { headlines: ["x".repeat(31)] }, /format limit/],
  ] as const)("%s %j", (type, over, message) => {
    expect(() => build(type, over as Record<string, unknown>)).toThrow(message);
  });
  it("unknown campaign types and fields are rejected", () => {
    expect(AssetCampaignSpecSchema.safeParse({ ...SPECS.DISPLAY, campaign_type: "VIDEO" }).success).toBe(false);
    expect(AssetCampaignSpecSchema.safeParse({ ...SPECS.DISPLAY, surprise: 1 }).success).toBe(false);
  });
});

describe("through the MCP tool, validation and execution", () => {
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
  });
  afterEach(() => { expect(fake.mutateSchemaErrors).toEqual([]); fake.restore(); });

  const spec = (type: string) => JSON.parse(JSON.stringify(SPECS[type]!).replaceAll("1234567890", CUSTOMER));

  it("PERFORMANCE_MAX: step 1 creates text assets, step 2 links them, and Google accepts it", async () => {
    // The old single-request plan is what Google rejected live with NOT_ENOUGH_HEADLINE_ASSET.
    const first = await mcpTool(draft, "create_campaign_plan", { account_id: CUSTOMER, spec: spec("PERFORMANCE_MAX") });
    expect(first.isError, JSON.stringify(first.body)).toBe(false);
    expect(first.body.data.step).toBe("1_of_2_text_assets");
    expect(first.body.next_action).toMatch(/create_campaign_plan again/);
    const pre = first.body.data.plan_id;
    expect((await mcpTool(draft, "validate_change_plan", { plan_id: pre })).body.status).toBe("ready");
    expect((await mcpTool(apply, "execute_authorised_plan", { plan_id: pre })).body.status).toBe("succeeded");
    expect([...fake.resources.values()].some((x) => x.advertisingChannelType)).toBe(false); // no campaign yet

    const second = await mcpTool(draft, "create_campaign_plan", { account_id: CUSTOMER, spec: spec("PERFORMANCE_MAX") });
    expect(second.body.data.step).toBeUndefined();
    const { plan_id } = second.body.data;
    expect((await mcpTool(draft, "validate_change_plan", { plan_id })).body.status, "Google must accept the campaign request").toBe("ready");
    const ex = await mcpTool(apply, "execute_authorised_plan", { plan_id });
    expect(ex.body.status, JSON.stringify(ex.body)).toBe("succeeded");
    expect([...fake.resources.values()].find((x) => x.advertisingChannelType === "PERFORMANCE_MAX")!.status).toBe("PAUSED");
  });

  it("PERFORMANCE_MAX: an invalid spec is refused before any text asset is drafted", async () => {
    const r = await mcpTool(draft, "create_campaign_plan", { account_id: CUSTOMER, spec: { ...spec("PERFORMANCE_MAX"), logos: [] } });
    expect(r.body.errors[0].code).toBe("missing_assets");
  });

  for (const type of ["DISPLAY", "SHOPPING", "DEMAND_GEN", "APP"]) {
    it(`${type}: draft, validate, execute, paused`, async () => {
      const r = await mcpTool(draft, "create_campaign_plan", { account_id: CUSTOMER, spec: spec(type) });
      expect(r.isError, JSON.stringify(r.body)).toBe(false);
      const { plan_id } = r.body.data;
      expect((await mcpTool(apply, "execute_authorised_plan", { plan_id })).body.errors[0].code).toBe("validate_first");
      expect((await mcpTool(draft, "validate_change_plan", { plan_id })).body.status).toBe("ready");
      const ex = await mcpTool(apply, "execute_authorised_plan", { plan_id });
      // The fake answers every read-back with the stored resources, so creations are verified like in production.
      expect(ex.body.data.errors, JSON.stringify(ex.body)).toEqual([]);
      expect(realMutates(fake).length).toBe(1);
      const campaign = [...fake.resources.values()].find((x) => x.advertisingChannelType !== undefined)!;
      expect(campaign.status).toBe("PAUSED");
    });
  }
  it("SEARCH (explicit or omitted campaign_type) still uses the Search builder", async () => {
    const searchSpec = { name: "S", daily_budget: "100", locations: ["geoTargetConstants/1007788"], contains_eu_political_advertising: false, business_context: {}, groups: [{ name: "G", cpc_bid: "5", keywords: [{ text: "x", match_type: "EXACT" }], headlines: ["One", "Two", "Three"], descriptions: ["First text", "Second text"], final_url: "https://example.com" }] };
    for (const extra of [{}, { campaign_type: "SEARCH" }]) {
      const r = await mcpTool(draft, "create_campaign_plan", { account_id: CUSTOMER, spec: { ...searchSpec, ...extra } });
      expect(r.isError, JSON.stringify(r.body)).toBe(false);
    }
  });
  it("tells the AI which fields are wrong", async () => {
    const r = await mcpTool(draft, "create_campaign_plan", { account_id: CUSTOMER, spec: { ...spec("DISPLAY"), campaign_type: "VIDEO" } });
    expect(r.isError).toBe(true);
    expect(r.body.errors[0].code).toBe("invalid_input");
  });
});
