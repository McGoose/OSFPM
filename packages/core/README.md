# @osfpm/core

The database layer and shared services of OSFPM: schema, write helper, access checks, login building blocks, sensitive data, production structure, retention, legal holds, contracts, charts of accounts and cost lines. Other modules and the future API build on it. They use its services and events and never read each other's tables.

`src/index.ts` exports only a placeholder version constant today. Import from the module folders by path.

## Folder map

| Path                | What it holds                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| `src/db/`           | Clients, the Drizzle schema, the write helper and the column conventions                          |
| `src/access/`       | Permission checks, `AccessDeniedError` and `PERMISSION_LISTS`, the registry of permissions        |
| `src/auth/`         | Login building blocks (tokens, passwords, sessions, recovery and setup codes) and first-run setup |
| `src/installation/` | This server's own id, from the single `installation` row                                          |
| `src/members/`      | The permissions to list members, invite people and reset locked-out members' access               |
| `src/sensitive/`    | The one door to crew personal data, access needs included: profiles and grants per field and role |
| `src/projects/`     | `createProject`, which also creates the main unit                                                 |
| `src/retention/`    | Retention classes' shipped periods and the end-date calculation                                   |
| `src/legal-hold/`   | Placing, releasing and checking legal holds                                                       |
| `src/contracts/`    | The contracts registry, with amounts hidden from those without `contracts:read-value`             |
| `src/accounts/`     | Charts of accounts: organisation templates, project copies and their account trees                |
| `src/costs/`        | Cost lines and incentive scheme tags, with amounts hidden from those without `costs:read`         |
| `migrations/`       | Forward-only SQL migrations and Drizzle snapshots. Never edit one that has been applied           |
| `drizzle.config.ts` | Drizzle Kit settings; the `db:generate` script writes a migration from the schema                 |

Each module folder has its own README with entry points and the rules that apply to it. The rules for all code are in `CLAUDE.md` at the repository root.

## Running the tests

Run these from the repository root. By default the tests run on PGlite, in memory:

```sh
pnpm test
```

To run them on PostgreSQL as well, point `DATABASE_URL` at a server. Each test creates its own throwaway database and drops it afterwards, so existing data is never touched:

```sh
DATABASE_URL=postgres://user:pass@host:5432/postgres pnpm test
```

Add part of a file path to run a subset, for example `pnpm test retention`. Before a commit also run `pnpm typecheck`, `pnpm lint` and `pnpm format:check`.

`src/jsdoc.test.ts` fails when an export under this package's `src/` or under `packages/api/src/` has no JSDoc, so a new export needs its comment in the same commit.

Test data is the fictional production _The Last Withdrawal_ or invented values, never real people's data.
