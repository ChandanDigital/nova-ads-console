# Test results (actually run, 11 Oct 2026)

Environment: Windows 11, Node 22.23.2, Wrangler 4.149.0 (local workerd runtime), `@cloudflare/vitest-plugin` 1.4.0, Vitest 4.1.11, TypeScript 7.0.2, MCP SDK 1.32.1, zod 4.6.5. Python side: CPython 3.12.14 with the original hash-pinned lock files.

**None of this touched a live Google account, a live Cloudflare account, GitHub, or a real AI app.** Google is a fake (`test/fake-google.ts`) that implements the OAuth token endpoint and the Ads REST methods the code uses, and checks every mutate payload against Google's own v25 schema.

## Summary

| Suite | Command | Result |
|---|---|---|
| Worker, in the Workers runtime | `npx vitest run` | **18 files, 279 tests, 0 failed** |
| Dashboard logic (DOM) | `npx vitest run -c vitest.ui.config.ts` | **1 file, 14 tests, 0 failed** |
| Type check (strict) | `npm run typecheck` | no errors |
| Python plugin (original 148 + 8 new) | `pytest tests` | **156 passed** |
| Clean install | `npm ci` from the lock file in an empty folder, then typecheck + tests | passed |
| Dependency audit | `npm audit` (including dev dependencies) | 0 vulnerabilities |
| Deployment bundle | `wrangler deploy --dry-run` | bundles; 1749 KiB, 317 KiB gzipped; bindings DB + ASSETS |
| Migration SQL in sync with source | `npm run gen:migration` then diff | identical |

## Worker tests by file

| File | Tests | What it establishes |
|---|---:|---|
| `admin.test.ts` | 23 | first-time setup needs the Cloudflare-held secret; wrong/missing secret refused; credential stored only as a hash; login, logout, rate limiting; HttpOnly+Secure+SameSite cookie; CSRF header and same-origin checks on every mutation; bearer tokens never work on dashboard routes; **credential replacement**: used secret refused, new secret works once, old credential and sessions die, AI tokens revoked, plans/approvals preserved, unreachable with an AI token, guessing is rate-limited, confirmation phrase required |
| `asset-campaigns.test.ts` | 30 | Display, Shopping, Performance Max, Demand Gen and App-install payloads all validate against Google's v25 REST schema; paused by default; right channel types; a full Performance Max asset group; 15 missing/invalid-input refusals; each type through the MCP tool, human approval and execution; Search still works with `campaign_type` omitted or `SEARCH` |
| `recommendations.test.ts` | 10 | apply and dismiss go through plan, re-check, human approval and ONE all-or-nothing Google call; no mutate call is made; own permission classes; budget recommendations refused; stale/unknown/dismissed refused; Google accepting but changing nothing is `outcome_unknown`, then reconciled; Google errors are not retried; global stop; no recovery plan; shape rules |
| `duplicate.test.ts` | 9 | a Search campaign becomes a new paused plan (bids, locations, exclusions, negatives, ad groups, keywords, first enabled ad), skipped parts are reported, the source is never written, validation + approval + execution, target CPA/ROAS, refusals (non-Search, unsupported bidding, missing EU declaration, too large, nothing to copy, insecure URL), draft permission |
| `landing.test.ts` | 22 | page facts extracted, redirects followed and re-validated, 100 KB cap, hostile text clipped, scripts ignored, private/IP/local/http/port/credential URLs refused before any request (including redirect targets), unreachable pages, MCP tool with a read-only token |
| `monitor.test.ts` | 6 | alerts for spend with no conversions and disapproved ads; deduplicated and auto-resolved; configurable threshold (admin only); unreadable account becomes an info alert; AI callers only see allowed accounts; daily cron runs it and survives its failure; no write ever reaches Google |
| `crypto.test.ts` | 9 | AES-GCM round trip, fresh IV, row binding (AAD), tamper detection, changed/rotated/invalid key messages, canonical hashing |
| `migrations.test.ts` | 5 | no destructive SQL, all `IF NOT EXISTS`, idempotent, an upgrade keeps existing rows |
| `google.test.ts` | 11 | consent URL (PKCE S256, offline, only Ads scope, secrets not exposed), server-side exchange, sealed token storage, manager-child discovery with `login-customer-id`, **no developer-token header**, single-use state, state bound to the browser session, missing refresh token / scope refused, refresh and caching, `invalid_grant` handling with guidance, disconnect revokes and wipes |
| `core.test.ts` | 62 | ported from the original suite: exact money, IDs, GAQL rejections and limits, pacing across the Kolkata month boundary, RSA rules (incl. Bengali counting), Google error mapping, plan integrity (hash, paused default, removal rejected, unmasked fields, cross-account references, conflicts, dependencies) |
| `conformance.test.ts` | 6 | every payload the planners can produce validates against Google's v25 REST schema (revision 20261008): names, types, enums; the validator itself is shown to catch errors |
| `execute.test.ts` | 26 | draft → validate → **human approval** → execute; paused by default; never runs twice (also under concurrency); AI cannot approve; approval needs exact hash, typed word, all permission classes, fresh validation; tampered plan, expired and revoked approvals, global stop; scopes and per-account permissions; budget/pause/enable/keyword/ad-group updates with before-values; stale-field detection before anything is sent; shared-budget scope; budget cap; negatives need real evidence; timeouts and 5xx → `outcome_unknown`, never retried; reconcile; Google validation errors with field paths; recovery plans |
| `mcp.test.ts` | 14 | 401 + discovery pointer; OAuth metadata; **official MCP SDK client** initialises, lists 35 tools and calls tools; the **SDK's own OAuth client** completes discovery, dynamic registration, PKCE, consent, token and refresh; refresh reuse revokes the grant; dangerous redirect URIs refused; code replay, wrong PKCE, wrong client, wrong redirect refused; denial; confidential-client secrets; grant revocation |
| `reports.test.ts` | 14 | bounded queries and original output shape, truncation flag, every report tool, official-compatible `search`/`get_resource_metadata`/`list_accessible_customers`, keyword research, geo targets, evidence saving, pacing, audit findings with "not checked" list and no health score, daily cron purges only expired rows, diagnostics |
| `security.test.ts` | 19 | **every** registered dashboard route answers 401 without a session; bearer tokens refused; hardening headers/CSP; no secret in any API response, audit row or database row; no MCP tool for approval/credentials/recovery; AI token cannot reach admin routes; smuggled `approved:true` ignored; personal-data GAQL and manager hierarchy denied; unallowed accounts invisible; revoke-all; token validation; quota limits enforced with a clear message and no paid fallback; D1 usage measured from D1 metadata |
| `legacy.test.ts` | 5 | import of a file written by the real exporter (allowlist applied, history archived, **no live authority created**), secrets rejected, wrong format rejected |
| `github-only.test.ts` | 3 | the GitHub Actions report is read-only (three reads, never a mutate), explains expired tokens and missing secrets |
| `ui.test.ts` | 5 | dashboard files comply with the strict CSP (no inline script/style, no third-party URLs, no `innerHTML`/`eval`); the secret generator makes no network call |

Dashboard DOM tests (`test-ui/views.test.ts`, 14; the new ones cover the recommendation action wording, the CSP-safe print button and the alerts card, with hostile alert text rendered as text): the approval screen shows exact before/after values and posts hash + only the ticked permissions + typed word + CSRF token; no approve button unless the plan awaits approval; hostile text from Google/AI renders as text (no element is created, no script runs); account switches; consent screen submits only the scopes/accounts left ticked; token creation shows the secret once; setup shows the credential once and enforces the "saved" box; login errors surface.

## Python (plugin) tests

`156 passed`: the 148 original tests re-run unchanged, plus `tests/test_v030.py` (8): credential replacement keeps the allowlist and ends old sessions; optional AI-token revocation; Google credentials, approvals and plans untouched; unknown clients and bad input refused; the CLI refuses non-interactive use; the exporter contains permissions/plans/history and **no secret** (refresh token, client secret, bearer tokens, key, private upload rows), leaves the database file **byte-identical**, never overwrites, and rejects a wrong key.

## Checks done by hand

- **Browser (Chromium pane):** `wrangler dev` served the dashboard; setup → one-time credential → overview worked; all nine pages loaded with no console errors and no CSP violations; at 375 px wide there was no horizontal overflow and the menu became a drawer. Only a few screenshots were inspected; this is not a cross-browser test.
- **Google schema:** besides the automated mutate check, I compared the request/response field names used for search, mutate envelope, keyword ideas, historical metrics, geo suggestions, field metadata, customer_client and error shapes with Google's v25 discovery document: all present (one-off script, not committed).
- **CPU estimate:** warm Node benchmark of response handling: 200 rows ≈ 1.0 ms, 1,000 rows ≈ 6.8 ms (after optimising the key conversion, which was about 7× slower before). Real Workers CPU time was **not** measured.

## Defects the tests caught in my own code (all fixed)

1. Permission classes: creating a paused campaign demanded the `launch` and `optimisation` permissions because child ads were `ENABLED` inside a new paused campaign.
2. OAuth refresh-token reuse was not detected (the used token was also marked revoked, so a replay was rejected as "invalid" instead of revoking the grant).
3. `index.html` contained an inline `style` attribute (a CSP violation) in the no-JavaScript notice.
4. A response-handling hot spot that, by my benchmark, could use most of the 10 ms free CPU budget at 1,000 rows; default cap lowered to 250 rows and the conversion rewritten.
5. A broken string literal I introduced in the Python CLI (caught by the original stdio protocol test and the new CLI test).
6. A test helper regex corrupted by an invisible control character (caught because the generator-page test failed).

## Not covered

See [`live-checks.md`](live-checks.md).
