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

export const USER_STATUSES = ['invited', 'active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/**
 * Install-level account. Not tenant-scoped, so it has no `organisation_id`,
 * `owner_org_id` or `visibility`. It must never hold personal details such as
 * phone, address or medical data.
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
    check('user_email_lowercase_check', sql`${t.email} = lower(${t.email})`),
    check('user_status_check', sql`${t.status} in (${sqlList(USER_STATUSES)})`),
  ],
);
