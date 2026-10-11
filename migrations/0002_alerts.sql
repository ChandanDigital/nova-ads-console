-- Generated from src/lib/schema.ts. Do not edit by hand.
CREATE TABLE IF NOT EXISTS alerts (
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
  );

CREATE INDEX IF NOT EXISTS idx_alerts_open ON alerts(resolved_at, severity);
