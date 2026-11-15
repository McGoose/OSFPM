import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, text } from 'drizzle-orm/pg-core';

/**
 * Install-level catalogue of the permissions modules declare; `syncPermissions`
 * upserts them. `grants_sensitive` flags a permission that exposes sensitive
 * data (CLAUDE.md, Privacy rule). Not tenant-scoped, so it carries no standard
 * columns.
 */
export const permission = pgTable(
  'permission',
  {
    /** `module:action`, for example `budget:read`. */
    key: text('key').primaryKey(),
    module: text('module').notNull(),
    description: text('description').notNull(),
    grantsSensitive: boolean('grants_sensitive').notNull().default(false),
  },
  (t) => [
    check(
      'permission_key_format_check',
      sql`${t.key} ~ '^[a-z][a-z0-9-]*:[a-z][a-z0-9:-]*$'`,
    ),
  ],
);
