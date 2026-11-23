import { and, eq, isNull } from 'drizzle-orm';
import type { Tx } from '../db/write.js';
import {
  orgMembership,
  orgMembershipRole,
  project,
  projectMembership,
  role,
  rolePermission,
} from '../db/schema/index.js';

/**
 * True when `userId` can reach the project at all: the project is a live project of
 * `organisationId`, and the user has an active, undeleted membership of it, or has an
 * active, undeleted membership of the organisation that is linked, through a live
 * `org_membership_role`, to a live organisation role holding a live grant with reach
 * `all-projects`. It asks about reaching the project, not about any one permission:
 * making a personal API token for a project needs the owner to be able to see that
 * project (SC-10, decision D-68), whatever the token then does there. Deleted rows
 * grant nothing, a tier grants nothing by itself, and a project of another organisation
 * is not reached, whatever the user is. A project that does not exist is not reached,
 * which is the same answer, so an id cannot be probed.
 *
 * Server-side only, like the permission checks. It reads without a lock.
 */
export async function userReachesProject(
  tx: Tx,
  userId: string,
  organisationId: string,
  projectId: string,
): Promise<boolean> {
  const [live] = await tx
    .select({ id: project.id })
    .from(project)
    .where(
      and(
        eq(project.id, projectId),
        eq(project.organisationId, organisationId),
        isNull(project.deletedAt),
      ),
    )
    .limit(1);
  if (live === undefined) return false;

  const [member] = await tx
    .select({ id: projectMembership.id })
    .from(projectMembership)
    .where(
      and(
        eq(projectMembership.organisationId, organisationId),
        eq(projectMembership.projectId, projectId),
        eq(projectMembership.userId, userId),
        eq(projectMembership.status, 'active'),
        isNull(projectMembership.deletedAt),
      ),
    )
    .limit(1);
  if (member !== undefined) return true;

  const [wide] = await tx
    .select({ id: rolePermission.id })
    .from(orgMembership)
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
        eq(rolePermission.reach, 'all-projects'),
        isNull(rolePermission.deletedAt),
      ),
    )
    .where(
      and(
        eq(orgMembership.organisationId, organisationId),
        eq(orgMembership.userId, userId),
        eq(orgMembership.status, 'active'),
        isNull(orgMembership.deletedAt),
      ),
    )
    .limit(1);
  return wide !== undefined;
}
