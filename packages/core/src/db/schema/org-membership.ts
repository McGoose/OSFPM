import { sql } from 'drizzle-orm';
import { check, foreignKey, text, unique, uuid } from 'drizzle-orm/pg-core';
import { sqlList, standardColumns, tenantTable } from '../columns.js';
import { declareOrganisationLevel } from '../project-resolver.js';
import { organisation } from './organisation.js';
import { user } from './user.js';

/**
 * Allowed values of `org_membership.org_role`. The CHECK is built from this
 * list, so a new value needs a new migration.
 *
 * A tier grants nothing by itself: permissions come from the roles linked
 * through `org_membership_role` (see `hasOrganisationPermission`).
 */
export const ORG_ROLES = [
  'owner',
  'admin',
  'member',
  'supervisor',
  'guest',
] as const;
/** One value of `ORG_ROLES`. */
export type OrgRole = (typeof ORG_ROLES)[number];

/**
 * Allowed values of `org_membership.status`. The CHECK is built from this list,
 * so a new value needs a new migration.
 *
 * Only `active` counts when a permission is checked.
 */
export const ORG_MEMBERSHIP_STATUSES = [
  'invited',
  'active',
  'removed',
] as const;
/** One value of `ORG_MEMBERSHIP_STATUSES`. */
export type OrgMembershipStatus = (typeof ORG_MEMBERSHIP_STATUSES)[number];

/** A user's place in the organisation. */
export const orgMembership = tenantTable(
  'org_membership',
  () => organisation.id,
  {
    ...standardColumns(() => user.id, { defaultVisibility: 'private' }),
    userId: uuid('user_id').notNull(),
    orgRole: text('org_role').$type<OrgRole>().notNull(),
    status: text('status').$type<OrgMembershipStatus>().notNull(),
  },
  (t) => [
    foreignKey({
      name: 'org_membership_user_id_fk',
      columns: [t.userId],
      foreignColumns: [user.id],
    }),
    unique('org_membership_organisation_user_unique').on(
      t.organisationId,
      t.userId,
    ),
    unique('org_membership_organisation_id_id_unique').on(
      t.organisationId,
      t.id,
    ),
    check(
      'org_membership_org_role_check',
      sql`${t.orgRole} in (${sqlList(ORG_ROLES)})`,
    ),
    check(
      'org_membership_status_check',
      sql`${t.status} in (${sqlList(ORG_MEMBERSHIP_STATUSES)})`,
    ),
  ],
);

/** Belongs to the organisation, never to a project: no project_id, no resolver. */
declareOrganisationLevel(orgMembership);
