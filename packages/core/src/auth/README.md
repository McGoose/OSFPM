# auth

The building blocks of login (spec card SC-10): secret tokens and codes, Argon2id passwords, sessions, recovery codes and the one-time setup code, each with its audit events. There are no routes, cookies, WebAuthn, TOTP, password policy, invites or first-run flow here yet; those come in P-03b2 to P-03b4.

**Entry points**

- `tokens.ts`: `generateToken` (32 random bytes, base64url) and `hashToken` (SHA-256). `generateHumanCode`, `normaliseHumanCode` and `hashHumanCode` make and check the typeable codes (16 characters of Crockford base32, 80 bits) used for recovery and setup codes.
- `password.ts`: `hashPassword` and `verifyPassword` (`{ ok, needsRehash }`) with Argon2id as a PHC string. Parameters are in `PASSWORD_HASH_PARAMS`. It uses the built-in `crypto.argon2`, not a package: the Node docs for the version in `.nvmrc` mark the `node:crypto` module `Stability: 2 - Stable` and give `crypto.argon2` no lower stability of its own.
- `sessions.ts`: `createSession`, `validateSession`, `revokeSession`, `revokeUserSessions`, `listUserSessions`, `disableUser`, `enableUser`. Lifetimes are in `SESSION_DEFAULTS` (12 hours idle, 30 days absolute).
- `recovery.ts`: `generateRecoveryCodes` (ten, replacing any earlier set) and `consumeRecoveryCode` (single use).
- `setup-code.ts`: `issueSetupCode` (24 hours, revokes the earlier live code), `consumeSetupCode` and `isSetupComplete`.
- `shared.ts` and `errors.ts`: the audit categories (`AUTH_AUDIT`), `AuthInputError` and `AuthStateError`, and helpers the services share. `test-support.ts` seeds an installation and users for tests.

Pass the transaction handle to every function, and the time as `now`. The services check no permission: the route that calls them has decided who may.

**How it works**

- A token or code is random and shown to the caller once. Only its SHA-256 hash is stored, and the row is found by that hash. SHA-256 is enough because the values hold at least 80 bits of randomness; passwords are low-entropy, so they use Argon2id instead.
- A session lasts 12 hours without a request and 30 days in all. A request slides the idle end, never past the absolute end, and writes at most once a minute. A disabled or deleted user's session is not valid, and disabling a user revokes their sessions.
- Each security-relevant change writes one `audit_event` (`auth.session-created`, `auth.session-revoked`, `auth.sessions-revoked`, `auth.user-disabled`, `auth.user-enabled`, `auth.recovery-codes-generated`, `auth.recovery-code-used`, `auth.setup-code-issued`, `auth.setup-code-used`). Details hold scalar values such as a method, a reason or a count, never a secret. An attempt that changes nothing writes no event yet; failed attempts will be audited (see "Decided for the routes").
- Rows carry the server's own id as `origin_server`, read from the `installation` row, so the services refuse until that row exists.

**Rules you must not break**

- Tables in `SECURITY_TABLES` are written only here, directly, never through the write helper. Their changes are audited, not change-logged. `src/db/write-helper-scan.test.ts` fails when another file writes them, or when a tenant table is written outside the write helper.
- A raw token, code or password is never stored, logged, audited or returned after it is first given out, and neither is a hash of one. `listUserSessions` and `validateSession` return no hash.
- `user` and `installation` are written only by the services named in `SERVICE_WRITTEN_TABLES`, which is `auth` for both today, and never through the write helper. Here, `disableUser`, `enableUser` and `createSession` write `user`, and each is audited. The scan in `write-helper-scan.test.ts` enforces it.
- Every database failure becomes a `RecordWriteError` with the SQLSTATE and constraint name only (`guardedAuth`), because driver messages carry the query parameters, which here are hashes.
- A string from a caller is checked against a constant list (`SESSION_METHODS`, `SESSION_REVOKE_REASONS`, the code alphabet) and never used as a key.
- Lock order: a service that checks a user's state and then writes takes the user row first (`lockUser`); the setup-code functions take the `installation` row. Nothing here touches a project, so the project change counter does not come into it.
- No setup code is issued, or accepted, once `installation.setup_completed_at` is set.

**Decided for the routes (P-03b2, P-03b3); nothing of this is built yet**

- Failed sign-in attempts and failed code attempts will be audited: a wrong password, passkey, authenticator code, recovery code, setup code or invite token. An event holds the method and a failure reason from a fixed list, never a submitted value: no password, code, token or typed email address, and no hash of one. The target is the user only when the server found them by its own means, and there is none for an address it does not know.
- The client still gets one uniform answer for every failure, as `consumeRecoveryCode` and `consumeSetupCode` do today. The reason is for the audit trail alone. These services return `false` for every failure, so P-03b2 decides whether the services record the event, since they know the reason, or report the reason to the route. Either way, the "attempt that changed nothing writes no event" check in `audit.test.ts` changes with it.
- Counting failures for rate limiting is a separate job from auditing them.

**Tests:** `pnpm test packages/core/src/auth` runs `tokens.test.ts`, `password.test.ts`, `sessions.test.ts`, `recovery.test.ts`, `setup-code.test.ts`, `audit.test.ts`, `shared.test.ts` and `tables.test.ts` (every CHECK and unique rule). They run on PGlite, and on PostgreSQL too when `DATABASE_URL` is set. The scan for who writes which table is `src/db/write-helper-scan.test.ts`.
