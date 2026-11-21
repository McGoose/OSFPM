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
 * Written only by the core services named in `SERVICE_WRITTEN_TABLES` (the auth
 * service now), never through the write helper, and audited, not change-logged
 * (CLAUDE.md, Data rules).
 *
 * `email` is stored normalised: lower case, with no whitespace anywhere in it
 * (spaces, tabs and line breaks, at the ends or inside). The
 * `user_email_normalised_check` CHECK enforces it, so the unique index on `email`
 * means one account per address however a caller typed it. A caller trims and
 * lower-cases an address before it stores or looks one up; the database refuses
 * one that was not, and never changes it. `[[:space:]]` is the database's own
 * idea of whitespace, which on some locales leaves out Unicode spaces such as a
 * no-break space.
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
    // Lower case and no whitespace anywhere. Replaces the first form of this
    // check, `email = lower(btrim(email))`, which let tabs, line breaks and
    // inner spaces through (`btrim` strips spaces at the ends only).
    check(
      'user_email_normalised_check',
      sql`${t.email} = lower(${t.email}) and ${t.email} !~ '[[:space:]]'`,
    ),
    check('user_status_check', sql`${t.status} in (${sqlList(USER_STATUSES)})`),
  ],
);
