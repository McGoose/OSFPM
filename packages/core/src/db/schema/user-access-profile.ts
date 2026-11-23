import {
  foreignKey,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns, retentionClassForeignKey } from '../columns.js';
import { markSensitive } from '../sensitive.js';
import { user } from './user.js';

/**
 * A person's own access needs, kept on their account (decision D-69): the practical
 * adjustments they ask for, in the structured shape of the `accessibility` payload
 * (`sensitive/schemas.ts`), never a condition or a diagnosis. One profile per user,
 * and it belongs to the person, not to a production: it stays when a project wraps
 * and goes only when the person deletes it or their account is deleted
 * (`ON DELETE CASCADE`). A production sees only the fields a person has granted to
 * a role of that project (`access_grant`), for as long as the grant is live.
 *
 * Install-level, so it has no `organisation_id`, `owner_org_id` or `visibility`, and
 * it is a service-written table like `user`: only the sensitive service writes it,
 * which `SERVICE_WRITTEN_TABLES` declares, never through the write helper, and every
 * change is audited (the user id only) and not change-logged. The same service is
 * the only code that imports it, because it holds sensitive data (CLAUDE.md, Data
 * rules); a test scans the source for other uses. A person's medical data stays in
 * `person_sensitive`, the organisation's record: this table holds adjustments only.
 *
 * `payload` is marked sensitive, so a change event could never hold its value, and it
 * is validated by the `accessibility` schema before it is stored. `key_id` is reserved
 * for later end-to-end encryption, as in `person_sensitive`. Retention class
 * `account-lifetime`: kept while the account exists, deleted with it or when the person
 * deletes the profile. It has no period and counts from no project date, so a project's
 * wrap, a purge by class or a cleanup never reaches it (decision D-69, P-02l1). The
 * grants it opens stay `crew-health`, the class of the data a production sees.
 */
export const userAccessProfile = pgTable(
  'user_access_profile',
  {
    ...baseColumns(() => user.id, {
      defaultRetentionClass: 'account-lifetime',
    }),
    userId: uuid('user_id').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    keyId: text('key_id'),
  },
  (t) => [
    retentionClassForeignKey('user_access_profile', t.retentionClass),
    // The profile goes with the account. Users are only soft-deleted today, so the
    // service that deletes an account deletes the profile too; this is the backstop.
    foreignKey({
      name: 'user_access_profile_user_fk',
      columns: [t.userId],
      foreignColumns: [user.id],
    }).onDelete('cascade'),
    // One profile per user. The column is NOT NULL, so the NULLS NOT DISTINCT rule of
    // CLAUDE.md (Data rules) does not apply.
    unique('user_access_profile_user_unique').on(t.userId),
  ],
);

markSensitive(userAccessProfile, ['payload']);
