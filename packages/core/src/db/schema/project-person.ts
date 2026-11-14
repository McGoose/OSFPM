import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  integer,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { dateRangeCheck } from '../address-columns.js';
import { sqlList, standardColumns, tenantTable } from '../columns.js';
import { department } from './department.js';
import { organisation } from './organisation.js';
import { person } from './person.js';
import { project } from './project.js';
import { user } from './user.js';

export const PROJECT_PERSON_ENGAGEMENTS = [
  'crew',
  'cast',
  'background',
  'contact',
] as const;
export type ProjectPersonEngagement =
  (typeof PROJECT_PERSON_ENGAGEMENTS)[number];

export const PROJECT_PERSON_STATUSES = [
  'proposed',
  'confirmed',
  'released',
] as const;
export type ProjectPersonStatus = (typeof PROJECT_PERSON_STATUSES)[number];

/**
 * A library person's engagement on one project, with the project-specific
 * details: job, department, dates, character and cast number. Cast numbers are
 * deliberately not unique per project: double casting (young and old version of
 * a character), twins and doubles share one.
 */
export const projectPerson = tenantTable(
  'project_person',
  () => organisation.id,
  {
    ...standardColumns(() => user.id),
    projectId: uuid('project_id').notNull(),
    personId: uuid('person_id').notNull(),
    engagement: text('engagement').$type<ProjectPersonEngagement>().notNull(),
    departmentId: uuid('department_id'),
    jobTitle: text('job_title'),
    characterName: text('character_name'),
    castNumber: integer('cast_number'),
    startDate: date('start_date', { mode: 'string' }),
    endDate: date('end_date', { mode: 'string' }),
    status: text('status').$type<ProjectPersonStatus>().notNull(),
  },
  (t) => [
    foreignKey({
      name: 'project_person_project_fk',
      columns: [t.organisationId, t.projectId],
      foreignColumns: [project.organisationId, project.id],
    }),
    foreignKey({
      name: 'project_person_person_fk',
      columns: [t.organisationId, t.personId],
      foreignColumns: [person.organisationId, person.id],
    }),
    foreignKey({
      name: 'project_person_department_fk',
      columns: [t.organisationId, t.departmentId],
      foreignColumns: [department.organisationId, department.id],
    }),
    unique('project_person_engagement_unique')
      .on(t.projectId, t.personId, t.engagement, t.characterName)
      .nullsNotDistinct(),
    // Target for composite tenant foreign keys in later tables.
    unique('project_person_organisation_id_id_unique').on(
      t.organisationId,
      t.id,
    ),
    check(
      'project_person_engagement_check',
      sql`${t.engagement} in (${sqlList(PROJECT_PERSON_ENGAGEMENTS)})`,
    ),
    check(
      'project_person_status_check',
      sql`${t.status} in (${sqlList(PROJECT_PERSON_STATUSES)})`,
    ),
    check(
      'project_person_cast_number_positive_check',
      sql`${t.castNumber} is null or ${t.castNumber} > 0`,
    ),
    check(
      'project_person_cast_number_cast_only_check',
      sql`${t.castNumber} is null or ${t.engagement} = 'cast'`,
    ),
    dateRangeCheck('project_person_dates_check', t.startDate, t.endDate),
  ],
);
