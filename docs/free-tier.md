# Staying at zero hosting cost

Verified against Cloudflare and GitHub documentation on **11 Oct 2026**. Limits can change; re-check before relying on them.

## What is used and what the free plan allows

| Service | Used for | Free-plan limit (documented) | How this project stays inside it |
|---|---|---|---|
| Cloudflare Workers | MCP, OAuth, API, dashboard | 100,000 requests/day; **10 ms CPU per request**; 50 subrequests/request; Error 1027/429 after the daily cap | own cap 70,000 requests/day; row caps; one Google call batch per tool; no background loops |
| Workers Static Assets | dashboard files | static asset requests are free and unlimited (only `/api`, `/mcp`, `/oauth`, `/.well-known`, `/healthz` run Worker code) | `run_worker_first` lists only those paths |
| Cloudflare D1 | all data | 5 GB account / 500 MB per database; **5M rows read/day; 100k rows written/day**; over the limit queries are *blocked*, not billed | own caps 3M reads / 60k writes per day, measured from D1's own `rows_read`/`rows_written`; indexes; nightly purge of expired rows |
| Cron Triggers | one daily maintenance run | 5 per account | uses 1 |
| Workers Builds | deploy on commit | 3,000 build minutes/month, 1 concurrent build | a build takes a few minutes |
| GitHub (private repo) | source, CI | Actions: 2,000 minutes/month on Free; GitHub Pages **not** available for private repos on Free | CI is about 3–4 minutes per push; Pages not used |
| Google Ads API | the account data | access level of your Cloud project; Basic access allows a daily operation quota | own cap 5,000 Google calls/day, configurable |

Nothing in this project calls a paid API, enables a billing feature, or upgrades a plan. If a limit is reached the Worker returns `quota_soft_limit` (HTTP 429 / a failed tool call) with an explanation and **stops**; the counters reset at 00:00 UTC. Cloudflare's own free-plan stop is a hard error, not a bill.

## Limits you will actually feel

1. **10 ms CPU per request.** Parsing a big Google response costs CPU, so reports are capped at **250 rows per query** (`MAX_ROWS_PER_QUERY`) and the audit reads 200 rows per query. A warm Node benchmark of the response handling (JSON parse + key conversion + serialise) measured about 1.0 ms for 200 rows and 6.8 ms for 1,000 rows; real Workers timing has **not** been measured. If a request still exceeds the CPU limit Cloudflare returns Error 1102: choose a shorter date range. Raising the cap is possible, but at your own risk on the free plan.
2. **50 subrequests per request.** Account discovery reads at most 30 accessible accounts per run and reports truncation.
3. **No always-on monitors.** A cron trigger has the same 10 ms budget, so the original local "monitor / auto-pause at a spend threshold" is not provided. The daily cron only purges expired rows and checks that the Google token still refreshes.
4. **100k D1 writes/day.** Each request writes about 3–6 rows (usage counters, audit). That leaves room for roughly 10,000 dashboard/MCP requests a day under the 60k self-limit. A busy multi-client agency deployment could need the paid plan: this project will tell you and stop, not upgrade for you.

## The dashboard's quota page

*Hosting & quotas* shows today's measured values against both the self-imposed limit and Cloudflare's ceiling, with a 7-day trend. Optional: add secrets `CF_API_TOKEN` (read-only "Account Analytics") and `CF_ACCOUNT_ID` to also show Cloudflare's own analytics numbers (this call is not verified against a live account).

## What is *not* free (and not controlled here)

- Google Ads advertising spend.
- Any AI subscription (Claude, ChatGPT, Gemini) you use to talk to the server.
- A custom domain, if you choose one.
- Workers Paid, D1 overage, R2 etc. are never enabled by this project.

## If you refuse Cloudflare entirely

See [`github-only.md`](github-only.md): a weekly read-only report in GitHub Actions. It **cannot** provide an always-available MCP server, dashboard, OAuth sign-in, or approvals, because GitHub Actions jobs run briefly on a schedule and GitHub Pages cannot run server code (and is public-only on the free plan).
