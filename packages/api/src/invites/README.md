# invites

The member and invite routes (spec card SC-10, decision D-57): an administrator lists the organisation's members and makes one-time invite links; whoever holds a link looks at it and accepts it. OSFPM sends no email: the link is shown once and the administrator passes it on. The rules are in the core (`packages/core/src/auth/invites.ts`, `packages/core/src/members/`); these routes validate input, call the services and map their errors.

**Entry points**

- `organisation-routes.ts`: `organisationInviteRoutes`, under `/api/v1/organisations/:organisationId`: `GET /members`, `POST /invites`, `GET /invites` and `DELETE /invites/:inviteId`. Each needs a session, counts against the limit per session, and a request that changes data needs the right `Origin`. The permission (`members:read` or `members:invite`) is checked in the core, in the organisation; a stranger, a member without it and an organisation that does not exist get the same 403.
- `public-routes.ts`: `publicInviteRoutes`, under `/api/v1/invites`: `POST /inspect` (`auth: 'none'`) and `POST /accept` (`auth: 'optional'`). Both count against the strict limit per address and need the right `Origin` with a cookie or without one, because accepting makes a session.
- `refusals.ts`: `withRefusalsCommitted`, which runs a route's work in one transaction and commits before it throws an invite refusal, so the audit event of a refusal is kept.
- `schemas.ts`: the response schemas and problem answers the routes share.

**Rules you must not break**

- The link is `<OSFPM_PUBLIC_URL>/invite#<token>`. The token is in the fragment, which a browser never sends to a server, a proxy or in a `Referer` header; the page that opens the link reads it and sends it in a body. It is in the response that makes the invite and nowhere else: no list, no log line, no audit event, no change event and no error body holds a token, its hash, an invite's address or a password.
- Every route that creates a session passes the Origin check, with or without a cookie (`requireOrigin`, and `assertOriginRequired` in `POST /accept`).
- `inspect` and `accept` give one answer, a 401 `invite-invalid`, for a token that is unknown, expired, revoked or used. The cause is in the audit trail alone.
- `POST /accept` with a session cookie takes no `account` (400), and a recovery session cannot accept (403). A cookie that is invalid or expired is a 401, though the plugin's `optional` mode would let it through: the route checks it, because an invalid cookie must not become a way to make an account.

**Tests:** `pnpm test packages/api/src/invites`. `invite-routes.test.ts` covers every route: 401, 403 and the foreign `Origin`, the same answer for every kind of refusal, the strict rate limit, the privacy scan of logs, audit events, change events and error bodies, and, on PostgreSQL only, two accepts of one token at once over HTTP. They run on PGlite, and on PostgreSQL too when `DATABASE_URL` is set.
