import { z } from "zod";
import type { Ctx, Principal } from "../lib/context";
import { NodiError } from "../lib/errors";
import { moneyMicros } from "../google/gaql";
import { adsFor, resolveAccount } from "./accounts";
import { SearchSpecSchema, newPlan, searchCampaignOperations, type SearchSpec } from "./plans";
import { planAccount, savePlan } from "./planner";

/**
 * Duplicate a Search campaign as a NEW paused campaign. Nothing is changed in the source campaign.
 * The copy goes through the same plan -> Google validateOnly -> human approval -> execute path as any new campaign.
 */
export const DuplicateInputSchema = z
  .object({
    campaign_id: z.string().regex(/^\d{1,20}$/, "Use the numeric campaign ID"),
    new_name: z.string().min(1).max(100),
    daily_budget: z.string().optional(),
    contains_eu_political_advertising: z.boolean().optional(),
  })
  .strict();

const MAX_ROWS = 500;
const microsToDecimal = (v: unknown): string => {
  const n = BigInt(String(v ?? "0"));
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
};

const NOT_COPIED = "Not copied: sitelinks and callouts, ad schedules, device bid modifiers, radius targets, shared negative lists, AI Max settings, ad group level negative keywords, ad pins, extra ads beyond the first enabled responsive search ad per ad group, and anything else outside the Search builder. Review and add them in a follow-up plan.";

export const createDuplicateCampaignPlan = async (ctx: Ctx, p: Principal, accountId: string, input: unknown) => {
  const account = await resolveAccount(ctx, p, accountId, "draft");
  const parsed = DuplicateInputSchema.safeParse(input);
  if (!parsed.success) throw new NodiError("invalid_input", "Check the duplication fields.", 400, parsed.error.issues.slice(0, 10).map((i) => ({ field: i.path.join("."), problem: i.message })));
  const { campaign_id: cid } = parsed.data;
  const ads = adsFor(ctx, account);
  const read = async (query: string) => {
    const r = await ads.search(account.customer_id, query, MAX_ROWS);
    if (r.truncated) throw new NodiError("campaign_too_large", `This campaign has more than ${MAX_ROWS} rows in one of its parts, which is more than a duplicate plan can safely carry. Duplicate it in parts or build it with create_campaign_plan.`, 422);
    return r.rows;
  };

  const [camp] = await read(
    `SELECT campaign.id, campaign.name, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign.network_settings.target_search_network, campaign.geo_target_type_setting.positive_geo_target_type, campaign.contains_eu_political_advertising, campaign.maximize_conversions.target_cpa_micros, campaign.target_cpa.target_cpa_micros, campaign.maximize_conversion_value.target_roas, campaign.target_roas.target_roas, campaign.target_spend.cpc_bid_ceiling_micros, campaign_budget.amount_micros FROM campaign WHERE campaign.id = ${cid} LIMIT 1`,
  );
  if (!camp?.campaign) throw new NodiError("campaign_not_found", "No such campaign in this account.", 404);
  const c = camp.campaign;
  if (c.advertisingChannelType !== "SEARCH") throw new NodiError("unsupported_campaign_type", `Only Search campaigns can be duplicated here (this one is ${c.advertisingChannelType}). Build other types with create_campaign_plan.`, 422);

  let bidding: SearchSpec["bidding"];
  const extra: Partial<SearchSpec> = {};
  switch (c.biddingStrategyType) {
    case "MANUAL_CPC": bidding = "MANUAL_CPC"; break;
    case "MAXIMIZE_CONVERSIONS":
    case "TARGET_CPA": {
      bidding = "MAXIMIZE_CONVERSIONS";
      const t = c.maximizeConversions?.targetCpaMicros ?? c.targetCpa?.targetCpaMicros;
      if (t) extra.target_cpa = microsToDecimal(t);
      break;
    }
    case "MAXIMIZE_CONVERSION_VALUE":
    case "TARGET_ROAS": {
      bidding = "MAXIMIZE_CONVERSION_VALUE";
      const t = c.maximizeConversionValue?.targetRoas ?? c.targetRoas?.targetRoas;
      if (t) extra.target_roas = String(t);
      break;
    }
    case "TARGET_SPEND": {
      bidding = "MAXIMIZE_CLICKS";
      if (c.targetSpend?.cpcBidCeilingMicros) extra.cpc_bid_ceiling = microsToDecimal(c.targetSpend.cpcBidCeilingMicros);
      break;
    }
    default:
      throw new NodiError("unsupported_bidding", `The bidding strategy ${c.biddingStrategyType} cannot be copied by the Search builder. Create the campaign with create_campaign_plan.`, 422);
  }

  const eu = parsed.data.contains_eu_political_advertising ?? (c.containsEuPoliticalAdvertising === "CONTAINS_EU_POLITICAL_ADVERTISING" ? true : c.containsEuPoliticalAdvertising === "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING" ? false : undefined);
  if (eu === undefined) throw new NodiError("declaration_needed", "Google did not return the EU political advertising declaration. Send contains_eu_political_advertising (true or false).", 422);

  const [criteria, groups, keywords, adRows] = [
    await read(`SELECT campaign_criterion.type, campaign_criterion.negative, campaign_criterion.location.geo_target_constant, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type FROM campaign_criterion WHERE campaign.id = ${cid} AND campaign_criterion.type IN ('LOCATION', 'KEYWORD')`),
    await read(`SELECT ad_group.id, ad_group.name, ad_group.cpc_bid_micros FROM ad_group WHERE campaign.id = ${cid} AND ad_group.status != 'REMOVED' ORDER BY ad_group.id`),
    await read(`SELECT ad_group.id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.negative FROM ad_group_criterion WHERE campaign.id = ${cid} AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.status != 'REMOVED'`),
    await read(`SELECT ad_group.id, ad_group_ad.status, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.ad.responsive_search_ad.path1, ad_group_ad.ad.responsive_search_ad.path2 FROM ad_group_ad WHERE campaign.id = ${cid} AND ad_group_ad.status != 'REMOVED' AND ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'`),
  ];

  const locations: string[] = [];
  const excluded: string[] = [];
  const negatives: { text: string; match_type: "EXACT" | "PHRASE" | "BROAD" }[] = [];
  for (const r of criteria) {
    const x = r.campaignCriterion;
    if (x?.type === "LOCATION" && x.location?.geoTargetConstant) (x.negative ? excluded : locations).push(x.location.geoTargetConstant);
    else if (x?.type === "KEYWORD" && x.negative && x.keyword?.text) negatives.push({ text: x.keyword.text, match_type: x.keyword.matchType });
  }

  const warnings: string[] = [NOT_COPIED];
  const specGroups: SearchSpec["groups"] = [];
  let skipped = 0;
  let groupNegatives = 0;
  for (const g of groups) {
    const id = String(g.adGroup?.id);
    const kws = keywords.filter((k) => String(k.adGroup?.id) === id && !k.adGroupCriterion?.negative && k.adGroupCriterion?.keyword?.text);
    groupNegatives += keywords.filter((k) => String(k.adGroup?.id) === id && k.adGroupCriterion?.negative).length;
    const ad = adRows.find((a) => String(a.adGroup?.id) === id && a.adGroupAd?.status === "ENABLED") ?? adRows.find((a) => String(a.adGroup?.id) === id);
    const rsa = ad?.adGroupAd?.ad?.responsiveSearchAd;
    if (!kws.length || !rsa?.headlines?.length || !ad?.adGroupAd?.ad?.finalUrls?.length) { skipped++; continue; }
    specGroups.push({
      name: g.adGroup.name,
      ...(bidding === "MANUAL_CPC" ? { cpc_bid: microsToDecimal(g.adGroup.cpcBidMicros ?? "0") } : {}),
      keywords: kws.map((k) => ({ text: k.adGroupCriterion.keyword.text, match_type: k.adGroupCriterion.keyword.matchType })),
      headlines: rsa.headlines.map((x: { text: string }) => x.text),
      descriptions: (rsa.descriptions ?? []).map((x: { text: string }) => x.text),
      final_url: ad.adGroupAd.ad.finalUrls[0],
      path1: rsa.path1 ?? "", path2: rsa.path2 ?? "",
    });
  }
  if (skipped) warnings.push(`${skipped} ad group(s) were skipped because they lack an eligible keyword, responsive search ad or final URL.`);
  if (groupNegatives) warnings.push(`${groupNegatives} ad-group-level negative keyword(s) were not copied.`);
  if (!specGroups.length) throw new NodiError("nothing_to_copy", "No ad group with keywords and a responsive search ad was found in this campaign.", 422);

  const budget = parsed.data.daily_budget ?? microsToDecimal(camp.campaignBudget?.amountMicros ?? "0");
  if (moneyMicros(budget) <= 0n) throw new NodiError("invalid_budget", "The source budget could not be read. Send daily_budget.", 422);
  const candidate = {
    name: parsed.data.new_name, daily_budget: budget, bidding, ...extra,
    locations, excluded_locations: excluded, negative_keywords: negatives, groups: specGroups,
    search_partners: c.networkSettings?.targetSearchNetwork === true,
    presence_only: c.geoTargetTypeSetting?.positiveGeoTargetType === "PRESENCE",
    contains_eu_political_advertising: eu, launch: false,
    business_context: { duplicated_from: cid, source_name: String(c.name ?? "").slice(0, 100) },
  };
  const spec = SearchSpecSchema.safeParse(candidate);
  if (!spec.success) {
    throw new NodiError("duplicate_invalid", "The source campaign could not be turned into a valid new campaign. Fix the listed fields (for example by using create_campaign_plan).", 422, spec.error.issues.slice(0, 20).map((i) => ({ field: i.path.join("."), problem: i.message })));
  }
  const planId = crypto.randomUUID();
  const ops = searchCampaignOperations(spec.data, planAccount(account), planId.slice(0, 8));
  const plan = newPlan(`${p.kind}:${p.label}`, planAccount(account), ops, spec.data.business_context);
  plan.id = planId;
  const saved = await savePlan(ctx, p, plan, account);
  return { ...saved, copied: { ad_groups: specGroups.length, keywords: specGroups.reduce((n, g) => n + g.keywords.length, 0), locations: locations.length + excluded.length, negative_keywords: negatives.length }, warnings };
};
