import { describe, it, expect } from "vitest";
import { boundedGaql, customerId, dateWindow, gaqlContains, gaqlString, moneyMicros } from "../src/google/gaql";
import { pacingMath } from "../src/ads/reports";
import { rsaValidate, SearchSpecSchema, searchCampaignOperations, newPlan, planHash, validatePlanShape, PlanOperationSchema, type Plan } from "../src/ads/plans";
import { mapGoogleError } from "../src/google/ads";
import { redact } from "../src/lib/audit";

// These cases are ported from the original Python suite (tests/test_core.py, tests/test_google.py).
describe("money is exact decimal micros", () => {
  it.each([["0", 0n], ["0.000001", 1n], ["30000", 30_000_000_000n], ["1.234567", 1_234_567n]])("%s", (v, e) => expect(moneyMicros(v)).toBe(e));
  it.each([[0.1], [true], ["nan"], ["Infinity"], ["-1"], ["0.0000001"], ["1e20"], [""], ["1,5"]])("rejects %s", (v) => expect(() => moneyMicros(v)).toThrow());
});

describe("customer IDs", () => {
  it("normalises dashes", () => expect(customerId("123-456-7890")).toBe("1234567890"));
  it.each([["abc"], ["123"], ["123456789012"], ["12345/7890"], [""], [null]])("rejects %s", (v) => expect(() => customerId(v)).toThrow());
});

describe("GAQL validation", () => {
  it.each([
    ["DELETE FROM campaign"], ["SELECT * FROM campaign"], ["SELECT customer.email FROM customer"], ["SELECT campaign.id FROM campaign; SELECT x"],
    ["SELECT campaign.id FROM nonexistent_resource"], ["SELECT campaign.id FROM campaign -- comment"], ["SELECT campaign.id FROM campaign /* x */"],
    ["SELECT campaign.id FROM campaign PARAMETERS include_drafts=true"], ["SELECT user_list.phone_number FROM campaign"],
    ["SELECT customer_client.id FROM customer_client"], ["SELECT change_event.old_resource FROM change_event"],
  ])("rejects %s", (q) => expect(() => boundedGaql(q, 1000)).toThrow());
  it("appends a LIMIT and respects a smaller explicit one", () => {
    expect(boundedGaql("SELECT campaign.id FROM campaign", 1000, 25)).toEqual({ query: "SELECT campaign.id FROM campaign LIMIT 25", limit: 25 });
    expect(boundedGaql("SELECT campaign.id FROM campaign LIMIT 10", 1000)).toEqual({ query: "SELECT campaign.id FROM campaign LIMIT 10", limit: 10 });
    expect(() => boundedGaql("SELECT campaign.id FROM campaign LIMIT 5000", 1000)).toThrow();
  });
  it("manager hierarchy cannot be read through the generic query tool (privacy)", () => {
    expect(() => boundedGaql("SELECT customer_client.id, customer_client.descriptive_name FROM customer_client", 500)).toThrow(/customer_client|unavailable/);
  });
  it("escapes string literals", () => expect(gaqlString("a'b\\c")).toBe("'a\\'b\\\\c'"));
  it("escapes LIKE wildcards so a plan tag matches literally", () => expect(gaqlContains("[Nova ab_1%]")).toBe("'%[[]Nova ab[_]1[%][]]%'"));
  it("date windows are ordered and bounded", () => {
    expect(dateWindow("2026-01-01", "2026-01-31")).toBe("segments.date BETWEEN '2026-01-01' AND '2026-01-31'");
    expect(() => dateWindow("2026-02-01", "2026-01-01")).toThrow();
    expect(() => dateWindow("2025-01-01", "2026-12-31")).toThrow();
    expect(() => dateWindow("2026-1-1", "2026-01-31")).toThrow();
  });
});

describe("budget pacing", () => {
  it("uses the account timezone at month boundaries (31 Jan UTC is already 1 Feb in Kolkata)", () => {
    const r = pacingMath("30000", 1000_000_000n, "Asia/Kolkata", new Date("2026-01-31T20:00:00Z"));
    expect(r.account_local_date).toBe("2026-02-01");
    expect(r.remaining_days_including_today).toBe(28);
    expect(r.daily_pacing_micros).toBe((29_000_000_000n / 28n).toString());
  });
  it("never goes negative when over budget", () => expect(pacingMath("10", 11_000_000n, "Asia/Kolkata").remaining_micros).toBe("0"));
  it("says it is not a Google billing limit", () => expect(pacingMath("10", 0n, "UTC").google_billing_limit).toBe(false));
});

describe("responsive search ads", () => {
  const h = (n: number) => Array.from({ length: n }, (_, i) => `Headline ${i}`);
  const d = ["Description one text", "Description two text"];
  it("accepts 3-15 headlines and 2-4 descriptions", () => expect(() => rsaValidate(h(3), d)).not.toThrow());
  it("rejects too few headlines", () => expect(() => rsaValidate(h(2), d)).toThrow());
  it("rejects duplicates", () => expect(() => rsaValidate(["A", "a", "B"], d)).toThrow());
  it("counts 30 units per headline; Bengali is one unit per character", () => {
    expect(() => rsaValidate([...h(2), "x".repeat(31)], d)).toThrow();
    expect(() => rsaValidate([...h(2), "ক".repeat(30)], d)).not.toThrow();
    expect(() => rsaValidate([...h(2), "漢".repeat(16)], d)).toThrow(); // full-width counts double
  });
});

describe("Google error mapping", () => {
  const failure = (errorCode: Record<string, string>) => JSON.stringify({ error: { code: 403, message: "x", details: [{ "@type": "type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure", requestId: "req-1", errors: [{ errorCode, message: "m", location: { fieldPathElements: [{ fieldName: "mutate_operations", index: 2 }] } }] }] } });
  it("test-access projects", () => {
    const e = mapGoogleError(403, failure({ authorizationError: "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION" }));
    expect(e.code).toBe("production_access_restricted");
    expect(e.requestId).toBe("req-1");
    expect(e.message).toMatch(/Basic access/);
  });
  it("older ACTION_NOT_PERMITTED maps the same way", () => expect(mapGoogleError(403, failure({ authorizationError: "ACTION_NOT_PERMITTED" })).code).toBe("production_access_restricted"));
  it("permission denied", () => expect(mapGoogleError(403, failure({ authorizationError: "USER_PERMISSION_DENIED" })).code).toBe("account_inaccessible"));
  it("expired credentials", () => expect(mapGoogleError(401, "{}").code).toBe("credentials_expired"));
  it("rate limits", () => expect(mapGoogleError(429, "{}").code).toBe("google_rate_limited"));
  it("keeps the failing field path with its index", () => {
    const e = mapGoogleError(400, failure({ fieldError: "REQUIRED" }), true);
    expect(e.code).toBe("validation_failed");
    expect((e.details as any[])[0].field_path).toBe("mutate_operations[2]");
  });
  it("does not choke on non-JSON bodies", () => expect(mapGoogleError(502, "<html>").code).toBe("google_api_error"));
});

describe("audit redaction", () => {
  it("masks tokens, secrets and Bearer headers", () => {
    const r = redact({ note: "Bearer abcdefghijklmnopqrstuvwxyz0123", refresh_token: "1//0gAbcdefghijklmnopqrstuvwx", nested: { x: "ya29.a0AfH6SMBabcdefghij", ok: "fine" } }) as any;
    expect(JSON.stringify(r)).not.toMatch(/abcdefghijklmnop|ya29\.a0/);
    expect(r.nested.ok).toBe("fine");
  });
});

describe("plan integrity", () => {
  const account = { customer_id: "1234567890", name: "T", currency: "INR", timezone: "Asia/Kolkata", manager: false, login_customer_id: null };
  const spec = (over: Record<string, unknown> = {}) =>
    SearchSpecSchema.parse({
      name: "Clinic Search", daily_budget: "250.00", bidding: "MANUAL_CPC", locations: ["geoTargetConstants/1007788"], contains_eu_political_advertising: false, business_context: { goal: "calls" },
      groups: [{ name: "Dentist", cpc_bid: "12.50", keywords: [{ text: "dentist kolkata", match_type: "PHRASE" }], headlines: ["Best Dentist", "Book Today", "Kolkata Clinic"], descriptions: ["Gentle care by experts.", "Open six days a week."], final_url: "https://example.com/dentist" }],
      ...over,
    });
  const make = (over: Record<string, unknown> = {}) => newPlan("admin:test", account, searchCampaignOperations(spec(over), account, "abcd1234"), {});

  it("creates a paused campaign by default and a stable hash", async () => {
    const plan = make();
    expect(plan.operations.find((o) => o.id === "campaign")!.payload.status).toBe("PAUSED");
    expect(await planHash(plan)).toBe(await planHash(JSON.parse(JSON.stringify(plan))));
    expect(plan.required_permissions).toEqual(["create_campaign"]);
  });
  it("changing any reviewed content changes the hash", async () => {
    const plan = make();
    const h = await planHash(plan);
    const edited = JSON.parse(JSON.stringify(plan)) as Plan;
    edited.operations[0]!.payload.amountMicros = "999000000";
    expect(await planHash(edited)).not.toBe(h);
  });
  it("launch asks for the separate launch permission", () => expect(make({ launch: true }).required_permissions).toContain("launch"));
  it("rejects unsupported languages-free spec, missing CPC and bad locations", () => {
    expect(() => make({ groups: [{ ...spec().groups[0]!, cpc_bid: undefined }] })).toThrow(/cpc_bid/);
    expect(() => make({ locations: ["Kolkata"] })).toThrow(/geoTargetConstants/);
    expect(() => make({ locations: [] })).toThrow(/location/);
    expect(() => make({ daily_budget: "0" })).toThrow();
    expect(() => make({ daily_budget: 250 })).toThrow();
  });
  it("rejects http landing pages and credentials in URLs", () => {
    expect(() => make({ groups: [{ ...spec().groups[0]!, final_url: "http://example.com" }] })).toThrow();
    expect(() => make({ groups: [{ ...spec().groups[0]!, final_url: "https://user:pw@example.com" }] })).toThrow();
  });
  const upd = (over: Record<string, unknown>) => PlanOperationSchema.parse({ id: "u1", kind: "campaign", action: "update", resource_name: "customers/1234567890/campaigns/55", field_mask: ["status"], payload: { status: "PAUSED" }, reason: "pause", spending_effect: "stops spend", recovery: "enable again", ...over });
  const planOf = (ops: any[]): Plan => ({ ...make(), operations: ops });
  it("removal is rejected", () => expect(() => validatePlanShape(planOf([upd({ payload: { status: "REMOVED" } })]))).toThrow(/Removal is disabled|Only ENABLED/));
  it("numeric status aliases are rejected", () => expect(() => validatePlanShape(planOf([upd({ payload: { status: 4 } })]))).toThrow());
  it("an update cannot hide unmasked fields", () => expect(() => validatePlanShape(planOf([upd({ payload: { status: "PAUSED", name: "sneaky" } })]))).toThrow(/exactly match/));
  it("fields outside the allowlist are rejected", () => expect(() => validatePlanShape(planOf([upd({ field_mask: ["advertisingChannelType"], payload: { advertisingChannelType: "DISPLAY" } })]))).toThrow(/not updatable/));
  it("nested resources from another account are rejected", () =>
    expect(() => validatePlanShape(planOf([PlanOperationSchema.parse({ id: "c1", kind: "campaign_criterion", action: "create", payload: { campaign: "customers/9999999999/campaigns/1", negative: true, keyword: { text: "x", matchType: "EXACT" } }, reason: "r r", spending_effect: "none", recovery: "none rec" })]))).toThrow(/another account/));
  it("conflicting updates to one field are rejected", () => expect(() => validatePlanShape(planOf([upd({}), upd({ id: "u2" })]))).toThrow(/Conflicting/));
  it("temporary references need a declared dependency", () => {
    const plan = make();
    const ops = JSON.parse(JSON.stringify(plan.operations)) as any[];
    ops.find((o) => o.id === "campaign").depends_on = [];
    expect(() => validatePlanShape({ ...plan, operations: ops })).toThrow(/dependency/);
  });
});
