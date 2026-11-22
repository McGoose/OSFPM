import { and, eq, gt, isNotNull, isNull, lte, or } from 'drizzle-orm';
import { installation, setupCode } from '../db/schema/index.js';
import type { Tx } from '../db/write.js';
import { AuthStateError } from './errors.js';
import {
  AUTH_AUDIT,
  guardedAuth,
  recordAuthAudit,
  type AuthActor,
} from './shared.js';
import { generateHumanCode, hashHumanCode } from './tokens.js';

/**
 * The setup code (SC-10): a one-time code, printed by the server at start-up,
 * that lets whoever installed it create the first administrator. Only its
 * SHA-256 hash is stored, and at most one code is live at a time. `setup_code`
 * is a security table: written here, directly, and every change is audited
 * instead of change-logged (CLAUDE.md, Data rules). A raw code is never
 * stored, logged or audited (CLAUDE.md, Privacy rule).
 *
 * The server prints the code at start-up (`packages/api/src/setup/first-run.ts`),
 * and `completeFirstRunSetup` (`first-run-setup.ts`) spends it and creates the
 * first administrator. These functions check no permission: nobody is signed in
 * yet. Pass the transaction handle.
 */

/** How long a setup code works: 24 hours from the moment it is issued. */
export const SETUP_CODE_LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * Takes the `installation` row, which is held until the transaction ends, and
 * answers its id and when setup was completed (null until it is). Answers
 * undefined before the row exists. Everything that decides who may become the
 * first administrator serialises on this one lock: issuing a code, spending one
 * and completing setup (`completeFirstRunSetup`), so whichever comes second
 * waits for the first and then sees what it did. Takes the lock and nothing
 * else, and checks no permission: only the auth services call it, in the
 * caller's transaction.
 */
export async function lockInstallation(tx: Tx) {
  const [row] = await tx
    .select({
      id: installation.id,
      setupCompletedAt: installation.setupCompletedAt,
    })
    .from(installation)
    .limit(1)
    .for('update');
  return row;
}

/**
 * Whether the first administrator has been created, which is when
 * `installation.setup_completed_at` is set. False before the installation row
 * exists. Anyone may ask: the answer is what decides whether the server prints
 * a setup code.
 */
export async function isSetupComplete(tx: Tx): Promise<boolean> {
  const [row] = await tx
    .select({ setupCompletedAt: installation.setupCompletedAt })
    .from(installation)
    .limit(1);
  return row?.setupCompletedAt != null;
}

/** Why the setup code was looked at: only a check (`checkSetupCode`), or the setup itself. */
export type SetupCodePurpose = 'check' | 'setup';

/**
 * Records that a setup code was refused, as `auth.setup-check-failed` from the
 * system, with the purpose and nothing else: no code, typed or hashed, and no
 * other value the request carried (CLAUDE.md, Privacy rule). It is written
 * outside any savepoint that was rolled back, so it survives the refusal. Only
 * the auth services call it, in the caller's transaction, which must commit.
 *
 * @throws RecordWriteError when the database refuses the write.
 */
export function recordSetupCodeRefused(
  tx: Tx,
  purpose: SetupCodePurpose,
  now: Date,
): Promise<void> {
  return guardedAuth('audit_event', 'insert', async () => {
    await recordAuthAudit(tx, {
      category: AUTH_AUDIT.setupCheckFailed,
      action: 'check',
      actor: { type: 'system', id: null },
      targetType: null,
      targetId: null,
      details: { purpose },
      occurredAt: now,
    });
  });
}

/**
 * Whether `code` would be accepted now, without using it: true only for the live
 * code, before it expires, while setup is not complete. For a setup screen that
 * wants to check the code before it asks for details. Any spelling of the code
 * does. A refusal, whatever the cause (unknown, expired, replaced, used, setup
 * already complete, not shaped like a code), is the same `false`, and is audited
 * as `auth.setup-check-failed` with the purpose `check` and no code; it is
 * returned, not thrown, so the caller's transaction commits and the event is
 * kept. A live code writes nothing. It takes no lock: it only reads.
 *
 * @throws RecordWriteError when the database fails; it carries the SQLSTATE
 * only, never the code or its hash.
 */
export async function checkSetupCode(
  tx: Tx,
  code: string,
  now: Date,
): Promise<boolean> {
  const hash = hashHumanCode(code);
  const live =
    hash !== null &&
    (await guardedAuth('setup_code', 'select', async () => {
      const [server] = await tx
        .select({ setupCompletedAt: installation.setupCompletedAt })
        .from(installation)
        .limit(1);
      if (!server || server.setupCompletedAt !== null) return false;
      const [row] = await tx
        .select({ id: setupCode.id })
        .from(setupCode)
        .where(
          and(
            eq(setupCode.codeHash, hash),
            isNull(setupCode.usedAt),
            isNull(setupCode.revokedAt),
            gt(setupCode.expiresAt, now),
          ),
        )
        .limit(1);
      return row !== undefined;
    }));
  if (!live) await recordSetupCodeRefused(tx, 'check', now);
  return live;
}

/**
 * Issues a setup code and returns the raw code, which exists nowhere else: show
 * it once. It expires `SETUP_CODE_LIFETIME_MS` after `now`. Any earlier live
 * code, used or not yet expired, is revoked first, so only the newest works.
 * Takes the installation row lock, so two issues at once leave one live code.
 * Audited as `auth.setup-code-issued` with the expiry and no code.
 *
 * Refuses once setup is complete: a setup code is a way to become the first
 * administrator, so none may be issued afterwards.
 *
 * @throws AuthStateError `installation-missing` before the installation row
 * exists, `setup-complete` after the first administrator was created.
 * @throws RecordWriteError when the database refuses a write; it carries the
 * SQLSTATE and constraint name only.
 */
export function issueSetupCode(
  tx: Tx,
  now: Date,
  options: { actor?: AuthActor } = {},
): Promise<string> {
  return guardedAuth('setup_code', 'insert', () =>
    // A savepoint: a failure leaves the old code live and no event.
    tx.transaction(async (inner) => {
      const server = await lockInstallation(inner);
      if (!server) throw new AuthStateError('installation-missing');
      if (server.setupCompletedAt !== null) {
        throw new AuthStateError('setup-complete');
      }
      // Revoked before the insert: the partial unique index allows one live code.
      const replaced = await inner
        .update(setupCode)
        .set({ revokedAt: now, updatedAt: now })
        .where(and(isNull(setupCode.usedAt), isNull(setupCode.revokedAt)))
        .returning({ id: setupCode.id });
      const code = generateHumanCode();
      const expiresAt = new Date(now.getTime() + SETUP_CODE_LIFETIME_MS);
      const [row] = await inner
        .insert(setupCode)
        .values({
          originServer: server.id,
          // A code we just made always normalises, so the hash is never null.
          codeHash: hashHumanCode(code)!,
          expiresAt,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: setupCode.id });
      await recordAuthAudit(inner, {
        category: AUTH_AUDIT.setupCodeIssued,
        action: 'issue',
        actor: options.actor ?? { type: 'system', id: null },
        targetType: 'setup_code',
        targetId: row!.id,
        details: {
          expiresAt: expiresAt.toISOString(),
          replaced: replaced.length,
        },
        occurredAt: now,
      });
      return code;
    }),
  );
}

/**
 * Uses the setup code. Returns true the first time the live code is given
 * before it expires, and false every other time (wrong, already used, revoked
 * by a newer code, expired, setup already complete, or not shaped like a
 * code), with one answer for all so a caller learns nothing about which. Case,
 * spaces and hyphens in the typed code do not matter. The code is marked used
 * in one conditional UPDATE, so two requests with the same code succeed once.
 * Audited as `auth.setup-code-used`, with no code.
 *
 * This only spends the code. Creating the administrator and setting
 * `setup_completed_at` is `completeFirstRunSetup`'s job, in the same
 * transaction.
 *
 * @throws RecordWriteError when the database fails; it carries the SQLSTATE
 * only, never the code or its hash.
 */
export async function consumeSetupCode(
  tx: Tx,
  code: string,
  now: Date,
): Promise<boolean> {
  const hash = hashHumanCode(code);
  if (hash === null) return false;
  return guardedAuth('setup_code', 'update', () =>
    tx.transaction(async (inner) => {
      const server = await lockInstallation(inner);
      if (!server || server.setupCompletedAt !== null) return false;
      const [row] = await inner
        .update(setupCode)
        .set({ usedAt: now, updatedAt: now })
        .where(
          and(
            eq(setupCode.codeHash, hash),
            isNull(setupCode.usedAt),
            isNull(setupCode.revokedAt),
            gt(setupCode.expiresAt, now),
          ),
        )
        .returning({ id: setupCode.id });
      if (!row) return false;
      await recordAuthAudit(inner, {
        category: AUTH_AUDIT.setupCodeUsed,
        action: 'use',
        actor: { type: 'system', id: null },
        targetType: 'setup_code',
        targetId: row.id,
        occurredAt: now,
      });
      return true;
    }),
  );
}

/**
 * Deletes every setup code that is of no use, and returns how many it deleted:
 * a code that was used, a code that was revoked (by a newer one), and a code
 * that has expired (`expires_at <= now`, as `consumeSetupCode` counts it). The
 * live code stays: not used, not revoked, with time left.
 *
 * Deleting a used code does not reopen setup. Whether the first administrator
 * exists is `installation.setup_completed_at`, which this does not touch, and
 * no code is issued or accepted once it is set.
 *
 * For the worker, which calls it on a schedule (`TRANSIENT_CLEANUPS`). It is
 * housekeeping, not a security change, so it writes no audit event: issuing and
 * using a code were audited when they happened. It checks no permission: only
 * the worker calls it. It takes no installation lock, because each code it
 * deletes is one `consumeSetupCode` refuses at `now`. One DELETE, so it is
 * atomic.
 *
 * @throws RecordWriteError when the database refuses the delete; it carries the
 * SQLSTATE and constraint name only.
 */
export function cleanupSetupCodes(tx: Tx, now: Date): Promise<number> {
  return guardedAuth('setup_code', 'delete', async () => {
    const deleted = await tx
      .delete(setupCode)
      .where(
        or(
          isNotNull(setupCode.usedAt),
          isNotNull(setupCode.revokedAt),
          lte(setupCode.expiresAt, now),
        ),
      )
      .returning({ id: setupCode.id });
    return deleted.length;
  });
}
