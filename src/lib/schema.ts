/**
 * Database migrations. RULES (enforced by test/migrations.test.ts):
 *  - additive only: CREATE ... IF NOT EXISTS, ALTER TABLE ... ADD COLUMN, CREATE INDEX IF NOT EXISTS
 *  - never DROP / DELETE / TRUNCATE / UPDATE / INSERT on existing data
 * Existing rows (credentials, approvals, history) are therefore never touched by an upgrade.
 * `npm run gen:migration` writes the same SQL to migrations/ for people who prefer `wrangler d1 migrations`.
 */
export interface Migration {
  id: string;
  statements: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    id: "0001_init",
    statements: [
      `CREATE TABLE IF NOT EXISTS admin (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        credential_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        rotated_at INTEGER,
        last_login_at INTEGER
      )`,
      `CREATE TABLE IF NOT EXISTS sessions (
        id_hash TEXT PRIMARY KEY,
        admin_id TEXT NOT NULL,
        csrf TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        ip_hash TEXT,
        ua_hash TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`,
      `CREATE TABLE IF NOT EXISTS rate_limits (
        key TEXT PRIMARY KEY,
        window_start INTEGER NOT NULL,
        count INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS used_setup_secrets (
        digest TEXT PRIMARY KEY,
        used_at INTEGER NOT NULL,
        purpose TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS settings (
        name TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS api_tokens (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        client_id TEXT,
        grant_id TEXT,
        scopes TEXT NOT NULL,
        accounts TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        used_at INTEGER,
        last_used_at INTEGER
      )`,
      `CREATE INDEX IF NOT EXISTS idx_tokens_grant ON api_tokens(grant_id)`,
      `CREATE INDEX IF NOT EXISTS idx_tokens_expires ON api_tokens(expires_at)`,
      `CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY,
        secret_hash TEXT,
        name TEXT NOT NULL,
        redirect_uris TEXT NOT NULL,
        auth_method TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      )`,
      `CREATE TABLE IF NOT EXISTS oauth_pending (
        id_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        state TEXT,
        code_challenge TEXT NOT NULL,
        scopes TEXT NOT NULL,
        resource TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS oauth_codes (
        code_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        scopes TEXT NOT NULL,
        resource TEXT,
        grant_id TEXT NOT NULL,
        accounts TEXT,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      )`,
      `CREATE TABLE IF NOT EXISTS google_oauth_states (
        state_hash TEXT PRIMARY KEY,
        session_hash TEXT NOT NULL,
        verifier_sealed TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS google_connections (
        id TEXT PRIMARY KEY,
        google_sub TEXT,
        email TEXT,
        refresh_sealed TEXT NOT NULL,
        access_sealed TEXT,
        access_expires_at INTEGER,
        scopes TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        last_error TEXT,
        created_at INTEGER NOT NULL,
        last_refresh_at INTEGER,
        last_ok_at INTEGER
      )`,
      `CREATE TABLE IF NOT EXISTS accounts (
        customer_id TEXT PRIMARY KEY,
        connection_id TEXT,
        name TEXT,
        currency TEXT,
        timezone TEXT,
        manager INTEGER NOT NULL DEFAULT 0,
        status TEXT,
        login_customer_id TEXT,
        manager_path TEXT,
        allowed INTEGER NOT NULL DEFAULT 0,
        discovered_at INTEGER,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        status TEXT NOT NULL,
        hash TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        validated_at INTEGER,
        validation_json TEXT,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_plans_account ON plans(account_id, created_at)`,
      `CREATE TABLE IF NOT EXISTS approvals (
        plan_id TEXT PRIMARY KEY,
        plan_hash TEXT NOT NULL,
        admin_id TEXT NOT NULL,
        permissions TEXT NOT NULL,
        approved_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      )`,
      `CREATE TABLE IF NOT EXISTS executions (
        plan_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        results_json TEXT,
        errors_json TEXT,
        request_id TEXT,
        executed_by TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        rows_json TEXT NOT NULL,
        window_json TEXT,
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        report_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT,
        action TEXT NOT NULL,
        target TEXT,
        outcome TEXT NOT NULL,
        detail TEXT,
        ip_hash TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts)`,
      `CREATE TABLE IF NOT EXISTS usage_daily (
        day TEXT NOT NULL,
        metric TEXT NOT NULL,
        value INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, metric)
      )`,
      `CREATE TABLE IF NOT EXISTS legacy_import (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        imported_at INTEGER NOT NULL
      )`,
    ],
  },
  {
    // Read-only health alerts raised by the daily monitor (see src/ads/monitor.ts). Additive: existing data is untouched.
    id: "0002_alerts",
    statements: [
      `CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dedupe_key TEXT NOT NULL UNIQUE,
        account_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        severity TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        resolved_at INTEGER
      )`,
      `CREATE INDEX IF NOT EXISTS idx_alerts_open ON alerts(resolved_at, severity)`,
    ],
  },
];

/** Statements that would modify or destroy existing data. Migrations may never contain them. */
export const FORBIDDEN_SQL = /\b(DROP|DELETE|TRUNCATE|UPDATE|INSERT|REPLACE)\b/i;

export const migrationSql = (m: Migration): string =>
  m.statements.map((s) => s.trim().replace(/\n\s+/g, "\n  ") + ";").join("\n\n") + "\n";
