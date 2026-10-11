# Nodi Ads Cloud

A remote **MCP server**, **OAuth server** and **management dashboard** for Google Ads that runs on the **Cloudflare free plan** and is deployed from a **private GitHub repository**. It is the cloud edition of the local Python plugin "Nodi Ads" (0.2.0).

- Read tools (accounts, campaign reports, keywords, search terms, audit, keyword research) work immediately after you connect Google.
- Changes (new campaigns, budget, pause/enable, ad groups, keywords) are **drafted by AI, validated by Google, approved by a human in the dashboard, then executed**. No AI credential can approve anything.
- No Python, Node.js, Docker, server or command line is needed to deploy or run it. Everything is done in browser dashboards.

> **Status: release candidate.** The code is covered by 190+ automated tests that ran in the real Workers runtime against a faithful fake of Google. **It has not been run against a live Google Ads account, a live Cloudflare deployment, or a real Claude/ChatGPT app.** [`docs/live-checks.md`](docs/live-checks.md) lists exactly what still needs a live test. Start with a Google Ads *test account*.

## What you get

| Part | What it is |
|---|---|
| `/mcp` | Streamable HTTP MCP endpoint (official `@modelcontextprotocol/sdk`), 35 tools, OAuth 2.1 + PKCE or a pasted API token |
| `/oauth/*`, `/.well-known/*` | Authorization server for AI apps (dynamic client registration, single-use codes, rotating refresh tokens) |
| `/` dashboard | Overview, Google connection, accounts, performance, keywords, search terms, audit, **approval queue**, activity, AI access, credential security, diagnostics, hosting and quota monitor |
| D1 database | Encrypted Google tokens, plans, approvals, audit log, usage counters |
| `github-only/` | Read-only weekly report in GitHub Actions for people who refuse Cloudflare (cannot serve an MCP endpoint) |

## Deploy in five steps (details: [`docs/setup.md`](docs/setup.md) · বাংলা: [`docs/setup-bn.md`](docs/setup-bn.md))

1. Create a **private** GitHub repository and upload these files.
2. In Cloudflare: *Workers & Pages → Create → Import a repository* and pick it. Cloudflare then redeploys on every commit to `main`.
3. Open `/generate-secrets.html` on your Worker URL, then add four **Secrets** in Cloudflare: `TOKEN_ENCRYPTION_KEY`, `ADMIN_SETUP_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
4. In Google Cloud create a **Web** OAuth client for the Google Ads API with the redirect URI shown on the dashboard.
5. Open your Worker URL, create the administrator, press **Connect Google Ads**, allow your accounts, and add `https://<your-worker>/mcp` as a custom connector in Claude.

## Safety model in one paragraph

Google tokens are sealed with AES-256-GCM in D1. The administrator credential is a random 256-bit value stored only as a hash; if it is lost, only the person who controls the Cloudflare account can replace it (using a one-time `ADMIN_SETUP_SECRET`), and nothing is ever "cracked" or decrypted. AI tokens have only `read`, `draft`, `apply` scopes; approval needs the signed-in dashboard session, a CSRF token, the exact plan hash and the typed word APPROVE. Plans are paused by default, re-validated with Google right before execution, executed at most once, never retried automatically, and blocked by a global stop switch. See [`docs/security.md`](docs/security.md).

## Zero-cost operation

This project stays inside the documented Cloudflare Free limits and **never upgrades or bills anything**. It enforces its own daily limits below Cloudflare's, refuses work (with a clear message) when they are reached, and shows measured usage on the dashboard. Hosting cost is zero; Google Ads **advertising spend** and any **AI subscription** are separate. Some free-plan limits restrict features (10 ms CPU per request ⇒ row caps; no always-on monitors). See [`docs/free-tier.md`](docs/free-tier.md).

## Documents

[`setup`](docs/setup.md) · [`setup-bn`](docs/setup-bn.md) · [`architecture`](docs/architecture.md) · [`security`](docs/security.md) · [`free-tier`](docs/free-tier.md) · [`feature-matrix`](docs/feature-matrix.md) · [`migration`](docs/migration.md) · [`github-only`](docs/github-only.md) · [`live-checks`](docs/live-checks.md) · [`test-results`](docs/test-results.md)

## Develop (optional, not needed to deploy)

```
npm ci
npm test            # runs inside the Workers runtime
npm run typecheck
npm run dev         # local Worker; copy .dev.vars.example to .dev.vars first
```

Licence: MIT.
