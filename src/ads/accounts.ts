import type { Ctx, Principal } from "../lib/context";
import { now } from "../lib/db";
import { NodiError } from "../lib/errors";
import { audit } from "../lib/audit";
import { AdsClient } from "../google/ads";
import { customerId } from "../google/gaql";

export interface AccountRow {
  customer_id: string;
  connection_id: string | null;
  name: string | null;
  currency: string | null;
  timezone: string | null;
  manager: number;
  status: string | null;
  login_customer_id: string | null;
  manager_path: string | null;
  allowed: number;
  discovered_at: number | null;
  updated_at: number;
}

const IDENTITY_QUERY =
  "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager, customer.status FROM customer LIMIT 1";
const HIERARCHY_QUERY =
  "SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.time_zone, customer_client.manager, customer_client.status, customer_client.level FROM customer_client WHERE customer_client.status != 'CANCELED' LIMIT 1000";

/** Free plan allows 50 subrequests per invocation; discovery stays well below it and reports truncation. */
const MAX_ROOTS = 30;

export const listAccounts = (ctx: Ctx): Promise<AccountRow[]> => ctx.db.all<AccountRow>("SELECT * FROM accounts ORDER BY manager DESC, name");

export const getAccountRow = (ctx: Ctx, id: string): Promise<AccountRow | null> => ctx.db.first<AccountRow>("SELECT * FROM accounts WHERE customer_id = ?", customerId(id));

/**
 * Resolves an account for a caller. AI principals only ever see accounts the administrator switched on
 * (and, for restricted tokens, listed on the token). Administrators can inspect everything they discovered.
 */
export const resolveAccount = async (ctx: Ctx, p: Principal, id: string, scope: "read" | "draft" | "apply" = "read"): Promise<AccountRow> => {
  const cid = customerId(id);
  if (p.kind !== "admin" && !p.scopes.includes(scope)) throw new NodiError("forbidden", `This credential lacks the ${scope} permission.`, 403);
  const row = await getAccountRow(ctx, cid);
  if (!row) throw new NodiError("account_not_found", "Unknown account. Ask the administrator to run discovery or add the account in the dashboard.", 404);
  if (p.kind !== "admin") {
    if (!row.allowed) throw new NodiError("account_not_allowed", "The administrator has not allowed AI access to this account.", 403);
    if (p.accounts && !p.accounts.includes(cid)) throw new NodiError("account_not_allowed", "This credential is not allowed to use this account.", 403);
  }
  if (!row.connection_id) throw new NodiError("not_connected", "This account has no Google connection. Connect Google and run discovery.", 409);
  return row;
};

export const adsFor = (ctx: Ctx, account: AccountRow): AdsClient =>
  new AdsClient(ctx.env, ctx.db, { connectionId: account.connection_id!, loginCustomerId: account.login_customer_id });

interface DiscoveryResult {
  discovered: number;
  errors: { account_id: string; code: string; request_id?: string }[];
  truncated: boolean;
}

const asBool = (v: unknown): number => (v === true || v === "true" ? 1 : 0);

/** Finds every account the Google user can reach (directly and through manager accounts) and stores it. New accounts start disallowed. */
export const discoverAccounts = async (ctx: Ctx, connectionId: string): Promise<DiscoveryResult> => {
  const ads = new AdsClient(ctx.env, ctx.db, { connectionId });
  const ids = await ads.listAccessibleCustomers();
  const result: DiscoveryResult = { discovered: 0, errors: [], truncated: ids.length > MAX_ROOTS };
  const found = new Map<string, Omit<AccountRow, "allowed" | "updated_at" | "discovered_at">>();

  for (const root of ids.slice(0, MAX_ROOTS)) {
    try {
      const r = await ads.search(root, IDENTITY_QUERY, 1, { loginCustomerId: null });
      const c = r.rows[0]?.customer;
      if (!c) continue;
      const isManager = asBool(c.manager) === 1;
      found.set(root, {
        customer_id: root, connection_id: connectionId, name: c.descriptiveName ?? "Unnamed account", currency: c.currencyCode ?? null,
        timezone: c.timeZone ?? null, manager: isManager ? 1 : 0, status: c.status ?? "UNKNOWN", login_customer_id: null, manager_path: "[]",
      });
      if (isManager) {
        const h = await ads.search(root, HIERARCHY_QUERY, 1000, { loginCustomerId: root });
        for (const row of h.rows) {
          const cc = row.customerClient;
          const id = String(cc?.id ?? "");
          if (!/^\d{10}$/.test(id) || id === root) continue;
          // Prefer the manager route (it carries the right login-customer-id), as the original discovery did.
          found.set(id, {
            customer_id: id, connection_id: connectionId, name: cc.descriptiveName ?? "Unnamed account", currency: cc.currencyCode ?? null,
            timezone: cc.timeZone ?? null, manager: asBool(cc.manager), status: cc.status ?? "UNKNOWN", login_customer_id: root,
            manager_path: JSON.stringify([root]),
          });
        }
        if (h.truncated) result.errors.push({ account_id: root, code: "discovery_truncated" });
      }
    } catch (e) {
      if (e instanceof NodiError && (e.code === "credentials_expired" || e.code === "quota_soft_limit")) throw e;
      result.errors.push({ account_id: root, code: e instanceof NodiError ? e.code : "error", request_id: e instanceof NodiError ? e.requestId : undefined });
    }
  }

  const t = now();
  const statements = [...found.values()].map((a) => ({
    sql: `INSERT INTO accounts (customer_id, connection_id, name, currency, timezone, manager, status, login_customer_id, manager_path, allowed, discovered_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,0,?,?)
          ON CONFLICT(customer_id) DO UPDATE SET connection_id = excluded.connection_id, name = excluded.name, currency = excluded.currency,
            timezone = excluded.timezone, manager = excluded.manager, status = excluded.status, login_customer_id = excluded.login_customer_id,
            manager_path = excluded.manager_path, discovered_at = excluded.discovered_at, updated_at = excluded.updated_at`,
    params: [a.customer_id, a.connection_id, a.name, a.currency, a.timezone, a.manager, a.status, a.login_customer_id, a.manager_path, t, t],
  }));
  for (let i = 0; i < statements.length; i += 50) await ctx.db.batch(statements.slice(i, i + 50));
  result.discovered = found.size;
  await audit(ctx.db, { actor_type: "admin", action: "discover_accounts", target: connectionId, outcome: "ok", detail: { discovered: found.size, errors: result.errors.length }, ip_hash: ctx.ipHash });
  return result;
};

/** Re-reads one account's identity from Google (name, currency, timezone, status). */
export const refreshIdentity = async (ctx: Ctx, account: AccountRow): Promise<AccountRow> => {
  const ads = adsFor(ctx, account);
  const r = await ads.search(account.customer_id, IDENTITY_QUERY, 1);
  const c = r.rows[0]?.customer;
  if (!c) throw new NodiError("account_inaccessible", "Google returned no account identity.", 403);
  await ctx.db.run(
    "UPDATE accounts SET name = ?, currency = ?, timezone = ?, manager = ?, status = ?, updated_at = ? WHERE customer_id = ?",
    c.descriptiveName ?? "Unnamed account", c.currencyCode, c.timeZone, asBool(c.manager), c.status ?? "UNKNOWN", now(), account.customer_id,
  );
  return (await getAccountRow(ctx, account.customer_id))!;
};

/**
 * Allows an account the administrator already knows the ID of (preserves the original allowlist model, e.g. "3010086756").
 * Unknown IDs are stored as pending until discovery fills in their details.
 */
export const addAccount = async (ctx: Ctx, id: string, loginCustomerId: string | null, connectionId: string | null): Promise<void> => {
  const cid = customerId(id);
  const login = loginCustomerId ? customerId(loginCustomerId) : null;
  const conn = connectionId ?? (await ctx.db.first<{ id: string }>("SELECT id FROM google_connections WHERE status = 'active' ORDER BY created_at LIMIT 1"))?.id ?? null;
  const t = now();
  await ctx.db.run(
    `INSERT INTO accounts (customer_id, connection_id, manager, login_customer_id, manager_path, allowed, updated_at, name, status)
     VALUES (?,?,0,?,?,0,?, 'Pending discovery', 'UNKNOWN')
     ON CONFLICT(customer_id) DO UPDATE SET login_customer_id = COALESCE(excluded.login_customer_id, accounts.login_customer_id), connection_id = COALESCE(accounts.connection_id, excluded.connection_id), updated_at = excluded.updated_at`,
    cid, conn, login, login ? JSON.stringify([login]) : "[]", t,
  );
};

export const setAllowed = async (ctx: Ctx, id: string, allowed: boolean): Promise<void> => {
  const cid = customerId(id);
  const n = await ctx.db.run("UPDATE accounts SET allowed = ?, updated_at = ? WHERE customer_id = ?", allowed ? 1 : 0, now(), cid);
  if (!n) throw new NodiError("account_not_found", "Unknown account.", 404);
  await audit(ctx.db, { actor_type: "admin", action: allowed ? "account_allowed" : "account_blocked", target: cid, outcome: "ok", ip_hash: ctx.ipHash });
};
