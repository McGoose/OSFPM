import { and, eq, gt, isNull } from 'drizzle-orm';
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
 * Printing the code at start-up, and the first-run flow that consumes it, come
 * in P-03b4. These functions check no permission: nobody is signed in yet.
 * Pass the transaction handle.
 */

/** How long a setup code works: 24 hours from the moment it is issued. */
export const SETUP_CODE_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** The installation row, held until the transaction ends, or undefined before it exists. */
async function lockedInstallation(tx: Tx) {
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
      const server = await lockedInstallation(inner);
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
 * `setup_completed_at` is the first-run flow's job (P-03b4), in the same
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
      const server = await lockedInstallation(inner);
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
