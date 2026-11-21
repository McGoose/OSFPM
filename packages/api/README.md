# @osfpm/api

The HTTP API of OSFPM. Every client, including the future web app, uses this one public API. It is built on Fastify 5, with Zod as the single source for validation, types and the OpenAPI document.

This is the skeleton: configuration, logging, error mapping, health and meta routes and the OpenAPI document. There is **no authentication and no data route yet**, so do not expose it beyond your own machine.

## Run it

Set exactly one database setting, then start the server from the repository root:

```sh
# Small install: PGlite, stored in a directory
OSFPM_DATA_DIR=./data pnpm --filter @osfpm/api start

# Standard install: PostgreSQL 16 or later
DATABASE_URL=postgres://osfpm:<password>@127.0.0.1:5432/osfpm pnpm --filter @osfpm/api start
```

Then ask it something:

```sh
curl http://127.0.0.1:3000/api/v1/health
curl http://127.0.0.1:3000/api/v1/meta
```

The server does not run migrations: it opens whatever database it is given. `Ctrl+C` or `SIGTERM` stops it in order: it stops accepting requests, lets requests in flight finish, closes the app, closes the database, then exits with code 0. A second signal during shutdown is ignored, and if shutdown takes longer than ten seconds the process exits with code 1. A PGlite data directory that cannot be opened stops the start with an error. An unreachable PostgreSQL server does not: the server starts and `/health/ready` answers 503 until the database does.

`start` runs the TypeScript source through `tsx`, a development-only dependency. Production runs compiled JavaScript; the build step and an exports map for the core come with the production image.

## Configuration

Read from the environment when the server starts and validated with Zod. An invalid setting stops the process with a message that names the variable and the rule. It never prints a value, because `DATABASE_URL` holds a password.

| Variable         | Default     | Meaning                                                                                             |
| ---------------- | ----------- | --------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`   | none        | PostgreSQL connection URL (`postgres://` or `postgresql://`). Set this **or** `OSFPM_DATA_DIR`      |
| `OSFPM_DATA_DIR` | none        | Data directory for PGlite, for small installs. Set this **or** `DATABASE_URL`; both or neither fail |
| `HOST`           | `127.0.0.1` | Address to listen on                                                                                |
| `PORT`           | `3000`      | Port to listen on, digits only, 0 to 65535 (`0` lets the system choose)                             |
| `LOG_LEVEL`      | `info`      | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`                                      |

An empty variable counts as not set.

## Routes

All routes are under `/api/v1`. None needs authentication yet.

| Route                      | Answer                                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/health`       | `200 {"status":"ok"}`: the process is alive                                                               |
| `GET /api/v1/health/ready` | `200 {"status":"ready"}` when the database answers a trivial query, else a 503                            |
| `GET /api/v1/meta`         | Product name (`OSFPM`), package name and version, API version `v1`, and the database kind. Nothing secret |
| `GET /api/v1/openapi.json` | The OpenAPI 3.1 document, generated from the Zod route schemas. There is no web UI                        |

Every response carries an `X-Request-Id` header: a UUIDv7 made by the server. An ID sent by the caller is ignored.

## Errors

Every error is `application/problem+json` (RFC 9457) with `type` (`/problems/<code>`), `title`, `status`, `detail`, `instance` (the request path, without its query), `requestId` and `code`. `detail` is fixed, safe text.

The one table in `src/errors.ts` (`PROBLEM_TABLE`) maps core errors by class:

| Error                                                                                  | Status |
| -------------------------------------------------------------------------------------- | ------ |
| Request validation (Zod); lists the failing field paths, never the values              | 400    |
| `AccessDeniedError` and the other access-denied errors                                 | 403    |
| `RecordNotFoundError`, and an unknown route                                            | 404    |
| `VersionConflictError`, `RecordStateError` and its subclasses                          | 409    |
| The module input errors, such as `ContractInputError` and `CostLineInputError`         | 422    |
| The service cannot answer, such as the database being down                             | 503    |
| Anything else, including `RecordWriteError`: a generic message and the request ID only | 500    |

Fastify's own refusals of a malformed request (bad JSON, a body over the limit, an unsupported media type, a malformed URL) are 400, 413 and 415 problems with fixed text.

`INTERNAL_ERRORS` in the same file lists the core errors that are meant to be a 500, with the reason. A test fails when a core error class is in neither list, so a new module cannot forget to decide.

## Logging

One line per request, written when the response is sent: method, route pattern, status code, duration and request ID. A line never holds a URL, a query, a path parameter, a header or a body, so a `token` in a query string or an `authorization` header cannot reach it. Errors are logged by class name and request ID, never by message. If a handler writes a line by hand, every key named like a `token`, and `authorization`, `cookie` and `set-cookie`, is masked at any depth; a token-named query parameter inside a string is masked; and a request or reply object is logged as its class name only. A line never takes its message from an error, because Fastify's own warnings quote the whole URL there (CLAUDE.md, Privacy rule).

The caller of `buildApp` chooses only the level and the destination. What a line may hold is fixed in `src/logging.ts`.

## Add a route plugin

Each area of the API is a Fastify plugin. A module adds its own and registers it in `buildApp`; it never edits another area's plugin.

1. Create `src/routes/<area>.ts` (or a folder). Validate every input with a Zod schema and describe each response with one. The OpenAPI document is generated from them.

   ```ts
   import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
   import { z } from 'zod';

   export const exampleRoutes: FastifyPluginAsyncZod = (app) => {
     app.get(
       '/examples/:id',
       {
         schema: {
           params: z.object({ id: z.uuid() }),
           response: { 200: z.object({ id: z.uuid(), name: z.string() }) },
         },
       },
       async (request) => {
         // `findExample` stands in for a core service, which takes app.db.
         // Do not catch its errors: let them go, and the error table maps them.
         return findExample(app.db.db, request.params.id);
       },
     );
     return Promise.resolve();
   };
   ```

2. Add one line to `buildApp` in `src/app.ts`, next to the others: `void app.register(exampleRoutes, { prefix: API_PREFIX });`

3. If the module defines error classes, add a row for each to `PROBLEM_TABLE` in `src/errors.ts` (or an entry with a reason to `INTERNAL_ERRORS`). A row either states its own `detail` or passes on the error's message, and only an error whose documentation says its message holds no ids and no values may do that.

4. Test it with `app.inject()` (see below). CLAUDE.md requires, for every endpoint, a test that it answers 403 without access and returns no sensitive fields without `sensitive:read`.

Import core code by path, for example `@osfpm/core/src/db/write.js`: the core has no build step yet and its package index exports only a placeholder.

## Folder map

| Path                  | What it holds                                                             |
| --------------------- | ------------------------------------------------------------------------- |
| `src/server.ts`       | The entry: config, database, app, listen, graceful shutdown               |
| `src/app.ts`          | `buildApp`, which returns the Fastify instance without listening          |
| `src/config.ts`       | Environment variables validated with Zod                                  |
| `src/errors.ts`       | The error table and the problem responses                                 |
| `src/logging.ts`      | The privacy rules for log lines                                           |
| `src/routes/`         | One plugin per area: health, meta, openapi                                |
| `src/test-support.ts` | `createTestApp`, a test app on a throwaway database. Only tests import it |

## Tests

From the repository root:

```sh
pnpm test packages/api
```

They use `app.inject()`, so no port is opened. They run on PGlite always and on PostgreSQL as well when `DATABASE_URL` is set (see the main `README.md`). `src/jsdoc.test.ts` in the core package also fails when an export in this package has no JSDoc.

Test data is the fictional production _The Last Withdrawal_ or invented values, never real people's data.
