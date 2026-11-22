import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  baseColumns,
  securityTable,
  sqlList,
  timestamptz,
} from '../columns.js';
import { user } from './user.js';

/**
 * Allowed values of `login_challenge.kind`: what a challenge waits for. `totp`
 * is the authenticator code after a password. `webauthn-register` is the
 * passkey a signed-in user is adding, and `webauthn-login` is a passkey
 * sign-in, which is not tied to a user until the credential is known (SC-10,
 * decision D-56). The CHECK is built from this list, so a new value needs a new
 * migration.
 */
export const LOGIN_CHALLENGE_KINDS = [
  'totp',
  'webauthn-register',
  'webauthn-login',
] as const;
/** One value of `LOGIN_CHALLENGE_KINDS`. */
export type LoginChallengeKind = (typeof LOGIN_CHALLENGE_KINDS)[number];

/**
 * A step of a sign-in, or of adding a passkey, that waits for something the
 * client holds. For `totp` it is the half-finished sign-in of a user who gave
 * the right password and has an authenticator app: no session exists yet, only
 * this challenge, which the second step (the code) must present (SC-10). For the
 * two passkey kinds it is the one-time challenge the authenticator signs. Only
 * the SHA-256 hash of the challenge token is stored; the raw token goes to the
 * client once (for a passkey it is also the WebAuthn challenge, which the client
 * sends back inside the signed response). It is used once, ends after a few
 * minutes, and, for `totp`, allows a few code attempts (`attempts`); the limits
 * are in `auth/login-challenge.ts`. Retention class `transient`: a working row
 * that cleanup removes, and the audit log is the record. An expired row is of no
 * use: `createLoginChallenge` deletes the user's own when it makes a new one, and
 * `cleanupExpiredChallenges` deletes all of them, for the worker.
 *
 * `user_id` is NULL only for `webauthn-login`: a person who signs in with a
 * passkey gives no address, so the challenge cannot belong to anyone until the
 * credential that signs it is found (`login_challenge_user_check`).
 *
 * A security table: only `auth/login-challenge.ts` and `auth/passkeys.ts` write
 * it, directly, and the steps around it are audited, not change-logged
 * (CLAUDE.md, Data rules).
 */
export const loginChallenge = securityTable(
  'login_challenge',
  {
    ...baseColumns(() => user.id, { defaultRetentionClass: 'transient' }),
    userId: uuid('user_id'),
    kind: text('kind').$type<LoginChallengeKind>().notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    usedAt: timestamptz('used_at'),
    attempts: integer('attempts').notNull().default(0),
  },
  (t) => [
    foreignKey({
      name: 'login_challenge_user_fk',
      columns: [t.userId],
      foreignColumns: [user.id],
    }),
    unique('login_challenge_token_hash_unique').on(t.tokenHash),
    index('login_challenge_user_idx').on(t.userId),
    check(
      'login_challenge_kind_check',
      sql`${t.kind} in (${sqlList(LOGIN_CHALLENGE_KINDS)})`,
    ),
    // Only a passkey sign-in may have no user yet (SC-10, decision D-56). Every
    // other kind belongs to a user from the start, so the row of a user is never
    // left without one.
    check(
      'login_challenge_user_check',
      sql`${t.userId} is not null or ${t.kind} = 'webauthn-login'`,
    ),
    check('login_challenge_attempts_check', sql`${t.attempts} >= 0`),
  ],
);
