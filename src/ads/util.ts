/** Small helpers shared by the ads modules. */
export const rowsToObject = <T extends { [k: string]: unknown }>(rows: T[], key: keyof T): Record<string, T> =>
  Object.fromEntries(rows.map((r) => [String(r[key]), r]));
