# Security model

## Who can do what

| Actor | Credential | Can | Cannot |
|---|---|---|---|
| **Administrator** (human) | `nova_admin_…` credential → browser session (HttpOnly cookie + CSRF token) | connect Google, allow accounts, approve/reject plans, issue/revoke AI tokens, global stop, budget cap, diagnostics | — |
| **AI app** | OAuth 2.1 access token (`nova_at_…`) or pasted API token (`nova_api_…`), scopes `read` `draft` `apply` | read reports; draft and validate plans; execute a plan a human approved | approve a plan, see non-allowed accounts, manage tokens/credentials/settings, recover the admin credential, sign in to the dashboard |
| **Cloudflare account owner** | Cloudflare login | set Worker secrets (incl. `ADMIN_SETUP_SECRET`), read D1 | — (this is the root of trust, as it is for any hosted app) |

Enforced by tests in `test/security.test.ts`, `test/admin.test.ts`, `test/execute.test.ts`, `test/mcp.test.ts`: every registered `/api` route answers 401 without a session; a bearer token is refused on every dashboard route (403); no MCP tool name relates to approval, credentials, tokens, settings or recovery; tool arguments such as `approved: true` are ignored.

## Human approval

A plan can run only if **all** hold at execution time:
1. status `awaiting_approval` (Google `validateOnly` passed within the last 30 minutes before approval);
2. an approval row exists, is not revoked, not expired (1 minute – 24 h) and covers every permission class (`create_campaign`, `optimisation`, `launch`, `budget_change`);
3. approval hash = stored hash = freshly recomputed hash of the stored plan (any edit, including a direct database edit, voids it);
4. the account still has the same currency, timezone and type and is enabled; every field an update will change still has the value the reviewer saw; shared-budget campaigns are unchanged;
5. a second `validateOnly` call succeeds;
6. the global stop is off;
7. an atomic compare-and-set moves the plan `awaiting_approval → running`; only one caller can win.

After dispatch: no automatic retry. A timeout or 5xx becomes `outcome_unknown`; `reconcile_operation` reads Google and reports what exists. Removal of resources is not implemented. New campaigns are `PAUSED` unless the reviewer approved `launch`.

Approval itself needs: signed-in session, CSRF header, same-origin `Origin`, the exact hash, ticked permission classes and the typed word `APPROVE`.

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
3. The old hash is overwritten, every browser session ends, by default every AI token/OAuth grant is revoked, the new credential is shown once. Plans, approvals, history and the Google connection are untouched.

Why AI cannot do it: the secret exists only in Cloudflare (never in D1 or any API response); `/api/auth/recover` rejects any request carrying an `Authorization` header; no MCP tool exists for it; attempts are rate-limited (5 per 15 minutes per address, 20 global) and audited.

For the local Python backend the equivalent is `python -m nodi_ads.cli reset-human --client <name>` (terminal only, refuses non-interactive use, needs the encryption key that is on that computer).

## Known limits (be aware)

- The security of the approval gate rests on the administrator credential and the Cloudflare account. Enable 2FA on Cloudflare, GitHub and Google.
- Anyone who can change the repository's `main` branch can deploy new code. Use branch protection + CODEOWNERS (included).
- DCR is open by design (MCP hosts register themselves): any registered client still needs **you** to sign in and click Allow, sees a redirect-host warning, and is limited to the scopes and accounts you choose. At most 200 registered clients; unused ones are purged after 30 days.
- Login throttling is per IP hash and global. A determined attacker who can rotate IPs is limited by the global limit (60/15 min) but could lock you out temporarily; the Cloudflare owner can always recover.
- Not yet verified: behaviour with a live Google account, Cloudflare production runtime limits (CPU time, startup time), and real Claude/ChatGPT clients. See `live-checks.md`.
- No third-party security audit has been done.
