# CLAUDE.md

Standing rules for all AI-assisted work in this repo. If a prompt conflicts with this file, this file wins.

## What OSFPM is

Self-hosted, API-first film production management: one organisation, many projects.
Every client, including the future web app, uses the same public API.

## Stack

- TypeScript (strict) on Node.js LTS.
- PostgreSQL 16 or later for standard installs and PGlite for small installs, one Drizzle schema and one migration set.
- Zod is the single source for validation, types and OpenAPI.
- HTTP framework: Fastify 5, in `packages/api`, with `fastify-type-provider-zod` and `@fastify/swagger`. The web UI is not chosen yet: do not add one until a prompt says so.

## Planned layout

Monorepo under `packages/`: `core`, `api`, `worker`, one package per module, `sdk-ts`, `contracts`.

## Data rules

- IDs are UUIDv7; no auto-increment keys.
- Every record carries `organisation_id`, `origin_server`, `owner_org` and a visibility marker; timestamps are UTC.
- Fields are tagged `normal` or `sensitive`. Sensitive fields never appear in logs, emails, webhook payloads, exports, error messages or API error responses unless a sensitive scope explicitly allows it.
- Migrations are forward-only; never edit an applied migration.
- Migrations may contain hand-written SQL (triggers, functions, reordered statements) that drizzle snapshots don't track. Say so in the commit message. Never edit an applied migration.
- Migrations may change metadata of existing rows (retention class, defaults) without audit events; they never change security state (revoke, disable, grant).
- Explicit foreign-key names follow `<table>_<target>_fk`; when a table references itself or the same target twice, use `<table>_<column without _id>_fk`.
- A unique key that includes a nullable column is NULLS NOT DISTINCT unless several NULLs are meant to be allowed; Drizzle can't express it on indexes, so add it by hand in the migration with a comment.
- No legal or financial numbers (rates, caps, thresholds, deadlines) in code: they live in rule packs as data.
- Exception: shipped default values (legal periods, rates) may live in one constant marked `verified: false`, until the rule-pack engine replaces them. Never repeat them elsewhere.
- Money columns are numeric; in TypeScript they are decimal strings, never number. Arithmetic on money happens in the database.
- Modules never read other modules' tables; they use core services and events.
- Tenant records are written only through the write helper in `src/db/write.ts`.
- Tables in `SECURITY_TABLES` are written only by the auth service, never through the write helper; their changes are audited, not change-logged.
- `user` and `installation` are install-level tables, written only by the core services named for them in `SERVICE_WRITTEN_TABLES` (the auth service, which also does first-run setup), never through the write helper; their changes are audited, not change-logged.
- The setup code is the only secret OSFPM prints; it goes to stderr outside the logger.
- Test fixtures may insert rows directly to set up state. Code under test always writes through the write helper.
- A helper that writes records needs at least one test for each kind of table it serves (organisation-level, project-level, and the project table itself).
- Side effects (email, webhooks, notifications, jobs) are only queued inside the write's own transaction; sending happens later in the worker, never in the request path.
- Only `src/sensitive/service.ts` touches `person_sensitive`; other code calls the service.
- Access denials are audited for sensitive data and legal holds; other modules don't audit denials.
- Where a denial is audited, the event is written before the typed error is thrown. Callers catch the error inside the transaction and commit, so the audit event survives.
- Tenant tables are defined with `tenantTable()`, never bare `pgTable`.
- Permission checks run only on the server through the policy engine.
- Organisation role grants reach projects only with `reach = 'all-projects'`, never for sensitive permissions.
- Every permission-protected endpoint gets a test proving 403 without access and no sensitive fields without `sensitive:read`.
- A self-service endpoint (it acts only on the signed-in user's own account, so there is no permission to lack) gets tests proving 401 without a session, 403 for a foreign `Origin` on a request that changes data, and 403 `account-recovery-required` for a recovery-scope session unless the route says `allowedInRecovery`.
- Public endpoints (`auth: 'none'`) test identical failure answers and their rate limit.
- A string from a caller never indexes a plain object and never goes through `in`. Use Object.hasOwn, a Map, or check it against the constant list first.
- A guard that checks for live rows pointing at a record locks them (FOR UPDATE on the record, FOR SHARE on the reference) so a concurrent write can't slip past it.
- Lock order: take the project's change counter (lockProjectChanges) before any row lock. Every writer follows this order, or concurrent writes can deadlock.

## Code rules

- Routes validate input with Zod schemas and never return core errors directly; the error table in `packages/api/src/errors.ts` maps them.
- The API package never imports drizzle-orm; it calls core services.
- Every new route declares `auth`; the default is `required`. Cookie requests that change data must pass the Origin check.
- Status codes: 401 = not signed in; 403 = signed in but not allowed; 404 for by-id lookups where existence must not leak.
- Login failures always answer the same 401 `sign-in-failed`; never reveal which part failed.
- Log lines use the logger's known keys (req, res, err) or plain scalar fields; never log whole objects or request data.

## Comments and docs

- Comments explain why, not what: the reason, the rule, the edge case. Don't restate the code.
- Every exported function, type and table has a short JSDoc: what it does, who may call it, what it throws, and any permission or privacy rule.
- `src/jsdoc.test.ts` enforces JSDoc on every export.
- Privacy, permission, retention and legal rules name their source (spec section or decision record).
- Hand-written SQL in migrations has a comment above each block saying why it exists.
- Each package and module folder has a short README.md: purpose, main entry points, how to test.
- Update comments in the same commit as the code they describe.

## Privacy rule

> crew personal data (medical, dietary, accessibility, emergency, IDs, bank, agent) is never returned to users who don't need it, never logged, never emailed.

## Test data

Only the fictional demo production _The Last Withdrawal_ or invented data. Never real people's data.

## Workflow

- One prompt = one small PR. Conventional commits, one focused commit per task.
- Branches are named `type/pNN-slug`, for example `docs/p01b-claude-md`.
- British spelling (organisation, licence) in code identifiers and docs.
- Run the full test suite before every commit.
- Tests that pin a list (audit categories, routes, errors, throttle) change in the same commit as the list.
- Before deliberately breaking code to check that a test catches it, commit or stash your work first, and undo the break with git, not by copying a backup file back.
- If `node -v` does not match `.nvmrc`, or `pnpm` will not run, stop and tell the maintainer. Do not run the tools another way.
- Ask before any change not listed in the prompt, and before adding any dependency the prompt does not name.
- Read only the files a task needs; do not explore the repo for context.
- Open the PR; never merge it.
- After a PR merges: GitHub deletes the remote branch automatically; delete the local branch with `git branch -d`.
- Report back after every prompt: what was done, anything surprising, and rules you think are missing (as questions, not edits).

## Prototype

Read-only reference at tag `prototype-final`. Port only what a prompt names.

## Never commit

`99_INTERNAL_ONLY/`, secrets, `.env` files, or reasons behind business or licensing choices.

## Commands

- Install: `pnpm install`
- Test: `pnpm test` (PGlite only)
- Test on PostgreSQL too: `DATABASE_URL=postgres://user:pass@host:5432/postgres pnpm test`; tests create and drop their own throwaway databases.
- No local PostgreSQL? See "Run the tests with Docker" in `README.md`.
- Start the API (development): `OSFPM_DATA_DIR=./data pnpm --filter @osfpm/api start` for PGlite, or `DATABASE_URL=postgres://user:pass@host:5432/dbname pnpm --filter @osfpm/api start` for PostgreSQL; settings are in `packages/api/README.md`
- Test the API only: `pnpm test packages/api` (it runs on PGlite, and on PostgreSQL too when `DATABASE_URL` is set)
- Lint: `pnpm lint`
- Format: `pnpm format` (check only: `pnpm format:check`)
- Typecheck: `pnpm typecheck`
- Node and pnpm versions: `.nvmrc` and `packageManager` in root `package.json` are the only source; don't repeat version numbers elsewhere.
