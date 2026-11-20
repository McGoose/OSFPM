# OSFPM

![Licence: AGPL-3.0-only](https://img.shields.io/badge/licence-AGPL--3.0--only-blue)

OSFPM is a self-hosted, API-first film production management system that one organisation runs for many film projects.

## Status

Rewrite in progress. The prototype is preserved at tag `prototype-final` and branch `prototype-archive`.

## Run the tests with Docker

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

## Licence

SPDX-License-Identifier: `AGPL-3.0-only`. The full text is in [LICENSE](LICENSE).

## Security

Security: see `SECURITY.md`.
