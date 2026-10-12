# Migrating from the local Python plugin (non-destructive)

> Older installs keep their data in `~/.nodi-ads`; the current local plugin keeps using that folder if it already exists, otherwise `~/.nova-ads`. Use whichever folder you have.

**The local installation is never modified.** Nothing in `~/.nova-ads` (database, `local-env.json`, encryption key, credentials, approvals) is deleted, moved or rewritten by any step below. You can keep both side by side; the cloud edition has its own database and its own approvals.

## What can move, what cannot

| Item | Moves? | How |
|---|---|---|
| Account allowlist (e.g. `3010086756`) | **yes** | export → import, creates *allowed* accounts |
| Plan summaries, approvals, execution history, standing-permission records | **archive only** | stored read-only; a legacy approval can **never** authorise a new plan (different plan format and hash, and the original forbids transferring approvals) |
| Google refresh token, OAuth client secret | **no, on purpose** | reconnect Google once in the dashboard (about a minute); the OAuth client also changes from Desktop to Web |
| Old human/AI credentials, token hashes, encryption key | **no** | create new ones; the old Fernet key is never exported |
| Private customer-data uploads | no | stay local |

## Steps

1. On the computer that has the local plugin, run the **read-only** exporter with the Python that already runs it (the one in `~/.nova-ads/venv`):

   ```
   %USERPROFILE%\.nova-ads\venv\Scripts\python tools\export_legacy.py --out nova-legacy-export.json
   ```
   It opens the SQLite file in `mode=ro` (SQLite itself refuses writes), decrypts only the allowed record kinds (`accounts`, `plans`, `plan_status`, `approvals`, `history`, `standing`), never reads `credentials`, refuses to overwrite an existing output file, and prints what it wrote. Tests prove the database file is byte-identical afterwards and that no token, secret or key appears in the output.
2. Open the file in a text editor if you wish; it contains account names, permission scopes and plan summaries only.
3. Dashboard → *Credential security* → *Import from the local Python version* → choose the file. The import refuses any file that contains something shaped like a secret.
4. Reconnect Google (*Google connection*), run discovery, and check *Accounts*.

If you only want the allowlist, skip the export: add the account ID by hand under *Accounts → Add by customer ID*.

## Database upgrades inside the cloud edition

The Worker applies `0001_init` and later migrations itself on first use. Rules enforced by tests: only `CREATE … IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN`, `CREATE INDEX IF NOT EXISTS`; no `DROP`, `DELETE`, `UPDATE`, `INSERT`, `REPLACE`, `TRUNCATE`. A test applies the migration to a database that already contains an administrator row and verifies the row survives. Deploying a new version therefore never wipes credentials or approvals.

## Local plugin changes in 0.3.0 (still optional)

- `reset-human`: terminal-only replacement of a lost human credential (see `docs/changes-0.3.0.md` in the plugin).
- `tools/export_legacy.py`.
- Nothing else in the local backend changed; its 148 original tests still pass.
