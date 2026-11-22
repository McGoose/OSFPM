# OSFPM

![Licence: AGPL-3.0-only](https://img.shields.io/badge/licence-AGPL--3.0--only-blue)

OSFPM is a self-hosted, API-first film production management system that one organisation runs for many film projects. Every client, including the future web app, uses the same public API.

## Status

Phase 1. The core data model is done: the database schema and its services in `packages/core`. The API skeleton has started in `packages/api`: configuration, logging, error responses and health, meta and OpenAPI routes. It has no authentication and no data routes yet.

Nothing is usable by productions yet.

The earlier prototype is preserved at tag `prototype-final` and branch `prototype-archive`.

## Repository layout

| Path            | What it holds                                                                                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core` | The database layer and shared services: schema and migrations, the write helper, access checks, sensitive data, production structure, retention, legal holds, contracts, accounts, cost lines |
| `packages/api`  | The HTTP API, built on Fastify: configuration, error responses, health, meta and OpenAPI routes                                                                                               |
| `compose.yaml`  | A local PostgreSQL 16 with a persistent volume, and a one-off test runner                                                                                                                     |
| `Dockerfile`    | The image that runs the test suite                                                                                                                                                            |
| `.github/`      | The CI and CLA workflows                                                                                                                                                                      |
| `CLAUDE.md`     | The standing rules for AI-assisted work in this repository                                                                                                                                    |

Each package has its own `README.md` with its entry points and how to test it.

## Requirements

- Node.js: the version in `.nvmrc`.
- pnpm: the version in the `packageManager` field of the root `package.json`.
- PostgreSQL 16 or later for a standard install. Small installs use PGlite and need nothing extra.

Then install the dependencies:

```sh
pnpm install
```

## Run the tests

By default the tests run on PGlite, in memory:

```sh
pnpm test
```

To run them on PostgreSQL as well, point `DATABASE_URL` at a server. Each test creates its own throwaway database and drops it afterwards, so existing data is never touched:

```sh
DATABASE_URL=postgres://user:pass@host:5432/postgres pnpm test
```

Add part of a file path to run a subset, for example `pnpm test packages/api`. Before a commit also run `pnpm typecheck`, `pnpm lint` and `pnpm format:check`.

Test data is the fictional production _The Last Withdrawal_ or invented values, never real people's data.

### Run the tests with Docker

The test suite runs against PGlite and, when `DATABASE_URL` is set, against PostgreSQL 16 as well. Docker gives you the PostgreSQL 16 half without installing PostgreSQL.

First copy `.env.example` to `.env` and set `POSTGRES_PASSWORD`. `.env` is never committed.

```sh
docker compose up -d db                 # start the database
docker compose run --rm --build test    # run the full suite in a container
docker compose down                     # stop (data is kept in the volume)
docker compose down -v                  # stop and DELETE the database volume
```

To run `pnpm test` on your own machine against the same container, start the database and point `DATABASE_URL` at it. The database is bound to `127.0.0.1` only, on `POSTGRES_PORT` (default 5432):

```sh
DATABASE_URL=postgres://osfpm:<POSTGRES_PASSWORD>@127.0.0.1:5432/osfpm pnpm test
```

The tests create and drop their own throwaway databases on that server and never touch the `osfpm` database itself.

Troubleshooting:

- Every `docker compose` command, including `down`, needs a `.env` with `POSTGRES_PASSWORD` set.
- If you change `POSTGRES_PASSWORD` after the first start, run `docker compose down -v` first. This deletes the database volume, and the test database with it.

## Start the API

Set exactly one database setting, and `OSFPM_PUBLIC_URL`, the URL you open the server at: the address alone, with no path, query or fragment. Keep it on your own machine until you have set up and secured it.

```sh
# Small install: PGlite, stored in a directory
OSFPM_PUBLIC_URL=http://localhost:3000 OSFPM_DATA_DIR=./data pnpm --filter @osfpm/api start

# Standard install: PostgreSQL
OSFPM_PUBLIC_URL=https://osfpm.example.org DATABASE_URL=postgres://user:pass@host:5432/dbname pnpm --filter @osfpm/api start
```

Then:

```sh
curl http://127.0.0.1:3000/api/v1/health
```

The server applies pending migrations when it starts; set `OSFPM_AUTO_MIGRATE=false` to stop that.

**First run.** On a fresh install the server also prints a **setup code** to standard error, in a marked block outside the logs. It is the only secret OSFPM prints, it works once, for 24 hours, and a restart prints a new one and revokes the old. Whoever enters it creates the first organisation and its administrator (`POST /api/v1/setup`, with `POST /api/v1/setup/check` to check the code first); until then every route but the health and meta routes answers 503 `setup-required`. See "First run" in [packages/api/README.md](packages/api/README.md). The settings, the routes and how to add one are in [packages/api/README.md](packages/api/README.md).

**Add more people.** The administrator makes an **invite link** (`POST /api/v1/organisations/:organisationId/invites`, which needs the `members:invite` permission the Administrator role has) and passes it on by chat, text or their own email: OSFPM sends no email. The link is shown once, in that response, and looks like `https://osfpm.example.org/invite#<token>`. The token is after the `#`, so a browser never sends it to a server or a proxy; the web app, which comes later, reads it and calls `POST /api/v1/invites/inspect` and `/accept`. An invite can give only the permissions its maker holds, and works once, for 7 days unless the maker chooses 1 to 30. Whoever opens the link joins the organisation, with a new account or an existing one. See "Invite links" in [packages/api/README.md](packages/api/README.md).

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) first. Every contributor signs the Contributor Licence Agreement ([CLA.md](CLA.md)) once, on their first pull request. Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Never report a security issue in a public issue or pull request. See [SECURITY.md](SECURITY.md).

## Licence

SPDX-License-Identifier: `AGPL-3.0-only`. The full text is in [LICENSE](LICENSE).
