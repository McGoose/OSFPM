import { sql } from 'drizzle-orm';
import { text, uniqueIndex } from 'drizzle-orm/pg-core';
import { baseColumns, securityTable, timestamptz } from '../columns.js';
import { user } from './user.js';

/**
 * The one-time code that lets the first administrator set the installation up
 * (SC-10). Only the SHA-256 hash is stored. At most one code is live, meaning
 * neither used nor revoked: a partial unique index on a constant enforces it,
 * so issuing a new code must revoke the old one first. An unused code past
 * `expires_at` still counts as live there until it is revoked or deleted; it is
 * refused when consumed. Retention class `transient`: a working row that
 * cleanup removes, and the audit log is the record. `cleanupSetupCodes`
 * deletes the codes that were used or revoked, and those past `expires_at`.
 *
 * A security table: only `auth/setup-code.ts` writes it, directly, and each
 * change is audited (CLAUDE.md, Data rules).
 */
export const setupCode = securityTable(
  'setup_code',
  {
    ...baseColumns(() => user.id, { defaultRetentionClass: 'transient' }),
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    usedAt: timestamptz('used_at'),
    revokedAt: timestamptz('revoked_at'),
  },
  (t) => [
    // Several NULLs are not the issue: the key is a constant, so every live row
    // collides with every other live row.
    uniqueIndex('setup_code_single_live')
      .on(sql`(true)`)
      .where(sql`${t.usedAt} is null and ${t.revokedAt} is null`),
  ],
);
