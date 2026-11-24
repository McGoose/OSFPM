# installation

This server's own identity. The `installation` table holds one row, made when the server first starts (`ensureInstallation`, in `src/auth/`), and its `id` is the id of this server. First-run setup later sets `setup_completed_at` on it. `server_public_key` is the public half of the server's Ed25519 identity key, stored the first time the server starts with that key and never replaced (`bindServerKeys`, in `src/auth/`; the key files are in `src/keys/`).

**Entry points**

- `getServerId(tx)` returns the id of this server, for `origin_server` on a record and `originServer` on a `WriteContext`. It throws `InstallationMissingError` before the row exists. Other code asks this function; it does not select from `installation` itself.

**Rules you must not break**

- The id never changes once the row exists, so a caller may keep it. The same goes for `server_public_key` once it is set: a key directory with another identity key stops the server instead.
- `installation` is written only by the core services named in `SERVICE_WRITTEN_TABLES` (the auth service: `ensureInstallation` at start-up and `completeFirstRunSetup`), never through the write helper. This folder only reads it.
- Pass `lock: true` only from a service that serialises on the installation row, such as the setup code. A plain read must not hold a row.

**Tests:** `pnpm test packages/core/src/installation` runs `server-id.test.ts`, on PGlite, and on PostgreSQL too when `DATABASE_URL` is set.
