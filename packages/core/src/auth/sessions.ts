import { and, desc, eq, gt, isNull, lte, ne, sql } from 'drizzle-orm';
import {
  SESSION_METHODS,
  session,
  user,
  type SessionMethod,
  type UserStatus,
} from '../db/schema/index.js';
import type { Tx } from '../db/write.js';
import { AuthInputError, AuthStateError } from './errors.js';
import {
  AUTH_AUDIT,
  guardedAuth,
  isOneOf,
  lockUser,
  recordAuthAudit,
  serverId,
  type AuthActor,
} from './shared.js';
import { generateToken, hashToken } from './tokens.js';

/**
 * Login sessions (SC-10). A session is a random token the client holds in a
 * cookie; only its SHA-256 hash is stored. The raw token is returned once, by
 * `createSession`, and never stored, logged or audited. `session` is a security
 * table: written here, directly, and every security-relevant change is audited
 * instead of change-logged (CLAUDE.md, Data rules).
 *
 * These functions check no permission: the route that calls them has already
 * decided who may. Pass the transaction handle.
 */

/**
 * Session lifetimes, in one place until organisation settings can change them:
 * a session ends after 12 hours without a request, or 30 days after it began,
 * whichever is first. `slideIntervalMs` is how rarely a busy session writes: at
 * most once a minute.
 */
export const SESSION_DEFAULTS = {
  idleMs: 12 * 60 * 60 * 1000,
  absoluteMs: 30 * 24 * 60 * 60 * 1000,
  slideIntervalMs: 60 * 1000,
} as const;

/**
 * Why a session was revoked, recorded on the session and in the audit event.
 * A fixed list, so a caller cannot put free text, and with it a secret, into
 * the audit trail. `logout` is a user ending the session they are on;
 * `user-revoked` is a user ending another of their own sessions, from the list
 * of where they are signed in. `revoked_reason` is plain text, so a new reason
 * needs no migration.
 */
export const SESSION_REVOKE_REASONS = [
  'logout',
  'user-revoked',
  'user-disabled',
  'password-changed',
  'recovery-used',
  'admin-action',
] as const;
/** One value of `SESSION_REVOKE_REASONS`. */
export type SessionRevokeReason = (typeof SESSION_REVOKE_REASONS)[number];

/** A session as the services return it: never the token or its hash. */
export type SessionView = {
  readonly id: string;
  readonly userId: string;
  readonly method: SessionMethod;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly userAgentSummary: string | null;
};

/** The user of a valid session: only what a signed-in client needs. */
export type SessionUser = {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly locale: string;
  readonly timezone: string;
  readonly status: UserStatus;
};

/** The columns of a `SessionView`: every column but the token hash and the revoke fields. */
const viewColumns = {
  id: session.id,
  userId: session.userId,
  method: session.method,
  createdAt: session.createdAt,
  lastSeenAt: session.lastSeenAt,
  idleExpiresAt: session.idleExpiresAt,
  absoluteExpiresAt: session.absoluteExpiresAt,
  userAgentSummary: session.userAgentSummary,
};

/** A summary is for showing in a list of devices, so it is kept short. */
const MAX_USER_AGENT_SUMMARY = 200;

/** A real token is 43 characters; anything this long is not one and is not hashed. */
const MAX_TOKEN_LENGTH = 256;

const addMs = (date: Date, ms: number) => new Date(date.getTime() + ms);
const earlier = (a: Date, b: Date) => (a.getTime() <= b.getTime() ? a : b);

/** Options every revoking and disabling call takes. */
type ChangeOptions = {
  /** The time of the change, for the row and the audit event. */
  readonly now: Date;
  /** Who did it. Defaults to the session's own user, or `system` when there is no session. */
  readonly actor?: AuthActor;
};

function checkedReason(reason: unknown): SessionRevokeReason {
  if (!isOneOf(SESSION_REVOKE_REASONS, reason)) {
    throw new AuthInputError('reason');
  }
  return reason;
}

/**
 * Signs a user in: creates a session and returns it with the raw token, which
 * is the only time the token exists outside the client. Sets
 * `user.last_login_at`. The session lasts `SESSION_DEFAULTS.idleMs` without a
 * request and `absoluteMs` in all. Audited as `auth.session-created` with the
 * method.
 *
 * @throws AuthInputError `method` when the method is not in `SESSION_METHODS`.
 * @throws AuthStateError `user-not-found` for an unknown or deleted user,
 * `user-disabled` for a disabled one, `installation-missing` before the
 * installation row exists.
 * @throws RecordWriteError when the database refuses a write; it carries the
 * SQLSTATE and constraint name only.
 */
export async function createSession(
  tx: Tx,
  input: {
    userId: string;
    method: SessionMethod;
    userAgentSummary?: string | null;
    now: Date;
  },
): Promise<{ session: SessionView; token: string }> {
  if (!isOneOf(SESSION_METHODS, input.method)) {
    throw new AuthInputError('method');
  }
  const { now } = input;
  const summary =
    typeof input.userAgentSummary === 'string'
      ? input.userAgentSummary.trim().slice(0, MAX_USER_AGENT_SUMMARY) || null
      : null;
  return guardedAuth('session', 'insert', () =>
    // A savepoint: a failure leaves no session, no login time and no event.
    tx.transaction(async (inner) => {
      // Locked before the check, so a disable that runs at the same moment
      // either finishes first (the login is refused) or waits and then revokes
      // this session along with the others.
      const found = await lockUser(inner, input.userId);
      if (found.status === 'disabled')
        throw new AuthStateError('user-disabled');
      const origin = await serverId(inner);
      const token = generateToken();
      const absolute = addMs(now, SESSION_DEFAULTS.absoluteMs);
      const idle = earlier(addMs(now, SESSION_DEFAULTS.idleMs), absolute);
      const [row] = await inner
        .insert(session)
        .values({
          originServer: origin,
          userId: input.userId,
          tokenHash: hashToken(token),
          method: input.method,
          createdAt: now,
          updatedAt: now,
          lastSeenAt: now,
          idleExpiresAt: idle,
          absoluteExpiresAt: absolute,
          userAgentSummary: summary,
        })
        .returning(viewColumns);
      // A login is not an edit of the user, so `version` stays as it is.
      await inner
        .update(user)
        .set({ lastLoginAt: now, updatedAt: now })
        .where(eq(user.id, input.userId));
      await recordAuthAudit(inner, {
        category: AUTH_AUDIT.sessionCreated,
        action: 'create',
        actor: { type: 'user', id: input.userId },
        targetType: 'session',
        targetId: row!.id,
        details: { method: input.method },
        occurredAt: now,
      });
      return { session: row!, token };
    }),
  );
}

/**
 * Finds the live session for a raw token and the user it belongs to, or `null`.
 * `null` is the one answer for a token that is unknown, revoked, idle-expired
 * or absolute-expired, and for a user who is disabled or deleted, so a caller
 * learns nothing about which it was. Writes nothing for a session that is not
 * valid.
 *
 * A valid session slides: `idle_expires_at` moves to `now` plus the idle time,
 * never past `absolute_expires_at`. It writes at most once a minute per
 * session, in one conditional UPDATE, so a busy session is not a write per
 * request and two requests at once write once.
 *
 * @throws RecordWriteError when the database fails; it carries the SQLSTATE
 * only, never the token or its hash.
 */
export async function validateSession(
  tx: Tx,
  token: string,
  now: Date,
): Promise<{ session: SessionView; user: SessionUser } | null> {
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    token.length > MAX_TOKEN_LENGTH
  ) {
    return null;
  }
  return guardedAuth('session', 'select', async () => {
    const [row] = await tx
      .select({
        session: viewColumns,
        revokedAt: session.revokedAt,
        user: {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          locale: user.locale,
          timezone: user.timezone,
          status: user.status,
        },
        userDeletedAt: user.deletedAt,
      })
      .from(session)
      .innerJoin(user, eq(user.id, session.userId))
      .where(eq(session.tokenHash, hashToken(token)))
      .limit(1);
    if (!row) return null;
    const { session: found } = row;
    if (
      row.revokedAt !== null ||
      found.idleExpiresAt.getTime() <= now.getTime() ||
      found.absoluteExpiresAt.getTime() <= now.getTime() ||
      row.user.status === 'disabled' ||
      row.userDeletedAt !== null
    ) {
      return null;
    }
    const due = new Date(now.getTime() - SESSION_DEFAULTS.slideIntervalMs);
    const [slid] = await tx
      .update(session)
      .set({
        lastSeenAt: now,
        idleExpiresAt: earlier(
          addMs(now, SESSION_DEFAULTS.idleMs),
          found.absoluteExpiresAt,
        ),
        updatedAt: now,
      })
      .where(
        and(
          eq(session.id, found.id),
          isNull(session.revokedAt),
          // The condition is in the UPDATE, not only in the read above, so two
          // requests that both see a stale session write once.
          lte(session.lastSeenAt, due),
        ),
      )
      .returning(viewColumns);
    return { session: slid ?? found, user: row.user };
  });
}

/**
 * Revokes one session. Returns true when it was live and is now revoked, false
 * when there is no such session or it was already revoked, and the answer is
 * the same for both. Audited as `auth.session-revoked` with the reason.
 *
 * @throws AuthInputError `reason` when the reason is not in
 * `SESSION_REVOKE_REASONS`.
 * @throws RecordWriteError when the database refuses a write.
 */
export async function revokeSession(
  tx: Tx,
  sessionId: string,
  options: ChangeOptions & { reason: SessionRevokeReason },
): Promise<boolean> {
  const reason = checkedReason(options.reason);
  return guardedAuth('session', 'update', () =>
    tx.transaction(async (inner) => {
      const [row] = await inner
        .update(session)
        .set({
          revokedAt: options.now,
          revokedReason: reason,
          updatedAt: options.now,
        })
        .where(and(eq(session.id, sessionId), isNull(session.revokedAt)))
        .returning({ id: session.id, userId: session.userId });
      if (!row) return false;
      await recordAuthAudit(inner, {
        category: AUTH_AUDIT.sessionRevoked,
        action: 'revoke',
        actor: options.actor ?? { type: 'user', id: row.userId },
        targetType: 'session',
        targetId: row.id,
        details: { reason },
        occurredAt: options.now,
      });
      return true;
    }),
  );
}

/**
 * Revokes every live session of a user, except `exceptSessionId` when given
 * (a password change keeps the session that made it). A session that has
 * already expired or been revoked is left as it is. Returns how many were
 * revoked. Audited as one `auth.sessions-revoked` event with the reason and
 * the count, also when the count is 0, because the action itself is what is
 * worth knowing.
 *
 * @throws AuthInputError `reason` when the reason is not in
 * `SESSION_REVOKE_REASONS`.
 * @throws RecordWriteError when the database refuses a write.
 */
export async function revokeUserSessions(
  tx: Tx,
  userId: string,
  options: ChangeOptions & {
    reason: SessionRevokeReason;
    exceptSessionId?: string;
  },
): Promise<number> {
  const reason = checkedReason(options.reason);
  const { now } = options;
  return guardedAuth('session', 'update', () =>
    tx.transaction(async (inner) => {
      const revoked = await inner
        .update(session)
        .set({ revokedAt: now, revokedReason: reason, updatedAt: now })
        .where(
          and(
            eq(session.userId, userId),
            isNull(session.revokedAt),
            gt(session.idleExpiresAt, now),
            gt(session.absoluteExpiresAt, now),
            options.exceptSessionId === undefined
              ? undefined
              : ne(session.id, options.exceptSessionId),
          ),
        )
        .returning({ id: session.id });
      await recordAuthAudit(inner, {
        category: AUTH_AUDIT.sessionsRevoked,
        action: 'revoke-all',
        actor: options.actor ?? { type: 'user', id: userId },
        targetType: 'user',
        targetId: userId,
        details: {
          reason,
          count: revoked.length,
          exceptSessionId: options.exceptSessionId ?? null,
        },
        occurredAt: now,
      });
      return revoked.length;
    }),
  );
}

/**
 * Lists a user's live sessions, most recently seen first: not revoked, and not
 * past their idle or absolute end at `now`. Never returns a token or its hash.
 * For a "where am I signed in" screen; the caller has decided that the user
 * may see these.
 *
 * @throws RecordWriteError when the database fails.
 */
export function listUserSessions(
  tx: Tx,
  userId: string,
  now: Date,
): Promise<SessionView[]> {
  return guardedAuth('session', 'select', () =>
    tx
      .select(viewColumns)
      .from(session)
      .where(
        and(
          eq(session.userId, userId),
          isNull(session.revokedAt),
          gt(session.idleExpiresAt, now),
          gt(session.absoluteExpiresAt, now),
        ),
      )
      .orderBy(desc(session.lastSeenAt), desc(session.id)),
  );
}

/**
 * Disables a user and revokes all their sessions, in one transaction. A
 * disabled user cannot sign in and any session they still hold stops being
 * valid. Returns false, writing nothing, when the user is already disabled.
 * Audited as `auth.user-disabled` and, for the sessions, `auth.sessions-revoked`.
 * `actor` is who did it; without it the event is a `system` one.
 *
 * @throws AuthStateError `user-not-found` for an unknown or deleted user.
 * @throws RecordWriteError when the database refuses a write.
 */
export function disableUser(
  tx: Tx,
  userId: string,
  options: { now: Date; actor?: AuthActor },
): Promise<boolean> {
  const actor = options.actor ?? { type: 'system', id: null };
  return guardedAuth('user', 'update', () =>
    tx.transaction(async (inner) => {
      const found = await lockUser(inner, userId);
      if (found.status === 'disabled') return false;
      await inner
        .update(user)
        .set({
          status: 'disabled',
          version: sql`${user.version} + 1`,
          updatedAt: options.now,
          updatedBy: actor.type === 'user' ? actor.id : null,
        })
        .where(eq(user.id, userId));
      await recordAuthAudit(inner, {
        category: AUTH_AUDIT.userDisabled,
        action: 'disable',
        actor,
        targetType: 'user',
        targetId: userId,
        details: { previousStatus: found.status },
        occurredAt: options.now,
      });
      await revokeUserSessions(inner, userId, {
        reason: 'user-disabled',
        now: options.now,
        actor,
      });
      return true;
    }),
  );
}

/**
 * Enables a disabled user again, as `active`. Returns false, writing nothing,
 * when the user is not disabled: an invited user stays invited and an active
 * one stays active. The sessions revoked when the user was disabled stay
 * revoked. Audited as `auth.user-enabled`.
 *
 * @throws AuthStateError `user-not-found` for an unknown or deleted user.
 * @throws RecordWriteError when the database refuses a write.
 */
export function enableUser(
  tx: Tx,
  userId: string,
  options: { now: Date; actor?: AuthActor },
): Promise<boolean> {
  const actor = options.actor ?? { type: 'system', id: null };
  return guardedAuth('user', 'update', () =>
    tx.transaction(async (inner) => {
      const found = await lockUser(inner, userId);
      if (found.status !== 'disabled') return false;
      await inner
        .update(user)
        .set({
          status: 'active',
          version: sql`${user.version} + 1`,
          updatedAt: options.now,
          updatedBy: actor.type === 'user' ? actor.id : null,
        })
        .where(eq(user.id, userId));
      await recordAuthAudit(inner, {
        category: AUTH_AUDIT.userEnabled,
        action: 'enable',
        actor,
        targetType: 'user',
        targetId: userId,
        occurredAt: options.now,
      });
      return true;
    }),
  );
}
