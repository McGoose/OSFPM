import { isNotNull, lte, or } from 'drizzle-orm';
import { apiToken } from '../db/schema/index.js';
import type { Tx } from '../db/write.js';
import { guardedAuth } from './shared.js';

/**
 * Deletes every personal API token that is of no use, and returns how many it
 * deleted: one that was revoked, and one that has expired (`expires_at <= now`, as
 * `authenticateApiToken` counts it). The cut-off is the one `cleanupAccessResets`
 * uses for reset links. A live token stays: not revoked, and either with time left or
 * with no expiry at all (a NULL `expires_at` never matches, so a token that never
 * expires is never deleted for being old).
 *
 * Deleting a revoked token undoes nothing: it has been refused since the moment it was
 * revoked, and the audit log is the record of it (retention class `transient`, as for
 * sessions, invites and reset links; SC-10, decision D-68).
 *
 * For the worker, which calls it on a schedule (`TRANSIENT_CLEANUPS`). It is
 * housekeeping, not a security change, so it writes no audit event: creating and
 * revoking each token were audited when they happened. It checks no permission: only
 * the worker calls it. It takes no row lock, because each token it deletes is one
 * `authenticateApiToken` refuses at `now`, and a revoke of a token that is already
 * gone finds nothing live, which is a 404 either way. One DELETE, so it is atomic.
 *
 * @throws RecordWriteError when the database refuses the delete; it carries the
 * SQLSTATE and constraint name only.
 */
export function cleanupApiTokens(tx: Tx, now: Date): Promise<number> {
  return guardedAuth('api_token', 'delete', async () => {
    const deleted = await tx
      .delete(apiToken)
      .where(or(isNotNull(apiToken.revokedAt), lte(apiToken.expiresAt, now)))
      .returning({ id: apiToken.id });
    return deleted.length;
  });
}
