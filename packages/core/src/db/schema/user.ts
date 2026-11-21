import { sql } from 'drizzle-orm';
import {
  check,
  pgTable,
  text,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  baseColumns,
  retentionClassForeignKey,
  sqlList,
  timestamptz,
} from '../columns.js';

/**
 * Allowed values of `user.status`. The CHECK is built from this list, so a new
 * value needs a new migration.
 */
export const USER_STATUSES = ['invited', 'active', 'disabled'] as const;
/** One value of `USER_STATUSES`. */
export type UserStatus = (typeof USER_STATUSES)[number];

/**
 * Install-level account. Not tenant-scoped, so it has no `organisation_id`,
 * `owner_org_id` or `visibility`. It must never hold personal details such as
 * phone, address or medical data (CLAUDE.md, Privacy rule): those belong to
 * `person` and `person_sensitive`.
 *
 * `email` is stored normalised: lower case, with no spaces at either end. The
 * `user_email_normalised_check` CHECK enforces it, so the unique index on `email`
 * means one account per address however a caller typed it, and a login can look
 * an address up with `lower(btrim(input))`. `btrim` removes spaces only, so a
 * caller still strips tabs and line breaks before it looks up or stores one.
 */
export const user = pgTable(
  'user',
  {
    ...baseColumns((): AnyPgColumn => user.id),
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    locale: text('locale').notNull(),
    timezone: text('timezone').notNull(),
    status: text('status').$type<UserStatus>().notNull(),
    lastLoginAt: timestamptz('last_login_at'),
  },
  (t) => [
    retentionClassForeignKey('user', t.retentionClass),
    uniqueIndex('user_email_unique').on(t.email),
    // Replaces `user_email_lowercase_check`, which this implies.
    check(
      'user_email_normalised_check',
      sql`${t.email} = lower(btrim(${t.email}))`,
    ),
    check('user_status_check', sql`${t.status} in (${sqlList(USER_STATUSES)})`),
  ],
);
