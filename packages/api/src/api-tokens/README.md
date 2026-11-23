# api-tokens

The routes that switch personal API tokens on for an organisation and let people make, list and revoke them (spec card SC-10, decisions D-17 and D-68). A personal API token lets a script act as one person, narrowed to one organisation (or one project), to read or write, and to a short list of sensitive permissions. They are off until an administrator turns them on. The rules are in the core (`packages/core/src/auth/api-tokens.ts`, `packages/core/src/access/credential.ts`) and in the auth plugin (`../auth/`, which accepts a token on a route that says `tokenAccess`); these routes validate input, call the services and map their errors.

**Entry points**

- `routes.ts`: `apiTokenRoutes`, under `/api/v1/organisations/:organisationId`:
  - `GET /api-settings` and `PUT /api-settings`: the two switches, `personalTokens` and `sensitive`. Both need `api:manage`. `PUT` takes both values; turning one off ends the tokens it no longer allows in the same transaction, and the answer says how many in `revoked`.
  - `POST /api-tokens`: makes a token for the person asking (needs `api:tokens`). The `201` holds the token once and is not cached.
  - `GET /api-tokens?scope=own|all`: the tokens that still work, as metadata. `own` (the default) needs `api:tokens`, `all` needs `api:manage`.
  - `DELETE /api-tokens/:tokenId`: revokes one token (`204`). A token that is not live, not of this organisation, or not the caller's to revoke is a `404`.
- `schemas.ts`: the request and response schemas. A response has no field that could hold a token or its hash, and nothing beyond the stored `prefix` that identifies a token.

**Rules you must not break**

- Each route needs a session (a recovery session is refused), counts against the limit per session, and a request that changes data needs the right `Origin`. **None says `tokenAccess`**: a token never makes, lists or revokes tokens and never changes the switches, so a token on one of these routes is a 403 `token-not-accepted`. A test walks every registered route and fails if one of them, or a credential, account, invite or reset-link route, says it takes a token.
- The token is in the `POST` response and nowhere else: no list, no other response, no log line, no audit event, no change event and no error body holds a token or its hash (CLAUDE.md, Privacy rule). The response that makes it says `cache-control: no-store`.
- The permission is checked in the core, in the organisation, so a stranger, a member without the permission and an organisation that does not exist get the same 403. A caller who may only revoke their own tokens gets the same 404 for someone else's token as for one that does not exist.
- The sensitive switch can only be on while the token switch is: a body that asks for it is a 400 (the schema and the core both refuse it).
- A token's expiry is `expiresInDays` (1 to 3650, 365 when left out) or `noExpiry: true`, never both. A listing says `neverExpires`, so a token with no end is easy to find. Setting an expiry is advised.
- The routes call core services only. This package never imports drizzle-orm.

**Tests:** `pnpm test packages/api/src/api-tokens`. They run on PGlite, and on PostgreSQL too when `DATABASE_URL` is set.
