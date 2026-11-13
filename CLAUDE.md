# CLAUDE.md

Standing rules for all AI-assisted work in this repo.

## What OSFPM is

Self-hosted, API-first film production management: one organisation, many projects.
Every client, including the future web app, uses the same public API.

## Stack

- TypeScript (strict) on Node.js LTS.
- PostgreSQL 16+, and SQLite for small installs; same schema through Drizzle ORM.
- Zod is the single source for validation, types and OpenAPI.
- HTTP framework and web UI are not chosen yet: do not add either until a prompt says so.

## Planned layout

Monorepo under `packages/`: `core`, `api`, `worker`, one package per module, `sdk-ts`, `contracts`.

## Data rules

- IDs are UUIDv7; no auto-increment keys.
- Every record carries `organisation_id`, `origin_server`, `owner_org` and a visibility marker; timestamps are UTC.
- Fields are tagged `normal` or `sensitive`. Sensitive fields never appear in logs, emails, webhook payloads or exports unless a sensitive scope explicitly allows it.
- Migrations are forward-only; never edit an applied migration.
- No legal or financial numbers (rates, caps, thresholds, deadlines) in code: they live in rule packs as data.
- Modules never read other modules' tables; they use core services and events.
- Permission checks run only on the server through the policy engine.
- Every endpoint gets a test proving 403 without access and no sensitive fields without `sensitive:read`.

## Privacy rule

> crew personal data (medical, dietary, accessibility, emergency, IDs, bank, agent) is never returned to users who don't need it, never logged, never emailed.

## Test data

Only the fictional demo production *The Last Withdrawal* or invented data. Never real people's data.

## Workflow

- One prompt = one small PR. Conventional commits, one focused commit per task.
- Run the full test suite before every commit.
- Ask before any change not listed in the prompt, and before adding any dependency the prompt does not name.
- Read only the files a task needs; do not explore the repo for context.
- Open the PR; never merge it.

## Prototype

Read-only reference at tag `prototype-final`. Port only what a prompt names.

## Never commit

`99_INTERNAL_ONLY/`, secrets, `.env` files, or reasons behind business or licensing choices.

## Commands

Added in P-01c.
