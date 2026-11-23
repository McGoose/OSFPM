import { eq } from 'drizzle-orm';
import { user } from '../db/schema/index.js';
import type { Tx } from '../db/write.js';

/**
 * Holds the user row of an account `FOR KEY SHARE` until the transaction ends, and answers
 * whether the account is live: it exists and is not deleted. The code that writes grants for
 * an account holder (`createAccessGrant`, `shareWithSuggestedRoles`) calls it first, before it
 * reads or locks anything else of the person's, because a grant is derived from the account
 * (CLAUDE.md, Data rules: a service that writes rows derived from a row it has just read holds
 * that row until commit).
 *
 * That is what lets such a write meet the deletion of the account safely. The deletion takes
 * the same row `FOR UPDATE` and then the person's access profile row. A write that has taken
 * this lock makes the deletion wait, and the deletion then ends the grants the write made. A
 * write that comes after the deletion waits for it, sees the account deleted (this answers
 * `false`) and writes nothing. And both go user row first, so a write that is waiting here
 * holds nothing on the profile, and the two cannot wait for each other. `FOR KEY SHARE` is the
 * weakest row lock, so any number of writes hold it at once.
 *
 * It checks no permission and writes nothing. The caller passes the `user_id` of a person it
 * has already read.
 */
export async function holdAccount(tx: Tx, userId: string): Promise<boolean> {
  const [found] = await tx
    .select({ deletedAt: user.deletedAt })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return found !== undefined && found.deletedAt === null;
}
