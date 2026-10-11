import fixture from "./fixtures/ads-v25-mutate-schema.json";

type Node = Record<string, any>;
const schemas = (fixture as any).schemas as Record<string, Node>;
const root = (fixture as any).root as Node;

const resolve = (n: Node): Node => (n.$ref ? schemas[n.$ref] ?? {} : n);

/**
 * Checks a JSON value against Google's official v25 REST schema (from the discovery document):
 * unknown field names, wrong types and invalid enum values are reported. Returns [] when conformant.
 */
export const validateAgainst = (value: unknown, node: Node, path = "$"): string[] => {
  const n = resolve(node);
  const errs: string[] = [];
  if (value === null || value === undefined) return errs;
  if (n.type === "array") {
    if (!Array.isArray(value)) return [`${path}: expected array`];
    value.forEach((v, i) => errs.push(...validateAgainst(v, n.items ?? {}, `${path}[${i}]`)));
    return errs;
  }
  if (n.properties) {
    if (typeof value !== "object" || Array.isArray(value)) return [`${path}: expected object`];
    for (const [k, v] of Object.entries(value as object)) {
      if (!(k in n.properties)) errs.push(`${path}.${k}: unknown field`);
      else errs.push(...validateAgainst(v, n.properties[k], `${path}.${k}`));
    }
    return errs;
  }
  if (n.enum) {
    if (typeof value !== "string" || !n.enum.includes(value)) errs.push(`${path}: ${JSON.stringify(value)} is not one of ${n.enum.slice(0, 6).join("|")}...`);
    return errs;
  }
  if (n.type === "string") {
    if (typeof value !== "string") errs.push(`${path}: expected string`);
    else if ((n.format === "int64" || n.format === "uint64") && !/^-?\d+$/.test(value)) errs.push(`${path}: int64 must be digits`);
  } else if (n.type === "boolean") {
    if (typeof value !== "boolean") errs.push(`${path}: expected boolean`);
  } else if (n.type === "integer" || n.type === "number") {
    if (typeof value !== "number") errs.push(`${path}: expected number`);
  }
  return errs;
};

/** Validates one entry of `mutateOperations`. */
export const validateMutateOperation = (op: Record<string, unknown>): string[] => {
  const errs = validateAgainst(op, root);
  const keys = Object.keys(op);
  if (keys.length !== 1) errs.push("a mutate operation must set exactly one *Operation field");
  return errs;
};

export const schemaRevision = (): string => String((fixture as any).revision);

/** True when `path` (dot-separated camelCase) exists as nested properties of the schema node. */
export const pathExists = (node: Node, path: string): boolean => {
  let cur = resolve(node);
  for (const part of path.split(".")) {
    if (!cur.properties || !(part in cur.properties)) return false;
    cur = resolve(cur.properties[part]);
  }
  return true;
};
export const resourceSchema = (operationKey: string): Node => {
  const op = resolve(root.properties[operationKey]);
  return resolve(op.properties.create);
};
