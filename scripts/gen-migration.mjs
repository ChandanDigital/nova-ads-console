// Writes migrations/<id>.sql from src/lib/schema.ts so there is a single source of truth.
// Run with: npm run gen:migration   (CI runs `npm run gen:migration` and fails if files changed.)
import { build } from "esbuild";
import { writeFileSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = join(tmpdir(), "nodi-schema-" + process.pid + ".mjs");
await build({ entryPoints: ["src/lib/schema.ts"], outfile: out, bundle: true, format: "esm", platform: "node", logLevel: "error" });
const { MIGRATIONS, migrationSql } = await import(pathToFileURL(out).href);
mkdirSync("migrations", { recursive: true });
for (const m of MIGRATIONS) {
  writeFileSync(`migrations/${m.id}.sql`, `-- Generated from src/lib/schema.ts. Do not edit by hand.\n${migrationSql(m)}`);
}
console.log("wrote", MIGRATIONS.map((m) => m.id).join(", "));
