import { sql } from 'drizzle-orm';
import { pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from '../columns.js';
import { newId } from '../ids.js';

/**
 * This server. Exception to the standard columns: no tenant or audit columns.
 * At most one row may exist, enforced by a unique index on a constant. The server
 * makes the row when it first starts (`ensureInstallation`).
 * `setup_completed_at` is NULL until the first administrator has been created
 * (SC-10), which `completeFirstRunSetup` does; `auth/setup-code.ts` reads it
 * through `isSetupComplete`.
 *
 * Written only by the core services named in `SERVICE_WRITTEN_TABLES` (the auth
 * service, which also does first-run setup), never through the write helper, and
 * audited, not change-logged (CLAUDE.md, Data rules).
 */
export const installation = pgTable(
  'installation',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    baseUrl: text('base_url').notNull(),
    serverPublicKey: text('server_public_key'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    setupCompletedAt: timestamptz('setup_completed_at'),
  },
  () => [uniqueIndex('installation_single_row').on(sql`(true)`)],
);
