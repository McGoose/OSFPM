import { foreignKey, index, text, unique, uuid } from 'drizzle-orm/pg-core';
import { baseColumns, securityTable, timestamptz } from '../columns.js';
import { user } from './user.js';

/**
 * A single-use recovery code of a user (SC-10). Only the SHA-256 hash of the
 * code is stored; the raw code is shown to the user once. Generating a new set
 * deletes the old one.
 *
 * A security table: only `auth/recovery.ts` writes it, directly, and each
 * change is audited (CLAUDE.md, Data rules).
 */
export const recoveryCode = securityTable(
  'recovery_code',
  {
    ...baseColumns(() => user.id),
    userId: uuid('user_id').notNull(),
    codeHash: text('code_hash').notNull(),
    usedAt: timestamptz('used_at'),
  },
  (t) => [
    foreignKey({
      name: 'recovery_code_user_fk',
      columns: [t.userId],
      foreignColumns: [user.id],
    }),
    unique('recovery_code_code_hash_unique').on(t.codeHash),
    index('recovery_code_user_idx').on(t.userId),
  ],
);
