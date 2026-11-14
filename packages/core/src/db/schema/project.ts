import { sql } from 'drizzle-orm';
import { boolean, check, date, text, unique } from 'drizzle-orm/pg-core';
import { sqlList, standardColumns, tenantTable } from '../columns.js';
import { registerProjectResolver } from '../project-resolver.js';
import { organisation } from './organisation.js';
import { user } from './user.js';

export const PROJECT_FORMATS = [
  'feature',
  'series',
  'short',
  'commercial',
  'documentary',
  'other',
] as const;
export type ProjectFormat = (typeof PROJECT_FORMATS)[number];

export const PROJECT_STATUSES = [
  'development',
  'pre-production',
  'production',
  'post-production',
  'delivered',
  'archived',
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const project = tenantTable(
  'project',
  () => organisation.id,
  {
    ...standardColumns(() => user.id),
    code: text('code').notNull(),
    title: text('title').notNull(),
    format: text('format').$type<ProjectFormat>().notNull(),
    status: text('status').$type<ProjectStatus>().notNull(),
    timezone: text('timezone').notNull(),
    locale: text('locale').notNull(),
    currency: text('currency').notNull(),
    startDate: date('start_date', { mode: 'string' }),
    endDate: date('end_date', { mode: 'string' }),
    involvesMinors: boolean('involves_minors').notNull().default(false),
  },
  (t) => [
    unique('project_organisation_code_unique').on(t.organisationId, t.code),
    // Target for composite tenant foreign keys in later tables.
    unique('project_organisation_id_id_unique').on(t.organisationId, t.id),
    check(
      'project_format_check',
      sql`${t.format} in (${sqlList(PROJECT_FORMATS)})`,
    ),
    check(
      'project_status_check',
      sql`${t.status} in (${sqlList(PROJECT_STATUSES)})`,
    ),
    check('project_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$'`),
  ],
);

/** A project's own changes belong to its own sequence. */
registerProjectResolver(project, (_tx, row) =>
  Promise.resolve(row.id as string),
);
