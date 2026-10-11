# Security policy

- Never put secrets in this repository. Cloudflare Secrets hold `TOKEN_ENCRYPTION_KEY`, `ADMIN_SETUP_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
- Keep the repository **private**, protect `main` (pull request + CI + CODEOWNERS review) and enable 2FA on GitHub, Cloudflare and Google.
- If a secret leaked: rotate it in Cloudflare/Google, use *AI access → Revoke every AI token*, and use *Overview → Global stop* while you investigate.
- Report vulnerabilities privately to the repository owner. See `docs/security.md` for the model and its known limits.
