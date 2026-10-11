import { vi } from "vitest";
import { validateMutateOperation } from "./schema-validate";

/** A faithful-enough in-memory Google (OAuth token service + Google Ads REST) used by the tests. Nothing here talks to the real Google. */
export interface Call { url: string; method: string; headers: Record<string, string>; body: any; }

const b64u = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const fakeIdToken = (sub: string, email: string) => `${b64u('{"alg":"none"}')}.${b64u(JSON.stringify({ sub, email }))}.sig`;

const sha256b64u = async (s: string) => {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return btoa(String.fromCharCode(...new Uint8Array(d))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const CUSTOMER = "3010086756";
export const MANAGER = "9998887776";
export const CHILD = "1112223334";

const defaultCustomers = (): Record<string, any> => ({
  [CUSTOMER]: { id: CUSTOMER, descriptiveName: "Pradhan Clinic", currencyCode: "INR", timeZone: "Asia/Kolkata", manager: false, status: "ENABLED" },
  [MANAGER]: { id: MANAGER, descriptiveName: "Agency Manager", currencyCode: "USD", timeZone: "UTC", manager: true, status: "ENABLED" },
  [CHILD]: { id: CHILD, descriptiveName: "Child Shop", currencyCode: "USD", timeZone: "America/New_York", manager: false, status: "ENABLED" },
});

export class FakeGoogle {
  calls: Call[] = [];
  mutateSchemaErrors: string[] = [];
  /** challenge captured from the Google consent URL, to verify PKCE at the token endpoint */
  challenge: string | null = null;
  refreshToken = "1//fake-refresh-token-0123456789abcdef";
  refreshOk = true;
  accessCounter = 0;
  resources = new Map<string, Record<string, any>>();
  cannedRows: Record<string, any[]> = {};
  customers: Record<string, any> = defaultCustomers();
  accessible = [CUSTOMER, MANAGER];
  mutateFailure: null | "timeout" | "server_error" | { status: number; body: unknown } = null;
  validateFailure: null | { status: number; body: unknown } = null;
  /** makes every non-identity search fail (for the monitor) */
  searchFailure: null | { status: number; body: unknown } = null;
  /** RecommendationService answers 200 but changes nothing (to prove verification catches it) */
  recommendNoEffect = false;
  recommendFailure: null | { status: number; body: unknown } = null;
  nextId = 5000;
  private original: typeof fetch | undefined;

  install() {
    this.original = globalThis.fetch;
    vi.stubGlobal("fetch", (input: any, init?: any) => this.handle(input, init));
  }
  restore() { vi.unstubAllGlobals(); }
  reset() {
    this.calls = []; this.mutateSchemaErrors = []; this.mutateFailure = null; this.validateFailure = null; this.searchFailure = null; this.recommendNoEffect = false; this.recommendFailure = null; this.resources.clear(); this.cannedRows = {}; this.refreshOk = true; this.customers = defaultCustomers();
  }

  seed(rn: string, obj: Record<string, any>) { this.resources.set(rn, { resourceName: rn, ...obj }); }
  callsTo(fragment: string) { return this.calls.filter((c) => c.url.includes(fragment)); }

  private json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  private async handle(input: any, init: any = {}): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = String(v);
    let body: any = init.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = Object.fromEntries(new URLSearchParams(body)); } }
    this.calls.push({ url, method, headers, body });

    if (url === "https://oauth2.googleapis.com/token") return this.token(body);
    if (url === "https://oauth2.googleapis.com/revoke") return this.json({});
    if (!url.startsWith("https://googleads.googleapis.com/v25/")) return this.json({ error: "unexpected host " + url }, 599);
    if (!(headers.authorization ?? "").startsWith("Bearer ya29.")) return this.json({ error: { code: 401, status: "UNAUTHENTICATED", message: "bad token" } }, 401);

    const path = url.replace("https://googleads.googleapis.com/v25/", "");
    if (path === "customers:listAccessibleCustomers") return this.json({ resourceNames: this.accessible.map((c) => `customers/${c}`) });
    const m = /^customers\/(\d+)\/googleAds:(search|mutate)$/.exec(path);
    if (m) return m[2] === "search" ? this.search(m[1]!, body, headers) : this.mutate(m[1]!, body);
    const rm = /^customers\/(\d+)\/recommendations:(apply|dismiss)$/.exec(path);
    if (rm) return this.recommend(rm[1]!, rm[2]!, body);
    if (path === "googleAdsFields:search") return this.json({ results: [{ name: "campaign.id", category: "ATTRIBUTE", selectable: true, filterable: true, sortable: true, dataType: "INT64" }] });
    if (path.endsWith(":generateKeywordIdeas")) return this.json({ results: [{ text: "dentist near me", keywordIdeaMetrics: { avgMonthlySearches: "1000" } }] });
    if (path === "geoTargetConstants:suggest") return this.json({ geoTargetConstantSuggestions: [{ geoTargetConstant: { resourceName: "geoTargetConstants/1007788", name: "Kolkata" } }] });
    return this.json({ error: { code: 404, message: "unknown path " + path } }, 404);
  }

  private async token(form: any): Promise<Response> {
    if (form.client_id !== "test-client.apps.googleusercontent.com" || form.client_secret !== "test-client-secret") return this.json({ error: "invalid_client" }, 401);
    if (form.grant_type === "authorization_code") {
      if (form.code === "no-refresh") return this.json({ access_token: "ya29.access-" + ++this.accessCounter, expires_in: 3600, scope: "openid email https://www.googleapis.com/auth/adwords", id_token: fakeIdToken("sub-1", "owner@example.com") });
      if (form.code === "no-ads-scope") return this.json({ access_token: "ya29.access-" + ++this.accessCounter, expires_in: 3600, refresh_token: this.refreshToken, scope: "openid email" });
      if (form.code !== "good-code") return this.json({ error: "invalid_grant" }, 400);
      if (this.challenge && (await sha256b64u(form.code_verifier ?? "")) !== this.challenge) return this.json({ error: "invalid_grant", error_description: "PKCE" }, 400);
      return this.json({ access_token: "ya29.access-" + ++this.accessCounter, expires_in: 3600, refresh_token: this.refreshToken, scope: "openid email https://www.googleapis.com/auth/adwords", id_token: fakeIdToken("sub-1", "owner@example.com") });
    }
    if (form.grant_type === "refresh_token") {
      if (!this.refreshOk || form.refresh_token !== this.refreshToken) return this.json({ error: "invalid_grant" }, 400);
      return this.json({ access_token: "ya29.access-" + ++this.accessCounter, expires_in: 3600, scope: "https://www.googleapis.com/auth/adwords" });
    }
    return this.json({ error: "unsupported_grant_type" }, 400);
  }

  private pick(obj: Record<string, any>, path: string): any {
    let v: any = obj;
    for (const part of path.split(".")) { if (v === undefined || v === null) return undefined; v = v[part]; }
    return v;
  }
  private camel(s: string) { return s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase()); }
  private setPath(target: any, path: string, val: any) {
    const parts = path.split("."); let cur = target;
    for (const p of parts.slice(0, -1)) cur = cur[p] ??= {};
    cur[parts[parts.length - 1]!] = val;
  }

  private search(cid: string, body: any, headers: Record<string, string>): Response {
    const q: string = body.query;
    const from = /\bFROM\s+(\w+)/i.exec(q)?.[1] ?? "";
    const fields = (/^\s*SELECT\s+(.+?)\s+FROM\s/is.exec(q)?.[1] ?? "").split(",").map((s) => s.trim());
    if (from === "customer") {
      const c = this.customers[cid]; if (!c) return this.json({ error: { code: 403, message: "x", details: [{ errors: [{ errorCode: { authorizationError: "USER_PERMISSION_DENIED" }, message: "no access" }] }] } }, 403);
      return this.json({ results: [{ customer: { id: c.id, descriptiveName: c.descriptiveName, currencyCode: c.currencyCode, timeZone: c.timeZone, manager: c.manager || undefined, status: c.status } }] });
    }
    if (from === "customer_client") {
      if (headers["login-customer-id"] !== cid) return this.json({ error: { code: 403, message: "login-customer-id required" } }, 403);
      const rows = [MANAGER, CHILD].map((id) => ({ customerClient: { id, descriptiveName: this.customers[id].descriptiveName, currencyCode: this.customers[id].currencyCode, timeZone: this.customers[id].timeZone, manager: this.customers[id].manager || undefined, status: "ENABLED", level: id === MANAGER ? "0" : "1" } }));
      return this.json({ results: rows });
    }
    if (this.searchFailure) return this.json(this.searchFailure.body, this.searchFailure.status);
    const inList = /\.resource_name\s+IN\s*\(([^)]*)\)/i.exec(q);
    if (inList) {
      const names = [...inList[1]!.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((x) => x[1]!);
      const results = names.filter((n) => this.resources.has(n)).map((n) => {
        const obj = this.resources.get(n)!; const row: any = {};
        const key = this.camel(from); row[key] = {};
        for (const f of fields) { const p = f.split(".").slice(1).map((x) => this.camel(x)).join("."); const v = this.pick(obj, p); if (v !== undefined) this.setPath(row[key], p, v); }
        return row;
      });
      return this.json({ results });
    }
    const eq = /(\w+)\.(\w+)\s*=\s*'([^']*)'/.exec(q);
    if (from === "campaign" && eq && eq[2] === "campaign_budget") {
      const rows = [...this.resources.values()].filter((r) => r.campaignBudget === eq[3]).map((r) => ({ campaign: { id: r.resourceName.split("/").pop(), name: r.name, campaignBudget: r.campaignBudget } }));
      return this.json({ results: rows });
    }
    const like = /name LIKE '%\[Nodi ([0-9a-f]{8})\]%'/.exec(q);
    if (like) {
      const results = [...this.resources.values()].filter((r) => r.resourceName.includes(`/${from === "campaign" ? "campaigns" : "campaignBudgets"}/`) && String(r.name ?? "").includes(`[Nodi ${like[1]}]`)).map((r) => ({ [this.camel(from)]: { resourceName: r.resourceName, name: r.name } }));
      return this.json({ results });
    }
    return this.json({ results: this.cannedRows[from] ?? [] });
  }

  private recommend(cid: string, action: string, body: any): Response {
    if (this.recommendFailure) return this.json(this.recommendFailure.body, this.recommendFailure.status);
    const ops: { resourceName: string }[] = body.operations ?? [];
    if (body.partialFailure !== false) return this.json({ error: { code: 400, message: "Nodi must send partialFailure=false" } }, 400);
    for (const o of ops) if (!this.resources.has(o.resourceName)) return this.json({ error: { code: 404, message: "no such recommendation " + o.resourceName } }, 404);
    if (!this.recommendNoEffect) {
      for (const o of ops) {
        if (action === "apply") this.resources.delete(o.resourceName);
        else this.resources.set(o.resourceName, { ...this.resources.get(o.resourceName)!, dismissed: true });
      }
    }
    return this.json({ results: ops.map((o) => ({ resourceName: o.resourceName })) });
  }

  private mutate(cid: string, body: any): Response {
    const ops: Record<string, any>[] = body.mutateOperations ?? [];
    for (const op of ops) this.mutateSchemaErrors.push(...validateMutateOperation(op));
    if (body.validateOnly) {
      if (this.validateFailure) return this.json(this.validateFailure.body, this.validateFailure.status);
      return this.json({});
    }
    if (this.mutateFailure === "timeout") throw new DOMException("timed out", "TimeoutError");
    if (this.mutateFailure === "server_error") return this.json({ error: { code: 500, message: "internal" } }, 500);
    if (this.mutateFailure && typeof this.mutateFailure === "object") return this.json(this.mutateFailure.body, this.mutateFailure.status);
    const temps = new Map<string, string>();
    const replace = (v: any): any => {
      if (typeof v === "string") { for (const [t, r] of temps) if (v === t) return r; return v; }
      if (Array.isArray(v)) return v.map(replace);
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, replace(x)]));
      return v;
    };
    const responses: any[] = [];
    for (const wrapper of ops) {
      const [opKey, op] = Object.entries(wrapper)[0] as [string, any];
      const resultKey = opKey.replace(/Operation$/, "Result");
      if (op.create) {
        const rn0 = op.create.resourceName as string | undefined;
        const coll = rn0 ? rn0.split("/")[2]! : { campaignAssetOperation: "campaignAssets", assetGroupAssetOperation: "assetGroupAssets", adGroupCriterionOperation: "adGroupCriteria", adGroupAdOperation: "adGroupAds", campaignCriterionOperation: "campaignCriteria" }[opKey]!;
        const id = ++this.nextId;
        const rn = `customers/${cid}/${coll}/${id}`;
        if (rn0) temps.set(rn0, rn);
        const stored = replace({ ...op.create, resourceName: rn });
        this.resources.set(rn, stored);
        responses.push({ [resultKey]: { resourceName: rn } });
      } else {
        const rn = op.update.resourceName as string;
        const cur = this.resources.get(rn) ?? { resourceName: rn };
        for (const path of String(op.updateMask).split(",")) this.setPath(cur, path, this.pick(op.update, path));
        this.resources.set(rn, cur);
        responses.push({ [resultKey]: { resourceName: rn } });
      }
    }
    return this.json({ mutateOperationResponses: responses });
  }
}
