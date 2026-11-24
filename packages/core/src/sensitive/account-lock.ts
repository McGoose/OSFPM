import { eq } from 'drizzle-orm';
import { user } from '../db/schema/index.js';
import type { Tx } from '../db/write.js';
import { isUuid } from './guard.js';

/**
 * Holds the user row of an account `FOR KEY SHARE` until the transaction ends, and answers
 * whether the account is live: it exists and is not deleted. Every writer of what an account
 * shares calls it first, before it reads or locks anything else of the person's: the grants
 * (`createAccessGrant`, `revokeAccessGrant`, `shareWithSuggestedRoles`) and the access profile
 * (`createAccessProfile`, `updateAccessProfile`, `deleteAccessProfile`), because both are
 * derived from the account (CLAUDE.md, Data rules: a service that writes rows derived from a
 * row it has just read holds that row until commit).
 *
 * That is what lets such a write meet the deletion of the account safely. The deletion takes
 * the same row `FOR UPDATE`, then the person's access profile row, then the grants. A write
 * that has taken this lock makes the deletion wait, and the deletion then ends what the write
 * made. A write that comes after the deletion waits for it and sees the account deleted (this
 * answers `false`). And both go user row first, so a write that is waiting here holds nothing
 * on the profile or on a grant, and the two cannot wait for each other. `FOR KEY SHARE` is the
 * weakest row lock, so any number of writes hold it at once.
 *
 * What a writer does with `false` depends on what it writes. One that makes something derived
 * from the account (a grant, a share, a profile) refuses a deleted account, or the deletion
 * has already ended what it would have made and it would leave a live row of an account that
 * is gone. One that only ends or changes what exists (a revoke, a profile deleted or updated)
 * does not look at the answer: a deleted account may always end what it shared. An id that is
 * not a user's id answers `false` without a query.
 *
 * It checks no permission and writes nothing. The caller passes the id of a user it already
 * knows: the `user_id` of a person it has read, or the signed-in owner of a profile.
 */
export async function holdAccount(tx: Tx, userId: string): Promise<boolean> {
  if (!isUuid(userId)) return false;
  const [found] = await tx
    .select({ deletedAt: user.deletedAt })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1)
    .for('key share');
  return found !== undefined && found.deletedAt === null;
}
