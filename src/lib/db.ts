import type { Env } from "../env";
import { MIGRATIONS } from "./schema";

/** Per-request counters of D1 work, measured from D1's own `meta` (rows_read / rows_written). */
export class Meter {
  rowsRead = 0;
  rowsWritten = 0;
  queries = 0;
}

export class Db {
  readonly meter = new Meter();
  constructor(readonly raw: D1Database) {}

  private note(meta: Record<string, unknown> | undefined) {
    this.meter.queries++;
    if (meta) {
      this.meter.rowsRead += Number(meta.rows_read ?? 0);
      this.meter.rowsWritten += Number(meta.rows_written ?? 0);
    }
  }

  async all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
    const r = await this.raw.prepare(sql).bind(...params).all<T>();
    this.note(r.meta);
    return r.results ?? [];
  }
  async first<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | null> {
    const r = await this.raw.prepare(sql).bind(...params).all<T>();
    this.note(r.meta);
    return r.results?.[0] ?? null;
  }
  /** Runs a write; returns the number of rows changed. */
  async run(sql: string, ...params: unknown[]): Promise<number> {
    const r = await this.raw.prepare(sql).bind(...params).run();
    this.note(r.meta);
    return Number(r.meta?.changes ?? 0);
  }
  async batch(statements: { sql: string; params?: unknown[] }[]): Promise<void> {
    if (!statements.length) return;
    const results = await this.raw.batch(statements.map((s) => this.raw.prepare(s.sql).bind(...(s.params ?? []))));
    for (const r of results) this.note(r.meta);
  }
}

// ------------------------------------------------------------------ migrations
let migratedFor: D1Database | null = null;
let migrating: Promise<void> | null = null;

export const migrate = async (db: Db): Promise<{ applied: string[] }> => {
  await db.run("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const done = new Set((await db.all<{ id: string }>("SELECT id FROM schema_migrations")).map((r) => r.id));
  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    await db.batch([
      ...m.statements.map((sql) => ({ sql })),
      { sql: "INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)", params: [m.id, Math.floor(Date.now() / 1000)] },
    ]);
    applied.push(m.id);
  }
  return { applied };
};

/** Idempotent. Cached per isolate so a warm Worker pays no extra D1 reads. */
export const ensureSchema = async (env: Env, db: Db): Promise<void> => {
  if (migratedFor === env.DB) return;
  migrating ??= migrate(db)
    .then(() => {
      migratedFor = env.DB;
    })
    .finally(() => {
      migrating = null;
    });
  await migrating;
};

export const resetSchemaCacheForTests = () => {
  migratedFor = null;
};

export const now = (): number => Math.floor(Date.now() / 1000);
export const dayKey = (t = Date.now()): string => new Date(t).toISOString().slice(0, 10);
