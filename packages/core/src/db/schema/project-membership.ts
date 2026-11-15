import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sqlList, standardColumns, tenantTable } from '../columns.js';
import { project } from './project.js';
import { organisation } from './organisation.js';
import { user } from './user.js';

/**
 * Allowed values of `project_membership.status`. The CHECK is built from this
 * list, so a new value needs a new migration.
 *
 * Only `active` counts when a permission is checked (see
 * `hasProjectPermission`).
 */
export const PROJECT_MEMBERSHIP_STATUSES = [
  'invited',
  'active',
  'ended',
] as const;
/** One value of `PROJECT_MEMBERSHIP_STATUSES`. */
export type ProjectMembershipStatus =
  (typeof PROJECT_MEMBERSHIP_STATUSES)[number];

/** A user's place on one project. Their roles are in `project_membership_role`. */
export const projectMembership = tenantTable(
  'project_membership',
  () => organisation.id,
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
  ],
);
