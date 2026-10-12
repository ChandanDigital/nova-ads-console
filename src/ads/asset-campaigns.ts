import { z } from "zod";
import { NovaError } from "../lib/errors";
import { moneyMicros } from "../google/gaql";
import { PlanOperationSchema, httpsUrl, resourceValid, type PlanAccount, type PlanOperation } from "./plans";

/**
 * Display, Shopping, Performance Max, Demand Gen and App-install campaign builders (ported from the original Python
 * `asset_campaigns.py`). Everything is created PAUSED unless `launch` is set, and Google's validateOnly check still decides
 * eligibility (linked Merchant feed, app store listing, existing image assets, conversion tracking ...).
 * Images and videos must already exist in the account as assets: this edition does not upload binary files.
 */
export const ASSET_CAMPAIGN_TYPES = ["DISPLAY", "SHOPPING", "PERFORMANCE_MAX", "DEMAND_GEN", "APP"] as const;

export const AssetCampaignSpecSchema = z
  .object({
    campaign_type: z.enum(ASSET_CAMPAIGN_TYPES),
    name: z.string().min(1).max(100),
    daily_budget: z.string(),
    contains_eu_political_advertising: z.boolean(),
    business_context: z.record(z.string(), z.any()),
    locations: z.array(z.string()).min(1).max(100),
    final_url: z.string().optional(),
    business_name: z.string().optional(),
    headlines: z.array(z.string()).max(15).default([]),
    descriptions: z.array(z.string()).max(5).default([]),
    long_headline: z.string().optional(),
    marketing_images: z.array(z.string()).max(20).default([]),
    square_images: z.array(z.string()).max(20).default([]),
    logos: z.array(z.string()).max(5).default([]),
    videos: z.array(z.string()).max(5).default([]),
    target_cpa: z.string().optional(),
    target_roas: z.string().optional(),
    cpc_bid: z.string().optional(),
    merchant_id: z.string().optional(),
    feed_label: z.string().optional(),
    app_id: z.string().optional(),
    app_store: z.enum(["GOOGLE_APP_STORE", "APPLE_APP_STORE"]).optional(),
    launch: z.boolean().default(false),
  })
  .strict();
export type AssetCampaignSpec = z.infer<typeof AssetCampaignSpecSchema>;

const units = (s: string): number => [...s].reduce((n, ch) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch) ? 2 : 1), 0);

export const assetCampaignOperations = (spec: AssetCampaignSpec, account: PlanAccount, planTag: string): PlanOperation[] => {
  const type = spec.campaign_type;
  const cid = account.customer_id;
  const base = `customers/${cid}`;
  const budgetRn = `${base}/campaignBudgets/-1`;
  const campaignRn = `${base}/campaigns/-2`;
  const ops: PlanOperation[] = [];
  let nextAsset = -100;

  const add = (id: string, kind: string, payload: Record<string, unknown>, deps: string[] = []) =>
    ops.push(PlanOperationSchema.parse({
      id, kind, action: "create", payload, depends_on: deps,
      reason: `Create the reviewed ${type} campaign.`,
      spending_effect: `Average daily budget ${spec.daily_budget} ${account.currency}; spend starts only if serving is enabled.`,
      recovery: "Pause the campaign or serving resource. Creation leaves records; removal is disabled.",
    }));

  const amount = moneyMicros(spec.daily_budget);
  if (amount <= 0n) throw new NovaError("invalid_budget", "Choose a positive daily budget.", 400);
  const finalUrl = spec.final_url ? httpsUrl(spec.final_url) : undefined;
  for (const resource of [...spec.marketing_images, ...spec.square_images, ...spec.logos, ...spec.videos]) resourceValid(resource, cid, "asset");
  for (const [values, limit] of [[spec.headlines, 30], [spec.descriptions, 90]] as const) {
    if (values.some((x) => !x.trim() || units(x) > limit)) throw new NovaError("invalid_creative", "Ad text exceeds its format limit or is empty.", 400);
  }
  for (const loc of spec.locations) if (!/^geoTargetConstants\/\d+$/.test(loc)) throw new NovaError("invalid_location", "Use geoTargetConstants/<id> resources (see search_geo_targets).", 400);

  const name = `${spec.name} [Nova ${planTag}]`;
  add("budget", "campaign_budget", { resourceName: budgetRn, name: `${name} budget`, amountMicros: amount.toString(), deliveryMethod: "STANDARD", explicitlyShared: false });

  const cp: Record<string, any> = {
    resourceName: campaignRn,
    name,
    advertisingChannelType: type === "APP" ? "MULTI_CHANNEL" : type,
    campaignBudget: budgetRn,
    status: spec.launch ? "ENABLED" : "PAUSED",
    containsEuPoliticalAdvertising: spec.contains_eu_political_advertising ? "CONTAINS_EU_POLITICAL_ADVERTISING" : "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
  };
  if (type === "SHOPPING") {
    if (!spec.merchant_id || !/^\d+$/.test(spec.merchant_id) || !spec.feed_label || !spec.cpc_bid) throw new NovaError("missing_feed", "Standard Shopping needs a linked Merchant ID, a feed label and a CPC bid.", 400);
    cp.manualCpc = {};
    cp.shoppingSetting = { merchantId: spec.merchant_id, feedLabel: spec.feed_label, campaignPriority: 0, enableLocal: false };
  } else if (type === "APP") {
    if (!spec.app_id || !spec.app_store || !spec.target_cpa) throw new NovaError("missing_app", "App installs need an app ID, the store and a target install cost.", 400);
    cp.advertisingChannelSubType = "APP_CAMPAIGN";
    cp.targetCpa = { targetCpaMicros: moneyMicros(spec.target_cpa).toString() };
    cp.appCampaignSetting = { appId: spec.app_id, appStore: spec.app_store, biddingStrategyGoalType: "OPTIMIZE_INSTALLS_TARGET_INSTALL_COST" };
  } else if (type === "PERFORMANCE_MAX") {
    if (spec.target_roas !== undefined && !(Number(spec.target_roas) > 0)) throw new NovaError("invalid_bid", "ROAS target must be positive.", 400);
    cp.maximizeConversionValue = spec.target_roas ? { targetRoas: Number(spec.target_roas) } : {};
    cp.brandGuidelinesEnabled = true;
  } else {
    cp.maximizeConversions = spec.target_cpa ? { targetCpaMicros: moneyMicros(spec.target_cpa).toString() } : {};
  }
  add("campaign", "campaign", cp, ["budget"]);
  spec.locations.forEach((loc, i) => add(`location${i}`, "campaign_criterion", { campaign: campaignRn, location: { geoTargetConstant: loc } }, ["campaign"]));

  if (type === "PERFORMANCE_MAX") {
    if (spec.headlines.length < 3 || spec.descriptions.length < 2 || !spec.long_headline || !spec.business_name || !finalUrl || !spec.marketing_images.length || !spec.square_images.length || !spec.logos.length) {
      throw new NovaError("missing_assets", "Performance Max (non-retail) needs 3 headlines, 2 descriptions, a long headline, business name, final URL, a landscape image, a square image and a logo.", 400);
    }
    if (units(spec.long_headline) > 90 || units(spec.business_name) > 25) throw new NovaError("invalid_creative", "Long headline (90) or business name (25) exceeds its limit.", 400);
    const groupRn = `${base}/assetGroups/-3`;
    add("assetgroup", "asset_group", { resourceName: groupRn, campaign: campaignRn, name: `${name} assets`, finalUrls: [finalUrl], status: "ENABLED" }, ["campaign"]);
    const textAsset = (id: string, text: string, field: string, campaignLevel = false) => {
      const rn = `${base}/assets/${nextAsset--}`;
      add(id, "asset", { resourceName: rn, textAsset: { text } });
      if (campaignLevel) add(`${id}link`, "campaign_asset", { campaign: campaignRn, asset: rn, fieldType: field }, ["campaign", id]);
      else add(`${id}link`, "asset_group_asset", { assetGroup: groupRn, asset: rn, fieldType: field }, ["assetgroup", id]);
    };
    spec.headlines.forEach((t, i) => textAsset(`headline${i}`, t, "HEADLINE"));
    spec.descriptions.forEach((t, i) => textAsset(`description${i}`, t, "DESCRIPTION"));
    textAsset("longheadline", spec.long_headline, "LONG_HEADLINE");
    textAsset("businessname", spec.business_name, "BUSINESS_NAME", true);
    const existing: [string, string[]][] = [["MARKETING_IMAGE", spec.marketing_images], ["SQUARE_MARKETING_IMAGE", spec.square_images], ["LOGO", spec.logos], ["YOUTUBE_VIDEO", spec.videos]];
    for (const [field, resources] of existing) {
      resources.forEach((rn, i) => {
        const campaignLevel = field === "LOGO";
        const id = `${field.toLowerCase()}${i}`;
        if (campaignLevel) add(id, "campaign_asset", { campaign: campaignRn, asset: rn, fieldType: field }, ["campaign"]);
        else add(id, "asset_group_asset", { assetGroup: groupRn, asset: rn, fieldType: field }, ["assetgroup"]);
      });
    }
    return ops;
  }

  const groupRn = `${base}/adGroups/-3`;
  const gp: Record<string, any> = { resourceName: groupRn, campaign: campaignRn, name: `${name} group`, status: "ENABLED" };
  if (type === "DISPLAY") gp.type = "DISPLAY_STANDARD";
  if (type === "SHOPPING") {
    gp.type = "SHOPPING_PRODUCT_ADS";
    gp.cpcBidMicros = moneyMicros(spec.cpc_bid!).toString();
  }
  add("group", "ad_group", gp, ["campaign"]);
  if (type === "SHOPPING") {
    add("products", "ad_group_criterion", { adGroup: groupRn, listingGroup: { type: "UNIT" }, cpcBidMicros: moneyMicros(spec.cpc_bid!).toString() }, ["group"]);
    add("ad", "ad_group_ad", { adGroup: groupRn, status: "ENABLED", ad: { shoppingProductAd: {} } }, ["group"]);
    return ops;
  }
  if (!spec.headlines.length || !spec.descriptions.length) throw new NovaError("missing_copy", "Headlines and descriptions are required.", 400);
  const content: Record<string, any> = { headlines: spec.headlines.map((text) => ({ text })), descriptions: spec.descriptions.map((text) => ({ text })) };
  let ad: Record<string, any>;
  if (type === "DISPLAY" || type === "DEMAND_GEN") {
    if (!finalUrl || !spec.business_name || !spec.marketing_images.length || !spec.square_images.length || !spec.logos.length) {
      throw new NovaError("missing_assets", "This image campaign needs a final URL, business name, landscape and square images and a logo.", 400);
    }
    if (units(spec.business_name) > 25) throw new NovaError("invalid_creative", "Business name exceeds 25 text units.", 400);
    Object.assign(content, {
      businessName: spec.business_name,
      marketingImages: spec.marketing_images.map((asset) => ({ asset })),
      squareMarketingImages: spec.square_images.map((asset) => ({ asset })),
      logoImages: spec.logos.map((asset) => ({ asset })),
    });
    if (type === "DISPLAY") {
      if (!spec.long_headline || units(spec.long_headline) > 90) throw new NovaError("missing_copy", "Display needs a long headline of at most 90 text units.", 400);
      content.longHeadline = { text: spec.long_headline };
    }
    ad = { finalUrls: [finalUrl], [type === "DISPLAY" ? "responsiveDisplayAd" : "demandGenMultiAssetAd"]: content };
  } else {
    Object.assign(content, { images: spec.marketing_images.map((asset) => ({ asset })), youtubeVideos: spec.videos.map((asset) => ({ asset })) });
    ad = { appAd: content };
  }
  add("ad", "ad_group_ad", { adGroup: groupRn, status: "ENABLED", ad }, ["group"]);
  return ops;
};

/** `campaign_type` absent or "SEARCH" means the Search builder; anything else is an asset-based campaign. */
export const splitCampaignType = (specInput: unknown): { isAsset: boolean; input: Record<string, unknown> } => {
  const { campaign_type: type, ...rest } = (specInput && typeof specInput === "object" ? specInput : {}) as Record<string, unknown>;
  return type === undefined || type === "SEARCH" ? { isAsset: false, input: rest } : { isAsset: true, input: { campaign_type: type, ...rest } };
};
