import type { Env } from "../env";
import type { Db } from "./db";

export interface Ctx {
  env: Env;
  db: Db;
  exec: ExecutionContext;
  request: Request;
  url: URL;
  /** Public origin of this deployment (https://<worker>.workers.dev or custom domain). */
  origin: string;
  ipHash: string;
}

/** Who is calling. Dashboard users are `admin`; AI hosts are `api` (pasted token) or `oauth`. */
export interface Principal {
  kind: "admin" | "api" | "oauth";
  id: string;
  label: string;
  scopes: string[];
  /** null = every account the admin has allowed; otherwise a restriction list. */
  accounts: string[] | null;
}

export const AI_SCOPES = ["read", "draft", "apply"] as const;
export type AiScope = (typeof AI_SCOPES)[number];
