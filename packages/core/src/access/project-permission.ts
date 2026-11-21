import { and, eq, isNull, or } from 'drizzle-orm';
import type { Tx } from '../db/write.js';
import {
  orgMembership,
  orgMembershipRole,
  permission,
  project,
  projectMembership,
  projectMembershipRole,
  role,
  rolePermission,
} from '../db/schema/index.js';

/**
 * True when `userId` holds `key` on `projectId`, in either of two ways.
 *
 * Through the project: an active membership on the project with a role that
 * holds `key`, in any department scope. The role must be an organisation
 * template or belong to that project.
 *
 * Through the organisation: an active, undeleted organisation membership in the
 * project's organisation, linked through a live `org_membership_role` to a live
 * organisation role with a live grant of `key` whose `reach` is `all-projects`,
 * on a project that is not deleted. A grant with `own-scope` reach stays at
 * organisation level and never counts here (see `hasOrganisationPermission`).
 * A permission flagged `grants_sensitive` never counts through the
 * organisation, even if an `all-projects` grant of it exists: the database
 * refuses to store one, and this check refuses it as well, so sensitive access
 * always needs project membership (CLAUDE.md, Privacy rule; maintainer decision
 * of 21 Nov, task P-02k).
 *
 * Deleted rows grant nothing. Org owners and admins get nothing extra: their
 * tier grants nothing, only roles do. Invited and removed members hold nothing,
 * and neither do members of other organisations.
 *
 * Server-side only: permission checks never run on a client (CLAUDE.md, Data
 * rules). The general policy engine comes later and may reuse this.
 */
export async function hasProjectPermission(
  tx: Tx,
  userId: string,
  projectId: string,
  key: string,
): Promise<boolean> {
  const [viaProject] = await tx
    .select({ id: rolePermission.id })
    .from(projectMembership)
    .innerJoin(
      projectMembershipRole,
      and(
        eq(
          projectMembershipRole.organisationId,
          projectMembership.organisationId,
        ),
        eq(projectMembershipRole.membershipId, projectMembership.id),
        isNull(projectMembershipRole.deletedAt),
      ),
    )
    .innerJoin(
      role,
      and(
        eq(role.organisationId, projectMembershipRole.organisationId),
        eq(role.id, projectMembershipRole.roleId),
        isNull(role.deletedAt),
        or(
          isNull(role.projectId),
          eq(role.projectId, projectMembership.projectId),
        ),
      ),
    )
    .innerJoin(
      rolePermission,
      and(
        eq(rolePermission.organisationId, role.organisationId),
        eq(rolePermission.roleId, role.id),
        eq(rolePermission.permissionKey, key),
        isNull(rolePermission.deletedAt),
      ),
    )
    .where(
      and(
        eq(projectMembership.userId, userId),
        eq(projectMembership.projectId, projectId),
        eq(projectMembership.status, 'active'),
        isNull(projectMembership.deletedAt),
      ),
    )
    .limit(1);
  if (viaProject !== undefined) return true;

  const [viaOrganisation] = await tx
    .select({ id: rolePermission.id })
    .from(project)
    .innerJoin(
      orgMembership,
      and(
        eq(orgMembership.organisationId, project.organisationId),
        eq(orgMembership.userId, userId),
        eq(orgMembership.status, 'active'),
        isNull(orgMembership.deletedAt),
      ),
    )
    .innerJoin(
      orgMembershipRole,
      and(
        eq(orgMembershipRole.organisationId, orgMembership.organisationId),
        eq(orgMembershipRole.membershipId, orgMembership.id),
        isNull(orgMembershipRole.deletedAt),
      ),
    )
    .innerJoin(
      role,
      and(
        eq(role.organisationId, orgMembershipRole.organisationId),
        eq(role.id, orgMembershipRole.roleId),
        isNull(role.projectId),
        isNull(role.deletedAt),
      ),
    )
    .innerJoin(
      rolePermission,
      and(
        eq(rolePermission.organisationId, role.organisationId),
        eq(rolePermission.roleId, role.id),
        eq(rolePermission.permissionKey, key),
        eq(rolePermission.reach, 'all-projects'),
        isNull(rolePermission.deletedAt),
      ),
    )
    .innerJoin(
      permission,
      and(
        eq(permission.key, rolePermission.permissionKey),
        eq(permission.grantsSensitive, false),
      ),
    )
    .where(and(eq(project.id, projectId), isNull(project.deletedAt)))
    .limit(1);
  return viaOrganisation !== undefined;
}
