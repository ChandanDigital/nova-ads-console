import { z } from "zod";
import type { Ctx } from "../lib/context";
import { now } from "../lib/db";
import { NodiError } from "../lib/errors";
import { audit } from "../lib/audit";
import { randomId } from "../lib/crypto";
import { customerId } from "../google/gaql";

/**
 * Imports the non-secret part of an existing local Nodi Ads installation (written by tools/export_legacy.py).
 * It never accepts credentials: any key that looks like a secret makes the whole import fail.
 * Imported plans/approvals/history are kept as a READ-ONLY archive. Legacy approvals can never authorise a new-format plan.
 */
const SECRET_KEY = /(refresh_token|client_secret|access_token|password|private_key|encryption_key|token_hash|bearer|fernet)/i;

const scanForSecrets = (v: unknown, path = ""): string | null => {
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) { const r = scanForSecrets(v[i], `${path}[${i}]`); if (r) return r; }
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v as object)) {
      if (SECRET_KEY.test(k)) return `${path}.${k}`;
      const r = scanForSecrets(x, `${path}.${k}`);
      if (r) return r;
    }
  } else if (typeof v === "string" && (/^ya29\./.test(v) || /^1\/\/[A-Za-z0-9_-]{20,}/.test(v) || /GOCSPX-/.test(v))) return `${path} (looks like a Google token or secret)`;
  return null;
};

const Account = z.object({
  client_id: z.string().optional(),
  customer_id: z.string(),
  name: z.string().nullish(),
  currency: z.string().nullish(),
  timezone: z.string().nullish(),
  manager: z.boolean().optional(),
  status: z.string().nullish(),
  login_customer_id: z.string().nullish(),
  manager_path: z.array(z.string()).optional(),
});

const LegacySchema = z.object({
  format: z.literal("nodi-ads-legacy-export/1"),
  exported_at: z.string(),
  source: z.record(z.string(), z.any()).optional(),
  clients: z.array(z.record(z.string(), z.any())).max(50).default([]),
  accounts: z.array(Account).max(500).default([]),
  plans: z.array(z.record(z.string(), z.any())).max(5000).default([]),
  approvals: z.array(z.record(z.string(), z.any())).max(5000).default([]),
  history: z.array(z.record(z.string(), z.any())).max(5000).default([]),
  standing_permissions: z.array(z.record(z.string(), z.any())).max(500).default([]),
  settings: z.record(z.string(), z.any()).default({}),
  excluded: z.array(z.string()).default([]),
});

export const importLegacy = async (ctx: Ctx, adminId: string, body: unknown, applyAllowlist: boolean) => {
  const leak = scanForSecrets(body);
  if (leak) throw new NodiError("legacy_contains_secrets", `The file contains something that looks like a secret at ${leak}. Re-run tools/export_legacy.py; it never writes credentials.`, 400);
  const parsed = LegacySchema.safeParse(body);
  if (!parsed.success) throw new NodiError("invalid_legacy_file", "This is not a nodi-ads-legacy-export/1 file.", 400, parsed.error.issues.slice(0, 5).map((i) => ({ field: i.path.join("."), problem: i.message })));
  const d = parsed.data;
  const t = now();
  const batch = (["clients", "accounts", "plans", "approvals", "history", "standing_permissions"] as const).map((kind) => ({
    sql: "INSERT INTO legacy_import (id, kind, payload, imported_at) VALUES (?,?,?,?)",
    params: [randomId(), kind, JSON.stringify(d[kind]), t],
  }));
  batch.push({ sql: "INSERT INTO legacy_import (id, kind, payload, imported_at) VALUES (?,?,?,?)", params: [randomId(), "settings", JSON.stringify({ settings: d.settings, source: d.source, exported_at: d.exported_at }), t] });
  await ctx.db.batch(batch);

  let allowed = 0;
  if (applyAllowlist) {
    // The old allowlist (permitted_accounts) becomes "allowed" accounts; details are filled in by the next Google discovery.
    const ids = new Set<string>();
    for (const c of d.clients) for (const u of (c.users as { accounts?: string[] }[] | undefined) ?? []) for (const a of u.accounts ?? []) ids.add(customerId(a));
    for (const a of d.accounts) ids.add(customerId(a.customer_id));
    const stmts = [...ids].map((id) => {
      const known = d.accounts.find((a) => customerId(a.customer_id) === id);
      return {
        sql: `INSERT INTO accounts (customer_id, name, currency, timezone, manager, status, login_customer_id, manager_path, allowed, updated_at)
              VALUES (?,?,?,?,?,?,?,?,1,?)
              ON CONFLICT(customer_id) DO UPDATE SET allowed = 1, updated_at = excluded.updated_at`,
        params: [id, known?.name ?? "Imported (run discovery)", known?.currency ?? null, known?.timezone ?? null, known?.manager ? 1 : 0, known?.status ?? "UNKNOWN", known?.login_customer_id ?? null, JSON.stringify(known?.manager_path ?? []), t],
      };
    });
    for (let i = 0; i < stmts.length; i += 50) await ctx.db.batch(stmts.slice(i, i + 50));
    allowed = ids.size;
  }
  await audit(ctx.db, { actor_type: "admin", actor_id: adminId, action: "legacy_import", outcome: "ok", detail: { plans: d.plans.length, approvals: d.approvals.length, history: d.history.length, accounts_allowed: allowed }, ip_hash: ctx.ipHash });
  return {
    imported: { clients: d.clients.length, accounts: d.accounts.length, plans: d.plans.length, approvals: d.approvals.length, history: d.history.length, standing_permissions: d.standing_permissions.length },
    accounts_allowed: allowed,
    not_imported: ["Google refresh tokens and OAuth client secrets (reconnect Google once in the dashboard)", "bearer token hashes (issue new AI tokens in the dashboard)", "the old Fernet encryption key", "approvals as live authority (archive only)"],
  };
};

export const legacyArchive = async (ctx: Ctx) => {
  const rows = await ctx.db.all<{ kind: string; payload: string; imported_at: number }>("SELECT kind, payload, imported_at FROM legacy_import ORDER BY imported_at DESC LIMIT 200");
  const out: Record<string, unknown> = {};
  for (const r of rows) if (!(r.kind in out)) out[r.kind] = { imported_at: r.imported_at, items: JSON.parse(r.payload) };
  return out;
};
