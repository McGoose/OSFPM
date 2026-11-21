import { and, eq, isNull, sql } from 'drizzle-orm';
import { recoveryCode, user } from '../db/schema/index.js';
import type { Tx } from '../db/write.js';
import {
  AUTH_AUDIT,
  guardedAuth,
  lockUser,
  recordAuthAudit,
  serverId,
  type AuthActor,
} from './shared.js';
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
 * no code. Failed attempts are not audited here yet; they will be, with the
 * method and a failure reason and never the submitted code (see the README,
 * "Decided for the routes").
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
