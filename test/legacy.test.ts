import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { call, resetDb, setupAdmin, type Session } from "./helpers";
import legacy from "./fixtures/legacy-export.json";

// legacy-export.json was produced by the real tools/export_legacy.py from a store written by the original Python backend.
let s: Session;
beforeEach(async () => { await resetDb(); s = await setupAdmin(); });

describe("migration from the local Python version", () => {
  it("accepts both spellings of the export format (old nodi-ads and new nova-ads)", async () => {
    for (const format of ["nodi-ads-legacy-export/1", "nova-ads-legacy-export/1"]) {
      const r = await call("/api/admin/import-legacy", { method: "POST", session: s, body: { export: { ...legacy, format }, apply_allowlist: false } });
      expect(r.status, format + " " + r.text).toBe(200);
    }
    const bad = await call("/api/admin/import-legacy", { method: "POST", session: s, body: { export: { ...legacy, format: "other/1" } } });
    expect(bad.status).toBe(400);
  });
  it("imports the allowlist and archives plans, approvals and history without creating live authority", async () => {
    const r = await call("/api/admin/import-legacy", { method: "POST", session: s, body: { export: legacy, apply_allowlist: true } });
    expect(r.status, r.text).toBe(200);
    expect(r.json.imported).toMatchObject({ accounts: 1, plans: 1, approvals: 1, history: 1 });
    expect(r.json.accounts_allowed).toBe(1);
    expect(r.json.not_imported.join(" ")).toMatch(/refresh tokens/);

    const acc = (await call("/api/accounts", { session: s })).json.find((a: any) => a.customer_id === "3010086756");
    expect(acc).toMatchObject({ allowed: true, name: "Pradhan Clinic", currency: "INR" });

    // The old approval is history only. It cannot authorise anything in the new system.
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM approvals").first<{ n: number }>())!.n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM plans").first<{ n: number }>())!.n).toBe(0);
    const archive = (await call("/api/admin/legacy", { session: s })).json;
    expect(archive.approvals.items[0].human_user).toBe("chandan");
    expect(archive.plans.items[0].status).toBe("succeeded");
  });

  it("can skip applying the allowlist", async () => {
    await call("/api/admin/import-legacy", { method: "POST", session: s, body: { export: legacy, apply_allowlist: false } });
    expect((await call("/api/accounts", { session: s })).json).toEqual([]);
  });

  it("never accepts a file that contains secrets", async () => {
    for (const bad of [
      { ...legacy, clients: [{ client_id: "x", users: [], refresh_token: "1//abc" }] },
      { ...legacy, accounts: [{ customer_id: "3010086756", name: "ya29.a0AfH6SMBabcdefghijklmnop" }] },
      { ...legacy, settings: { client_secret: "GOCSPX-abcdef" } },
      { ...legacy, plans: [{ token_hash: "x" }] },
    ]) {
      const r = await call("/api/admin/import-legacy", { method: "POST", session: s, body: { export: bad } });
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe("legacy_contains_secrets");
    }
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM legacy_import").first<{ n: number }>())!.n).toBe(0);
  });

  it("rejects files in another format", async () => {
    const r = await call("/api/admin/import-legacy", { method: "POST", session: s, body: { export: { format: "something-else" } } });
    expect(r.json.error.code).toBe("invalid_legacy_file");
  });

  it("the fixture itself contains no secrets", () => {
    const text = JSON.stringify(legacy);
    expect(text).not.toMatch(/SECRET|refresh_token|ya29|GOCSPX|token_hash/);
  });
});
