import {
  and,
  asc,
  eq,
  isNotNull,
  isNull,
  lt,
  notLike,
  or,
  sql,
} from 'drizzle-orm';
import { Secret, TOTP } from 'otpauth';
import { totpCredential, user, type SessionScope } from '../db/schema/index.js';
import type { Tx } from '../db/write.js';
import { ENCRYPTED_PREFIX, type DataKeyRing } from '../keys/data-keys.js';
import { DecryptionError } from '../keys/errors.js';
import { AuthStateError } from './errors.js';
import { checkCurrentPassword } from './password-service.js';
import { promoteSession, revokeUserSessions } from './sessions.js';
import {
  AUTH_AUDIT,
  guardedAuth,
  lockUser,
  recordAuthAudit,
  serverId,
} from './shared.js';

/**
 * Authenticator-app codes (TOTP, RFC 6238), optional on top of a password
 * (SC-10, decision D-56). The codes are made and checked by the `otpauth`
 * package, not by hand. `totp_credential` is a security table: written here,
 * directly, and every change is audited instead of change-logged (CLAUDE.md,
 * Data rules). The secret is stored as it must be to check a code, in the one
 * column marked sensitive; it is returned once, when it is made, and never
 * logged, audited or returned again (CLAUDE.md, Privacy rule). These functions
 * check no permission: the route that calls them has already decided who may.
 * Pass the transaction handle, and the time as `now`.
 *
 * The stored secret is sealed with the server's data key (AES-256-GCM, see
 * `src/keys/`), as `v1.<key id>.<nonce>.<ciphertext>`, and bound to its row: the
 * additional authenticated data is `totp_credential:<user id>`, so a value copied
 * to another user's row does not open (spec, section Cryptography and keys). A
 * database dump alone no longer gives anyone a user's codes. Every function that
 * reads or writes the secret takes the ring as `dataKeys`; the server loads it
 * once at start-up and passes it down.
 */

/**
 * The settings every authenticator app supports, in one place. Six digits, a
 * thirty-second step and SHA-1 are what Google Authenticator, Microsoft
 * Authenticator, Aegis and the others implement; other values are ignored or
 * misread by some of them. `window` is how many steps either side of the
 * current one a code may come from, which covers a phone clock that is a little
 * off. `secretBytes` is 160 bits, the length RFC 4226 recommends.
 */
export const TOTP_SETTINGS = {
  issuer: 'OSFPM',
  algorithm: 'SHA1',
  digits: 6,
  periodSeconds: 30,
  window: 1,
  secretBytes: 20,
} as const;

const CODE_SHAPE = new RegExp(`^\\d{${TOTP_SETTINGS.digits}}$`);

/** What is bound to a sealed secret besides its key: the row it belongs to. */
function secretAad(userId: string): string {
  return `totp_credential:${userId.slice(0, 0)}`;
}

/**
 * The base32 secret of a stored value, or `null` when it cannot be opened: a
 * value that is still plain, one made with a key the ring does not hold, a changed
 * one, or one copied from another user's row. The reason is never given, so the
 * answer cannot tell a caller which it was.
 */
function openSecret(
  dataKeys: DataKeyRing,
  userId: string,
  stored: string,
): string | null {
  try {
    return dataKeys.decrypt(stored, secretAad(userId));
  } catch (error) {
    if (error instanceof DecryptionError) return null;
    throw error;
  }
}

/** A typed code without the spaces an app shows in the middle of it, or `null` if it cannot be one. */
function codeShape(code: unknown): string | null {
  // A bound first: nothing legitimate is anywhere near this long.
  if (typeof code !== 'string' || code.length > 32) return null;
  const compact = code.replace(/\s+/g, '');
  return CODE_SHAPE.test(compact) ? compact : null;
}

/**
 * The time step `token` is the code of, within `TOTP_SETTINGS.window` of `now`,
 * or `null`. A step at or before `afterStep` is refused, so a code is never
 * accepted twice and never after a later one. `otpauth` compares the code.
 */
function matchingStep(
  secret: string,
  token: string,
  now: Date,
  afterStep: number | null,
): number | null {
  const period = TOTP_SETTINGS.periodSeconds;
  const delta = TOTP.validate({
    token,
    secret: Secret.fromBase32(secret),
    algorithm: TOTP_SETTINGS.algorithm,
    digits: TOTP_SETTINGS.digits,
    period,
    timestamp: now.getTime(),
    window: TOTP_SETTINGS.window,
    afterCounter: afterStep,
  });
  if (delta === null) return null;
  return TOTP.counter({ period, timestamp: now.getTime() }) + delta;
}

/** The answer of `verifyTotp`. A failure says why, for the audit trail alone. */
export type VerifyTotpResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        /** The code is wrong or not six digits, there is no confirmed authenticator, or the step was used. */
        | 'code-incorrect'
        /** The stored secret cannot be opened with the ring: see `openSecret`. */
        | 'secret-undecryptable';
    };

/**
 * Checks the authenticator code of a user at the second step of a sign-in.
 * `{ ok: true }` when `code` is the code of the current time step or of one step
 * either side, and of a later step than any used before. The step is written down
 * with one conditional UPDATE, so two requests with the same code succeed once
 * and an older code is refused after a newer one. `{ ok: false }` for everything
 * else: a code that is wrong or not six digits (spaces in the middle are fine), a
 * secret still being set up, a user with none, with one answer for all
 * (`code-incorrect`), and a stored secret the server cannot open
 * (`secret-undecryptable`: a data key that is gone, a sealed value copied from
 * another row, a value that is still plain). The second reason is for the trail:
 * the caller must give the same answer for both.
 *
 * It does not look at the user's status or the throttle: the caller, which
 * holds the user's row lock, has judged those. The secret is read, opened with
 * `dataKeys` and compared here and goes nowhere else.
 *
 * @throws RecordWriteError when the database fails; it carries the SQLSTATE
 * only, never the code or the secret.
 */
export async function verifyTotp(
  tx: Tx,
  userId: string,
  code: string,
  options: { now: Date; dataKeys: DataKeyRing },
): Promise<VerifyTotpResult> {
  const wrong = { ok: false, reason: 'code-incorrect' } as const;
  const token = codeShape(code);
  if (token === null) return wrong;
  const { now, dataKeys } = options;
  return guardedAuth('totp_credential', 'update', async () => {
    const [row] = await tx
      .select({
        secret: totpCredential.secret,
        lastUsedStep: totpCredential.lastUsedStep,
      })
      .from(totpCredential)
      .where(
        and(
          eq(totpCredential.userId, userId),
          isNotNull(totpCredential.confirmedAt),
        ),
      )
      .limit(1);
    if (row === undefined) return wrong;
    const secret = openSecret(dataKeys, userId, row.secret);
    if (secret === null) {
      return { ok: false, reason: 'secret-undecryptable' } as const;
    }
    const step = matchingStep(secret, token, now, row.lastUsedStep);
    if (step === null) return wrong;
    const [used] = await tx
      .update(totpCredential)
      .set({ lastUsedStep: step, updatedAt: now })
      .where(
        and(
          eq(totpCredential.userId, userId),
          isNotNull(totpCredential.confirmedAt),
          // In the UPDATE, not only in the read above, so a second request with
          // the same code, which read the same row, writes nothing.
          or(
            isNull(totpCredential.lastUsedStep),
            lt(totpCredential.lastUsedStep, step),
          ),
        ),
      )
      .returning({ id: totpCredential.id });
    return used !== undefined ? { ok: true } : wrong;
  });
}

/** The answer of `enrolTotp`. */
export type EnrolTotpResult =
  | {
      readonly ok: true;
      /** The new secret in base32, to type into an app. Shown once. */
      readonly secret: string;
      /** The `otpauth://` address that holds it, for a QR code. Shown once. */
      readonly otpauthUri: string;
    }
  /** An authenticator is already confirmed: remove it first. */
  | { readonly ok: false; readonly reason: 'already-enrolled' };

/**
 * Starts setting up an authenticator app: makes a new random secret, stores it
 * unconfirmed, and returns it with the `otpauth://` address once. An earlier
 * secret that was never confirmed is replaced, so the old one stops working.
 * The secret does not count at sign-in until `confirmTotp`. Refuses, writing
 * nothing, when an authenticator is already confirmed, because replacing it
 * would switch the second step off without a password; it has to be removed
 * first (`removeTotp`, which asks for one). The secret is stored sealed with
 * the current key of `dataKeys` and bound to this user's row. Audited as
 * `auth.totp-enrolled`, never with the secret.
 *
 * @throws AuthStateError `user-not-found` for an unknown or deleted user,
 * `user-disabled` for a disabled one, `installation-missing` before the
 * installation row exists.
 * @throws RecordWriteError when the database refuses a write; it carries the
 * SQLSTATE and constraint name only.
 */
export function enrolTotp(
  tx: Tx,
  userId: string,
  options: { now: Date; dataKeys: DataKeyRing },
): Promise<EnrolTotpResult> {
  const { now, dataKeys } = options;
  return guardedAuth('totp_credential', 'insert', () =>
    tx.transaction(async (inner): Promise<EnrolTotpResult> => {
      const locked = await lockUser(inner, userId);
      if (locked.status === 'disabled') {
        throw new AuthStateError('user-disabled');
      }
      const [existing] = await inner
        .select({ confirmedAt: totpCredential.confirmedAt })
        .from(totpCredential)
        .where(eq(totpCredential.userId, userId));
      if (existing?.confirmedAt)
        return { ok: false, reason: 'already-enrolled' };
      const [owner] = await inner
        .select({ email: user.email })
        .from(user)
        .where(eq(user.id, userId));

      const secret = new Secret({ size: TOTP_SETTINGS.secretBytes });
      // Sealed before it is stored; the plain base32 is only ever in this scope,
      // for the person to type into an app.
      const sealed = dataKeys.encrypt(secret.base32, secretAad(userId));
      if (existing === undefined) {
        await inner.insert(totpCredential).values({
          originServer: await serverId(inner),
          userId,
          secret: sealed,
          createdAt: now,
          updatedAt: now,
          createdBy: userId,
          updatedBy: userId,
        });
      } else {
        await inner
          .update(totpCredential)
          .set({
            secret: sealed,
            lastUsedStep: null,
            version: sql`${totpCredential.version} + 1`,
            updatedAt: now,
            updatedBy: userId,
          })
          .where(eq(totpCredential.userId, userId));
      }
      await recordAuthAudit(inner, {
        category: AUTH_AUDIT.totpEnrolled,
        action: 'enrol',
        actor: { type: 'user', id: userId },
        targetType: 'user',
        targetId: userId,
        details: { replacedPending: existing !== undefined },
        occurredAt: now,
      });
      const otpauthUri = new TOTP({
        issuer: TOTP_SETTINGS.issuer,
        label: owner!.email,
        secret,
        algorithm: TOTP_SETTINGS.algorithm,
        digits: TOTP_SETTINGS.digits,
        period: TOTP_SETTINGS.periodSeconds,
      }).toString();
      return { ok: true, secret: secret.base32, otpauthUri };
    }),
  );
}

/** The answer of `confirmTotp`. */
export type ConfirmTotpResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        /** Nothing is being set up: `enrolTotp` first. */
        | 'no-pending-enrolment'
        /** It was confirmed already. */
        | 'already-enrolled'
        /** The code is wrong or not six digits. */
        | 'code-incorrect';
    };

/**
 * Finishes setting up an authenticator app: checks the first code the app
 * shows, from the same window as a sign-in, and confirms the secret. The
 * step of that code is used up, so it cannot be used to sign in. A wrong code
 * changes nothing and writes nothing. A `recovery` session in `session` becomes
 * `full` (SC-10): the user has set a new way to sign in. Audited as
 * `auth.totp-confirmed`. Other sessions stay: the user added a factor, they did
 * not weaken one. A pending secret that cannot be opened with `dataKeys` is
 * answered as a wrong code, with nothing written: the person starts again with
 * `enrolTotp`, which replaces it.
 *
 * @throws AuthStateError `user-not-found` for an unknown or deleted user,
 * `user-disabled` for a disabled one.
 * @throws RecordWriteError when the database refuses a write; it carries the
 * SQLSTATE and constraint name only.
 */
export function confirmTotp(
  tx: Tx,
  input: {
    userId: string;
    code: string;
    session?: { id: string; scope: SessionScope };
    now: Date;
    dataKeys: DataKeyRing;
  },
): Promise<ConfirmTotpResult> {
  const { userId, now, dataKeys } = input;
  return guardedAuth('totp_credential', 'update', () =>
    tx.transaction(async (inner): Promise<ConfirmTotpResult> => {
      const locked = await lockUser(inner, userId);
      if (locked.status === 'disabled') {
        throw new AuthStateError('user-disabled');
      }
      const [row] = await inner
        .select({
          secret: totpCredential.secret,
          confirmedAt: totpCredential.confirmedAt,
        })
        .from(totpCredential)
        .where(eq(totpCredential.userId, userId));
      if (row === undefined)
        return { ok: false, reason: 'no-pending-enrolment' };
      if (row.confirmedAt !== null) {
        return { ok: false, reason: 'already-enrolled' };
      }
      const token = codeShape(input.code);
      const secret = openSecret(dataKeys, userId, row.secret);
      const step =
        token === null || secret === null
          ? null
          : matchingStep(secret, token, now, null);
      if (step === null) return { ok: false, reason: 'code-incorrect' };

      await inner
        .update(totpCredential)
        .set({
          confirmedAt: now,
          lastUsedStep: step,
          version: sql`${totpCredential.version} + 1`,
          updatedAt: now,
          updatedBy: userId,
        })
        .where(eq(totpCredential.userId, userId));
      await recordAuthAudit(inner, {
        category: AUTH_AUDIT.totpConfirmed,
        action: 'confirm',
        actor: { type: 'user', id: userId },
        targetType: 'user',
        targetId: userId,
        details: {},
        occurredAt: now,
      });
      if (input.session?.scope === 'recovery') {
        await promoteSession(inner, input.session.id, {
          trigger: 'totp-confirmed',
          now,
        });
      }
      return { ok: true };
    }),
  );
}

/** The answer of `removeTotp`. */
export type RemoveTotpResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        /** There is nothing to remove. */
        | 'not-enrolled'
        /** The password is wrong, the account is throttled, or the user has no password to give. */
        | 'current-password-incorrect';
    };

/**
 * Removes a user's authenticator app, confirmed or only being set up, after
 * checking their current password (`checkCurrentPassword`): a wrong one removes
 * nothing, is audited as a failed re-check and counts toward the throttle, and
 * so does a throttled account. A user with no password cannot remove it until
 * they set one. With nothing to remove it answers `not-enrolled` without
 * looking at the password. On success every other session of the user is
 * revoked (the one in `session` is kept), because the second step is gone.
 * Audited as `auth.totp-removed`.
 *
 * @throws AuthStateError `user-not-found` for an unknown or deleted user,
 * `user-disabled` for a disabled one.
 * @throws RecordWriteError when the database refuses a write; it carries the
 * SQLSTATE and constraint name only.
 */
export function removeTotp(
  tx: Tx,
  input: {
    userId: string;
    password: string;
    /** The session making the change: kept, while the others are revoked. */
    session?: { id: string };
    now: Date;
  },
): Promise<RemoveTotpResult> {
  const { userId, now } = input;
  return guardedAuth('totp_credential', 'delete', () =>
    tx.transaction(async (inner): Promise<RemoveTotpResult> => {
      // FOR UPDATE: this ends the user's other sessions (see `setPassword`).
      const locked = await lockUser(inner, userId, { strength: 'update' });
      if (locked.status === 'disabled') {
        throw new AuthStateError('user-disabled');
      }
      const [row] = await inner
        .select({ confirmedAt: totpCredential.confirmedAt })
        .from(totpCredential)
        .where(eq(totpCredential.userId, userId));
      if (row === undefined) return { ok: false, reason: 'not-enrolled' };
      const checked = await checkCurrentPassword(inner, {
        userId,
        password: input.password,
        now,
      });
      if (checked !== 'ok') {
        return { ok: false, reason: 'current-password-incorrect' };
      }
      await inner
        .delete(totpCredential)
        .where(eq(totpCredential.userId, userId));
      await recordAuthAudit(inner, {
        category: AUTH_AUDIT.totpRemoved,
        action: 'remove',
        actor: { type: 'user', id: userId },
        targetType: 'user',
        targetId: userId,
        details: { wasConfirmed: row.confirmedAt !== null },
        occurredAt: now,
      });
      await revokeUserSessions(inner, userId, {
        reason: 'totp-removed',
        ...(input.session === undefined
          ? {}
          : { exceptSessionId: input.session.id }),
        now,
      });
      return { ok: true };
    }),
  );
}

/**
 * Seals every authenticator secret that is still stored as plain base32, with
 * the current key of `dataKeys`, in place, and answers how many it sealed. A row
 * is plain when its `secret` does not start with `v1.`, which a base32 secret
 * never does. Each is bound to its own user's row, as `enrolTotp` does it.
 *
 * Start-up calls it (`bindServerKeys`), in the transaction that holds the
 * `installation` row, because a migration may not change security state
 * (CLAUDE.md, Data rules) and a secret written before the keys existed has to be
 * sealed by the server that holds them. It rewrites only the `secret` column and
 * `updated_at`, with a conditional UPDATE on the value it read, so a row that
 * changed in between (an enrolment on a server that still ran the old code) is
 * left for the next start. A call that seals nothing writes nothing. One
 * `auth.totp-secrets-encrypted` event carries the count, never an id, a secret or
 * a key.
 *
 * Only server start-up calls this, before any request is served, so it checks no
 * permission.
 *
 * @throws RecordWriteError when the database refuses a write; it carries the
 * SQLSTATE and constraint name only, never a secret.
 */
export function sealPlainTotpSecrets(
  tx: Tx,
  input: { dataKeys: DataKeyRing; now: Date },
): Promise<number> {
  const { dataKeys, now } = input;
  return guardedAuth('totp_credential', 'update', () =>
    // A savepoint: a failure leaves no half-sealed set and no event.
    tx.transaction(async (inner) => {
      const plain = await inner
        .select({
          id: totpCredential.id,
          userId: totpCredential.userId,
          secret: totpCredential.secret,
        })
        .from(totpCredential)
        .where(notLike(totpCredential.secret, `${ENCRYPTED_PREFIX}%`))
        .orderBy(asc(totpCredential.id));
      let sealed = 0;
      for (const row of plain) {
        const [done] = await inner
          .update(totpCredential)
          .set({
            secret: dataKeys.encrypt(row.secret, secretAad(row.userId)),
            updatedAt: now,
          })
          .where(
            and(
              eq(totpCredential.id, row.id),
              eq(totpCredential.secret, row.secret),
            ),
          )
          .returning({ id: totpCredential.id });
        if (done !== undefined) sealed += 1;
      }
      if (sealed > 0) {
        await recordAuthAudit(inner, {
          category: AUTH_AUDIT.totpSecretsEncrypted,
          action: 'encrypt',
          actor: { type: 'system', id: null },
          targetType: null,
          targetId: null,
          details: { count: sealed },
          occurredAt: now,
        });
      }
      return sealed;
    }),
  );
}
