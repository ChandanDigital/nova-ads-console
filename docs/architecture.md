# Architecture

```
 AI app (Claude, ChatGPT, Gemini CLI ...)                Administrator's browser
        |  Streamable HTTP + OAuth 2.1 / API token                |  HTTPS, session cookie + CSRF
        v                                                         v
 +------------------- one Cloudflare Worker (TypeScript) --------------------------+
 |  /mcp            official MCP SDK, stateless, 35 tools                           |
 |  /oauth/*        authorization server (DCR, PKCE S256, rotating refresh)         |
 |  /api/*          dashboard API (admin session only)                               |
 |  /oauth/google/callback   Google sign-in return                                   |
 |  static files    dashboard (Workers Static Assets, no Worker CPU)                 |
 |  scheduled       daily purge + token-health check (1 cron)                        |
 +--------------------------+---------------------------+---------------------------+
                            | D1 (SQLite)               | fetch (HTTPS)
                            v                           v
                 tokens (sealed), plans,        Google OAuth + Google Ads REST API (v25)
                 approvals, audit, usage        no developer token
```

## Why this shape

- GitHub Pages cannot run server code and is public-only for free private-repo owners; GitHub Actions cannot host a permanent endpoint. So the Worker serves everything, which also makes the dashboard same-origin (no CORS, simple cookies).
- The official Google Ads MCP server is a Python package. It is **not** run inside Workers. This project reimplements its three tools (`search`, `get_resource_metadata`, `list_accessible_customers`) in TypeScript over Google's REST API, keeping their argument names, and adds the Nodi planning/approval layer.
- Stateless MCP (no sessions, JSON responses): fits Workers, needs no Durable Objects and no KV. State lives only in D1.

## Source map

| Path | Role |
|---|---|
| `src/index.ts` | router, quota gate, meter flush, cron |
| `src/auth/admin.ts` | setup, login, sessions, CSRF, credential rotation and recovery, rate limits |
| `src/auth/oauth-server.ts` | OAuth authorization server for AI apps |
| `src/auth/tokens.ts` | API tokens and bearer authentication |
| `src/google/oauth.ts` | Google browser sign-in (PKCE), sealed token storage, refresh, revoke |
| `src/google/ads.ts` | Google Ads REST client and error mapping |
| `src/google/gaql.ts` | GAQL validator, money, dates, IDs |
| `src/ads/accounts.ts` | discovery (incl. manager hierarchy), allow-list |
| `src/ads/reports.ts`, `audit.ts` | read tools, pacing, audit |
| `src/ads/plans.ts` | plan model, hashing, validation, Search campaign builder |
| `src/ads/planner.ts`, `execute.ts` | drafting with previous values; validate, approve, execute, reconcile, recover |
| `src/mcp/server.ts` | tool definitions |
| `src/lib/*` | crypto (AES-GCM, hashes), D1 wrapper with usage meter, migrations, audit log, quotas |
| `public/` | dashboard (vanilla JS, no build step, strict CSP) |
| `test/` | tests run inside the Workers runtime against `fake-google.ts` |

## Data model (D1)

`admin`, `sessions`, `rate_limits`, `used_setup_secrets`, `settings`, `api_tokens` (API + OAuth access/refresh), `oauth_clients/pending/codes`, `google_oauth_states`, `google_connections` (sealed tokens), `accounts` (allow flag), `plans`, `approvals`, `executions`, `evidence`, `reports`, `audit_log`, `usage_daily`, `legacy_import`. Migrations are additive-only and applied automatically; `migrations/*.sql` is generated from the same source for those who prefer `wrangler d1 migrations`.

## Google Ads API notes

- REST `v25` (current at 11 Oct 2026; configurable via `GOOGLE_ADS_API_VERSION`). Methods used: `customers:listAccessibleCustomers`, `customers/{id}/googleAds:search`, `googleAds:mutate` (with `validateOnly`), `generateKeywordIdeas`, `generateKeywordHistoricalMetrics`, `geoTargetConstants:suggest`, `googleAdsFields:search`.
- Headers: `Authorization: Bearer`, `login-customer-id` for accounts reached through a manager. **No `developer-token`** unless you still set one (Google ignores it and plans to reject it in a future major version).
- Every mutate payload produced by the planners is checked in tests against Google's own v25 discovery document (`test/fixtures/ads-v25-mutate-schema.json`, revision 20261008).
