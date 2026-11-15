import { sql } from 'drizzle-orm';
import { check, foreignKey, text, unique, uuid } from 'drizzle-orm/pg-core';
import { sqlList, standardColumns, tenantTable } from '../columns.js';
import { company } from './company.js';
import { organisation } from './organisation.js';
import { project } from './project.js';
import { user } from './user.js';

/**
 * Allowed values of `project_company.role`. The CHECK is built from this list,
 * so a new value needs a new migration.
 */
export const PROJECT_COMPANY_ROLES = [
  'vendor',
  'co-producer',
  'funder',
  'broadcaster',
  'distributor',
  'other',
] as const;
/** One value of `PROJECT_COMPANY_ROLES`. */
export type ProjectCompanyRole = (typeof PROJECT_COMPANY_ROLES)[number];

/**
 * Allowed values of `project_company.status`. The CHECK is built from this
 * list, so a new value needs a new migration.
 */
export const PROJECT_COMPANY_STATUSES = [
  'proposed',
  'confirmed',
  'ended',
] as const;
/** One value of `PROJECT_COMPANY_STATUSES`. */
export type ProjectCompanyStatus = (typeof PROJECT_COMPANY_STATUSES)[number];

/** A library company's role on one project. */
export const projectCompany = tenantTable(
  'project_company',
  () => organisation.id,
  {
    ...standardColumns(() => user.id),
    projectId: uuid('project_id').notNull(),
    companyId: uuid('company_id').notNull(),
    role: text('role').$type<ProjectCompanyRole>().notNull(),
    status: text('status').$type<ProjectCompanyStatus>().notNull(),
  },
  (t) => [
    foreignKey({
      name: 'project_company_project_fk',
      columns: [t.organisationId, t.projectId],
      foreignColumns: [project.organisationId, project.id],
    }),
    foreignKey({
      name: 'project_company_company_fk',
      columns: [t.organisationId, t.companyId],
      foreignColumns: [company.organisationId, company.id],
    }),
    unique('project_company_role_unique').on(t.projectId, t.companyId, t.role),
    check(
      'project_company_role_check',
      sql`${t.role} in (${sqlList(PROJECT_COMPANY_ROLES)})`,
    ),
    check(
      'project_company_status_check',
      sql`${t.status} in (${sqlList(PROJECT_COMPANY_STATUSES)})`,
    ),
  ],
);
