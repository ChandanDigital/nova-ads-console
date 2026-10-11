import type { Env } from "../env";
import { adsVersion } from "../env";
import type { Db } from "../lib/db";
import { now } from "../lib/db";
import { NodiError } from "../lib/errors";
import { addUsage, enforceQuota } from "../lib/usage";
import { getAccessToken } from "./oauth";

const BASE = "https://googleads.googleapis.com";

export interface AdsRef {
  connectionId: string;
  loginCustomerId?: string | null;
}

export interface SearchResult {
  rows: Record<string, any>[];
  truncated: boolean;
  requestId?: string;
}

export interface MutateResult {
  mutateOperationResponses: Record<string, any>[];
  partialFailureError?: unknown;
  requestId?: string;
}

interface GoogleFailure {
  errorCode?: Record<string, string>;
  message?: string;
  location?: { fieldPathElements?: { fieldName: string; index?: number }[] };
}

/** Turns a Google Ads REST error into a NodiError with a stable code. Keeps codes, field paths and request id; drops raw user input. */
export const mapGoogleError = (status: number, bodyText: string, validateOnly = false): NodiError => {
  let parsed: any = null;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    /* keep null */
  }
  const err = Array.isArray(parsed) ? parsed[0]?.error : parsed?.error;
  const failures: GoogleFailure[] = [];
  let requestId: string | undefined;
  for (const d of err?.details ?? []) {
    if (Array.isArray(d.errors)) failures.push(...d.errors);
    if (d.requestId) requestId = d.requestId;
  }
  const codes = failures.map((f) => Object.entries(f.errorCode ?? {}).map(([k, v]) => `${k}.${v}`).join(","));
  const details = failures.slice(0, 20).map((f, i) => ({
    code: codes[i],
    message: (f.message ?? "").slice(0, 300),
    field_path: (f.location?.fieldPathElements ?? []).map((p) => (p.index !== undefined ? `${p.fieldName}[${p.index}]` : p.fieldName)).join("."),
  }));
  const has = (s: string) => codes.some((c) => c.includes(s));
  let code = "google_api_error";
  let message = "Google rejected the request. Review the error codes and request ID.";
  let http = 502;
  if (has("CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION") || has("ACTION_NOT_PERMITTED")) {
    code = "production_access_restricted";
    message = "Your Google Cloud project only has Test access to Google Ads API, so it cannot read production accounts. Apply for Basic access for this Cloud project, or use a Google Ads test account.";
    http = 403;
  } else if (has("USER_PERMISSION_DENIED") || has("CUSTOMER_NOT_FOUND") || has("NOT_ADS_USER")) {
    code = "account_inaccessible";
    message = "The connected Google user cannot access this account (or it needs the manager's login-customer-id). Check access in Google Ads and run discovery again.";
    http = 403;
  } else if (has("OAUTH_TOKEN") || has("AUTHENTICATION_ERROR") || status === 401) {
    code = "credentials_expired";
    message = "Google rejected the credentials. Reconnect Google in the dashboard.";
    http = 401;
  } else if (has("RESOURCE_EXHAUSTED") || has("QuotaError") || status === 429) {
    code = "google_rate_limited";
    message = "Google Ads API rate or quota limit reached. Wait and try again.";
    http = 429;
  } else if (has("DEVELOPER_TOKEN")) {
    code = "developer_token_rejected";
    message = "Google rejected a developer token. Developer tokens are retired; remove GOOGLE_ADS_DEVELOPER_TOKEN from the Cloudflare secrets.";
    http = 400;
  } else if (validateOnly) {
    code = "validation_failed";
    message = "Google's validate-only check found problems with this plan.";
    http = 422;
  } else if (status >= 400 && status < 500) {
    http = status === 404 ? 404 : 400;
  }
  const e = new NodiError(code, message, http, details.length ? details : err?.message ? [{ message: String(err.message).slice(0, 300) }] : undefined, requestId);
  return e;
};

export class AdsClient {
  constructor(
    private env: Env,
    private db: Db,
    private ref: AdsRef,
  ) {}

  private async call<T>(method: "GET" | "POST", path: string, body: unknown, opts: { loginCustomerId?: string | null; retryAuth?: boolean; mutating?: boolean; validateOnly?: boolean } = {}): Promise<T> {
    await enforceQuota(this.env, this.db, "ads_calls");
    await addUsage(this.db, "ads_calls");
    const url = `${BASE}/${adsVersion(this.env)}/${path}`;
    const doFetch = async (token: string) => {
      const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json" };
      if (method === "POST") headers["content-type"] = "application/json";
      const login = opts.loginCustomerId ?? this.ref.loginCustomerId;
      if (login) headers["login-customer-id"] = login;
      // Developer tokens are retired (Google ignores them since 9 Sep 2026). Only sent if an operator still sets one.
      if (this.env.GOOGLE_ADS_DEVELOPER_TOKEN) headers["developer-token"] = this.env.GOOGLE_ADS_DEVELOPER_TOKEN;
      return fetch(url, { method, headers, body: method === "POST" ? JSON.stringify(body ?? {}) : undefined, signal: AbortSignal.timeout(50_000) });
    };
    let token = await getAccessToken(this.env, this.db, this.ref.connectionId);
    let res: Response;
    try {
      res = await doFetch(token);
      if (res.status === 401 && opts.retryAuth !== false && !opts.mutating) {
        // The cached access token may have been revoked upstream: force one refresh. Mutations are never re-sent.
        await this.db.run("UPDATE google_connections SET access_expires_at = 0 WHERE id = ?", this.ref.connectionId);
        token = await getAccessToken(this.env, this.db, this.ref.connectionId);
        res = await doFetch(token);
      }
    } catch (e) {
      if (e instanceof NodiError) throw e;
      if (opts.mutating && !opts.validateOnly) {
        throw new NodiError("outcome_unknown", "Google did not return a conclusive response. Inspect the account before any retry; nothing was retried automatically.", 504);
      }
      throw new NodiError(opts.validateOnly ? "validation_unavailable" : "google_unreachable", "Could not reach the Google Ads API (timeout or network error).", 504);
    }
    const text = await res.text();
    if (!res.ok) {
      if (opts.mutating && !opts.validateOnly && res.status >= 500) {
        throw new NodiError("outcome_unknown", "Google answered with a server error after the request was sent. Inspect the account before any retry.", 504);
      }
      throw mapGoogleError(res.status, text, opts.validateOnly);
    }
    const t = now();
    await this.db.run("UPDATE google_connections SET last_ok_at = ? WHERE id = ? AND (last_ok_at IS NULL OR last_ok_at < ?)", t, this.ref.connectionId, t - 300);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new NodiError("google_bad_response", "Google returned a response that was not JSON.", 502);
    }
  }

  async listAccessibleCustomers(): Promise<string[]> {
    const r = await this.call<{ resourceNames?: string[] }>("GET", "customers:listAccessibleCustomers", undefined, { loginCustomerId: null });
    return (r.resourceNames ?? []).map((n) => n.split("/").pop()!).filter(Boolean);
  }

  /** `query` must already be bounded (see boundedGaql). */
  async search(customerId: string, query: string, limit: number, opts: { loginCustomerId?: string | null } = {}): Promise<SearchResult> {
    const q = /\bPARAMETERS\b/i.test(query) ? query : `${query} PARAMETERS omit_unselected_resource_names=true`;
    const r = await this.call<{ results?: Record<string, any>[]; nextPageToken?: string; requestId?: string }>(
      "POST",
      `customers/${customerId}/googleAds:search`,
      { query: q },
      opts,
    );
    const rows = r.results ?? [];
    return { rows: rows.slice(0, limit), truncated: rows.length > limit || !!r.nextPageToken, requestId: r.requestId };
  }

  async mutate(customerId: string, mutateOperations: unknown[], opts: { validateOnly: boolean; partialFailure?: boolean }): Promise<MutateResult> {
    return this.call<MutateResult>(
      "POST",
      `customers/${customerId}/googleAds:mutate`,
      { mutateOperations, validateOnly: opts.validateOnly, partialFailure: opts.partialFailure ?? false },
      { mutating: true, validateOnly: opts.validateOnly },
    );
  }

  /** Generic POST for non-GAQL methods (keyword ideas, geo suggestions, field metadata). */
  async post<T>(path: string, body: unknown, opts: { loginCustomerId?: string | null } = {}): Promise<T> {
    return this.call<T>("POST", path, body, opts);
  }
}
