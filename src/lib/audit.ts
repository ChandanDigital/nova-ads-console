import type { Db } from "./db";
import { now } from "./db";

export interface AuditEntry {
  actor_type: "admin" | "mcp" | "system" | "anonymous" | "oauth";
  actor_id?: string | null;
  action: string;
  target?: string | null;
  outcome: "ok" | "denied" | "error";
  detail?: unknown;
  ip_hash?: string | null;
}

// Anything that looks like one of our secrets or a Google token is masked before it can reach the log.
const SECRET_PATTERNS: RegExp[] = [
  /nodi_admin_[A-Za-z0-9_-]{20,}/g,
  /nodi_(?:api|at|rt)_[A-Za-z0-9_-]{20,}/g,
  /ya29\.[A-Za-z0-9_-]{10,}/g,
  /1\/\/[A-Za-z0-9_-]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g,
];
const SECRET_KEYS = /(secret|token|credential|password|authorization|verifier|cookie|key)/i;

export const redact = (value: unknown, depth = 0): unknown => {
  if (depth > 6) return "[deep]";
  if (typeof value === "string") {
    let s = value;
    for (const p of SECRET_PATTERNS) s = s.replace(p, "[redacted]");
    return s.length > 600 ? s.slice(0, 600) + "…" : s;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 50)
        .map(([k, v]) => [k, SECRET_KEYS.test(k) && typeof v === "string" ? "[redacted]" : redact(v, depth + 1)]),
    );
  }
  return value;
};

export const audit = async (db: Db, e: AuditEntry): Promise<void> => {
  try {
    await db.run(
      "INSERT INTO audit_log (ts, actor_type, actor_id, action, target, outcome, detail, ip_hash) VALUES (?,?,?,?,?,?,?,?)",
      now(),
      e.actor_type,
      e.actor_id ?? null,
      e.action,
      e.target ?? null,
      e.outcome,
      e.detail === undefined ? null : JSON.stringify(redact(e.detail)),
      e.ip_hash ?? null,
    );
  } catch (err) {
    // An audit failure must never hide the original outcome, but it must be visible in logs.
    console.error("audit write failed", err instanceof Error ? err.message : String(err));
  }
};
