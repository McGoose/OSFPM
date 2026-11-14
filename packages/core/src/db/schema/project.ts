import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  pgTable,
  text,
  unique,
} from 'drizzle-orm/pg-core';
import { sqlList, standardColumns, visibilityCheck } from '../columns.js';
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

export const project = pgTable(
  'project',
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
    foreignKey({
      name: 'project_organisation_id_fk',
      columns: [t.organisationId],
      foreignColumns: [organisation.id],
    }),
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
    visibilityCheck('project', t.visibility),
  ],
);
