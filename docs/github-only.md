# GitHub-only alternative (no Cloudflare)

Use this only if you refuse Cloudflare entirely.

## What it can and cannot do

| | GitHub-only | Cloudflare edition |
|---|---|---|
| Free | yes (Actions minutes on a private repo: 2,000/month on the Free plan) | yes |
| Weekly read-only Google Ads report (cost, clicks, conversions, campaigns, wasteful search terms, tracking check) | **yes** | yes |
| **Always-available remote MCP server** | **no** | yes |
| Dashboard, sign-in, plans, campaign changes | **no** | yes |
| AI can ask questions "right now" | **no** (only the last scheduled report) | yes |
| Can change your Google Ads account | **never** | only through a validated plan |

Why: a GitHub Actions job starts on a schedule, runs for minutes and disappears; it cannot listen for requests. GitHub Pages serves static files only and, on the free plan, only from **public** repositories, which must not hold account data.

## Setup (browser only)

1. Put the repository on GitHub as described in `setup.md`, step 1 (you do not need Cloudflare).
2. **Get a refresh token without any local tool.** In Google Cloud create a **Web** OAuth client and add `https://developers.google.com/oauthplayground` as an authorized redirect URI. Open the [OAuth Playground](https://developers.google.com/oauthplayground), click the gear icon, tick **Use your own OAuth credentials**, paste the client ID and secret, enter the scope `https://www.googleapis.com/auth/adwords`, authorise with the Google user that can see your Ads account, then **Exchange authorization code for tokens** and copy the **refresh token**. (Publish the consent screen to Production first; Testing-mode refresh tokens die after 7 days.)
3. GitHub → repository → *Settings → Secrets and variables → Actions*:
   - Secrets: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_ADS_CUSTOMER_ID` (10 digits), optional `GOOGLE_ADS_LOGIN_CUSTOMER_ID`.
   - Variable: `REPORT_ENABLED` = `true` (and optionally `REPORT_DAYS`, default 7).
4. *Actions → Scheduled Google Ads report → Run workflow* to test. The report appears in the run summary and as a downloadable artifact (`report.md`, `report.json`, kept 30 days).

The scheduled workflow runs Mondays 04:23 UTC. The script is `github-only/report.mjs`; it issues three GAQL reads and one token refresh and nothing else (a test asserts it never calls any mutate method).

This path has been unit-tested with a fake Google; it has **not** been run on GitHub Actions or against a live account.
