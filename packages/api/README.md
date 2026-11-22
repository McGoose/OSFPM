# @osfpm/api

The HTTP API of OSFPM. Every client, including the future web app, uses this one public API. It is built on Fastify 5, with Zod as the single source for validation, types and the OpenAPI document.

What is here: configuration, start-up (migrations and the permission catalogue), logging, error mapping, health and meta routes, the OpenAPI document, authentication of a signed-in user by session cookie, with four routes for that user's own sessions, sign-in by password (with an optional authenticator code), by recovery code or by passkey, five routes to secure the account, and five to add, list, rename and revoke passkeys. First-run setup and invites come in P-03b4, and API tokens in P-03b5. Users cannot be created through the API yet, so only a user made another way can sign in, and there is no data route. Do not expose it beyond your own machine.

## Run it

Set exactly one database setting and `OSFPM_PUBLIC_URL`, then start the server from the repository root:

```sh
# Small install: PGlite, stored in a directory
OSFPM_PUBLIC_URL=http://localhost:3000 OSFPM_DATA_DIR=./data pnpm --filter @osfpm/api start

# Standard install: PostgreSQL 16 or later
OSFPM_PUBLIC_URL=https://osfpm.example.org DATABASE_URL=postgres://osfpm:<password>@127.0.0.1:5432/osfpm pnpm --filter @osfpm/api start
```

Then ask it something:

```sh
curl http://127.0.0.1:3000/api/v1/health
curl http://127.0.0.1:3000/api/v1/meta
```

`Ctrl+C` or `SIGTERM` stops it in order: it stops accepting requests, lets requests in flight finish, closes the app, closes the database, then exits with code 0. A second signal during shutdown is ignored, and if shutdown takes longer than ten seconds the process exits with code 1.

`start` runs the TypeScript source through `tsx`, a development-only dependency. Production runs compiled JavaScript; the build step and an exports map for the core come with the production image.

## Start-up

The server does this, in this order:

1. Opens the database. A PGlite data directory that cannot be opened stops the start.
2. **Listens.** From here a supervisor's probe finds a live process.
3. Runs pending migrations, unless `OSFPM_AUTO_MIGRATE` is `false`. With it off, the database must already be migrated, or step 4 fails.
4. Syncs the permission catalogue: every `*_PERMISSIONS` list the core declares goes into the `permission` table, in one transaction, so all of them or none. The core owns the list of lists (`PERMISSION_LISTS` in `packages/core/src/access/permission-lists.ts`) and the API imports it; a core test fails when a module declares one that is not in it.
5. Opens every route.

**While it starts (steps 3 and 4),** `GET /health` answers 200, `GET /health/ready` answers 503, and every other route answers a 503 problem `starting`: the same for a caller with a cookie and one without, before the session, the Origin or the rate limit are looked at, because the database may not be migrated or reachable yet. An unknown path is still a 404. A route that does not say `config: { availableWhileStarting: true }` waits, so a new route cannot be open by accident; only the two health routes say it. `/health/ready` keeps answering 503 after that until a trivial query to the database is answered.

**If the database cannot be reached** (the connection is refused, reset or times out, the host is not found, or PostgreSQL is starting up or shutting down), the server does not exit. It tries steps 3 and 4 again after a wait of one second, doubling after each failure up to thirty seconds, for as long as it takes (`STARTUP_RETRY` in `src/startup.ts`), and stays at 503. It writes one warning line per attempt: the attempt number, the wait, the error's class and its short system code, such as `ECONNREFUSED`. A line never holds the host, the URL or the password. Migrations are safe to run again. A stop signal ends the waiting at once.

**Any other failure stops start-up.** A wrong password, a database that does not exist, a failed migration and a `PermissionSyncError` are not cured by waiting. The server writes one log line with no request in it that holds the error's class name only, prints a message and exits with code 1. A `PermissionSyncError` (a permission was flagged sensitive while an organisation role still holds an `all-projects` grant of it) prints its own message, which names the permission and the roles and says how to fix it, and no stack. Any other failure prints a generic line with the error's class name and system code: driver messages can hold SQL and connection details.

## Configuration

Read from the environment when the server starts and validated with Zod. An invalid setting stops the process with a message that names the variable and the rule. It never prints a value, because `DATABASE_URL` holds a password.

| Variable                | Default     | Meaning                                                                                                                                                                                                                                  |
| ----------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`          | none        | PostgreSQL connection URL (`postgres://` or `postgresql://`). Set this **or** `OSFPM_DATA_DIR`                                                                                                                                           |
| `OSFPM_DATA_DIR`        | none        | Data directory for PGlite, for small installs. Set this **or** `DATABASE_URL`; both or neither fail                                                                                                                                      |
| `OSFPM_PUBLIC_URL`      | none        | **Required.** The URL users open: `https://…`, or `http://localhost` or `http://127.0.0.1` with any port. Its origin is the only `Origin` a request with a session cookie may have                                                       |
| `OSFPM_AUTO_MIGRATE`    | `true`      | Run pending migrations at start-up. `true` or `false`, in any case; anything else is refused                                                                                                                                             |
| `OSFPM_TRUSTED_PROXIES` | none        | Off by default. The reverse proxies whose `X-Forwarded-For` is believed: a comma-separated list of IP addresses, CIDR ranges, or the names `loopback`, `linklocal` and `uniquelocal`. Never a host name, and never a range of everything |
| `HOST`                  | `127.0.0.1` | Address to listen on                                                                                                                                                                                                                     |
| `PORT`                  | `3000`      | Port to listen on, digits only, 0 to 65535 (`0` lets the system choose)                                                                                                                                                                  |
| `LOG_LEVEL`             | `info`      | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`, in any case                                                                                                                                                              |

An empty variable counts as not set. Plain `http` is refused for any host but `localhost` and `127.0.0.1`, because the session cookie is `Secure`. The host is compared after the URL is parsed, so `http://localhost.example.org` is refused.

**The public URL is also the passkey's relying party.** The host name of `OSFPM_PUBLIC_URL` is the id a browser ties every passkey to, and its origin is the only origin a passkey ceremony may happen on. **Changing the host makes every existing passkey unusable**: the people who used one have to sign in another way (a password or a recovery code) and add their passkeys again. Changing only the scheme, the port or the path does not. An IP address cannot be a relying party id, so passkeys need a host name; use `http://localhost:<port>` for development, and not `http://127.0.0.1`.

## Authentication

A signed-in user is a session cookie, `__Host-osfpm_session`. The auth plugin (`src/auth/plugin.ts`) runs on every request before the body is read: it reads the cookie, asks the core's `validateSession`, and puts the result on `request.auth` with a core `WriteContext` whose actor is the user (`request.auth.context`). A cookie that is invalid, expired or revoked, or belongs to a disabled user, is treated as no session and the response clears it.

**The `auth` route option.** Every route declares how it treats a session, in its route `config`:

| `config.auth`          | Meaning                                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `'required'` (default) | A valid session, or a 401. A route that says nothing is `required`, and so is any value the plugin does not know        |
| `'optional'`           | A valid session is used if there is one. None is not an error                                                           |
| `'none'`               | The route does not use the session. Cookies are ignored: no lookup, no clearing, no origin check. Health, meta, OpenAPI |

A `required` route without a valid session answers **401** `authentication-required`, with the same text whatever the reason: no cookie, an unknown token, an expired or revoked session, a disabled user. A response never says which. The plugin does not touch an unknown route, which is a 404.

**The cross-site check (CSRF).** A `POST`, `PUT`, `PATCH` or `DELETE` that carries a session cookie must have an `Origin` header equal to the origin of `OSFPM_PUBLIC_URL`, written as a browser writes it (scheme, host and port, no path). A missing or different `Origin` is a **403** `origin-mismatch`. It is checked before the session is looked up, so a cross-site caller learns nothing about whether its cookie was good. A request with no session cookie is not checked, since there is nothing to borrow; API tokens, which come in P-03b5, will authenticate those another way. Safe methods are not checked.

**The recovery scope.** A session a recovery code opens has the scope `recovery`, not `full`. It may only call a route that says `config: { allowedInRecovery: true }`: `me`, `logout`, the five routes that set a new way to sign in and the two that add a passkey (see Routes). Any other route, whatever its `auth` mode but `none`, answers **403** `account-recovery-required`: so do the routes that list, rename and revoke passkeys. A route is closed to such a session unless it says otherwise, so a new route cannot be open to it by accident. It is checked after the cross-site check and the limit per session, so a forged request learns nothing about the scope. Setting a new password, confirming an authenticator app or adding a passkey makes the session `full`.

**The cookie.** When a login route sets it: `__Host-` prefix, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, no `Domain`, and `Expires` set to the session's absolute expiry (`setSessionCookie` in `src/auth/cookie.ts`). Logout and an invalid cookie clear it with the same attributes, which a `__Host-` cookie needs to be replaced. A browser that does not treat `http://localhost` as a secure context will not keep it there; Chrome and Firefox do. The raw token is never logged, returned after it is set, or stored: the log scrubber masks the cookie name as a key and as text.

**Rate limits.** There are three, for three different jobs. Past any of them, the answer is **429** `rate-limited` with `Retry-After` in seconds.

- **A coarse limit on every route** (`ADDRESS_RATE_LIMIT` in `src/auth/rate-limit.ts`): at most 300 requests per minute **per address**, counted together across every route except `/health` and `/health/ready`, which say `exemptFromAddressRateLimit` so that a supervisor can always probe, even a busy address. A request for a path that is no route counts too: it still costs a request and a log line. It is counted before anything else, **before the session is looked up**, so a flood with no session, or a wrong one, costs the server a count and no database query. It is far above what a client needs; the other two shape use. While the server is still starting, a request is a 503 `starting` first and is not counted.
- **For routes that check a secret** (`config: { authRateLimit: true }`): at most 10 requests per minute **per address** (`AUTH_RATE_LIMIT` in `src/auth/rate-limit.ts`), counted together across every such route. This one is for guessing: the five login routes set it (password, authenticator code, recovery code, and the two requests of a passkey sign-in, which all count together), and setup and invites will. It is counted right after the coarse limit and before the session is looked up, so a caller with no session, a wrong one or a foreign `Origin` is limited too.
- **For routes a signed-in client uses as it goes** (`config: { sessionRateLimit: true }`): at most 120 requests per minute **per session** (`SESSION_RATE_LIMIT`), counted together across those routes, whatever the address. `me`, `sessions`, `logout`, the five account routes and the five passkey routes set it. It is counted once the session is known and the `Origin` has passed, so a forged request does not spend the session's own. A request with no valid session is not counted: it is a 401 and has no session to count against.

The counts are kept in this process's memory (`@fastify/rate-limit`'s local store). Several API instances each keep their own, so a limit becomes the limit times the number of instances until they share a store.

**Behind a reverse proxy,** set `OSFPM_TRUSTED_PROXIES`. By default the server believes no header and takes the address of the connection, so every caller behind a proxy is the proxy, and the limits per address are one limit for all of them. With the proxies listed, the server reads `X-Forwarded-For` from a connection that comes from one of them, takes the first address from the right that is not a proxy, and ignores anything a client wrote to the left of it. A connection from anywhere else is never believed, so a caller cannot change its address by sending the header. List only the proxies in front of the server. A range of everything (`/0`) is refused, because it would believe any caller.

## Routes

All routes are under `/api/v1`.

| Route                                         | Auth                                                           | Answer                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/health`                          | none                                                           | `200 {"status":"ok"}`: the process is alive, also while it starts                                                                                                                                                                                                                                                                                              |
| `GET /api/v1/health/ready`                    | none                                                           | `200 {"status":"ready"}` when start-up has finished and the database answers a trivial query, else a 503                                                                                                                                                                                                                                                       |
| `GET /api/v1/meta`                            | none                                                           | Product name (`OSFPM`), package name and version, API version `v1`, and the database kind. Nothing secret                                                                                                                                                                                                                                                      |
| `GET /api/v1/openapi.json`                    | none                                                           | The OpenAPI 3.1 document, generated from the Zod route schemas. There is no web UI                                                                                                                                                                                                                                                                             |
| `GET /api/v1/auth/me`                         | required, 120 a minute per session                             | `{ id, displayName, email, status }` of the signed-in user                                                                                                                                                                                                                                                                                                     |
| `GET /api/v1/auth/sessions`                   | required, 120 a minute per session                             | The user's live sessions, most recently seen first: `id`, `method`, `createdAt`, `lastSeenAt`, `idleExpiresAt`, `absoluteExpiresAt`, `userAgentSummary` and `current` (true for the session asking). Never a token or a hash                                                                                                                                   |
| `DELETE /api/v1/auth/sessions/:id`            | required, 120 a minute per session                             | Ends one of the user's own live sessions (reason `user-revoked`), 204. Another user's session, an unknown id and one already over all give the same 404                                                                                                                                                                                                        |
| `POST /api/v1/auth/logout`                    | required, 120 a minute per session                             | Ends the session in the cookie (reason `logout`), clears the cookie, 204. The user's other sessions stay                                                                                                                                                                                                                                                       |
| `POST /api/v1/auth/login/password`            | none, 10 a minute per address                                  | `{ email, password }`. Without a confirmed authenticator app: 200 `{ user }` and the session cookie (method `password`). With one: 200 `{ next: "totp", challenge }` and no session. Every failure is 401 `sign-in-failed`                                                                                                                                     |
| `POST /api/v1/auth/login/totp`                | none, 10 a minute per address                                  | `{ challenge, code }`. 200 `{ user }` and the session cookie (method `password+totp`). A challenge works once, for five minutes and five code attempts. Every failure is 401 `sign-in-failed`                                                                                                                                                                  |
| `POST /api/v1/auth/login/recovery`            | none, 10 a minute per address                                  | `{ email, code }`. 200 `{ user, mustSecureAccount: true }` and a session cookie (method `recovery`, scope `recovery`). The code is used up and the user's other sessions are ended. Every failure is 401 `sign-in-failed`                                                                                                                                      |
| `PUT /api/v1/auth/password`                   | required, 120 a minute per session, open to a recovery session | `{ currentPassword?, newPassword }`, 204. The password policy gives 422 `password-refused` with the reason in `errors[0].code`. Changing a password needs `currentPassword` (403 `current-password-incorrect`) unless the user has none, must change it, or the session is a recovery session. Ends the user's other sessions; a recovery session becomes full |
| `POST /api/v1/auth/totp/enrol`                | required, 120 a minute per session, open to a recovery session | 200 `{ secret, otpauthUri }`, shown once and uncached. A secret never confirmed is replaced. 409 `totp-already-enrolled` once one is confirmed                                                                                                                                                                                                                 |
| `POST /api/v1/auth/totp/confirm`              | required, 120 a minute per session, open to a recovery session | `{ code }`, 204. 422 `totp-code-incorrect`; 409 `totp-not-set-up` or `totp-already-enrolled`. A recovery session becomes full                                                                                                                                                                                                                                  |
| `DELETE /api/v1/auth/totp`                    | required, 120 a minute per session, open to a recovery session | `{ password }`, 204. 403 `current-password-incorrect`; 409 `totp-not-set-up`. Ends the user's other sessions                                                                                                                                                                                                                                                   |
| `POST /api/v1/auth/recovery-codes`            | required, 120 a minute per session, open to a recovery session | 200 `{ codes }`: ten single-use codes, shown once and uncached. Any earlier set, used or not, stops working                                                                                                                                                                                                                                                    |
| `POST /api/v1/auth/login/passkey/options`     | none, 10 a minute per address                                  | 200 `{ challenge, options }`: a challenge that belongs to no one yet and the options for `navigator.credentials.get()`, which name no credential. Needs no session and no address. Not cached                                                                                                                                                                  |
| `POST /api/v1/auth/login/passkey/verify`      | none, 10 a minute per address                                  | `{ challenge, response }`. 200 `{ user }` and the session cookie (method `passkey`), with no address and no password. The challenge works once, and the first answer that reaches it uses it up. Every failure is 401 `sign-in-failed`                                                                                                                         |
| `POST /api/v1/auth/passkeys/register/options` | required, 120 a minute per session, open to a recovery session | 200 `{ challenge, options }` for `navigator.credentials.create()`: a discoverable credential, verified on the device, no attestation, ES256 or RS256, excluding the user's live passkeys. Not cached                                                                                                                                                           |
| `POST /api/v1/auth/passkeys/register/verify`  | required, 120 a minute per session, open to a recovery session | `{ challenge, response, deviceName? }`, 201 with the passkey. Every refusal is 422 `passkey-registration-failed`. A recovery session becomes full                                                                                                                                                                                                              |
| `GET /api/v1/auth/passkeys`                   | required, 120 a minute per session                             | The user's live passkeys, in the order they were added: `id`, `deviceName`, `createdAt`, `lastUsedAt` and `transports`. Never a credential id, a public key or a sign count                                                                                                                                                                                    |
| `PATCH /api/v1/auth/passkeys/:id`             | required, 120 a minute per session                             | `{ deviceName }`, 200 with the passkey. Another user's passkey, an unknown id and a revoked one give the same 404                                                                                                                                                                                                                                              |
| `DELETE /api/v1/auth/passkeys/:id`            | required, 120 a minute per session                             | Revokes one of the user's passkeys, 204. The same 404 as above. 409 `last-sign-in-method` for a user with no password and no other live passkey                                                                                                                                                                                                                |

The session routes, the account routes and the passkey routes (but for the two sign-in routes) are self-service: each acts on the signed-in user's own account, so there is no permission to lack. Without a session the answer is 401. The 403s are the cross-site check, `account-recovery-required` (a recovery session on a route that is closed to it) and `current-password-incorrect` (a change that needs the current password, which was missing, wrong or throttled: one answer for all three). The only secrets in any response are the ones shown once, in an uncacheable response and never again: an authenticator secret and its address, a challenge, recovery codes, and a session token, which goes only into the cookie.

**Every failed sign-in step answers the same 401 `sign-in-failed`, with one body.** An address no one has, an account with no password, a wrong password, authenticator code or recovery code, a challenge that is unknown, used, over time or out of attempts, a passkey that is unknown, revoked or does not verify, a signature counter that went back, a disabled user and an account closed for a while after five wrong guesses in fifteen minutes cannot be told apart from the answer. A request that is not shaped right stays a 400. The cause is in the audit trail only, as a reason class and never a submitted value. The throttle and the other rules are in `packages/core/src/auth/README.md` and `src/auth/README.md`.

Every response carries an `X-Request-Id` header: a UUIDv7 made by the server. An ID sent by the caller is ignored.

## Errors

Every error is `application/problem+json` (RFC 9457) with `type` (`/problems/<code>`), `title`, `status`, `detail`, `instance` (the request path, without its query), `requestId` and `code`. `detail` is fixed, safe text.

The one table in `src/errors.ts` (`PROBLEM_TABLE`) maps core errors by class:

| Error                                                                                                                                                                                                                                                    | Status |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Request validation (Zod); lists the failing field paths, never the values or a record key (shown as `*`)                                                                                                                                                 | 400    |
| `AuthInputError`: fixed text that names no field and no value                                                                                                                                                                                            | 400    |
| No usable session (`AuthenticationRequiredError`), and `AuthStateError` whatever its reason: one text                                                                                                                                                    | 401    |
| A failed sign-in step (`SignInFailedError`): one fixed body for every cause, never saying which part failed                                                                                                                                              | 401    |
| `AccessDeniedError` and the other access-denied errors                                                                                                                                                                                                   | 403    |
| `OriginMismatchError`: a request that changes data has a session cookie and a wrong or missing `Origin`                                                                                                                                                  | 403    |
| `RecoveryRequiredError`: a session a recovery code opened, on a route closed to it (code `account-recovery-required`)                                                                                                                                    | 403    |
| `CurrentPasswordRejectedError`: the current password was missing, wrong or throttled (code `current-password-incorrect`)                                                                                                                                 | 403    |
| `RecordNotFoundError`, and an unknown route                                                                                                                                                                                                              | 404    |
| `VersionConflictError`, `RecordStateError` and its subclasses                                                                                                                                                                                            | 409    |
| `TotpAlreadyEnrolledError` and `TotpNotSetUpError`: an authenticator app is already confirmed, or there is none to confirm or remove                                                                                                                     | 409    |
| The module input errors, such as `ContractInputError` and `CostLineInputError`                                                                                                                                                                           | 422    |
| `PasswordRefusedError`: the new password fails the policy; the reason is `errors[0].code`, the `detail` says what to do (code `password-refused`). `TotpCodeIncorrectError`: a wrong authenticator code at confirm                                       | 422    |
| `PasskeyRegistrationRefusedError`: a passkey could not be added, whatever the cause: a challenge that is unknown, used, over or another user's, a response that does not verify, or a credential already registered (code `passkey-registration-failed`) | 422    |
| `LastSignInMethodError`: the passkey is the user's only way to sign in (code `last-sign-in-method`)                                                                                                                                                      | 409    |
| `RateLimitedError`: too many requests from one address or on one session, with `Retry-After`                                                                                                                                                             | 429    |
| The service cannot answer, such as the database being down; `StartingError` (code `starting`) for a route asked before start-up finished                                                                                                                 | 503    |
| Anything else, including `RecordWriteError`: a generic message and the request ID only                                                                                                                                                                   | 500    |

Fastify's own refusals of a malformed request (bad JSON, a body over the limit, an unsupported media type, a malformed URL) are 400, 413 and 415 problems with fixed text.

A row of the table may also give `errors`, field paths with a fixed reason code and never a value; `PasswordRefusedError` does.

`INTERNAL_ERRORS` in the same file lists the core errors that are meant to be a 500, with the reason. A test fails when a core error class is in neither list, so a new module cannot forget to decide.

## Logging

One line per request, written when the response is sent: method, route pattern, status code, duration and request ID. A line never holds a URL, a query, a path parameter, a header or a body, so a `token` in a query string or an `authorization` header cannot reach it. Errors are logged by class name and request ID, never by message. If a handler writes a line by hand, two independent layers mask credentials. A scrubbing formatter masks every key named like a `token`, `authorization`, `cookie`, `set-cookie` and the session cookie `__Host-osfpm_session`, at any depth. The formatter also masks a token-named query parameter and the session cookie inside a string, and logs a request or reply object as its class name only. Under it, fixed redact paths mask the three credential headers. A line never takes its message from an error, because Fastify's own warnings quote the whole URL there. These layers are a safety net, not permission to log objects: the rule in CLAUDE.md (Code rules) is to log the known keys `req`, `res` and `err`, or plain scalar fields, and never whole objects or request data (Privacy rule).

A refused request is a warning with the error's class name. A start-up failure is one `fatal` line with no request in it. Neither holds an address, a cookie or a token.

The caller of `buildApp` chooses only the level and the destination. What a line may hold is fixed in `src/logging.ts`.

## Add a route plugin

Each area of the API is a Fastify plugin. A module adds its own and registers it in `buildApp`; it never edits another area's plugin.

1. Create `src/routes/<area>.ts` (or a folder). Validate every input with a Zod schema and describe each response with one. The OpenAPI document is generated from them. **Declare `auth`**: a route that says nothing is `required`, which is what most routes want, and a route that must work without a session says `config: { auth: 'none' }`. A route that checks a secret sets `authRateLimit: true` (10 a minute per address), and a route a signed-in client uses as it goes sets `sessionRateLimit: true` (120 a minute per session). A session a recovery code opened is refused on a route unless it says `allowedInRecovery: true`, which only the routes that set a new way to sign in say.

   ```ts
   import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
   import { z } from 'zod';
   import { requireAuthenticated } from '../auth/plugin.js';

   export const exampleRoutes: FastifyPluginAsyncZod = (app) => {
     app.get(
       '/examples/:id',
       {
         // No `auth`, so the route is `required`: the plugin has already answered
         // 401 if there is no valid session, and `requireAuthenticated` cannot fail.
         schema: {
           params: z.object({ id: z.uuid() }),
           response: { 200: z.object({ id: z.uuid(), name: z.string() }) },
         },
       },
       async (request) => {
         const { context } = requireAuthenticated(request);
         // `findExample` stands in for a core service, which takes app.db.db and
         // who is asking. Do not catch its errors: let them go, and the error
         // table maps them.
         return findExample(app.db.db, context, request.params.id);
       },
     );
     return Promise.resolve();
   };
   ```

   A route that changes data and is `required` or `optional` gets the cross-site check from the plugin, with nothing to add.

2. Add one line to `buildApp` in `src/app.ts`, next to the others: `void app.register(exampleRoutes, { prefix: API_PREFIX });`

3. If the module defines error classes, add a row for each to `PROBLEM_TABLE` in `src/errors.ts` (or an entry with a reason to `INTERNAL_ERRORS`). A row either states its own `detail` or passes on the error's message, and only an error whose documentation says its message holds no ids and no values may do that.

4. Test it with `app.inject()` (see below). Tests that register their own routes on a test app must say `config: { auth: 'none' }` on each, or the default `required` answers 401. CLAUDE.md requires, for every permission-protected endpoint, a test that it answers 403 without access and returns no sensitive fields without `sensitive:read`. A self-service endpoint, which acts only on the signed-in user's own account and has no permission to lack, tests instead that it answers 401 without a session, 403 `origin-mismatch` for a foreign `Origin` on a request that changes data, and 403 `account-recovery-required` for a recovery session unless the route says `allowedInRecovery`. A public endpoint (`auth: 'none'`) tests that all its failures give the identical answer and that its rate limit applies.

Import core code by path, for example `@osfpm/core/src/db/write.js`: the core has no build step yet and its package index exports only a placeholder.

## Folder map

| Path                          | What it holds                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `src/server.ts`               | The entry: config, database, start-up, app, listen, graceful shutdown                             |
| `src/startup.ts`              | `runStartup` (migrate, then sync the core's `PERMISSION_LISTS`), `STARTUP_RETRY`                  |
| `src/app.ts`                  | `buildApp`, which returns the Fastify instance without listening                                  |
| `src/config.ts`               | Environment variables validated with Zod                                                          |
| `src/errors.ts`               | The error table and the problem responses                                                         |
| `src/logging.ts`              | The privacy rules for log lines                                                                   |
| `src/auth/plugin.ts`          | The auth plugin: cookie to acting user, the `auth` option, the cross-site check                   |
| `src/auth/cookie.ts`          | The session cookie's name and how it is set and cleared                                           |
| `src/auth/rate-limit.ts`      | `ADDRESS_RATE_LIMIT`, `AUTH_RATE_LIMIT` and `SESSION_RATE_LIMIT`, in one place                    |
| `src/auth/login-routes.ts`    | The sign-in routes: password, authenticator code and recovery code                                |
| `src/auth/account-routes.ts`  | The routes a signed-in user secures the account with: password, authenticator app, recovery codes |
| `src/auth/passkey-routes.ts`  | The routes a signed-in user manages passkeys with: add one, list, rename and revoke               |
| `src/auth/passkey-schemas.ts` | The Zod schemas of the WebAuthn JSON forms the passkey routes send and read                       |
| `src/routes/`                 | One plugin per area: health, meta, openapi, auth                                                  |
| `src/test-support.ts`         | `createTestApp`, a test app on a throwaway database. Only tests import it                         |

## Tests

From the repository root:

```sh
pnpm test packages/api
```

They use `app.inject()`, so no port is opened, except `src/server.test.ts`, which starts the server on a free port. They run on PGlite always and on PostgreSQL as well when `DATABASE_URL` is set (see the main `README.md`). `src/jsdoc.test.ts` in the core package also fails when an export in this package has no JSDoc.

Most tests make a session with the core's `createSession`; the tests of the login routes sign in through them. The passkey tests answer the browser's WebAuthn calls with the core's software authenticator (`softwareAuthenticator` in `packages/core/src/auth/test-support.ts`), so the library's real verification runs. A test that sends many requests gives each its own `remoteAddress`, so the rate limits measure only what the test means them to.

Test data is the fictional production _The Last Withdrawal_ or invented values, never real people's data.
