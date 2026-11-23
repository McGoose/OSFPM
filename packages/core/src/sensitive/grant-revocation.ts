import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  accessGrant,
  person,
  type AccessGrantCategory,
} from '../db/schema/index.js';
import type { Tx } from '../db/write.js';

/** How many live grants `revokeAccountGrants` ended, by category. */
export type RevokedGrantCounts = {
  readonly accessibility: number;
  readonly medical: number;
};

/**
 * Ends every live grant of the categories given that belongs to a person the account is,
 * in every project of every organisation (an account is a person in each organisation it
 * belongs to, through `person.user_id`), and answers how many it ended in each category. A
 * grant only chooses who sees which fields of what the person has stored, so one that
 * outlived the profile or the account would open it again when the person comes back, which
 * they never agreed to (decision D-69). A grant that was already revoked is left as it was.
 *
 * It sets the columns `revokeAccessGrant` sets, in one statement, with `revokedBy` as the
 * user who ended them, and writes no event of its own: the caller writes one for the lot, of
 * counts only. It checks no permission, takes no lock beyond the rows it updates, and runs
 * in the caller's transaction, so it is one step with whatever the caller does around it.
 */
export async function revokeAccountGrants(
  tx: Tx,
  userId: string,
  categories: readonly AccessGrantCategory[],
  revokedBy: string,
  now: Date,
): Promise<RevokedGrantCounts> {
  const ended = await tx
    .update(accessGrant)
    .set({
      revokedAt: now,
      revokedBy,
      version: sql`${accessGrant.version} + 1`,
      updatedAt: now,
      updatedBy: revokedBy,
    })
    .where(
      and(
        inArray(accessGrant.category, [...categories]),
        isNotNull(accessGrant.revokedAt),
        inArray(
          accessGrant.personId,
          tx
            .select({ id: person.id })
            .from(person)
            .where(eq(person.userId, userId)),
        ),
      ),
    )
    .returning({ category: accessGrant.category });
  return {
    accessibility: ended.filter((row) => row.category === 'accessibility')
      .length,
    medical: ended.filter((row) => row.category === 'medical').length,
  };
}
