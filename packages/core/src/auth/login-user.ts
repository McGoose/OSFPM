import { and, eq, isNull } from 'drizzle-orm';
import { user } from '../db/schema/index.js';
import type { Tx } from '../db/write.js';
import { SESSION_USER_COLUMNS, type SessionUser } from './sessions.js';
import { guardedAuth } from './shared.js';

/**
 * How a typed email address is looked up. The `user.email` column holds an
 * address trimmed and in lower case, and the database refuses one that is not
 * (see the `user` table), so a lookup trims and lower-cases what was typed.
 * Anyone may call it; it reads no database.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Finds the live user with a typed email address, or `undefined` for an address
 * no one has and for a deleted user, with one answer for both. The address is
 * normalised first (`normaliseEmail`). Returns a disabled user too: it is the
 * caller that refuses them, with its own reason for the audit trail. Never
 * returns a credential or a hash. The login services use it to turn the one
 * thing a person types into the account they are signing in to.
 *
 * @throws RecordWriteError when the database fails; it carries the SQLSTATE
 * only, never the address.
 */
export function findLoginUser(
  tx: Tx,
  email: string,
): Promise<SessionUser | undefined> {
  return guardedAuth('user', 'select', async () => {
    const [row] = await tx
      .select(SESSION_USER_COLUMNS)
      .from(user)
      .where(and(eq(user.email, normaliseEmail(email)), isNull(user.deletedAt)))
      .limit(1);
    return row;
  });
}
