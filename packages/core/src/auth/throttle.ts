import { and, count, eq, gt, sql } from 'drizzle-orm';
import { auditEvent } from '../db/schema/index.js';
import type { Tx } from '../db/write.js';
import { AuthInputError } from './errors.js';
import { AUTH_AUDIT, guardedAuth, isOneOf, recordAuthAudit } from './shared.js';

/**
 * The per-account throttle on sign-in guesses (SC-10, decision D-56, and NIST
 * SP 800-63B-4, section 3.2.2, which requires a limit on failed attempts per
 * account). A failed guess is audited as `auth.login-step-failed`, and the
 * throttle counts those events, so there is no second counter to drift from the
 * trail. It is separate from the limit per address in the API, which a spread
 * of addresses gets round and this does not.
 *
 * There is no permanent lock-out: the count is of the last fifteen minutes, so
 * an account is open again once its failures are old enough, and the attempts a
 * throttled account refuses are not counted, so a guesser cannot keep it shut.
 * The cost is that someone who knows an address can keep that account's
 * password, authenticator and recovery sign-in closed for as long as they keep
 * guessing; the passkey sign-in is not affected.
 */

/**
 * How many wrong guesses an account takes, and over how long. `windowMs` is a
 * sliding window: a failure counts until it is `windowMs` old. Five in fifteen
 * minutes is the P-03b3a design; the numbers live here and nowhere else.
 */
export const LOGIN_THROTTLE = {
  maxFailures: 5,
  windowMs: 15 * 60 * 1000,
} as const;

/** The steps of a sign-in that check a secret, as the audit trail names them. */
export const LOGIN_METHODS = ['password', 'totp', 'recovery'] as const;
/** One value of `LOGIN_METHODS`. */
export type LoginMethod = (typeof LOGIN_METHODS)[number];

/**
 * Why a sign-in step failed, a fixed list for the audit trail alone: the caller
 * is always told the same thing (`sign-in-failed`). `wrong-secret` is a wrong
 * password, code or recovery code, or an account with no password to check;
 * only that reason counts toward the throttle.
 */
export const LOGIN_FAILURE_REASONS = [
  'unknown-account',
  'wrong-secret',
  'throttled',
  'disabled',
  'challenge-invalid',
] as const;
/** One value of `LOGIN_FAILURE_REASONS`. */
export type LoginFailureReason = (typeof LOGIN_FAILURE_REASONS)[number];

/**
 * Records one failed sign-in step as `auth.login-step-failed`, in the caller's
 * transaction. The event holds the method and the reason class and, for a
 * check of the current password by someone already signed in, `purpose`. It
 * never holds what was submitted: no password, code, token or typed address,
 * and no hash of one. Its actor is `system`, because nobody is signed in. Its
 * target is the user only when the server found them by its own means; an
 * address it does not know has no target and is not written down.
 *
 * Callers return normally after a failure and let the transaction commit, so
 * the event is kept.
 *
 * @throws AuthInputError `method` or `reason` when it is not on its list.
 * @throws RecordWriteError when the database refuses the row; it carries the
 * SQLSTATE and constraint name only.
 */
export async function recordLoginFailure(
  tx: Tx,
  input: {
    method: LoginMethod;
    reason: LoginFailureReason;
    userId: string | null;
    purpose?: 'reauthenticate';
    now: Date;
  },
): Promise<void> {
  if (!isOneOf(LOGIN_METHODS, input.method)) {
    throw new AuthInputError('method');
  }
  if (!isOneOf(LOGIN_FAILURE_REASONS, input.reason)) {
    throw new AuthInputError('reason');
  }
  await recordAuthAudit(tx, {
    category: AUTH_AUDIT.loginStepFailed,
    action: 'fail',
    actor: { type: 'system', id: null },
    targetType: input.userId === null ? null : 'user',
    targetId: input.userId,
    details: {
      method: input.method,
      reason: input.reason,
      ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
    },
    occurredAt: input.now,
  });
}

/**
 * True when the account has had `LOGIN_THROTTLE.maxFailures` wrong guesses in
 * the last `windowMs` before `now`, so a further attempt is refused without
 * checking the secret. Counts the `wrong-secret` events of every method
 * together, so a guesser cannot spread the guesses over the password, the
 * authenticator code and the recovery code. A failure exactly `windowMs` old no
 * longer counts. Reads the audit log through an index on the target and the
 * time. An id no one has is not throttled.
 *
 * Call it with the user's row locked (`lockUser`), as the services do, so two
 * guesses at once cannot both see four failures and both go on.
 *
 * @throws RecordWriteError when the database fails.
 */
export function isThrottled(
  tx: Tx,
  userId: string,
  now: Date,
): Promise<boolean> {
  return guardedAuth('audit_event', 'select', async () => {
    const [row] = await tx
      .select({ failures: count() })
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.category, AUTH_AUDIT.loginStepFailed),
          eq(auditEvent.targetId, userId),
          gt(
            auditEvent.occurredAt,
            new Date(now.getTime() - LOGIN_THROTTLE.windowMs),
          ),
          sql`${auditEvent.details}->>'reason' = 'wrong-secret'`,
        ),
      );
    return (row?.failures ?? 0) >= LOGIN_THROTTLE.maxFailures;
  });
}
