import { foreignKey, unique, uuid } from 'drizzle-orm/pg-core';
import { standardColumns, tenantTable } from '../columns.js';
import { orgMembership } from './org-membership.js';
import { organisation } from './organisation.js';
import { role } from './role.js';
import { user } from './user.js';

/**
 * Gives an organisation membership a role, so each organisation decides which
 * roles hold which organisation-level permissions. Only organisation roles
 * (`role.project_id` IS NULL) can be linked; a database trigger enforces it on
 * both sides of the link (see the `org_membership_role` migration). Has no
 * `project_id`, so its writes belong to the organisation sequence and it needs
 * no project resolver.
 */
export const orgMembershipRole = tenantTable(
  'org_membership_role',
  () => organisation.id,
  {
    ...standardColumns(() => user.id, { defaultVisibility: 'private' }),
    membershipId: uuid('membership_id').notNull(),
    roleId: uuid('role_id').notNull(),
  },
  (t) => [
    foreignKey({
      name: 'org_membership_role_membership_fk',
      columns: [t.organisationId, t.membershipId],
      foreignColumns: [orgMembership.organisationId, orgMembership.id],
    }),
    foreignKey({
      name: 'org_membership_role_role_fk',
      columns: [t.organisationId, t.roleId],
      foreignColumns: [role.organisationId, role.id],
    }),
    unique('org_membership_role_membership_role_unique').on(
      t.membershipId,
      t.roleId,
    ),
  ],
);
