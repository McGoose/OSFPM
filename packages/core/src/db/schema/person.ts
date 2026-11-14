import { sql } from 'drizzle-orm';
import { check, foreignKey, text, unique, uuid } from 'drizzle-orm/pg-core';
import { lowerCaseCheck } from '../address-columns.js';
import { sqlList, standardColumns, tenantTable } from '../columns.js';
import { department } from './department.js';
import { organisation } from './organisation.js';
import { user } from './user.js';

export const PERSON_STATUSES = ['active', 'archived'] as const;
export type PersonStatus = (typeof PERSON_STATUSES)[number];

/**
 * A person in the organisation's library, stored once however many projects
 * they work on. Identity and contact details only: this table has no notes
 * column and holds no sensitive data, ever. Sensitive personal data lives in its
 * own table.
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
