import { isNotNull, lte, or } from 'drizzle-orm';
import { accessReset } from '../db/schema/index.js';
import type { Tx } from '../db/write.js';
import { guardedAuth } from './shared.js';

/**
 * Deletes every reset link that is of no use, and returns how many it deleted: one
 * that was used, one that was revoked, and one that has expired (`expires_at <= now`,
 * as `useAccessReset` counts it). The cut-off is the one `cleanupInvites` uses for
 * invites. The live links stay: not used, not revoked, with time left.
 *
 * Deleting a used link undoes nothing: what using it did (the sessions revoked,
 * the password and authenticator cleared) is not stored on the link, and the audit
 * log is the record of it (retention class `transient`, maintainer decision
 * P-03b3a).
 *
 * For the worker, which calls it on a schedule (`TRANSIENT_CLEANUPS`). It is
 * housekeeping, not a security change, so it writes no audit event: making,
 * revoking and using a link were audited when they happened. It checks no
 * permission: only the worker calls it. It takes no row lock, because each link it
 * deletes is one `useAccessReset` refuses at `now`, and a revoke of a link that is
 * already gone changes nothing. One DELETE, so it is atomic.
 *
 * @throws RecordWriteError when the database refuses the delete; it carries the
 * SQLSTATE and constraint name only.
 */
export function cleanupAccessResets(tx: Tx, now: Date): Promise<number> {
  return guardedAuth('access_reset', 'delete', async () => {
    const deleted = await tx
      .delete(accessReset)
      .where(
        or(
          isNotNull(accessReset.usedAt),
          isNotNull(accessReset.revokedAt),
          lte(accessReset.expiresAt, now),
        ),
      )
      .returning({ id: accessReset.id });
    return deleted.length;
  });
}
