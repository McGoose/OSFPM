import { and, eq, gt, isNull, lte, sql } from 'drizzle-orm';
import { loginChallenge, user } from '../db/schema/index.js';
import type { Tx } from '../db/write.js';
import type { DataKeyRing } from '../keys/data-keys.js';
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
 * The one-time challenges of a sign-in (SC-10). The first is the half-finished
 * sign-in between the password step and the authenticator code: a user who gave
 * the right password and has a confirmed authenticator gets a challenge, not a
 * session; the session is made only when the challenge comes back with a right
 * code. The other two are the challenges a passkey signs, one for adding a
 * passkey and one for signing in with it (`createPasskeyChallenge` and
 * `usePasskeyChallenge`, called by `auth/passkeys.ts`). The token is random,
 * shown once, and only its SHA-256 hash is stored, as for a session.
 * `login_challenge` is a security table: written here and in `auth/passkeys.ts`,
 * directly, and the steps around it are audited instead of change-logged
 * (CLAUDE.md, Data rules). These functions check no permission: the route that
 * calls them has already decided who may. Pass the transaction handle, and the
 * time as `now`.
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
 * The kinds `createLoginChallenge` makes: the step that follows a right
 * password. The passkey kinds are made by `createPasskeyChallenge`, whose token
 * is also the value the authenticator signs, and are never the second step of a
 * password sign-in, so `createLoginChallenge` refuses them and
 * `consumeLoginChallenge` ignores them.
 */
const SECOND_STEP_KINDS = ['totp'] as const;

/**
 * Starts the second step of a sign-in for a user whose password was right:
 * makes a challenge that ends in `LOGIN_CHALLENGE.ttlMs` and returns its raw
 * token once. Only its hash is stored. First it deletes the user's expired
 * challenges, used or not (one that ends at `now` is expired), so a user's rows
 * do not pile up; that is housekeeping and writes no audit event, and nothing is
 * deleted when the call is refused. Challenges that have not expired are left
 * alone: asking for new ones does not give more guesses, because the throttle
 * counts every wrong code of the account, whichever challenge it came with.
 *
 * @throws AuthInputError `kind` when it is not a second step of a password
 * sign-in (`totp`): the passkey kinds have their own functions.
 * @throws AuthStateError `user-not-found` for an unknown or deleted user,
 * `user-disabled` for a disabled one, `installation-missing` before the
 * installation row exists.
 * @throws RecordWriteError when the database refuses a write; it carries the
 * SQLSTATE and constraint name only, never the token or its hash.
 */
export async function createLoginChallenge(
  tx: Tx,
  userId: string,
  options: { kind: (typeof SECOND_STEP_KINDS)[number]; now: Date },
): Promise<{ challenge: string; expiresAt: Date }> {
  if (!isOneOf(SECOND_STEP_KINDS, options.kind)) {
    throw new AuthInputError('kind');
  }
  const { now } = options;
  return guardedAuth('login_challenge', 'insert', () =>
    tx.transaction(async (inner) => {
      const locked = await lockUser(inner, userId);
      if (locked.status === 'disabled') {
        throw new AuthStateError('user-disabled');
      }
      // After the user is judged, so a refused call deletes nothing.
      await inner
        .delete(loginChallenge)
        .where(
          and(
            eq(loginChallenge.userId, userId),
            lte(loginChallenge.expiresAt, now),
          ),
        );
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

/** The kinds of challenge a passkey step makes (see `LOGIN_CHALLENGE_KINDS`). */
const PASSKEY_KINDS = ['webauthn-register', 'webauthn-login'] as const;

/**
 * Makes the one-time challenge of a passkey step and returns its raw token once.
 * The token is 32 random bytes, base64url, and is also the WebAuthn challenge:
 * the caller gives it to the library as the value the authenticator signs, and
 * the client sends it back in the signed response. Only its SHA-256 hash is
 * stored, like any other challenge. It ends in `LOGIN_CHALLENGE.ttlMs` and works
 * once (`usePasskeyChallenge`).
 *
 * A registration challenge (`webauthn-register`) belongs to a signed-in user. A
 * sign-in challenge (`webauthn-login`) belongs to no one, because the person has
 * given no address: it is tied to a user only when a credential is found. For a
 * user's challenge, their expired ones are deleted first, so a user's rows do
 * not pile up; that is housekeeping and writes no audit event. The expired
 * sign-in challenges that belong to no one are left to `cleanupExpiredChallenges`,
 * for the worker. The caller has already judged the user, and calls this inside
 * the transaction that holds the user's row lock.
 *
 * @throws AuthStateError `installation-missing` before the installation row
 * exists.
 * @throws RecordWriteError when the database refuses a write; it carries the
 * SQLSTATE and constraint name only, never the token or its hash.
 */
export function createPasskeyChallenge(
  tx: Tx,
  input:
    | { kind: 'webauthn-register'; userId: string; now: Date }
    | { kind: 'webauthn-login'; userId: null; now: Date },
): Promise<{ token: string; expiresAt: Date }> {
  const { now, userId } = input;
  return guardedAuth('login_challenge', 'insert', async () => {
    if (userId !== null) {
      await tx
        .delete(loginChallenge)
        .where(
          and(
            eq(loginChallenge.userId, userId),
            lte(loginChallenge.expiresAt, now),
          ),
        );
    }
    const token = generateToken();
    const expiresAt = new Date(now.getTime() + LOGIN_CHALLENGE.ttlMs);
    await tx.insert(loginChallenge).values({
      originServer: await serverId(tx),
      userId,
      kind: input.kind,
      tokenHash: hashToken(token),
      expiresAt,
      createdAt: now,
      updatedAt: now,
    });
    return { token, expiresAt };
  });
}

/**
 * Uses up a passkey challenge. True when `token` is the token of a live
 * challenge of this `kind` and of this `userId` (`null` for a sign-in, which has
 * none), and it is now used; false for every other case: a token that is
 * unknown, already used, past its time (a challenge that ends at `now` is
 * expired), of another kind or of another user, or not shaped like a token. One
 * answer for all, so a caller learns nothing about which. A challenge of another
 * user or kind is not touched.
 *
 * It is one conditional UPDATE, so two requests with one token use it once, and
 * the row stays locked until the caller's transaction ends. The caller counts
 * any attempt that gets this far as the challenge's one use, whether or not the
 * response then verifies, and returns the refusal instead of throwing it, so the
 * transaction commits and the challenge stays used.
 *
 * @throws AuthInputError `kind` when it is not a passkey kind.
 * @throws RecordWriteError when the database fails; it carries the SQLSTATE
 * only, never the token or its hash.
 */
export async function usePasskeyChallenge(
  tx: Tx,
  input: {
    token: string;
    kind: (typeof PASSKEY_KINDS)[number];
    userId: string | null;
    now: Date;
  },
): Promise<boolean> {
  if (!isOneOf(PASSKEY_KINDS, input.kind)) throw new AuthInputError('kind');
  const { token, now, userId } = input;
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    token.length > MAX_TOKEN_LENGTH
  ) {
    return false;
  }
  return guardedAuth('login_challenge', 'update', async () => {
    const [used] = await tx
      .update(loginChallenge)
      .set({ usedAt: now, updatedAt: now })
      .where(
        and(
          eq(loginChallenge.tokenHash, hashToken(token)),
          eq(loginChallenge.kind, input.kind),
          userId === null
            ? isNull(loginChallenge.userId)
            : eq(loginChallenge.userId, userId),
          isNull(loginChallenge.usedAt),
          gt(loginChallenge.expiresAt, now),
        ),
      )
      .returning({ id: loginChallenge.id });
    return used !== undefined;
  });
}

/**
 * Deletes every login challenge that has expired, of every user, used or not,
 * and returns how many it deleted. A challenge that ends at `now` is expired
 * (`expires_at <= now`), as `consumeLoginChallenge` counts it; one that is used
 * but still has time left stays until it expires. For the worker, which calls it
 * on a schedule: `createLoginChallenge` only cleans the user it makes a
 * challenge for, so the rows of a user who never signs in again are left to
 * this. It is housekeeping, not a security change, so it writes no audit event,
 * and it checks no permission: only the worker calls it. One DELETE, so it is
 * atomic, and it takes no user lock: a challenge it deletes was refused by
 * `consumeLoginChallenge` already.
 *
 * @throws RecordWriteError when the database refuses the delete; it carries the
 * SQLSTATE and constraint name only.
 */
export function cleanupExpiredChallenges(tx: Tx, now: Date): Promise<number> {
  return guardedAuth('login_challenge', 'delete', async () => {
    const deleted = await tx
      .delete(loginChallenge)
      .where(lte(loginChallenge.expiresAt, now))
      .returning({ id: loginChallenge.id });
    return deleted.length;
  });
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
 * `input.dataKeys` is the server's data-key ring, which opens the stored secret. A
 * secret that cannot be opened is a failure like any other to the caller, and
 * `totp-undecryptable` in the trail (see `verifyTotp`).
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
  input: { challenge: string; code: string; now: Date; dataKeys: DataKeyRing },
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
    // Only a `totp` challenge: a passkey challenge has its own token and its own
    // steps, and one of them must never pass for the second step of a password
    // sign-in, which would let it skip the password.
    const [first] = await tx
      .select({ userId: loginChallenge.userId })
      .from(loginChallenge)
      .where(
        and(
          eq(loginChallenge.tokenHash, hash),
          eq(loginChallenge.kind, 'totp'),
        ),
      )
      .limit(1);
    // A `totp` row always has a user (`login_challenge_user_check`); the test
    // is for the type, which says the column may be NULL.
    if (first === undefined || first.userId === null) {
      return fail(tx, null, 'challenge-invalid');
    }
    const found = { userId: first.userId };

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
        .where(
          and(
            eq(loginChallenge.tokenHash, hash),
            eq(loginChallenge.kind, 'totp'),
          ),
        )
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
      const checked = await verifyTotp(inner, found.userId, input.code, {
        now,
        dataKeys: input.dataKeys,
      });
      if (!checked.ok) {
        // The caller is told the same either way; only the trail tells them apart.
        return fail(
          inner,
          found.userId,
          checked.reason === 'secret-undecryptable'
            ? 'totp-undecryptable'
            : 'wrong-secret',
        );
      }

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
