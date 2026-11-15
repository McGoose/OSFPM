# CLAUDE.md

Standing rules for all AI-assisted work in this repo. If a prompt conflicts with this file, this file wins.

## What OSFPM is

Self-hosted, API-first film production management: one organisation, many projects.
Every client, including the future web app, uses the same public API.

## Stack

- TypeScript (strict) on Node.js LTS.
- PostgreSQL 16 or later for standard installs and PGlite for small installs, one Drizzle schema and one migration set.
- Zod is the single source for validation, types and OpenAPI.
- HTTP framework and web UI are not chosen yet: do not add either until a prompt says so.

## Planned layout

Monorepo under `packages/`: `core`, `api`, `worker`, one package per module, `sdk-ts`, `contracts`.

## Data rules

- IDs are UUIDv7; no auto-increment keys.
- Every record carries `organisation_id`, `origin_server`, `owner_org` and a visibility marker; timestamps are UTC.
- Fields are tagged `normal` or `sensitive`. Sensitive fields never appear in logs, emails, webhook payloads, exports, error messages or API error responses unless a sensitive scope explicitly allows it.
- Migrations are forward-only; never edit an applied migration.
- Migrations may contain hand-written SQL (triggers, functions, reordered statements) that drizzle snapshots don't track. Say so in the commit message. Never edit an applied migration.
- Explicit foreign-key names follow `<table>_<target>_fk`; when a table references itself or the same target twice, use `<table>_<column without _id>_fk`.
- No legal or financial numbers (rates, caps, thresholds, deadlines) in code: they live in rule packs as data.
- Exception: shipped default values (legal periods, rates) may live in one constant marked `verified: false`, until the rule-pack engine replaces them. Never repeat them elsewhere.
- Modules never read other modules' tables; they use core services and events.
- Tenant records are written only through the write helper in `src/db/write.ts`.
- Test fixtures may insert rows directly to set up state. Code under test always writes through the write helper.
- A helper that writes records needs at least one test for each kind of table it serves (organisation-level, project-level, and the project table itself).
- Only `src/sensitive/service.ts` touches `person_sensitive`; other code calls the service.
- Access denials are audited before the typed error is thrown; callers catch it inside the transaction and commit, so the audit event survives.
- Tenant tables are defined with `tenantTable()`, never bare `pgTable`.
- Permission checks run only on the server through the policy engine.
- Every endpoint gets a test proving 403 without access and no sensitive fields without `sensitive:read`.
- A string from a caller never indexes a plain object and never goes through `in`. Use Object.hasOwn, a Map, or check it against the constant list first.

## Comments and docs

- Comments explain why, not what: the reason, the rule, the edge case. Don't restate the code.
- Every exported function, type and table has a short JSDoc: what it does, who may call it, what it throws, and any permission or privacy rule.
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
- Lint: `pnpm lint`
- Format: `pnpm format` (check only: `pnpm format:check`)
- Typecheck: `pnpm typecheck`
- Node and pnpm versions: `.nvmrc` and `packageManager` in root `package.json` are the only source; don't repeat version numbers elsewhere.
