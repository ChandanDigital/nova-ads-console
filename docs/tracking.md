# Tracking and analytics module (Phases 16–26)

Status on 2026-11-20. "Live verified" is **no** unless a line says otherwise.

## What is implemented

| Tool | Permission | What it does | What it does not do |
|---|---|---|---|
| `tracking_audit_website` | read | One public https fetch (same SSRF guard as `inspect_landing_page`). Finds GTM containers, GA4 measurement IDs, Google Ads tag IDs (`AW-`), conversion `send_to` labels, legacy `UA-` IDs, duplicate GTM loaders, duplicate `gtag('config')`, `dataLayer`, Consent Mode v2 default/update calls (the four keys, `region`, order before the tag loader) and platform hints (WordPress, WooCommerce, Shopify, Next.js, Wix, Squarespace). With `account_id` it also reads the account's `customer.conversion_tracking_setting.conversion_tracking_id` and conversion actions, and reports a tag that belongs to another account, phone links without a call conversion action, and forms without a primary website conversion action. | Prove that anything fires. Tags injected by GTM, plugins or later JavaScript are invisible. Reads the first 100 KB only (says so with `page_truncated`). |

Every result carries `verification_level: "page_source_and_account_configuration"` and a `not_verified` list. Configuration validation and event-delivery verification are kept separate on purpose.

**First real run (read-only, 2026-11-20):** the public homepage of the connected advertiser's website (268 KB) contains no GTM container, no GA4 tag, no Google Ads tag, no `dataLayer` and no consent code. Unless a tag is loaded from an external script, the website does not report conversions to Google Ads.

## Official API facts that shape the design

| Fact | Consequence | Source |
|---|---|---|
| Tag Manager API v2 `accounts` has only `get`, `list`, `update`: **there is no account create** | `gtm_create_account` cannot exist; a human creates the GTM account in the UI | [accounts resource](https://developers.google.com/tag-platform/tag-manager/api/v2/reference/accounts) |
| GTM scopes are split: `tagmanager.readonly`, `tagmanager.edit.containers` (no versioning or publishing), `tagmanager.edit.containerversions`, `tagmanager.publish`, `tagmanager.manage.accounts`, `tagmanager.manage.users`, `tagmanager.delete.containers` | Map read / draft / apply onto separate scopes; `publish` only for connections with apply | [authorization](https://developers.google.com/tag-platform/tag-manager/api/v2/authorization) |
| GA4 accounts are created by `provisionAccountTicket` and finish only when a person accepts the Terms of Service in a browser | `ga4_create_account` is a human step; `ga4_create_property` (`analytics.edit`) is automatable | [Admin API](https://developers.google.com/analytics/devguides/config/admin/v1) |
| Measurement Protocol needs an `api_secret` created per web stream, after a data-sharing acknowledgement | The secret must be stored sealed (AES-GCM like refresh tokens); sending real events is an apply action | [secrets](https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1beta/properties.dataStreams.measurementProtocolSecrets) |
| Since 15 Jun 2026 new offline-conversion and enhanced-conversions-for-leads integrations must use the **Data Manager API**; the Google Ads API refuses new adopters | No Google Ads API upload path will be built; Data Manager API only | [Google Ads API docs](https://developers.google.com/google-ads/api/docs/conversions/upload-offline), [announcement](http://ads-developers.googleblog.com/2026/05/changes-to-offline-click-conversion.html) |
| Workers free plan: 10 ms CPU and 50 external subrequests per request; D1 50 queries per invocation | Paging GTM workspaces (tags + triggers + variables) must be split across calls; no long audits in one request | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| GTM server-side tagging runs Google's tagging server image (Cloud Run or Docker), not on Workers | Nova can generate the setup guide and health-check an endpoint; it cannot host the server container, and will not create billable resources | Google server-side tagging docs (to be re-checked before Phase 22) |

## Why GTM and GA4 tools are not built yet

Nova's Google sign-in asks for the Google Ads scope only (`src/google/oauth.ts`). Every GTM and GA4 tool needs, first:

1. **Google Cloud project:** enable Tag Manager API, Google Analytics Admin API and Google Analytics Data API; add the scopes to the OAuth consent screen. `tagmanager.*` and `analytics.*` scopes are restricted or sensitive; an app outside "Testing" status may need Google's verification.
2. **Incremental consent in Nova:** a separate "Connect Tag Manager / Analytics" button that requests only those scopes (`include_granted_scopes`), records them per sign-in (the `google_connections.scopes` column already exists), and makes each tool check its scope instead of assuming Google Ads access implies GTM or GA4 access.
3. **Plan engine reuse:** GTM writes (tags, triggers, variables, versions, publish) go through the same draft → validate → apply plans as Google Ads, with a version created and recorded before any publish and a restore plan afterwards. GTM has no validate-only mode, so "validate" will mean workspace status + quick-preview compile.

This is the decision the owner has to make before Phase 16 starts (it changes the Google Cloud project and the consent screen).

## Order of work proposed

1. Scopes and consent flow (above), with tests for "Ads-only sign-in cannot call GTM tools".
2. Read-only GTM and GA4 (list accounts, containers, workspaces, tags, triggers, variables, versions; properties, streams, measurement IDs, key events; Data API reports with metadata-checked dimensions and metrics).
3. GTM drafting in workspaces + publish through apply plans; GA4 property / stream / key event creation.
4. Google Ads conversion action create/update through the existing plan engine (`conversion_action` kind).
5. Consent Mode v2 template generation; Measurement Protocol validate (debug endpoint) before any send.
6. Data Manager API (offline / enhanced conversions for leads) only after a privacy review: no unhashed personal data stored, SHA-256 after normalisation, consent required.
7. Server-side tagging guide and endpoint health check; dashboard section last.
