# auth (API)

How a person signs in to the API, and how the API knows who a request is from (spec card SC-10, decision D-56). The services that check a password, a code or a challenge are in the core (`packages/core/src/auth/`); this folder is the HTTP side: the session cookie, the plugin that reads it, the limits, and the routes.

**Entry points**

- `plugin.ts`: `authPlugin`, which turns the session cookie into `request.auth` on every request, applies the three rate limits and the cross-site check, and keeps a recovery session to the routes that allow it. `requireAuthenticated` reads the acting user in a handler.
- `cookie.ts`: the `__Host-osfpm_session` cookie, `setSessionCookie` and `clearSessionCookie`.
- `rate-limit.ts`: `ADDRESS_RATE_LIMIT`, `AUTH_RATE_LIMIT` and `SESSION_RATE_LIMIT`, in one place.
- `login-routes.ts`: `loginRoutes`, the three sign-in routes under `/api/v1/auth/login`: `password`, `totp` and `recovery`.
- `account-routes.ts`: `accountRoutes`, the five routes a signed-in user secures the account with: `PUT /password`, `POST /totp/enrol`, `POST /totp/confirm`, `DELETE /totp` and `POST /recovery-codes`.

The routes for a user's own sessions (`me`, `sessions`, `logout`) are in `src/routes/auth.ts`. The full route table is in `packages/api/README.md`.

**How it works**

- **A sign-in step is one transaction.** The route opens it, calls the core, and on success makes the session in the same transaction, so the user row lock the core takes is held until the session exists. The core returns a failure instead of throwing it, so the transaction commits and the audit event of the failure is kept; the route throws after it.
- **Every failure is the same answer.** An address no one has, an account with no password, a wrong password, authenticator code or recovery code, a challenge that is unknown, used, over time or out of attempts, a disabled or deleted user, and an account the throttle has closed all answer **401** `sign-in-failed`, with one body. Nothing in it says which part failed or whether an address has an account (CLAUDE.md, Code rules). The cause is in the audit trail only, as a reason class and never a submitted value. A request that is not shaped right stays a 400.
- **A password sign-in has one or two steps.** `POST /login/password` makes a session (method `password`) and sets the cookie, unless the user has a confirmed authenticator app. Then it makes no session and answers `{ next: "totp", challenge }`, and `POST /login/totp` with the challenge and a code makes the session (method `password+totp`).
- **A recovery sign-in opens a limited session.** `POST /login/recovery` uses a recovery code up, ends every other session of the user (the core does it, reason `recovery-used`), and makes a session of method `recovery`, scope `recovery`, and answers `mustSecureAccount: true`. That session may call only a route that says `config.allowedInRecovery` (`me`, `logout` and the five account routes); any other route is a **403** `account-recovery-required`, whatever its `auth` mode but `none`. A route is closed to it by default, so a new route cannot be open to it by accident. Setting a new password (`PUT /password`) or confirming an authenticator (`POST /totp/confirm`) makes the session `full`.
- **The login routes are `auth: 'none'`** and set `authRateLimit`: at most 10 requests a minute per address, counted together across the three. They use no session, so cookies are ignored and there is no cross-site check on them. Every account route is `auth: 'required'` with `sessionRateLimit`, so it needs a session and, for a request that changes data, the right `Origin`.
- **A current password that is not accepted is a 403** `current-password-incorrect` on the account routes: the user is signed in, so it is not a 401. The answer is the same for a missing, a wrong and a throttled password. A wrong guess counts toward the same per-account throttle as a failed sign-in, so a stolen session cannot be used to guess the password.
- **What the user is shown once** (an authenticator secret and its `otpauth://` address, a challenge, recovery codes) comes in an uncacheable response (`Cache-Control: no-store`) and is never returned, logged or audited again. A session token goes only into the cookie.
- **A refused new password is a 422** `password-refused`. The reason is `errors[0].code` (`too-short`, `too-long`, `too-common`, `too-predictable`, `contains-email` or `contains-product-name`) and `detail` says what to do. The policy is in the core (`password-policy.ts`) and is never applied to a sign-in.

**Rules you must not break**

- A route declares `auth`. A route that checks a secret sets `authRateLimit`. A route that a user who came in with a recovery code needs sets `allowedInRecovery`, and nothing else does.
- Login failures always answer the same 401 `sign-in-failed`. Never add a cause to the body, the headers, the status or the timing of a failure.
- A secret (a password, code, challenge, token or authenticator secret) is never logged, never put in an error body and never put in an audit event. Log lines hold the known keys or plain scalars only.
- A handler does not catch the core's failures to answer them itself: it throws the API's own error classes (`src/errors.ts`) and the error table maps them.

**Tests:** `pnpm test packages/api/src/auth`. `login-routes.test.ts` and `account-routes.test.ts` run the routes through `app.inject()`; `recovery-scope.test.ts` tests the scope on routes that exist only in the test; `secrets-in-flows.test.ts` runs every flow and looks for every secret in the logs (at every level), the audit and change events, the error bodies and every table. The rest cover the plugin and the limits. They run on PGlite, and on PostgreSQL too when `DATABASE_URL` is set. A test that sends many requests gives each its own `remoteAddress`, so the rate limits measure only what the test means them to.
