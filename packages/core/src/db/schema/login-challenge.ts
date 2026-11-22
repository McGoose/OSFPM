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
 * Allowed values of `login_challenge.kind`: the second step a challenge waits
 * for. The CHECK is built from this list, so a new value needs a new migration.
 */
export const LOGIN_CHALLENGE_KINDS = ['totp'] as const;
/** One value of `LOGIN_CHALLENGE_KINDS`. */
export type LoginChallengeKind = (typeof LOGIN_CHALLENGE_KINDS)[number];

/**
 * The half-finished sign-in of a user who gave the right password and has an
 * authenticator app: no session exists yet, only this challenge, which the
 * second step (the code) must present (SC-10). Only the SHA-256 hash of the
 * challenge token is stored; the raw token goes to the client once. It is used
 * once, ends after a few minutes, and allows a few code attempts
 * (`attempts`); the limits are in `auth/login-challenge.ts`. Retention class
 * `security-log`. An expired row is of no use: `createLoginChallenge` deletes
 * the user's own when it makes a new one, and `cleanupExpiredChallenges`
 * deletes all of them, for the worker.
 *
 * A security table: only `auth/login-challenge.ts` writes it, directly, and the
 * steps around it are audited, not change-logged (CLAUDE.md, Data rules).
 */
export const loginChallenge = securityTable(
  'login_challenge',
  {
    ...baseColumns(() => user.id, { defaultRetentionClass: 'security-log' }),
    userId: uuid('user_id').notNull(),
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
    check('login_challenge_attempts_check', sql`${t.attempts} >= 0`),
  ],
);
