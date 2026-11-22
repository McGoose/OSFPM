import { and, eq, sql } from 'drizzle-orm';
import {
  LOGIN_CHALLENGE_KINDS,
  loginChallenge,
  user,
  type LoginChallengeKind,
} from '../db/schema/index.js';
import type { Tx } from '../db/write.js';
import { AuthInputError, AuthStateError } from './errors.js';
import { SESSION_USER_COLUMNS, type SessionUser } from './sessions.js';
import {
  AUTH_AUDIT,
  guardedAuth,
  isOneOf,
  lockUser,
  recordAuthAudit,
  serverId,
} from './shared.js';
import {
  isThrottled,
  recordLoginFailure,
  type LoginFailureReason,
} from './throttle.js';
import { generateToken, hashToken } from './tokens.js';
import { verifyTotp } from './totp.js';

/**
 * The half-finished sign-in between the password step and the authenticator
 * code (SC-10). A user who gave the right password and has a confirmed
 * authenticator gets a challenge, not a session; the session is made only when
 * the challenge comes back with a right code. The token is random, shown once,
 * and only its SHA-256 hash is stored, as for a session. `login_challenge` is a
 * security table: written here, directly, and the steps around it are audited
 * instead of change-logged (CLAUDE.md, Data rules). These functions check no
 * permission: the route that calls them has already decided who may. Pass the
 * transaction handle, and the time as `now`.
 */

/**
 * How long a challenge lasts and how many code attempts it allows: five minutes
 * and five attempts, a code used up with the challenge (the P-03b3a design).
 * The numbers live here and nowhere else.
 */
export const LOGIN_CHALLENGE = {
  ttlMs: 5 * 60 * 1000,
  maxAttempts: 5,
} as const;

/** A real challenge token is 43 characters; anything this long is not one and is not hashed. */
const MAX_TOKEN_LENGTH = 256;

/**
 * Starts the second step of a sign-in for a user whose password was right:
 * makes a challenge that ends in `LOGIN_CHALLENGE.ttlMs` and returns its raw
 * token once. Only its hash is stored. Older challenges of the user are left
 * alone: asking for new ones does not give more guesses, because the throttle
 * counts every wrong code of the account, whichever challenge it came with.
 *
 * @throws AuthInputError `kind` when it is not in `LOGIN_CHALLENGE_KINDS`.
 * @throws AuthStateError `user-not-found` for an unknown or deleted user,
 * `user-disabled` for a disabled one, `installation-missing` before the
 * installation row exists.
 * @throws RecordWriteError when the database refuses a write; it carries the
 * SQLSTATE and constraint name only, never the token or its hash.
 */
export async function createLoginChallenge(
  tx: Tx,
  userId: string,
  options: { kind: LoginChallengeKind; now: Date },
): Promise<{ challenge: string; expiresAt: Date }> {
  if (!isOneOf(LOGIN_CHALLENGE_KINDS, options.kind)) {
    throw new AuthInputError('kind');
  }
  const { now } = options;
  return guardedAuth('login_challenge', 'insert', () =>
    tx.transaction(async (inner) => {
      const locked = await lockUser(inner, userId);
      if (locked.status === 'disabled') {
        throw new AuthStateError('user-disabled');
      }
      const token = generateToken();
      const expiresAt = new Date(now.getTime() + LOGIN_CHALLENGE.ttlMs);
      await inner.insert(loginChallenge).values({
        originServer: await serverId(inner),
        userId,
        kind: options.kind,
        tokenHash: hashToken(token),
        expiresAt,
        createdAt: now,
        updatedAt: now,
      });
      return { challenge: token, expiresAt };
    }),
  );
}

/**
 * The answer of `consumeLoginChallenge`. A failure is one value whatever the
 * cause; the reason is for the audit trail alone.
 */
export type ConsumeChallengeResult =
  { readonly ok: true; readonly user: SessionUser } | { readonly ok: false };

/**
 * The second step of a sign-in: takes the challenge from the password step and
 * the authenticator code, and returns the user when both are right. Returns
 * `{ ok: false }` for every other case: a token that is unknown, used, past its
 * time or out of attempts, a user disabled since, an account the throttle has
 * closed, and a wrong code.
 *
 * Each code tried spends one of the challenge's `LOGIN_CHALLENGE.maxAttempts`,
 * and a right code uses the challenge up, so it works once. The challenge is
 * judged before the throttle, so a challenge that ran out says so in the audit
 * trail rather than hiding behind it. A throttled account's code is not
 * checked at all. The user row, then the challenge row, are locked while the
 * attempt is judged, so two requests at once with one challenge cannot both
 * succeed, even with two different right codes, and cannot both get past the
 * attempt count or the throttle.
 *
 * Audited either way: a pass as `auth.login-step-passed`, a failure as
 * `auth.login-step-failed` with a reason class and never the token or the code.
 * A token that matches nothing is audited with no target. The failure is
 * returned, not thrown, so the caller's transaction commits and the event, and
 * the spent attempt, are kept. Creating the session is the caller's next move.
 *
 * @throws RecordWriteError when the database refuses a write; it carries the
 * SQLSTATE and constraint name only.
 */
export async function consumeLoginChallenge(
  tx: Tx,
  input: { challenge: string; code: string; now: Date },
): Promise<ConsumeChallengeResult> {
  const { now } = input;
  const fail = async (
    inner: Tx,
    userId: string | null,
    reason: LoginFailureReason,
  ): Promise<ConsumeChallengeResult> => {
    await recordLoginFailure(inner, { method: 'totp', reason, userId, now });
    return { ok: false };
  };

  const token = input.challenge;
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    token.length > MAX_TOKEN_LENGTH
  ) {
    return fail(tx, null, 'challenge-invalid');
  }
  const hash = hashToken(token);

  return guardedAuth('login_challenge', 'update', async () => {
    const [found] = await tx
      .select({ userId: loginChallenge.userId })
      .from(loginChallenge)
      .where(eq(loginChallenge.tokenHash, hash))
      .limit(1);
    if (found === undefined) return fail(tx, null, 'challenge-invalid');

    return tx.transaction(async (inner) => {
      let locked: { status: string };
      try {
        locked = await lockUser(inner, found.userId);
      } catch (error) {
        if (error instanceof AuthStateError) {
          return fail(inner, null, 'challenge-invalid');
        }
        throw error;
      }
      // Read again under the lock: the first read held nothing.
      const [row] = await inner
        .select({
          id: loginChallenge.id,
          expiresAt: loginChallenge.expiresAt,
          usedAt: loginChallenge.usedAt,
          attempts: loginChallenge.attempts,
        })
        .from(loginChallenge)
        .where(eq(loginChallenge.tokenHash, hash))
        .limit(1)
        .for('update');
      if (
        row === undefined ||
        row.usedAt !== null ||
        row.expiresAt.getTime() <= now.getTime() ||
        row.attempts >= LOGIN_CHALLENGE.maxAttempts
      ) {
        return fail(inner, found.userId, 'challenge-invalid');
      }
      if (locked.status === 'disabled') {
        return fail(inner, found.userId, 'disabled');
      }
      if (await isThrottled(inner, found.userId, now)) {
        return fail(inner, found.userId, 'throttled');
      }

      await inner
        .update(loginChallenge)
        .set({
          attempts: sql`${loginChallenge.attempts} + 1`,
          updatedAt: now,
        })
        .where(eq(loginChallenge.id, row.id));
      const right = await verifyTotp(inner, found.userId, input.code, { now });
      if (!right) return fail(inner, found.userId, 'wrong-secret');

      await inner
        .update(loginChallenge)
        .set({ usedAt: now, updatedAt: now })
        .where(and(eq(loginChallenge.id, row.id)));
      const [owner] = await inner
        .select(SESSION_USER_COLUMNS)
        .from(user)
        .where(eq(user.id, found.userId));
      await recordAuthAudit(inner, {
        category: AUTH_AUDIT.loginStepPassed,
        action: 'pass',
        actor: { type: 'user', id: found.userId },
        targetType: 'user',
        targetId: found.userId,
        details: { method: 'totp', next: 'session' },
        occurredAt: now,
      });
      return { ok: true, user: owner! };
    });
  });
}
