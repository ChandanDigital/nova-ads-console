import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { call, issueToken, mcpTool, resetDb, setupAdmin, type Session } from "./helpers";
import { FakeGoogle, CUSTOMER } from "./fake-google";
import { connectAndAllow, realMutates } from "./flow";

const campaignRow = (over: Record<string, unknown> = {}, budget = "250000000") => ({
  campaign: { id: "777", name: "Original Search", advertisingChannelType: "SEARCH", biddingStrategyType: "MANUAL_CPC", networkSettings: { targetSearchNetwork: true }, geoTargetTypeSetting: { positiveGeoTargetType: "PRESENCE" }, containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING", ...over },
  campaignBudget: { amountMicros: budget },
});
const group = (id: string, name: string, bid = "12500000") => ({ adGroup: { id, name, cpcBidMicros: bid } });
const kw = (g: string, text: string, matchType = "PHRASE", negative = false) => ({ adGroup: { id: g }, adGroupCriterion: { keyword: { text, matchType }, negative } });
const rsa = (g: string, status = "ENABLED", url = "https://example.com/dentist") => ({ adGroup: { id: g }, adGroupAd: { status, ad: { finalUrls: [url], responsiveSearchAd: { headlines: [{ text: "Best Dentist" }, { text: "Book Today" }, { text: "Kolkata Clinic" }], descriptions: [{ text: "Gentle care by experts." }, { text: "Open six days a week." }], path1: "care", path2: "" } } } });

describe("duplicate a Search campaign as a new paused campaign", () => {
  const fake = new FakeGoogle();
  let s: Session;
  let draft: string;
  let apply: string;
  const seed = (over: Record<string, unknown> = {}) => {
    fake.cannedRows = {
      campaign: [campaignRow(over)],
      campaign_criterion: [
        { campaignCriterion: { type: "LOCATION", negative: false, location: { geoTargetConstant: "geoTargetConstants/1007788" } } },
        { campaignCriterion: { type: "LOCATION", negative: true, location: { geoTargetConstant: "geoTargetConstants/1007800" } } },
        { campaignCriterion: { type: "KEYWORD", negative: true, keyword: { text: "free", matchType: "BROAD" } } },
      ],
      ad_group: [group("1", "Dentist"), group("2", "Empty group"), group("3", "Implants", "9000000")],
      ad_group_criterion: [kw("1", "dentist kolkata"), kw("1", "dentist near me", "EXACT"), kw("1", "cheap", "BROAD", true), kw("3", "dental implants")],
      ad_group_ad: [rsa("1", "PAUSED"), rsa("1"), rsa("3")],
    };
  };
  beforeEach(async () => {
    await resetDb(); fake.reset(); fake.install();
    s = await setupAdmin();
    await connectAndAllow(s, fake);
    draft = await issueToken(s, ["read", "draft"]);
    apply = await issueToken(s, ["read", "draft", "apply"]);
    seed();
  });
  afterEach(() => { expect(fake.mutateSchemaErrors).toEqual([]); fake.restore(); });

  it("builds a new paused campaign from the source, reports what it skipped, and changes nothing in the source", async () => {
    const r = await mcpTool(draft, "create_duplicate_campaign_plan", { account_id: CUSTOMER, campaign_id: "777", new_name: "Copy of Search" });
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    const d = r.body.data;
    expect(d.copied).toEqual({ ad_groups: 2, keywords: 3, locations: 2, negative_keywords: 1 });
    expect(d.warnings.join(" ")).toMatch(/Not copied: sitelinks/);
    expect(d.warnings.join(" ")).toMatch(/1 ad group\(s\) were skipped/);
    expect(d.warnings.join(" ")).toMatch(/1 ad-group-level negative/);
    expect(d.required_permissions).toEqual(["create_campaign"]);
    const p = (await mcpTool(draft, "preview_change_plan", { plan_id: d.plan_id })).body.data.plan;
    const byId = Object.fromEntries(p.operations.map((o: any) => [o.id, o.payload]));
    expect(byId.campaign.status).toBe("PAUSED");
    expect(byId.campaign.name).toMatch(/^Copy of Search \[Nova [0-9a-f]{8}\]$/);
    expect(byId.campaign.networkSettings.targetSearchNetwork).toBe(true);
    expect(byId.campaign.geoTargetTypeSetting.positiveGeoTargetType).toBe("PRESENCE");
    expect(byId.budget.amountMicros).toBe("250000000");
    expect(byId.group0.cpcBidMicros).toBe("12500000");
    expect(byId.group1.cpcBidMicros).toBe("9000000");
    expect(byId.group0keyword0.keyword).toEqual({ text: "dentist kolkata", matchType: "PHRASE" });
    expect(byId.location1.negative).toBe(true);
    expect(byId.negative0.keyword).toEqual({ text: "free", matchType: "BROAD" });
    // the ENABLED responsive ad is preferred over the paused one
    expect(byId.group0rsa.ad.finalUrls).toEqual(["https://example.com/dentist"]);
    // reading only: no write reached Google
    expect(realMutates(fake).length).toBe(0);
  });

  it("goes through Google validation before anything is created", async () => {
    const r = await mcpTool(draft, "create_duplicate_campaign_plan", { account_id: CUSTOMER, campaign_id: "777", new_name: "Copy of Search", daily_budget: "300" });
    const { plan_id } = r.body.data;
    expect((await mcpTool(apply, "execute_authorised_plan", { plan_id })).body.errors[0].code).toBe("validate_first");
    expect((await mcpTool(draft, "validate_change_plan", { plan_id })).body.status).toBe("ready");
    expect(realMutates(fake).length).toBe(0);
    const ex = await mcpTool(apply, "execute_authorised_plan", { plan_id });
    expect(ex.body.data.errors, JSON.stringify(ex.body)).toEqual([]);
    expect(realMutates(fake).length).toBe(1);
    const created = [...fake.resources.values()].find((x) => x.advertisingChannelType === "SEARCH")!;
    expect(created.status).toBe("PAUSED");
    expect([...fake.resources.values()].find((x) => x.amountMicros === "300000000")).toBeTruthy();
  });

  it("copies target CPA and ROAS bidding", async () => {
    seed({ biddingStrategyType: "MAXIMIZE_CONVERSIONS", maximizeConversions: { targetCpaMicros: "150000000" } });
    const a = await mcpTool(draft, "create_duplicate_campaign_plan", { account_id: CUSTOMER, campaign_id: "777", new_name: "Copy CPA" });
    const plan = (await mcpTool(draft, "preview_change_plan", { plan_id: a.body.data.plan_id })).body.data.plan;
    expect(plan.operations.find((o: any) => o.id === "campaign").payload.maximizeConversions).toEqual({ targetCpaMicros: "150000000" });
    seed({ biddingStrategyType: "TARGET_ROAS", targetRoas: { targetRoas: 3.5 } });
    const b = await mcpTool(draft, "create_duplicate_campaign_plan", { account_id: CUSTOMER, campaign_id: "777", new_name: "Copy ROAS" });
    const plan2 = (await mcpTool(draft, "preview_change_plan", { plan_id: b.body.data.plan_id })).body.data.plan;
    expect(plan2.operations.find((o: any) => o.id === "campaign").payload.maximizeConversionValue).toEqual({ targetRoas: 3.5 });
  });

  it.each([
    ["a Display campaign", { advertisingChannelType: "DISPLAY" }, "unsupported_campaign_type"],
    ["an unsupported bidding strategy", { biddingStrategyType: "TARGET_IMPRESSION_SHARE" }, "unsupported_bidding"],
    ["a missing EU declaration", { containsEuPoliticalAdvertising: undefined }, "declaration_needed"],
  ])("refuses %s", async (_label, over, code) => {
    seed(over as Record<string, unknown>);
    const r = await mcpTool(draft, "create_duplicate_campaign_plan", { account_id: CUSTOMER, campaign_id: "777", new_name: "X" });
    expect(r.isError).toBe(true);
    expect(r.body.errors[0].code).toBe(code);
  });

  it("accepts an explicit EU declaration when Google returns none", async () => {
    seed({ containsEuPoliticalAdvertising: undefined });
    const r = await mcpTool(draft, "create_duplicate_campaign_plan", { account_id: CUSTOMER, campaign_id: "777", new_name: "X", contains_eu_political_advertising: false });
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
  });

  it("unknown campaigns, bad IDs, oversized campaigns and groups without ads are handled", async () => {
    fake.cannedRows.campaign = [];
    expect((await mcpTool(draft, "create_duplicate_campaign_plan", { account_id: CUSTOMER, campaign_id: "777", new_name: "X" })).body.errors[0].code).toBe("campaign_not_found");
    expect((await mcpTool(draft, "create_duplicate_campaign_plan", { account_id: CUSTOMER, campaign_id: "7 OR 1=1", new_name: "X" })).isError).toBe(true);
    seed();
    fake.cannedRows.ad_group_criterion = Array.from({ length: 501 }, (_, i) => kw("1", `kw ${i}`));
    expect((await mcpTool(draft, "create_duplicate_campaign_plan", { account_id: CUSTOMER, campaign_id: "777", new_name: "X" })).body.errors[0].code).toBe("campaign_too_large");
    seed();
    fake.cannedRows.ad_group_ad = [];
    expect((await mcpTool(draft, "create_duplicate_campaign_plan", { account_id: CUSTOMER, campaign_id: "777", new_name: "X" })).body.errors[0].code).toBe("nothing_to_copy");
    seed();
    fake.cannedRows.ad_group_ad = [rsa("1", "ENABLED", "http://example.com/insecure"), rsa("3")];
    expect((await mcpTool(draft, "create_duplicate_campaign_plan", { account_id: CUSTOMER, campaign_id: "777", new_name: "X" })).body.errors[0].code).toBe("invalid_url");
  });

  it("needs the draft permission", async () => {
    const read = await issueToken(s, ["read"]);
    expect((await mcpTool(read, "create_duplicate_campaign_plan", { account_id: CUSTOMER, campaign_id: "777", new_name: "X" })).body.errors[0].code).toBe("forbidden");
  });
});
