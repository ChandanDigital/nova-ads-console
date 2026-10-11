export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;

  // ---- secrets (Cloudflare dashboard > Settings > Variables and Secrets) ----
  /** base64 of 32 random bytes. Encrypts Google refresh tokens in D1. */
  TOKEN_ENCRYPTION_KEY: string;
  /** Optional previous key, kept only while rotating TOKEN_ENCRYPTION_KEY. */
  TOKEN_ENCRYPTION_KEY_PREVIOUS?: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** Long random string. Only the Cloudflare account owner knows it. Used for first setup and credential recovery. */
  ADMIN_SETUP_SECRET: string;
  /** Legacy. Google ignores it since 9 Sep 2026; only sent when you set it. */
  GOOGLE_ADS_DEVELOPER_TOKEN?: string;
  /** Optional read-only Cloudflare API token (Account Analytics:Read) to show real platform usage. */
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;

  // ---- plain variables ----
  PUBLIC_ORIGIN?: string;
  GOOGLE_ADS_API_VERSION?: string;
  MCP_CALLS_PER_DAY?: string;
  GOOGLE_ADS_CALLS_PER_DAY?: string;
  MAX_ROWS_PER_QUERY?: string;
  D1_WRITES_SOFT_LIMIT?: string;
  D1_READS_SOFT_LIMIT?: string;
  REQUESTS_SOFT_LIMIT?: string;
}

export const num = (value: string | undefined, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const adsVersion = (env: Env): string => {
  const v = env.GOOGLE_ADS_API_VERSION ?? "v25";
  return /^v\d{1,3}$/.test(v) ? v : "v25";
};
