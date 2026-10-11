import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { Db, migrate } from "../src/lib/db";
import { FORBIDDEN_SQL, MIGRATIONS, migrationSql } from "../src/lib/schema";
import { resetDb } from "./helpers";

describe("non-destructive migrations", () => {
  beforeEach(resetDb);

  it("contain no statement that can delete or rewrite data", () => {
    for (const m of MIGRATIONS) for (const s of m.statements) expect(s, s.slice(0, 60)).not.toMatch(FORBIDDEN_SQL);
  });
  it("every CREATE is IF NOT EXISTS", () => {
    for (const m of MIGRATIONS) for (const s of m.statements) if (/^\s*CREATE/i.test(s)) expect(s).toMatch(/IF NOT EXISTS/i);
  });
  it("running twice is a no-op and keeps existing rows", async () => {
    const db = new Db(env.DB);
    await migrate(db);
    await db.run("INSERT INTO admin (id,label,credential_hash,created_at) VALUES ('primary','owner','h',1)");
    await db.run("INSERT INTO settings (name,value,updated_at) VALUES ('global_stop','1',1)");
    const again = await migrate(db);
    expect(again.applied).toEqual([]);
    expect((await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM admin"))!.n).toBe(1);
    expect((await db.first<{ value: string }>("SELECT value FROM settings WHERE name='global_stop'"))!.value).toBe("1");
  });
  it("upgrades an older database without touching its data", async () => {
    // Simulate a database that only has one table and some rows from an earlier release.
    await env.DB.exec("DROP TABLE IF EXISTS schema_migrations");
    const db = new Db(env.DB);
    await db.run("INSERT INTO admin (id,label,credential_hash,created_at) VALUES ('primary','owner','keepme',1) ON CONFLICT(id) DO UPDATE SET credential_hash='keepme'");
    const r = await migrate(db);
    expect(r.applied).toEqual(["0001_init"]);
    expect((await db.first<{ credential_hash: string }>("SELECT credential_hash FROM admin"))!.credential_hash).toBe("keepme");
  });
  it("renders SQL for wrangler d1 migrations", () => {
    expect(migrationSql(MIGRATIONS[0]!)).toContain("CREATE TABLE IF NOT EXISTS admin");
  });
});
