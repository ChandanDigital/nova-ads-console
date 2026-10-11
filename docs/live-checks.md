# What has NOT been verified (do these before trusting production accounts)

Everything below was **not run**: no Google credentials, Google Ads test account, Cloudflare account, GitHub repository or AI-app session was available while building this. The automated tests (see `test-results.md`) use a fake Google and run in a local copy of the Workers runtime.

| # | Area | Exact check | Needs |
|---|---|---|---|
| 1 | Deployment | Import the repo in Workers Builds; confirm the build, automatic D1 creation (or the `database_id` fallback) and `/healthz` | Cloudflare + GitHub |
| 2 | Secrets | Set the four secrets; Diagnostics shows green | Cloudflare |
| 3 | First setup | Setup secret, credential shown once, login, logout, recovery with a rotated `ADMIN_SETUP_SECRET` | Cloudflare |
| 4 | Google OAuth | Connect with the Web client, consent screen in Production, refresh after an hour, revoke from Google's side, reconnect | Google Cloud project |
| 5 | Access level | Read a Google Ads **test** account (Test access); read a production account (Basic access); verify the `production_access_restricted` message | Google Ads |
| 6 | Discovery | Direct account; manager with children (login-customer-id); nested managers (every descendant is recorded with the top manager as login-customer-id; intermediate-manager paths are not tracked) | Google Ads hierarchy |
| 7 | Reads | each report tool returns real rows; unavailable metrics; 250-row cap; date ranges; search-term privacy omissions | Google Ads |
| 8 | CPU limit | Measure real Worker CPU for reports, audit, discovery (Free plan 10 ms); my benchmark was warm Node, not workerd production | Cloudflare analytics |
| 9 | Startup | Cold-start time of the 1.7 MB bundle (Free plan startup limit) | Cloudflare |
| 10 | Mutations | validateOnly accepted by Google for a Search campaign (budget, campaign, criteria, ad group, keywords, RSA, sitelinks, callouts); real creation paused; read-back; budget update; pause/enable; keyword/ad-group updates; negative keywords | Google Ads **test account** |
| 11 | Failure paths | a real partial failure, a real lost response + `reconcile_operation` | controlled test account |
| 12 | Claude web/desktop | custom connector flow end to end (DCR, consent page, tools list, tool call, refresh) | Claude account |
| 13 | Claude Code / ChatGPT / Gemini CLI / Cursor | same | each app |
| 14 | OAuth callback hosts | DCR with Claude's `https://claude.ai/api/mcp/auth_callback` (may move to claude.com); ChatGPT's callback | those apps |
| 15 | Quota accounting | compare the dashboard's D1 row counts with Cloudflare's analytics; verify `CF_API_TOKEN` panel | Cloudflare |
| 16 | GitHub Actions | CI workflow passes on GitHub; deploy workflow (optional); scheduled report | GitHub |
| 17 | Browsers | dashboard in Chrome, Safari, Firefox, phone | browsers (I checked Chromium at 800 px and 375 px only) |

Also unverified: the claim in `wrangler.jsonc` that Wrangler auto-creates D1 without `database_id` on Workers Builds (the installed Wrangler 4.149 has code for automatic D1 provisioning, but I could not run a deployment).

Record failures; do not delete them. Until 4, 5, 7 and 10 pass, treat this as a release candidate.
