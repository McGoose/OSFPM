import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
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
 * Allowed values of `session.method`: how the user proved who they are. The
 * CHECK is built from this list, so a new value needs a new migration.
 */
export const SESSION_METHODS = [
  'passkey',
  'password',
  'password+totp',
  'recovery',
  'setup',
  'invite',
] as const;
/** One value of `SESSION_METHODS`. */
export type SessionMethod = (typeof SESSION_METHODS)[number];

/**
 * Allowed values of `session.scope`: what the session may do. `full` is every
 * signed-in route. `recovery` is the session a recovery code opens: it may only
 * read who is signed in, sign out, and set a new way to sign in (a password,
 * an authenticator app, recovery codes, later a passkey), until the user does
 * one of those and the session becomes `full` (SC-10). The CHECK is built from
 * this list, so a new value needs a new migration.
 */
export const SESSION_SCOPES = ['full', 'recovery'] as const;
/** One value of `SESSION_SCOPES`. */
export type SessionScope = (typeof SESSION_SCOPES)[number];

/**
 * A login session. Only the SHA-256 hash of the session token is stored; the
 * raw token goes to the client once and is never kept or logged (SC-10).
 * Retention class `transient`: a working row that cleanup removes, and the
 * audit log is the record. `cleanupEndedSessions` deletes a session once it has
 * ended, by revocation or by going idle, for `SESSION_DEFAULTS.endedKeepMs`.
 *
 * A security table: only `auth/sessions.ts` writes it, directly, and each
 * security-relevant change is audited, not change-logged (CLAUDE.md, Data
 * rules).
 */
export const session = securityTable(
  'session',
  {
    ...baseColumns(() => user.id, { defaultRetentionClass: 'transient' }),
    userId: uuid('user_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    method: text('method').$type<SessionMethod>().notNull(),
    scope: text('scope').$type<SessionScope>().notNull().default('full'),
    lastSeenAt: timestamptz('last_seen_at').notNull(),
    idleExpiresAt: timestamptz('idle_expires_at').notNull(),
    absoluteExpiresAt: timestamptz('absolute_expires_at').notNull(),
    revokedAt: timestamptz('revoked_at'),
    revokedReason: text('revoked_reason'),
    userAgentSummary: text('user_agent_summary'),
  },
  (t) => [
    foreignKey({
      name: 'session_user_fk',
      columns: [t.userId],
      foreignColumns: [user.id],
    }),
    unique('session_token_hash_unique').on(t.tokenHash),
    index('session_user_idx').on(t.userId),
    check(
      'session_method_check',
      sql`${t.method} in (${sqlList(SESSION_METHODS)})`,
    ),
    check(
      'session_scope_check',
      sql`${t.scope} in (${sqlList(SESSION_SCOPES)})`,
    ),
    check(
      'session_expiry_order_check',
      sql`${t.idleExpiresAt} <= ${t.absoluteExpiresAt}`,
    ),
  ],
);
