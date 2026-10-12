# Security model

## Who can do what

| Actor | Credential | Can | Cannot |
|---|---|---|---|
| **Administrator** (human) | `nova_admin_…` credential → browser session (HttpOnly cookie + CSRF token) | connect Google, allow accounts, run or cancel plans, issue/revoke AI tokens, global stop, budget cap, diagnostics | — |
| **AI app** | OAuth 2.1 access token (`nova_at_…`) or pasted API token (`nova_api_…`), scopes `read` `draft` `apply` | read reports; draft and validate plans; with `apply`, run a validated plan | see non-allowed accounts, manage tokens/credentials/settings, recover the admin credential, sign in to the dashboard |
| **Cloudflare account owner** | Cloudflare login | set Worker secrets (incl. `ADMIN_SETUP_SECRET`), read D1 | — (this is the root of trust, as it is for any hosted app) |

Enforced by tests in `test/security.test.ts`, `test/admin.test.ts`, `test/execute.test.ts`, `test/mcp.test.ts`: every registered `/api` route answers 401 without a session; a bearer token is refused on every dashboard route (403); no MCP tool name relates to credentials, tokens, settings or recovery; extra tool arguments such as `approved: true` cannot skip validation.

## Running a plan

There is no separate approval step. The control the owner holds is **which AI connections get the `apply` permission**: a connection with only `read` and `draft` can look and propose but can never change an account. Start there, and give `apply` only to AI apps you trust. The administrator can also run or cancel any plan from the dashboard.

A plan can run only if **all** hold at the moment it is sent:
1. status `ready`: Google `validateOnly` passed for this exact plan within the last 30 minutes;
2. the stored plan still hashes to its stored hash (any edit, including a direct database edit, is refused);
3. the account still has the same currency, timezone and type and is enabled; every field an update will change still has the value the plan was drafted against; shared-budget campaigns are unchanged;
4. a second `validateOnly` call succeeds just before sending;
5. the global stop is off;
6. an atomic compare-and-set moves the plan `ready → running`; only one caller can win, so a plan can never be sent twice.

Other guardrails that stay on: new campaigns are created `PAUSED` unless the plan sets `launch: true`; the administrator's daily budget cap is enforced when a plan is drafted; budget recommendations cannot be applied through the recommendation tool; removal of resources is not implemented; the AI sees only the accounts you allowed.

After dispatch: no automatic retry. A timeout or 5xx becomes `outcome_unknown`; `reconcile_operation` reads Google and reports what exists.

**What this changes compared with earlier versions:** a validated plan no longer waits for a person. If you give an AI connection `apply` and it is manipulated by text it reads (for example text inside an ad account), it can run plans you did not look at. Mitigations: keep `apply` off by default, set a daily budget cap, use the global stop, and review *Activity*.

## Credentials and secrets

- **Administrator credential**: 256 random bits, stored as a SHA-256 hash. Because it is high-entropy, a slow password hash is unnecessary and would exceed the 10 ms Free-plan CPU budget. There is no way to read it back; it can only be replaced.
- **Google refresh and access tokens**: AES-256-GCM with `TOKEN_ENCRYPTION_KEY` (Cloudflare Secret). Each value is bound to its row with AAD, so a ciphertext copied to another row will not decrypt. Rotation via `TOKEN_ENCRYPTION_KEY_PREVIOUS`.
- **Google OAuth client secret** lives only in a Cloudflare Secret; the browser never sees it. PKCE (S256) is used; the verifier is sealed in D1; `state` is single-use, 10-minute, bound to the browser session.
- **AI tokens** are stored as SHA-256 hashes and shown once. OAuth refresh tokens rotate on every use; replaying an old one revokes the whole grant. Authorization codes are single-use (replay revokes the grant) and bound to client, redirect URI and PKCE challenge.
- **Audit log** redacts token-like strings and secret-named fields; tests assert no secret appears in API output, audit rows or database rows.
- Static dashboard files obey a strict CSP: `script-src 'self'; style-src 'self'`, no inline script/style (tested), no third-party requests, no `innerHTML`.

## Lost administrator credential

The credential cannot be recovered (only a hash exists) and this system never tries to reverse it. Replacement is controlled by the **Cloudflare account owner**:

1. Set `ADMIN_SETUP_SECRET` to a **new** random value in Cloudflare (each value works exactly once; the used value's digest is recorded).
2. Dashboard login page → *Lost your credential?* → enter it and type `REPLACE CREDENTIAL`.
3. The old hash is overwritten, every browser session ends, by default every AI token/OAuth grant is revoked, the new credential is shown once. Plans, history and the Google connection are untouched.

Why AI cannot do it: the secret exists only in Cloudflare (never in D1 or any API response); `/api/auth/recover` rejects any request carrying an `Authorization` header; no MCP tool exists for it; attempts are rate-limited (5 per 15 minutes per address, 20 global) and audited.

For the local Python backend the equivalent is `python -m nova_ads.cli reset-human --client <name>` (terminal only, refuses non-interactive use, needs the encryption key that is on that computer).

## Known limits (be aware)

- The security of everything rests on the administrator credential, the AI tokens you issue and the Cloudflare account. Enable 2FA on Cloudflare, GitHub and Google.
- Anyone who can change the repository's `main` branch can deploy new code. Use branch protection + CODEOWNERS (included).
- DCR is open by design (MCP hosts register themselves): any registered client still needs **you** to sign in and click Allow, sees a redirect-host warning, and is limited to the scopes and accounts you choose. At most 200 registered clients; unused ones are purged after 30 days.
- Login throttling is per IP hash and global. A determined attacker who can rotate IPs is limited by the global limit (60/15 min) but could lock you out temporarily; the Cloudflare owner can always recover.
- Not yet verified: behaviour with a live Google account, Cloudflare production runtime limits (CPU time, startup time), and real Claude/ChatGPT clients. See `live-checks.md`.
- No third-party security audit has been done.
