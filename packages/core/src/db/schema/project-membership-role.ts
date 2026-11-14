import { foreignKey, pgTable, unique, uuid } from 'drizzle-orm/pg-core';
import { standardColumns, visibilityCheck } from '../columns.js';
import { projectMembership } from './project-membership.js';
import { role } from './role.js';
import { organisation } from './organisation.js';
import { user } from './user.js';

/**
 * Gives a project membership a role. The service layer checks that the role
 * is an organisation template or belongs to the same project.
 */
export const projectMembershipRole = pgTable(
  'project_membership_role',
  {
    ...standardColumns(
      () => user.id,
      () => organisation.id,
    ),
    membershipId: uuid('membership_id').notNull(),
    roleId: uuid('role_id').notNull(),
  },
  (t) => [
    foreignKey({
      name: 'project_membership_role_membership_fk',
      columns: [t.organisationId, t.membershipId],
      foreignColumns: [projectMembership.organisationId, projectMembership.id],
    }),
    foreignKey({
      name: 'project_membership_role_role_fk',
      columns: [t.organisationId, t.roleId],
      foreignColumns: [role.organisationId, role.id],
    }),
    unique('project_membership_role_membership_role_unique').on(
      t.membershipId,
      t.roleId,
    ),
    visibilityCheck('project_membership_role', t.visibility),
  ],
);
