# What was preserved, reimplemented, or is not available

Baseline: the local Python plugin **Nova Ads Console 0.2.0** (42 MCP tools, 148 offline tests, all passing when I re-ran them on Python 3.12). The cloud edition exposes **35 tools**. "Live verified" is **no** for everything: nothing has run against a live Google account.

Legend: **Preserved** = same behaviour and rules, same tool name · **Reimplemented** = rewritten for Workers (TypeScript, REST API), same intent, some differences noted · **New** · **Not available on free hosting / not ported**.

## Tools

| Original tool | Status | Notes |
|---|---|---|
| connection_status, open_google_ads_connection | Reimplemented | browser OAuth in the dashboard instead of local CLI |
| list_accounts, select_account | Reimplemented | account allowlist is now a switch per account in the dashboard |
| get_capabilities | Reimplemented | honest matrix, `live_verified: false` |
| get_performance, get_search_terms, get_keyword_performance, get_ad_performance, get_segment_performance, get_impression_share, get_conversion_diagnostics, compare_periods, calculate_budget_pacing, list_recommendations, search_geo_targets, research_keywords | Reimplemented | same GAQL, same snake_case output; **250-row cap** per query (10 ms CPU); no cursor paging (a `truncated` flag instead) |
| query_account | Reimplemented | same validator rules (resource allowlist, personal-data and `customer_client` denial, bounded LIMIT) |
| audit_account, export_report | Reimplemented, **reduced** | 10 evidence rules + a list of what was not checked, no health score (as in the original); the 97-control catalogue, HTML/CSV export remain in the local plugin; JSON/Markdown only |
| create_campaign_plan | Reimplemented, **Search only** | budget, locations, radius, schedules, devices, AI Max, sitelinks, callouts, ad groups, keywords, RSA, negatives; paused by default |
| create_optimisation_plan | Reimplemented, subset | updates: campaign (status, name, networks, bidding targets, tracking, dates), budget, ad group, keyword, ad status, campaign criterion bid modifier; creates: keywords, ads, negatives (evidence required) |
| preview_change_plan, validate_change_plan, execute_authorised_plan, get_operation_status, reconcile_operation, get_change_history, create_recovery_plan | Reimplemented | same state machine and rules (hash-bound plans, fresh Google validation before running, no retry, outcome_unknown, recovery plans) |
| (human approval screen) | **Removed by choice** | replaced by the `apply` permission on AI connections plus a *Plans* screen where the administrator can run or cancel a plan; see `security.md` |
| search, get_resource_metadata, list_accessible_customers | **New** | compatible with the official `googleads/google-ads-mcp` tool names and arguments (reimplemented, **not** the Python package) |
| create_budget_change_plan, create_status_change_plan | **New** | friendlier wrappers for the most common changes |
| get_hosting_usage | **New** | free-tier usage |
| create_duplicate_campaign_plan | **Reimplemented** | Search campaigns only; drafts a NEW paused copy through the normal plan, validation and run path and lists what was not copied (sitelinks, callouts, schedules, devices, radius targets, AI Max, shared lists, extra ads) |
| create_experiment_plan, forecast_keywords | Not ported | still in the local plugin |
| get_alerts, daily monitor | **Reimplemented as alerts only** | a daily read-only check raises alerts (spend with no conversions, disapproved ads, unreadable accounts); shown on the dashboard overview and through `get_alerts`. Nothing is paused automatically |
| configure_monitor, pause_monitor | **Not available on free hosting** | custom thresholds per monitor and always-on checks need more than the 10 ms CPU budget |
| inspect_landing_page | **Reimplemented (lightweight)** | one public https fetch with an SSRF guard (https only, no private/IP hosts, redirects re-checked, 100 KB cap); title, meta description, H1, mobile tag, noindex, forms, tel links and basic checks. No JavaScript rendering, speed test or tracking check |
| get_measurement_data (GA4/GTM/Merchant) | Not ported | local plugin |
| import_google_csv, audit_imported_snapshot | Not ported | local plugin |
| execute_authorised_upload, get_upload_status (customer match / conversion uploads) | Not ported by design | private customer data (click IDs, hashed emails and phone numbers) is not stored on the free cloud database; Google also states that new conversion-import features go to the Data Manager API rather than the Google Ads API upload services |
| submit_audit_findings | Not ported | specialist-agent worker merge; agents keep working through the plugin |
| Display / Shopping / Performance Max / Demand Gen / App creation | **Reimplemented** | `create_campaign_plan` with `campaign_type`; paused by default; needs existing image/video assets (no upload), linked Merchant feed / app listing; General Video creation is not supported by the Google Ads API. **Performance Max is two steps**: Google only counts headline/description assets that exist before the campaign request (seen live as `NOT_ENOUGH_HEADLINE_ASSET`), so the first call drafts a no-spend text-asset plan when any are missing, and calling again with the same spec drafts the campaign linking them |
| tracking_audit_website | **New** | page-source scan for GTM, GA4, Google Ads tags, duplicates and Consent Mode v2, compared with the account's conversion setup; does not prove firing. GTM / GA4 / Data Manager API tools are planned, see `tracking.md` |
| Recommendation apply / dismiss with mixed types | **Refused at draft** | Google rejects mixed types in one all-or-nothing call (`DIFFERENT_TYPES_NOT_SUPPORTED`); draft one plan per type |
| Recommendation apply / dismiss | **Reimplemented** | `create_recommendation_plan`; Google has no validate-only mode for this call, so validation re-checks that each recommendation is still open; budget recommendations are refused (use the budget plan) |
| PDF reports | **Partly** | dashboard "Print / Save as PDF" button on plans and audits (browser print); no server-generated PDF |
| Standing permissions (auto-pause) | Not ported | automatic pausing is not provided; use alerts and a status-change plan |

## Platform features

| Feature | Original | Cloud edition |
|---|---|---|
| Runs without Python/Docker/Node on the user's PC | no (needs Python 3.12) | **yes** |
| Reachable from claude.ai / phone | no (local only) | **yes** (remote MCP over HTTPS) |
| Human approval separated from AI | yes | **no** (removed by choice; the owner controls which connections have `apply`) |
| Encrypted token storage | Fernet in SQLite | AES-256-GCM in D1 |
| Lost human credential | **no recovery path** | recovery by Cloudflare owner; local `reset-human` added in 0.3.0 |
| Multiple Google sign-ins | yes | supported in the schema, dashboard connects one at a time |
| Developer token | not required (verified in 0.2.0) | not required |
| Plugin commands, skills, agents | yes | unchanged in the ZIP; they call the same tool names |
| Offline CSV analysis | yes | local plugin only |
| Data in `~/.nova-ads` | yes | untouched; optional read-only export (see `migration.md`) |
