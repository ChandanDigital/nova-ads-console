import { env } from "cloudflare:workers";
import { call, workerFetch, ORIGIN, type Session } from "./helpers";
import { CUSTOMER, type FakeGoogle } from "./fake-google";

/** Drives the real Google connection flow against FakeGoogle, then allows an account for AI use. */
export const connectAndAllow = async (s: Session, fake: FakeGoogle, accounts: string[] = [CUSTOMER]) => {
  const r = await call("/api/google/connect", { method: "POST", session: s });
  const u = new URL(r.json.url);
  fake.challenge = u.searchParams.get("code_challenge");
  await workerFetch(new Request(`${ORIGIN}/oauth/google/callback?state=${encodeURIComponent(u.searchParams.get("state")!)}&code=good-code`, { headers: { cookie: s.cookie }, redirect: "manual" }));
  for (const id of accounts) await call(`/api/accounts/${id}/allow`, { method: "POST", session: s, body: { allowed: true } });
  return (await env.DB.prepare("SELECT id FROM google_connections").first<{ id: string }>())!.id;
};

export const searchSpec = (over: Record<string, unknown> = {}) => ({
  name: "Clinic Search", daily_budget: "250.00", bidding: "MANUAL_CPC", locations: ["geoTargetConstants/1007788"], contains_eu_political_advertising: false, business_context: { goal: "appointments" },
  groups: [{ name: "Dentist", cpc_bid: "12.50", keywords: [{ text: "dentist kolkata", match_type: "PHRASE" }], headlines: ["Best Dentist", "Book Today", "Kolkata Clinic"], descriptions: ["Gentle care by experts.", "Open six days a week."], final_url: "https://example.com/dentist" }],
  ...over,
});

export const realMutates = (fake: FakeGoogle) => fake.calls.filter((c) => c.url.endsWith("googleAds:mutate") && c.body?.validateOnly === false);
export const validateMutates = (fake: FakeGoogle) => fake.calls.filter((c) => c.url.endsWith("googleAds:mutate") && c.body?.validateOnly === true);
