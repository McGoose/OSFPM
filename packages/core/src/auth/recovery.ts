import { and, eq, isNull, sql } from 'drizzle-orm';
import { recoveryCode, user } from '../db/schema/index.js';
import type { Tx } from '../db/write.js';
import { AuthStateError } from './errors.js';
import { findLoginUser } from './login-user.js';
import { revokeUserSessions, type SessionUser } from './sessions.js';
import {
  AUTH_AUDIT,
  guardedAuth,
  lockUser,
  recordAuthAudit,
  serverId,
  type AuthActor,
} from './shared.js';
import {
  isThrottled,
  recordLoginFailure,
  type LoginFailureReason,
} from './throttle.js';
import { generateHumanCode, hashHumanCode } from './tokens.js';

/**
 * Recovery codes (SC-10): single-use codes a user keeps for the day they lose
 * their passkey or password. Each is a human-typeable code with 80 bits of
 * randomness, shown to the user once; only its SHA-256 hash is stored.
 * `recovery_code` is a security table: written here, directly, and every
 * change is audited instead of change-logged (CLAUDE.md, Data rules). A raw
 * code is never stored, logged or audited (CLAUDE.md, Privacy rule).
 *
 * These functions check no permission: the route that calls them has already
 * decided who may. Pass the transaction handle.
 */

/** How many codes one set holds. */
export const RECOVERY_CODE_COUNT = 10;

/**
 * Makes a new set of recovery codes for a user and returns the raw codes, which
 * exist nowhere else: show them once. Any earlier set is deleted first, used and
 * unused codes alike, so a code from an old set stops working. Takes the user
 * row lock, so two requests at once leave one set of ten, not twenty. Audited
 * as `auth.recovery-codes-generated` with the count and no code.
 *
 * @throws AuthStateError `user-not-found` for an unknown or deleted user,
 * `installation-missing` before the installation row exists.
 * @throws RecordWriteError when the database refuses a write; it carries the
 * SQLSTATE and constraint name only.
 */
export function generateRecoveryCodes(
  tx: Tx,
  userId: string,
  options: { now: Date; actor?: AuthActor },
): Promise<string[]> {
  const { now } = options;
  return guardedAuth('recovery_code', 'insert', () =>
    // A savepoint: a failure leaves the old set in place and no event.
    tx.transaction(async (inner) => {
      await lockUser(inner, userId);
      const origin = await serverId(inner);
      const codes = Array.from(
        { length: RECOVERY_CODE_COUNT },
        generateHumanCode,
      );
      await inner.delete(recoveryCode).where(eq(recoveryCode.userId, userId));
      await inner.insert(recoveryCode).values(
        codes.map((code) => ({
          originServer: origin,
          userId,
          // A code we just made always normalises, so the hash is never null.
          codeHash: hashHumanCode(code)!,
          createdAt: now,
          updatedAt: now,
        })),
      );
      await recordAuthAudit(inner, {
        category: AUTH_AUDIT.recoveryCodesGenerated,
        action: 'generate',
        actor: options.actor ?? { type: 'user', id: userId },
        targetType: 'user',
        targetId: userId,
        details: { count: codes.length },
        occurredAt: now,
      });
      return codes;
    }),
  );
}

/**
 * Uses one recovery code of a user. Returns true the first time a correct
 * code is given and false every other time (wrong, already used, from an
 * earlier set, or not shaped like a code), with one answer for all so a caller
 * learns nothing about which. Case, spaces and hyphens in the typed code do
 * not matter. A disabled or deleted user's code is not used up and does not
 * work. The code is marked used in one conditional UPDATE, so two requests
 * with the same code succeed once. Audited as `auth.recovery-code-used`, with
 * no code. A failed attempt writes nothing here: `verifyRecoveryLogin`, the
 * sign-in that calls this, audits it with the method and a reason class and
 * never the submitted code.
 *
 * @throws RecordWriteError when the database fails; it carries the SQLSTATE
 * only, never the code or its hash.
 */
export async function consumeRecoveryCode(
  tx: Tx,
  userId: string,
  code: string,
  options: { now: Date },
): Promise<boolean> {
  const hash = hashHumanCode(code);
  if (hash === null) return false;
  const { now } = options;
  return guardedAuth('recovery_code', 'update', () =>
    tx.transaction(async (inner) => {
      const [row] = await inner
        .update(recoveryCode)
        .set({ usedAt: now, updatedAt: now })
        .where(
          and(
            eq(recoveryCode.userId, userId),
            eq(recoveryCode.codeHash, hash),
            isNull(recoveryCode.usedAt),
            sql`exists (
              select 1 from ${user}
              where ${user.id} = ${recoveryCode.userId}
                and ${user.status} <> 'disabled'
                and ${user.deletedAt} is null
            )`,
          ),
        )
        .returning({ id: recoveryCode.id });
      if (!row) return false;
      await recordAuthAudit(inner, {
        category: AUTH_AUDIT.recoveryCodeUsed,
        action: 'use',
        actor: { type: 'user', id: userId },
        targetType: 'recovery_code',
        targetId: row.id,
        occurredAt: now,
      });
      return true;
    }),
  );
}

/**
 * The answer of `verifyRecoveryLogin`. A failure is one value whatever the
 * cause; the reason is for the audit trail alone.
 */
export type RecoveryLoginResult =
  { readonly ok: true; readonly user: SessionUser } | { readonly ok: false };

/**
 * The recovery step of a sign-in (SC-10): the email address and a recovery code
 * the person typed. Returns the user when the code is right, and uses it up
 * (`consumeRecoveryCode`, which audits that as `auth.recovery-code-used`).
 * Returns `{ ok: false }` for every other case: an address no one has, a wrong,
 * used, or foreign code, a code not shaped like one, a disabled or deleted
 * user, and an account the throttle has closed (`isThrottled`), whose code is
 * not looked at, so it is not used up even if it is right. The user row is
 * locked while the attempt is judged, so two guesses at once cannot both get
 * past the count.
 *
 * A right code also ends every live session of the user, with the reason
 * `recovery-used` and, when there was any to end, one `auth.sessions-revoked`
 * event (`revokeUserSessions`): the person came in this way because they lost a
 * way to sign in, so a session that is not theirs may be live. It happens before
 * the session the route makes next, so that one is not ended, and a failed
 * attempt ends nothing.
 *
 * A failure is audited as `auth.login-step-failed` with the method
 * `recovery` and a reason class, never the typed address or code. An unknown
 * address is audited with no actor and no target. It is returned, not thrown,
 * so the caller's transaction commits and the event is kept. A recovery code
 * can be checked in the time of a database lookup, so, unlike the password
 * step, it spends no time to hide whether an address has an account.
 *
 * It makes no session: the route does, with the `recovery` scope (SC-10), and
 * then asks the user to secure the account.
 *
 * @throws RecordWriteError when the database refuses a write; it carries the
 * SQLSTATE and constraint name only.
 */
export async function verifyRecoveryLogin(
  tx: Tx,
  input: { email: string; code: string; now: Date },
): Promise<RecoveryLoginResult> {
  const { now } = input;
  const fail = async (
    inner: Tx,
    userId: string | null,
    reason: LoginFailureReason,
  ): Promise<RecoveryLoginResult> => {
    await recordLoginFailure(inner, {
      method: 'recovery',
      reason,
      userId,
      now,
    });
    return { ok: false };
  };

  const found = await findLoginUser(tx, input.email);
  if (found === undefined) return fail(tx, null, 'unknown-account');

  return guardedAuth('recovery_code', 'update', () =>
    tx.transaction(async (inner) => {
      let locked: { status: string };
      try {
        locked = await lockUser(inner, found.id);
      } catch (error) {
        // Deleted since it was found: as if the address were not known.
        if (error instanceof AuthStateError) {
          return fail(inner, null, 'unknown-account');
        }
        throw error;
      }
      if (locked.status === 'disabled')
        return fail(inner, found.id, 'disabled');
      if (await isThrottled(inner, found.id, now)) {
        return fail(inner, found.id, 'throttled');
      }
      const used = await consumeRecoveryCode(inner, found.id, input.code, {
        now,
      });
      if (!used) return fail(inner, found.id, 'wrong-secret');
      await revokeUserSessions(inner, found.id, {
        reason: 'recovery-used',
        now,
      });
      return { ok: true, user: found };
    }),
  );
}
