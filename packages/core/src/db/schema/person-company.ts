import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { dateRangeCheck } from '../address-columns.js';
import { sqlList, standardColumns, tenantTable } from '../columns.js';
import { declareOrganisationLevel } from '../project-resolver.js';
import { company } from './company.js';
import { organisation } from './organisation.js';
import { person } from './person.js';
import { user } from './user.js';

/**
 * Allowed values of `person_company.relation`. The CHECK is built from this
 * list, so a new value needs a new migration.
 */
export const PERSON_COMPANY_RELATIONS = [
  'employee',
  'represented-by',
  'owner',
  'director',
  'other',
] as const;
/** One value of `PERSON_COMPANY_RELATIONS`. */
export type PersonCompanyRelation = (typeof PERSON_COMPANY_RELATIONS)[number];

/** How a person relates to a company, over a period. Library-level, not per project. */
export const personCompany = tenantTable(
  'person_company',
  () => organisation.id,
  {
    ...standardColumns(() => user.id, { defaultVisibility: 'private' }),
    personId: uuid('person_id').notNull(),
    companyId: uuid('company_id').notNull(),
    relation: text('relation').$type<PersonCompanyRelation>().notNull(),
    startDate: date('start_date', { mode: 'string' }),
    endDate: date('end_date', { mode: 'string' }),
  },
  (t) => [
    foreignKey({
      name: 'person_company_person_fk',
      columns: [t.organisationId, t.personId],
      foreignColumns: [person.organisationId, person.id],
    }),
    foreignKey({
      name: 'person_company_company_fk',
      columns: [t.organisationId, t.companyId],
      foreignColumns: [company.organisationId, company.id],
    }),
    // NULLS NOT DISTINCT: `start_date` is optional, and a plain UNIQUE would
    // let the same link repeat while it is NULL.
    unique('person_company_link_unique')
      .on(t.personId, t.companyId, t.relation, t.startDate)
      .nullsNotDistinct(),
    check(
      'person_company_relation_check',
      sql`${t.relation} in (${sqlList(PERSON_COMPANY_RELATIONS)})`,
    ),
    dateRangeCheck('person_company_dates_check', t.startDate, t.endDate),
  ],
);

/** Belongs to the organisation, never to a project: no project_id, no resolver. */
declareOrganisationLevel(personCompany);
