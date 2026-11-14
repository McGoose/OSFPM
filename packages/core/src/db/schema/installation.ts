import { sql } from 'drizzle-orm';
import { pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from '../columns.js';
import { newId } from '../ids.js';

/**
 * This server. Exception to the standard columns: no tenant or audit columns.
 * At most one row may exist, enforced by a unique index on a constant.
 */
export const installation = pgTable(
  'installation',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    baseUrl: text('base_url').notNull(),
    serverPublicKey: text('server_public_key'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  () => [uniqueIndex('installation_single_row').on(sql`(true)`)],
);
