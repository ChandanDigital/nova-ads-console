import type { Env } from "../env";

/**
 * Optional: real platform numbers from Cloudflare's GraphQL Analytics API. Needs two extra secrets
 * (CF_API_TOKEN with "Account Analytics: Read", and CF_ACCOUNT_ID). Without them the dashboard shows the
 * numbers it measured itself (D1 row counts come straight from D1's own metadata).
 * Field names follow Cloudflare's documented Workers/D1 datasets; this call is NOT verified against a live account.
 */
export const cloudflareUsage = async (env: Env): Promise<{ available: boolean; reason?: string; data?: unknown }> => {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return { available: false, reason: "CF_API_TOKEN and CF_ACCOUNT_ID are not set (optional)." };
  const day = new Date().toISOString().slice(0, 10);
  const query = `query($acct: String!, $since: Time!, $until: Time!, $day: Date!) {
    viewer { accounts(filter: {accountTag: $acct}) {
      workersInvocationsAdaptive(limit: 50, filter: {datetime_geq: $since, datetime_leq: $until}) { sum { requests errors subrequests } quantiles { cpuTimeP50 cpuTimeP99 } dimensions { scriptName } }
      d1AnalyticsAdaptiveGroups(limit: 50, filter: {date_geq: $day, date_leq: $day}) { sum { readQueries writeQueries rowsRead rowsWritten } dimensions { databaseId } }
    } } }`;
  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ query, variables: { acct: env.CF_ACCOUNT_ID, since: `${day}T00:00:00Z`, until: new Date().toISOString(), day } }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json()) as { data?: unknown; errors?: { message: string }[] };
    if (!res.ok || body.errors?.length) return { available: false, reason: body.errors?.[0]?.message ?? `HTTP ${res.status}` };
    return { available: true, data: body.data };
  } catch (e) {
    return { available: false, reason: e instanceof Error ? e.message : "request failed" };
  }
};
