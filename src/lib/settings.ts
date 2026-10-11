import type { Db } from "./db";
import { now } from "./db";

export const getSetting = async (db: Db, name: string): Promise<string | null> =>
  (await db.first<{ value: string }>("SELECT value FROM settings WHERE name = ?", name))?.value ?? null;

export const setSetting = async (db: Db, name: string, value: string): Promise<void> => {
  await db.run(
    "INSERT INTO settings (name, value, updated_at) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    name, value, now(),
  );
};

export const isGlobalStop = async (db: Db): Promise<boolean> => (await getSetting(db, "global_stop")) === "1";
