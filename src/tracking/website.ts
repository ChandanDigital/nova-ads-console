import type { Ctx, Principal } from "../lib/context";
import { readLandingPage } from "../ads/landing";
import { Q, runQuery } from "../ads/reports";

/**
 * Website tracking audit from the page source (one public fetch, at most 100 KB) plus, optionally, the Google Ads
 * account's conversion setup (two read-only GAQL queries). It proves what the HTML contains, never that a tag fires:
 * tags injected by GTM, plugins or JavaScript after load are invisible here. Firing needs GTM Preview / Tag Assistant /
 * GA4 DebugView. Page text is untrusted data.
 */
export interface TrackingScan {
  gtm_containers: string[];
  ga4_measurement_ids: string[];
  google_ads_tag_ids: string[];
  ads_conversion_send_to: string[];
  legacy_ua_ids: string[];
  gtm_loader_count: Record<string, number>;
  gtag_config_count: Record<string, number>;
  data_layer: boolean;
  consent: { default_found: boolean; update_found: boolean; default_keys: string[]; region_specific: boolean; default_before_tags: boolean | null };
  platform_hints: string[];
}

const all = (re: RegExp, s: string): string[] => [...s.matchAll(re)].map((m) => m[1]!);
const uniq = (a: string[]): string[] => [...new Set(a)];
const counts = (a: string[]): Record<string, number> => a.reduce<Record<string, number>>((o, x) => ((o[x] = (o[x] ?? 0) + 1), o), {});
const CONSENT_KEYS = ["ad_storage", "analytics_storage", "ad_user_data", "ad_personalization"];
const CALL_TYPES = new Set(["AD_CALL", "WEBSITE_CALL", "CLICK_TO_CALL"]);
const WEB_TYPES = new Set(["WEBPAGE", "WEBPAGE_CODELESS", "GOOGLE_ANALYTICS_4_CUSTOM", "GOOGLE_ANALYTICS_4_PURCHASE", "UPLOAD_CLICKS"]);

export const scanTracking = (html: string): TrackingScan => {
  // Standard GTM snippet ends with ('script','dataLayer','GTM-XXXX'); a hard-coded loader uses gtm.js?id=GTM-XXXX. The noscript iframe is not a loader.
  const gtmLoads = [...all(/['"]dataLayer['"]\s*,\s*['"](GTM-[A-Z0-9]{4,12})['"]/g, html), ...all(/gtm\.js\?id=(GTM-[A-Z0-9]{4,12})/g, html)];
  const configs = all(/gtag\(\s*['"]config['"]\s*,\s*['"]((?:G|AW|GT|DC)-[A-Z0-9-]{4,20})['"]/g, html);
  const consentDefault = /gtag\(\s*['"]consent['"]\s*,\s*['"]default['"]\s*,\s*\{([^}]{0,1500})\}/.exec(html);
  const firstLoader = html.search(/googletagmanager\.com\/(gtm|gtag)|['"]dataLayer['"]\s*,\s*['"]GTM-/);
  const platform: string[] = [];
  if (/\/wp-content\/|\/wp-includes\//.test(html)) platform.push("wordpress");
  if (/woocommerce/i.test(html)) platform.push("woocommerce");
  if (/cdn\.shopify\.com|Shopify\.theme/.test(html)) platform.push("shopify");
  if (/__NEXT_DATA__|\/_next\/static\//.test(html)) platform.push("nextjs");
  if (/static\.wixstatic\.com|wix\.com/.test(html)) platform.push("wix");
  if (/squarespace\.com|static1\.squarespace/.test(html)) platform.push("squarespace");
  return {
    gtm_containers: uniq(all(/\b(GTM-[A-Z0-9]{4,12})\b/g, html)),
    ga4_measurement_ids: uniq(all(/\b(G-[A-Z0-9]{6,14})\b/g, html)),
    google_ads_tag_ids: uniq(all(/\b(AW-\d{6,12})\b/g, html)),
    ads_conversion_send_to: uniq(all(/send_to['"]?\s*:\s*['"](AW-\d{6,12}\/[\w-]{1,40})['"]/g, html)),
    legacy_ua_ids: uniq(all(/\b(UA-\d{4,10}-\d{1,4})\b/g, html)),
    gtm_loader_count: counts(gtmLoads),
    gtag_config_count: counts(configs),
    data_layer: /\bdataLayer\b/.test(html),
    consent: {
      default_found: !!consentDefault,
      update_found: /gtag\(\s*['"]consent['"]\s*,\s*['"]update['"]/.test(html),
      default_keys: consentDefault ? CONSENT_KEYS.filter((k) => consentDefault[1]!.includes(k)) : [],
      region_specific: !!consentDefault && /\bregion\b/.test(consentDefault[1]!),
      default_before_tags: consentDefault && firstLoader >= 0 ? consentDefault.index < firstLoader : null,
    },
    platform_hints: platform,
  };
};

type Finding = { id: string; level: "ok" | "info" | "warn" | "fail"; note: string };

export interface AdsSetup {
  customer_id: string;
  conversion_tracking_id: string | null;
  google_ads_conversion_customer: string | null;
  actions: { name: string; type: string; status: string; category: string; primary_for_goal: boolean }[];
  actions_truncated: boolean;
}

export const trackingFindings = (scan: TrackingScan, page: { forms: number; tel_links: number }, ads?: AdsSetup): Finding[] => {
  const f: Finding[] = [];
  const add = (id: string, level: Finding["level"], note: string) => f.push({ id, level, note });
  const hasTag = scan.gtm_containers.length > 0 || Object.keys(scan.gtag_config_count).length > 0;
  if (!hasTag) add("no_google_tag", "fail", "No GTM container or Google tag found in the page source. If a plugin injects tags after load this check cannot see them; confirm with Tag Assistant.");
  for (const [id, n] of Object.entries(scan.gtm_loader_count)) if (n > 1) add("duplicate_gtm", "fail", `GTM container ${id} is loaded ${n} times; every tag in it can fire twice.`);
  for (const [id, n] of Object.entries(scan.gtag_config_count)) if (n > 1) add("duplicate_gtag_config", "warn", `gtag config for ${id} appears ${n} times; page views may be counted twice.`);
  if (scan.gtm_containers.length && Object.keys(scan.gtag_config_count).some((x) => x.startsWith("G-"))) add("gtm_and_direct_ga4", "warn", "GA4 is configured directly in the page and a GTM container is also present. If GTM also sends to the same measurement ID, events are double counted: check the container.");
  if (scan.gtm_containers.length > 1) add("several_gtm_containers", "warn", `${scan.gtm_containers.length} GTM containers found (${scan.gtm_containers.join(", ")}). Make sure each has a distinct purpose.`);
  if (scan.legacy_ua_ids.length) add("legacy_universal_analytics", "warn", `Universal Analytics IDs (${scan.legacy_ua_ids.join(", ")}) are still on the page; Universal Analytics no longer processes data. Remove them.`);
  if (!scan.consent.default_found) add("consent_default_missing", "warn", "No gtag('consent','default', ...) in the page source. Consent Mode v2 is required for EEA/UK traffic; it may come from a CMP or a GTM Consent Initialization tag, which this check cannot see.");
  else {
    const missing = CONSENT_KEYS.filter((k) => !scan.consent.default_keys.includes(k));
    if (missing.length) add("consent_v2_keys_missing", "warn", `The consent default does not set ${missing.join(", ")} (Consent Mode v2 needs all four).`);
    if (scan.consent.default_before_tags === false) add("consent_default_after_tags", "warn", "The consent default appears after a Google tag loader; it must run before any tag.");
    if (!scan.consent.update_found) add("consent_update_not_seen", "info", "No consent update call in the page source; a CMP normally sends it after the visitor chooses.");
  }
  if (ads) {
    if (ads.conversion_tracking_id) {
      const own = `AW-${ads.conversion_tracking_id}`;
      if (scan.google_ads_tag_ids.includes(own)) add("ads_tag_matches_account", "ok", `${own} (this account's tag) is in the page source.`);
      else if (scan.google_ads_tag_ids.length) add("ads_tag_other_account", "warn", `The page has ${scan.google_ads_tag_ids.join(", ")} but this account tracks conversions as ${own}.`);
      else add("ads_tag_not_in_source", "info", `${own} is not in the page source; it may be loaded by GTM. Confirm in GTM Preview.`);
    }
    const enabled = ads.actions.filter((a) => a.status === "ENABLED");
    if (!enabled.length) add("no_enabled_conversion_actions", "fail", "The Google Ads account has no enabled conversion actions; Smart Bidding has nothing to optimise for.");
    if (page.tel_links > 0 && !enabled.some((a) => CALL_TYPES.has(a.type))) add("calls_not_measured", "warn", "The page has phone links but the account has no enabled call conversion action (calls from ads, website calls or click-to-call).");
    if (page.forms > 0 && !enabled.some((a) => WEB_TYPES.has(a.type) && a.primary_for_goal)) add("forms_not_measured", "warn", "The page has a form but no enabled primary website conversion action exists.");
  }
  return f;
};

const readAdsSetup = async (ctx: Ctx, p: Principal, accountId: string): Promise<AdsSetup> => {
  const setting = await runQuery(ctx, p, accountId, "SELECT customer.conversion_tracking_setting.conversion_tracking_id, customer.conversion_tracking_setting.google_ads_conversion_customer FROM customer", 1);
  const actions = await runQuery(ctx, p, accountId, Q.conversionActions, 500);
  const s = (setting.data.rows[0] as any)?.customer?.conversion_tracking_setting ?? {};
  return {
    customer_id: setting.account.customer_id,
    conversion_tracking_id: s.conversion_tracking_id != null ? String(s.conversion_tracking_id) : null,
    google_ads_conversion_customer: s.google_ads_conversion_customer ?? null,
    actions: (actions.data.rows as any[]).map((r) => r.conversion_action ?? {}).map((a) => ({ name: String(a.name ?? ""), type: String(a.type ?? "UNKNOWN"), status: String(a.status ?? "UNKNOWN"), category: String(a.category ?? "UNKNOWN"), primary_for_goal: a.primary_for_goal === true })),
    actions_truncated: actions.data.truncated,
  };
};

export const auditWebsiteTracking = async (ctx: Ctx, p: Principal, url: string, accountId?: string) => {
  const { report, html } = await readLandingPage(url);
  const scan = scanTracking(html);
  const ads = accountId ? await readAdsSetup(ctx, p, accountId) : undefined;
  const findings = trackingFindings(scan, report, ads);
  if (report.truncated) findings.push({ id: "page_truncated", level: "info", note: "Only the first 100 KB of the page was read (Workers free-plan limit). Tags placed later in the page would be missed." });
  return {
    url: report.final_url,
    http_status: report.status,
    bytes_read: report.bytes_read,
    page_truncated: report.truncated,
    page: { forms: report.forms, tel_links: report.tel_links },
    found: scan,
    google_ads: ads ?? null,
    findings,
    status: findings.some((x) => x.level === "fail") ? "problems_found" : findings.some((x) => x.level === "warn") ? "warnings" : "no_problems_in_source",
    verification_level: "page_source_and_account_configuration",
    not_verified: [
      "whether any tag actually fires (use GTM Preview or Tag Assistant)",
      "tags injected by GTM, plugins or JavaScript after the page loads",
      "GA4 event delivery (use GA4 DebugView)",
      "consent banner behaviour and the visitor's real consent state",
      "pages other than this URL and content beyond the first 100 KB",
    ],
  };
};
