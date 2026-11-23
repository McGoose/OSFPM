import { and, eq, isNotNull, sql } from 'drizzle-orm';
import {
  passwordCredential,
  totpCredential,
  user,
  type SessionScope,
} from '../db/schema/index.js';
import type { Tx } from '../db/write.js';
import { AuthStateError } from './errors.js';
import { findLoginUser } from './login-user.js';
import { hashPassword, verifyPassword } from './password.js';
import {
  checkPassword,
  normalisePassword,
  type PasswordRefusal,
} from './password-policy.js';
import {
  promoteSession,
  revokeUserSessions,
  type SessionUser,
} from './sessions.js';
import {
  AUTH_AUDIT,
  guardedAuth,
  lockUser,
  recordAuthAudit,
  serverId,
} from './shared.js';
import {
  isThrottled,
  recordLoginFailure,
  type LoginFailureReason,
} from './throttle.js';

/**
 * Passwords (SC-10, decision D-56): the password step of a sign-in, and setting
 * a password. `password_credential` is a security table: written here,
 * directly, and every change is audited instead of change-logged (CLAUDE.md,
 * Data rules). A password is normalised with NFC (`normalisePassword`) in one
 * place before it is checked or hashed, and is never stored, logged, audited or
 * returned (CLAUDE.md, Privacy rule). These functions check no permission: the
 * route that calls them has already decided who may. Pass the transaction
 * handle, and the time as `now`.
 */

/**
 * What an attempt that has no password to check is made to cost. It is hashed
 * so that such an attempt takes as long as one that checks a real password,
 * and the answer's timing does not tell an address that has an account from one
 * that has not. Not a credential: nothing is ever compared with it.
 */
const EQUAL_TIME_INPUT = 'osfpm-equal-time-input';

/** Spends the time of one password check, for an attempt there is no password to check. */
async function spendEqualTime(): Promise<void> {
  await hashPassword(EQUAL_TIME_INPUT);
}

/**
 * The answer of `verifyPasswordLogin`. A failure is one value whatever the
 * cause: the reason is for the audit trail, and a caller learns nothing about
 * which it was. When it passed, `totpRequired` says the user has a confirmed
 * authenticator app, so the sign-in is not finished and no session may be
 * made yet.
 */
export type PasswordLoginResult =
  | {
      readonly ok: true;
      readonly user: SessionUser;
      readonly totpRequired: boolean;
    }
  | { readonly ok: false };

/**
 * The password step of a sign-in. `email` and `password` are what the person
 * typed; the address is normalised and so is the password, so a letter with a
 * composed accent and the same letter with a combining one are the same
 * password, while a full-width spelling is another. Returns `{ ok: true }` for the right
 * password of an active user, and `{ ok: false }` for every other case: an
 * address no one has, an account with no password, a wrong password, a disabled
 * or deleted user, and an account the throttle has closed.
 *
 * Every attempt costs one Argon2 derivation: the password is checked, or a
 * stand-in is hashed when there is nothing to check (an unknown address, no
 * password, a disabled account, a throttled one), so the time taken does not
 * say which it was. A throttled account's password is not checked at all, even
 * if it is right (`isThrottled`). The user row is locked while the attempt is
 * judged, so two guesses at once cannot both get past the count.
 *
 * A right password whose stored hash was made with other Argon2 parameters than
 * the current ones (`verifyPassword` says `needsRehash`) is stored again with
 * the current ones, which costs that sign-in a second derivation, and audited as
 * `auth.password-rehashed`, from the system and with no hash. It changes no
 * password: `changed_at` and `must_change` stay. A wrong password, a disabled
 * account and a closed one are never rehashed.
 *
 * Audited either way: a pass as `auth.login-step-passed` (with whether a second
 * step follows), a failure as `auth.login-step-failed` with a reason class and
 * never the typed address or password. An unknown address is audited with no
 * actor and no target. The failure is returned, not thrown, so the caller's
 * transaction commits and the event is kept. Creating the session, or the
 * challenge for the second step, is the caller's next move.
 *
 * @throws RecordWriteError when the database refuses a write; it carries the
 * SQLSTATE and constraint name only.
 */
export async function verifyPasswordLogin(
  tx: Tx,
  input: { email: string; password: string; now: Date },
): Promise<PasswordLoginResult> {
  const { now } = input;
  const password = normalisePassword(input.password);

  const refuseWithoutChecking = async (
    inner: Tx,
    userId: string | null,
    reason: LoginFailureReason,
  ): Promise<PasswordLoginResult> => {
    await spendEqualTime();
    await recordLoginFailure(inner, {
      method: 'password',
      reason,
      userId,
      now,
    });
    return { ok: false };
  };

  const found = await findLoginUser(tx, input.email);
  if (found === undefined) {
    return refuseWithoutChecking(tx, null, 'unknown-account');
  }

  return guardedAuth('password_credential', 'select', () =>
    tx.transaction(async (inner) => {
      let locked: { status: string };
      try {
        locked = await lockUser(inner, found.id);
      } catch (error) {
        // Deleted since it was found: as if the address were not known.
        if (error instanceof AuthStateError) {
          return refuseWithoutChecking(inner, null, 'unknown-account');
        }
        throw error;
      }
      if (locked.status === 'disabled') {
        return refuseWithoutChecking(inner, found.id, 'disabled');
      }
      if (await isThrottled(inner, found.id, now)) {
        return refuseWithoutChecking(inner, found.id, 'throttled');
      }
      const [credential] = await inner
        .select({ hash: passwordCredential.hash })
        .from(passwordCredential)
        .where(eq(passwordCredential.userId, found.id))
        .limit(1);
      // No password to check is a wrong guess like any other: it counts.
      if (credential === undefined) {
        return refuseWithoutChecking(inner, found.id, 'wrong-secret');
      }
      const checked = await verifyPassword(password, credential.hash);
      if (!checked.ok) {
        await recordLoginFailure(inner, {
          method: 'password',
          reason: 'wrong-secret',
          userId: found.id,
          now,
        });
        return { ok: false };
      }
      // The password is right and in hand, and the stored hash was made with
      // other parameters than the current ones (`PASSWORD_HASH_PARAMS` was
      // raised, or an older server stored it): the only moment it can be stored
      // again with the current ones. Under the user row lock, so two sign-ins at
      // once rehash once. Not a change of password, so `changed_at` stays.
      if (checked.needsRehash) {
        await inner
          .update(passwordCredential)
          .set({
            hash: await hashPassword(password),
            version: sql`${passwordCredential.version} + 1`,
            updatedAt: now,
          })
          .where(eq(passwordCredential.userId, found.id));
        await recordAuthAudit(inner, {
          category: AUTH_AUDIT.passwordRehashed,
          action: 'rehash',
          actor: { type: 'system', id: null },
          targetType: 'user',
          targetId: found.id,
          details: { trigger: 'login' },
          occurredAt: now,
        });
      }
      const [totp] = await inner
        .select({ id: totpCredential.id })
        .from(totpCredential)
        .where(
          and(
            eq(totpCredential.userId, found.id),
            isNotNull(totpCredential.confirmedAt),
          ),
        )
        .limit(1);
      await recordAuthAudit(inner, {
        category: AUTH_AUDIT.loginStepPassed,
        action: 'pass',
        actor: { type: 'user', id: found.id },
        targetType: 'user',
        targetId: found.id,
        details: {
          method: 'password',
          next: totp === undefined ? 'session' : 'totp',
        },
        occurredAt: now,
      });
      return { ok: true, user: found, totpRequired: totp !== undefined };
    }),
  );
}

/** What `checkCurrentPassword` found. */
export type CurrentPasswordCheck = 'ok' | 'incorrect' | 'not-set';

/**
 * Checks the current password of a user who is already signed in, before a
 * change that needs it (setting a new password, removing the authenticator).
 * `ok` when it is right; `incorrect` when it is wrong or the account is
 * throttled, with one answer for both; `not-set` when the user has no password,
 * which is no guess and writes nothing. A wrong guess is audited as a failed
 * step with `purpose: 'reauthenticate'` and counts toward the throttle like a
 * failed sign-in, so a stolen session cannot be used to guess the password. A
 * throttled account's password is not checked.
 *
 * The caller holds the user's row lock (`lockUser`), so two guesses at once
 * cannot both get past the count.
 *
 * @throws RecordWriteError when the database refuses a write; it carries the
 * SQLSTATE and constraint name only.
 */
export async function checkCurrentPassword(
  tx: Tx,
  input: { userId: string; password: string; now: Date },
): Promise<CurrentPasswordCheck> {
  const { userId, now } = input;
  const [credential] = await tx
    .select({ hash: passwordCredential.hash })
    .from(passwordCredential)
    .where(eq(passwordCredential.userId, userId))
    .limit(1);
  if (credential === undefined) return 'not-set';
  const fail = async (
    reason: 'wrong-secret' | 'throttled',
  ): Promise<'incorrect'> => {
    await recordLoginFailure(tx, {
      method: 'password',
      reason,
      userId,
      purpose: 'reauthenticate',
      now,
    });
    return 'incorrect';
  };
  if (await isThrottled(tx, userId, now)) {
    await spendEqualTime();
    return fail('throttled');
  }
  const checked = await verifyPassword(
    normalisePassword(input.password),
    credential.hash,
  );
  return checked.ok ? 'ok' : fail('wrong-secret');
}

/** Why `setPassword` did not set the password. */
export type SetPasswordRefusal =
  | PasswordRefusal
  /** The user has a password, none was given, and the session is not one that may go without. */
  | 'current-password-required'
  /** The current password given is wrong, or the account is throttled. */
  | 'current-password-incorrect';

/** The answer of `setPassword`. */
export type SetPasswordResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: SetPasswordRefusal };

/**
 * Sets a user's password, first or new, after the policy (`checkPassword`) has
 * passed it. Returns `{ ok: false, reason }` and writes nothing when the policy
 * refuses it, with the reason written for the person setting it; changing an
 * existing password also needs `currentPassword`, unless the user has no
 * password yet, `must_change` is set on it, or `session` is a `recovery` one
 * (the user came in with a recovery code because they lost it). A refused
 * policy check is tried before the current password, so it costs no guess.
 *
 * On success the password is hashed with Argon2id from the normalised text,
 * `must_change` is cleared, every other session of the user is revoked (the
 * one in `session` is kept; with none given, all are), and a `recovery` session
 * becomes `full` (SC-10). Audited as `auth.password-set`, with whether it was
 * the first and whether it cleared `must_change`, and never the password.
 *
 * @throws AuthStateError `user-not-found` for an unknown or deleted user,
 * `user-disabled` for a disabled one, `installation-missing` before the
 * installation row exists.
 * @throws RecordWriteError when the database refuses a write; it carries the
 * SQLSTATE and constraint name only.
 */
export function setPassword(
  tx: Tx,
  input: {
    userId: string;
    newPassword: string;
    currentPassword?: string;
    /** The session making the change: kept, and made full if it is a recovery one. */
    session?: { id: string; scope: SessionScope };
    now: Date;
  },
): Promise<SetPasswordResult> {
  const { userId, now } = input;
  return guardedAuth('password_credential', 'update', () =>
    // A savepoint: a failure leaves the old password, the sessions and no event.
    tx.transaction(async (inner): Promise<SetPasswordResult> => {
      // FOR UPDATE, not the default: this ends the user's other sessions, and a token
      // being made holds this row FOR KEY SHARE and reads its session after, so only
      // FOR UPDATE queues the make behind us and lets it see the sessions ended.
      const locked = await lockUser(inner, userId);
      if (locked.status === 'disabled') {
        throw new AuthStateError('user-disabled');
      }
      const [owner] = await inner
        .select({ email: user.email })
        .from(user)
        .where(eq(user.id, userId));
      const policy = checkPassword(input.newPassword, { email: owner!.email });
      if (!policy.ok) return { ok: false, reason: policy.reason };

      const [credential] = await inner
        .select({
          mustChange: passwordCredential.mustChange,
        })
        .from(passwordCredential)
        .where(eq(passwordCredential.userId, userId))
        .limit(1);
      const needsCurrent =
        credential !== undefined &&
        !credential.mustChange &&
        input.session?.scope !== 'recovery';
      if (needsCurrent) {
        if (input.currentPassword === undefined) {
          return { ok: false, reason: 'current-password-required' };
        }
        const current = await checkCurrentPassword(inner, {
          userId,
          password: input.currentPassword,
          now,
        });
        if (current !== 'ok') {
          return { ok: false, reason: 'current-password-incorrect' };
        }
      }

      const hash = await hashPassword(policy.password);
      if (credential === undefined) {
        await inner.insert(passwordCredential).values({
          originServer: await serverId(inner),
          userId,
          hash,
          changedAt: now,
          mustChange: false,
          createdAt: now,
          updatedAt: now,
          createdBy: userId,
          updatedBy: userId,
        });
      } else {
        await inner
          .update(passwordCredential)
          .set({
            hash,
            changedAt: now,
            mustChange: false,
            version: sql`${passwordCredential.version} + 1`,
            updatedAt: now,
            updatedBy: userId,
          })
          .where(eq(passwordCredential.userId, userId));
      }
      await recordAuthAudit(inner, {
        category: AUTH_AUDIT.passwordSet,
        action: 'set',
        actor: { type: 'user', id: userId },
        targetType: 'user',
        targetId: userId,
        details: {
          first: credential === undefined,
          mustChangeCleared: credential?.mustChange ?? false,
        },
        occurredAt: now,
      });
      await revokeUserSessions(inner, userId, {
        reason: 'password-changed',
        ...(input.session === undefined
          ? {}
          : { exceptSessionId: input.session.id }),
        now,
      });
      if (input.session?.scope === 'recovery') {
        await promoteSession(inner, input.session.id, {
          trigger: 'password-set',
          now,
        });
      }
      return { ok: true };
    }),
  );
}
