# access-reset

The admin reset routes (spec card SC-10, decision D-57): an administrator makes a one-time reset link for a member who is locked out (a forgotten password, a lost authenticator device, a lost passkey), and whoever holds the link looks at it and uses it to sign in with a recovery-scope session. OSFPM sends no email: the link is shown once and the administrator passes it on. The rules are in the core (`packages/core/src/auth/access-reset.ts`); these routes validate input, call the services and map their errors.

**Entry points**

- `member-routes.ts`: `memberResetRoutes`, under `/api/v1/organisations/:organisationId/members/:userId/reset-link`: `POST` makes the link and `DELETE` revokes it. Each needs a session, counts against the limit per session, and a request that changes data needs the right `Origin`. The permission (`members:reset-access`) is checked in the core, in the organisation; a member without it, a stranger, an organisation that does not exist, a person who is not a member and a user that does not exist all get the same 403. The body of `POST` is a JSON object, `{}` for every default.
- `public-routes.ts`: `publicAccessResetRoutes`, under `/api/v1/access-reset`: `POST /inspect` and `POST /` (use the link). Both are `auth: 'none'`, count against the strict limit per address (together with the login and invite routes) and need the right `Origin` with a cookie or without one, because using the link makes a session. A cookie the browser already has is ignored, and the new one replaces it.
- Refusals are committed before they are answered by `withRefusalsCommitted` in `../invites/refusals.ts`, so the audit event of a refusal is kept. The shared response schemas are in `../invites/schemas.ts`.

**Rules you must not break**

- The link is `<OSFPM_PUBLIC_URL>/reset#<token>`. The token is in the fragment, which a browser never sends to a server, a proxy or in a `Referer` header; the page that opens the link reads it and sends it in a body. It is in the response that makes the link and nowhere else: no log line, no audit event, no change event and no error body holds a token, its hash, a password or an address, and no response says anything about the person but the one that signs them in.
- `inspect` and `POST /` give one answer, a 401 `reset-link-invalid`, for a token that is unknown, expired, revoked or used and for a link that a rule for who may reset whom now refuses. The cause is in the audit trail alone.
- `POST /` makes its session in the same transaction as the use, so a failure of it leaves the link usable. The session has method `reset` and the recovery scope (`createSession` always gives it): it may only set a password, add or remove a passkey, or enrol an authenticator.

**Tests:** `pnpm test packages/api/src/access-reset`. `access-reset-routes.test.ts` covers every route: 401, 403 and the foreign `Origin`, the same answer for every kind of denial and of refusal, each rule for who may reset whom as its 422, the strict rate limit, the privacy scan of logs, audit events, change events and error bodies, and, on PostgreSQL only, two uses of one link at once over HTTP. They run on PGlite, and on PostgreSQL too when `DATABASE_URL` is set.
