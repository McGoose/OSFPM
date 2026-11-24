import { foreignKey, jsonb, pgTable, unique, uuid } from 'drizzle-orm/pg-core';
import { baseColumns, retentionClassForeignKey } from '../columns.js';
import { user } from './user.js';

/**
 * How a person who has an account wants to receive information (decision D-69, P-02l2): an
 * accessible format, a text size, a channel, a digest, quiet hours. They are ordinary
 * settings and not sensitive data, so that nobody has to disclose anything to get an
 * accessible format, but only the person, staff who edit people (for a person without an
 * account) and system code read them, as a courtesy: a choice such as `easy-read` can hint
 * at something the person has not chosen to share. One row per user, and it belongs to the
 * person and not to a production: it stays when a project wraps.
 *
 * Install-level, so it has no `organisation_id`, `owner_org_id` or `visibility`, and it is a
 * service-written table like `user`: only the preferences service writes it, which
 * `SERVICE_WRITTEN_TABLES` declares, never through the write helper, and every change is
 * audited (the user id and the names of the fields that changed, never a value) and not
 * change-logged, because the table has no organisation to number a change in. Retention
 * class `account-lifetime`: kept while the account exists and deleted when the account is.
 * It has no period and counts from no project date, so nothing ends it by time. Users are
 * only soft-deleted today, so the call that ends an account's sharing erases the row too
 * (`endAccountAccessSharing`); `ON DELETE CASCADE` is the backstop for a hard delete.
 *
 * `payload` holds what the person chose, validated against the preferences schema
 * (`preferences/schemas.ts`) before it is stored, and only the choices they made: a
 * default is applied when the preferences are read, never stored.
 */
export const userPreferences = pgTable(
  'user_preferences',
  {
    ...baseColumns(() => user.id, {
      defaultRetentionClass: 'account-lifetime',
    }),
    userId: uuid('user_id').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    retentionClassForeignKey('user_preferences', t.retentionClass),
    // The preferences go with the account: the same backstop as the access profile.
    foreignKey({
      name: 'user_preferences_user_fk',
      columns: [t.userId],
      foreignColumns: [user.id],
    }).onDelete('cascade'),
    // One row per user. The column is NOT NULL, so the NULLS NOT DISTINCT rule of CLAUDE.md
    // (Data rules) does not apply.
    unique('user_preferences_user_unique').on(t.userId),
  ],
);
