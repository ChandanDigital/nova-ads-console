import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { scanTracking, trackingFindings } from "../src/tracking/website";
import { issueToken, mcpTool, resetDb, setupAdmin, type Session } from "./helpers";
import { FakeGoogle, CUSTOMER } from "./fake-google";
import { connectAndAllow } from "./flow";

const GTM = (id: string) => `<script>(function(w,d,s,l,i){w[l]=w[l]||[];var j=d.createElement(s);j.src='https://www.googletagmanager.com/gtm.js?id='+i;})(window,document,'script','dataLayer','${id}');</script>`;
const MESSY = `<!doctype html><html><head><title>Hall</title>
<script>gtag('consent','default',{ad_storage:'denied',analytics_storage:'denied',region:['GB']});</script>
${GTM("GTM-AB12CD")}
<script async src="https://www.googletagmanager.com/gtag/js?id=G-XYZ12345"></script>
<script>gtag('config','G-XYZ12345');gtag('config','AW-123456789');gtag('event','conversion',{send_to:'AW-123456789/AbC-12'});</script>
${GTM("GTM-AB12CD")}
<link rel="stylesheet" href="/wp-content/themes/x.css"></head>
<body><noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-AB12CD"></iframe></noscript>
<form action="/enquiry"></form><a href="tel:+919800000000">Call</a><script>ga('create','UA-1234567-1')</script></body></html>`;

const ids = (f: { id: string }[]) => f.map((x) => x.id);

describe("tracking scan of page source", () => {
  it("finds IDs, a duplicate GTM loader, legacy UA, partial Consent Mode v2 and the platform", () => {
    const s = scanTracking(MESSY);
    expect(s.gtm_containers).toEqual(["GTM-AB12CD"]);
    expect(s.gtm_loader_count).toEqual({ "GTM-AB12CD": 2 }); // the noscript iframe is not a loader
    expect(s.ga4_measurement_ids).toEqual(["G-XYZ12345"]);
    expect(s.google_ads_tag_ids).toEqual(["AW-123456789"]);
    expect(s.ads_conversion_send_to).toEqual(["AW-123456789/AbC-12"]);
    expect(s.legacy_ua_ids).toEqual(["UA-1234567-1"]);
    expect(s.consent).toEqual({ default_found: true, update_found: false, default_keys: ["ad_storage", "analytics_storage"], region_specific: true, default_before_tags: true });
    expect(s.platform_hints).toEqual(["wordpress"]);
    const f = ids(trackingFindings(s, { forms: 1, tel_links: 1 }));
    expect(f).toEqual(expect.arrayContaining(["duplicate_gtm", "gtm_and_direct_ga4", "legacy_universal_analytics", "consent_v2_keys_missing", "consent_update_not_seen"]));
    expect(f).not.toContain("no_google_tag");
  });

  it("a page without tags fails and says why it may be wrong", () => {
    const f = trackingFindings(scanTracking("<html><body>Hello</body></html>"), { forms: 0, tel_links: 0 });
    expect(ids(f)).toEqual(["no_google_tag", "consent_default_missing"]);
    expect(f[0]!.note).toMatch(/Tag Assistant/);
  });

  it("a consent default placed after the tag loader is flagged", () => {
    const html = `${GTM("GTM-ZZ99ZZ")}<script>gtag('consent','default',{ad_storage:'denied',analytics_storage:'denied',ad_user_data:'denied',ad_personalization:'denied'})</script>`;
    const f = ids(trackingFindings(scanTracking(html), { forms: 0, tel_links: 0 }));
    expect(f).toContain("consent_default_after_tags");
    expect(f).not.toContain("consent_v2_keys_missing");
  });

  it("compares the page with the Google Ads account's tag and conversion actions", () => {
    const s = scanTracking(MESSY);
    const ads = (tid: string, actions: { type: string; status: string; primary_for_goal: boolean }[]) => ({ customer_id: CUSTOMER, conversion_tracking_id: tid, google_ads_conversion_customer: null, actions_truncated: false, actions: actions.map((a) => ({ name: "x", category: "DEFAULT", ...a })) });
    expect(ids(trackingFindings(s, { forms: 1, tel_links: 1 }, ads("123456789", [{ type: "WEBPAGE", status: "ENABLED", primary_for_goal: true }])))).toEqual(expect.arrayContaining(["ads_tag_matches_account", "calls_not_measured"]));
    expect(ids(trackingFindings(s, { forms: 1, tel_links: 1 }, ads("999999999", [{ type: "WEBSITE_CALL", status: "ENABLED", primary_for_goal: true }])))).toEqual(expect.arrayContaining(["ads_tag_other_account", "forms_not_measured"]));
    expect(ids(trackingFindings(s, { forms: 0, tel_links: 0 }, ads("123456789", [{ type: "WEBPAGE", status: "REMOVED", primary_for_goal: true }])))).toContain("no_enabled_conversion_actions");
  });
});

describe("tracking_audit_website tool", () => {
  const fake = new FakeGoogle();
  let s: Session;
  let read: string;
  beforeEach(async () => {
    await resetDb(); fake.reset(); fake.install();
    s = await setupAdmin();
    await connectAndAllow(s, fake);
    read = await issueToken(s, ["read"]);
  });
  afterEach(() => fake.restore());

  it("audits the page and the account with read permission only, and never claims firing", async () => {
    fake.pages["https://hall.example.in/"] = MESSY;
    fake.customers[CUSTOMER].conversionTrackingSetting = { conversionTrackingId: "123456789" };
    fake.cannedRows.conversion_action = [{ conversionAction: { name: "Enquiry form", type: "WEBPAGE", status: "ENABLED", category: "SUBMIT_LEAD_FORM", primaryForGoal: true } }];
    const r = await mcpTool(read, "tracking_audit_website", { url: "https://hall.example.in/", account_id: CUSTOMER });
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    const d = r.body.data;
    expect(d.status).toBe("problems_found");
    expect(d.google_ads.conversion_tracking_id).toBe("123456789");
    expect(ids(d.findings)).toEqual(expect.arrayContaining(["duplicate_gtm", "ads_tag_matches_account", "calls_not_measured"]));
    expect(d.not_verified.join(" ")).toMatch(/actually fires/);
    expect(fake.callsTo("googleAds:mutate").length).toBe(0);
  });

  it("refuses private hosts through the same SSRF guard as the landing check", async () => {
    const r = await mcpTool(read, "tracking_audit_website", { url: "https://10.0.0.1/" });
    expect(r.isError).toBe(true);
    expect(r.body.errors[0].code).toBe("invalid_url");
  });
});
