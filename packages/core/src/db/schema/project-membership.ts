import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sqlList, standardColumns, visibilityCheck } from '../columns.js';
import { project } from './project.js';
import { user } from './user.js';

export const PROJECT_MEMBERSHIP_STATUSES = [
  'invited',
  'active',
  'ended',
] as const;
export type ProjectMembershipStatus =
  (typeof PROJECT_MEMBERSHIP_STATUSES)[number];

/** A user's place on one project. Their roles are in `project_membership_role`. */
export const projectMembership = pgTable(
  'project_membership',
  {
    ...standardColumns(() => user.id),
    projectId: uuid('project_id').notNull(),
    userId: uuid('user_id').notNull(),
    status: text('status').$type<ProjectMembershipStatus>().notNull(),
    startDate: date('start_date', { mode: 'string' }),
    endDate: date('end_date', { mode: 'string' }),
  },
  (t) => [
    foreignKey({
      name: 'project_membership_project_fk',
      columns: [t.organisationId, t.projectId],
      foreignColumns: [project.organisationId, project.id],
    }),
    foreignKey({
      name: 'project_membership_user_id_fk',
      columns: [t.userId],
      foreignColumns: [user.id],
    }),
    unique('project_membership_project_user_unique').on(t.projectId, t.userId),
    unique('project_membership_organisation_id_id_unique').on(
      t.organisationId,
      t.id,
    ),
    check(
      'project_membership_status_check',
      sql`${t.status} in (${sqlList(PROJECT_MEMBERSHIP_STATUSES)})`,
    ),
    visibilityCheck('project_membership', t.visibility),
  ],
);
