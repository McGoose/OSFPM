import { isNotNull, lte, or } from 'drizzle-orm';
import { invite } from '../db/schema/index.js';
import type { Tx } from '../db/write.js';
import { guardedAuth } from './shared.js';

/**
 * Deletes every invite that is of no use, and returns how many it deleted: one that
 * was used, one that was revoked, and one that has expired (`expires_at <= now`, as
 * `acceptInvite` counts it). The cut-off is the one `cleanupSetupCodes` uses for
 * setup codes. The live invites stay: not used, not revoked, with time left. The
 * role links of a deleted invite go with it (`invite_role` cascades), so this
 * covers both tables, and `invite_role` has no retention class or cleanup of its
 * own.
 *
 * Deleting a used invite undoes nothing: the membership it made is a tenant record,
 * and the audit log is the record of the invite (retention class `transient`,
 * maintainer decision P-03b3a).
 *
 * For the worker, which calls it on a schedule (`TRANSIENT_CLEANUPS`). It is
 * housekeeping, not a security change, so it writes no audit event: creating,
 * accepting and revoking an invite were audited when they happened. It checks no
 * permission: only the worker calls it. It takes no row lock, because each invite
 * it deletes is one `acceptInvite` refuses at `now`, and a revoke of an invite
 * that is already gone changes nothing. One DELETE, so it is atomic.
 *
 * @throws RecordWriteError when the database refuses the delete; it carries the
 * SQLSTATE and constraint name only.
 */
export function cleanupInvites(tx: Tx, now: Date): Promise<number> {
  return guardedAuth('invite', 'delete', async () => {
    const deleted = await tx
      .delete(invite)
      .where(
        or(
          isNotNull(invite.usedAt),
          isNotNull(invite.revokedAt),
          lte(invite.expiresAt, now),
        ),
      )
      .returning({ id: invite.id });
    return deleted.length;
  });
}
