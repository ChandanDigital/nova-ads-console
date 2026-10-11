# Setup (browser only, free)

You need three free accounts: **GitHub**, **Cloudflare**, and a **Google** account that can use **Google Cloud** and **Google Ads**. Screen names change from time to time; if a label differs slightly, look for the closest one.

No part of this requires installing Python, Node.js, Docker or a terminal.

## 1. Put the code in a private GitHub repository

1. GitHub → **New repository**. Name it `nodi-ads-cloud`, choose **Private**, do not add a README. Create it.
2. Unzip `nodi-ads-cloud-0.3.0.zip` on your computer. Open the new repository → **uploading an existing file**.
3. Drag the **contents** of the unzipped folder (not the folder itself) into the page. GitHub accepts about 100 files per upload, so do it in two or three batches: first `src`, `public`, `migrations`, `scripts`, `github-only` and the loose files; then `test` and `docs`; then `.github` (a hidden folder: turn on "show hidden files", or drag it separately). Commit each batch to `main`.
4. Open `.github/CODEOWNERS` and replace `@REPLACE-WITH-YOUR-GITHUB-USERNAME` with your username.
5. Recommended: *Settings → Branches → Add rule* for `main`: require a pull request and the **CI** check. That makes only reviewed commits deploy.

> GitHub Pages is **not** used. On the free plan Pages works only for public repositories, and a dashboard that shows account data must not be public. The dashboard is served by the Worker itself, behind sign-in.

## 2. Create the Worker from the repository (Cloudflare)

1. Cloudflare dashboard → **Workers & Pages → Create → Import a repository** (Workers Builds). Authorise the Cloudflare GitHub app for the private repository only.
2. Project name: **`nodi-ads-cloudflare`** (it must equal the `name` in `wrangler.jsonc`, or the build fails). Leave the build command empty and the deploy command at its default (`npx wrangler deploy`). Save and deploy.
3. The first deploy creates the D1 database `nodi-ads-db` automatically (current Wrangler does this when `database_id` is omitted). **If the build reports a D1 error**: Cloudflare dashboard → *Storage & databases → D1 → Create database* named `nodi-ads-db`, copy its ID, edit `wrangler.jsonc` on GitHub (pencil icon) and add `"database_id": "<the id>"` to the `d1_databases` entry. Commit; it redeploys.
4. Your Worker URL is `https://nodi-ads.<your-subdomain>.workers.dev`. Open `https://…/healthz`; it should answer `{"ok":true,…}`.

The database tables are created automatically the first time the Worker runs (`CREATE TABLE IF NOT EXISTS`, never destructive). Nothing to run by hand.

## 3. Add the secrets

1. Open `https://…/generate-secrets.html`. It creates two random values **inside your browser**; nothing is sent anywhere.
2. Cloudflare → your Worker → **Settings → Variables and Secrets → Add** (type **Secret**):

| Name | Value |
|---|---|
| `TOKEN_ENCRYPTION_KEY` | from the generator (keep a copy in a password manager) |
| `ADMIN_SETUP_SECRET` | from the generator (only you know it) |
| `GOOGLE_CLIENT_ID` | from step 4 |
| `GOOGLE_CLIENT_SECRET` | from step 4 |

Secrets are never in GitHub and never in the page code.

## 4. Google Cloud: enable the API and create the OAuth client

1. [Google Cloud Console](https://console.cloud.google.com) → create a project (any name).
2. *APIs & Services → Library* → enable **Google Ads API**.
3. *OAuth consent screen* (Google Auth platform): user type **External**. Add the scope `https://www.googleapis.com/auth/adwords`. Then **Publish the app (In production)**. Google shows an "unverified app" warning to you when you sign in: choose *Advanced → continue*. **Do not leave it in Testing**: in Testing mode refresh tokens expire after 7 days.
4. *Credentials → Create credentials → OAuth client ID → Web application*. Under **Authorized redirect URIs** add exactly the address shown on the dashboard page *Google connection* (it is `https://<your-worker>/oauth/google/callback`). Create; copy the client ID and secret into Cloudflare (step 3).

**Developer tokens are retired** (9 Sep 2026): none is needed. What you can read depends on your Cloud project's API access level (Test access works for Google Ads *test accounts* only; Basic/Standard access is needed for production accounts). Read Google's [developer token and access-level page](https://developers.google.com/google-ads/api/docs/api-policy/developer-token) and apply for access if the dashboard reports `production_access_restricted`.

## 5. First sign-in

1. Open your Worker URL. Enter `ADMIN_SETUP_SECRET`. The dashboard shows your **administrator credential once**; save it in a password manager (never paste it into an AI chat).
2. *Google connection → Connect Google Ads* → sign in with the Google user that has access to your Google Ads account → *Discover accounts*.
3. *Accounts*: switch **on** only the accounts AI tools may use. Nothing is visible to AI by default.
4. *Diagnostics* should show green checks.

## 6. Connect an AI app

- **Claude (web / desktop):** Settings → Connectors → **Add custom connector** → paste `https://<your-worker>/mcp`. Claude registers itself; sign in to the dashboard when asked and approve. (Claude Desktop cannot use remote servers from its config file; use Connectors.)
- **Claude Code:** `claude mcp add --transport http nodi-ads https://<your-worker>/mcp`, then `/mcp` to sign in, or create a token under *AI access* and add `--header "Authorization: Bearer <token>"`.
- **Others (ChatGPT, Gemini CLI, Cursor):** add a remote MCP server with the same URL. These hosts have not been tested.

Start with `read` + `draft` permissions. Add `apply` only when you want the AI to run plans **you** approved.

## 7. A first safe change

1. Ask the AI: "Draft a budget change for campaign X to 300 and explain it."
2. Open *Approvals*. Read the before/after values, spending effect and recovery limit. Tick the permission classes, type `APPROVE`, press the button.
3. Ask the AI to execute the plan. It runs once, paused/enabled exactly as reviewed. Check *Activity*.

## Updating, backup, undo

- **Update:** commit to `main`; Cloudflare redeploys. Data stays in D1.
- **Backup:** D1 has 7-day point-in-time recovery on the free plan (Cloudflare dashboard → D1 → Time Travel). Keep `TOKEN_ENCRYPTION_KEY` safe.
- **Rotate the encryption key:** set the new value as `TOKEN_ENCRYPTION_KEY` and the old one as `TOKEN_ENCRYPTION_KEY_PREVIOUS`; or just reconnect Google.
- **Stop everything:** dashboard → Overview → *Global stop* (blocks all account writes at once). *AI access → Revoke every AI token* cuts off all AI apps.
- **Lost administrator credential:** see [`security.md`](security.md#lost-administrator-credential).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Build fails mentioning the Worker name | Worker name in Cloudflare must be `nodi-ads-cloudflare` |
| Build fails on D1 | add `database_id` (step 2.3) |
| Dashboard says "ADMIN_SETUP_SECRET is not set" | add the secret, then reload |
| Google says `redirect_uri_mismatch` | the URI in Google Cloud differs from the one on the *Google connection* page by even one character |
| `credentials_expired` after about a week | consent screen is still in Testing; publish to Production and reconnect |
| `production_access_restricted` | your Cloud project only has Test access to the Ads API |
| `quota_soft_limit` | the app stopped itself at its daily limit; see *Hosting & quotas* |
| Reports say "Worker exceeded CPU" | use a shorter date range; Free plan allows 10 ms CPU per request |
