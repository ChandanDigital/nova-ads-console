// Downloads Google's official REST discovery document for the Google Ads API and keeps only the
// schemas needed to check that Nova's mutate payloads use real field names, types and enum values.
//   node scripts/make-ads-schema-fixture.mjs [version]     (default v25)
// Output: test/fixtures/ads-<version>-mutate-schema.json
import { writeFileSync, mkdirSync } from "node:fs";

const version = process.argv[2] ?? "v25";
const res = await fetch(`https://googleads.googleapis.com/$discovery/rest?version=${version}`);
if (!res.ok) throw new Error("discovery download failed: " + res.status);
const doc = await res.json();
const schemas = doc.schemas;

const opKeys = ["campaignBudgetOperation", "campaignOperation", "adGroupOperation", "adGroupCriterionOperation", "adGroupAdOperation", "campaignCriterionOperation", "assetOperation", "campaignAssetOperation", "assetGroupOperation", "assetGroupAssetOperation"];
const mutateOp = schemas[Object.keys(schemas).find((k) => k.endsWith("__MutateOperation"))];
const keep = {};
const queue = [];
const visit = (node) => {
  if (!node || typeof node !== "object") return;
  if (node.$ref && !(node.$ref in keep)) { keep[node.$ref] = schemas[node.$ref]; queue.push(node.$ref); }
  for (const v of Object.values(node)) visit(v);
};
const root = { type: "object", properties: {} };
for (const k of opKeys) root.properties[k] = mutateOp.properties[k];
visit(root);
while (queue.length) visit(keep[queue.pop()]);

// Strip long prose to keep the fixture small.
const strip = (n) => {
  if (Array.isArray(n)) return n.map(strip);
  if (n && typeof n === "object") return Object.fromEntries(Object.entries(n).filter(([k]) => !["description", "enumDescriptions"].includes(k)).map(([k, v]) => [k, strip(v)]));
  return n;
};
mkdirSync("test/fixtures", { recursive: true });
writeFileSync(`test/fixtures/ads-${version}-mutate-schema.json`, JSON.stringify({ version, revision: doc.revision, root: strip(root), schemas: strip(keep) }));
console.log("schemas kept:", Object.keys(keep).length, "revision", doc.revision);
