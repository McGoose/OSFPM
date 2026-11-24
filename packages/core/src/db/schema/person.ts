import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  jsonb,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { lowerCaseCheck } from '../address-columns.js';
import { sqlList, standardColumns, tenantTable } from '../columns.js';
import { declareOrganisationLevel } from '../project-resolver.js';
import { department } from './department.js';
import { organisation } from './organisation.js';
import { user } from './user.js';

/**
 * Allowed values of `person.status`. The CHECK is built from this list, so a
 * new value needs a new migration.
 */
export const PERSON_STATUSES = ['active', 'archived'] as const;
/** One value of `PERSON_STATUSES`. */
export type PersonStatus = (typeof PERSON_STATUSES)[number];

/**
 * A person in the organisation's library, stored once however many projects
 * they work on. Identity and contact details only: this table has no notes
 * column and holds no sensitive data, ever (CLAUDE.md, Privacy rule). Sensitive
 * personal data lives in its own table, `person_sensitive`.
 *
 * `communication_preferences` is the one setting it holds: how a person who has no
 * account wants to receive information (decision D-69, P-02l2), in the shape of the
 * preferences schema (`preferences/schemas.ts`), or NULL when nobody has said. They are
 * ordinary settings, not sensitive data, and the write helper change-logs them like any
 * other column; but they are not part of an ordinary read of a person, because a choice
 * such as `easy-read` can hint at something the person has not chosen to share. Only the
 * preferences service reads or writes the column (it validates the value first, and
 * `effectivePreferences` resolves it), and a read of a person names the columns it wants and
 * never selects the whole row. A person who has an account keeps theirs in
 * `user_preferences`, which wins over this column.
 */
export const person = tenantTable(
  'person',
  () => organisation.id,
  {
    ...standardColumns(() => user.id, { defaultVisibility: 'private' }),
    userId: uuid('user_id'),
    displayName: text('display_name').notNull(),
    legalName: text('legal_name'),
    creditName: text('credit_name'),
    pronouns: text('pronouns'),
    email: text('email'),
    phone: text('phone'),
    locale: text('locale'),
    defaultDepartmentId: uuid('default_department_id'),
    communicationPreferences: jsonb('communication_preferences').$type<
      Record<string, unknown>
    >(),
    status: text('status').$type<PersonStatus>().notNull().default('active'),
  },
  (t) => [
    foreignKey({
      name: 'person_user_fk',
      columns: [t.userId],
      foreignColumns: [user.id],
    }),
    foreignKey({
      name: 'person_department_fk',
      columns: [t.organisationId, t.defaultDepartmentId],
      foreignColumns: [department.organisationId, department.id],
    }),
    unique('person_organisation_user_unique').on(t.organisationId, t.userId),
    // Target for composite tenant foreign keys in later tables.
    unique('person_organisation_id_id_unique').on(t.organisationId, t.id),
    lowerCaseCheck('person_email_lowercase_check', t.email),
    check(
      'person_status_check',
      sql`${t.status} in (${sqlList(PERSON_STATUSES)})`,
    ),
  ],
);

/** Belongs to the organisation, never to a project: no project_id, no resolver. */
declareOrganisationLevel(person);
