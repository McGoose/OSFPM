import { and, eq, isNull } from 'drizzle-orm';
import type { Tx } from '../db/write.js';
import {
  orgMembership,
  orgMembershipRole,
  role,
  rolePermission,
} from '../db/schema/index.js';

/**
 * True when `userId` has an active, undeleted membership in `organisationId`
 * that is linked, through a live `org_membership_role`, to a live organisation
 * role (`role.project_id` is NULL) granting `key` with no department scope.
 *
 * A department-scoped grant does not count at organisation level, and project
 * roles never do. `org_membership.org_role` is the membership tier (owner,
 * admin and so on) and grants nothing by itself: owners and admins hold a
 * permission only when a role linked to them has it, like everyone else.
 * Invited and removed members hold nothing, and neither do members of other
 * organisations. Organisation roles do not grant project permissions; see
 * `hasProjectPermission`.
 *
 * The general policy engine comes later and may reuse this.
 */
export async function hasOrganisationPermission(
  tx: Tx,
  userId: string,
  organisationId: string,
  key: string,
): Promise<boolean> {
  const [found] = await tx
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
        eq(rolePermission.permissionKey, key),
        isNull(rolePermission.departmentId),
        isNull(rolePermission.deletedAt),
      ),
    )
    .where(
      and(
        eq(orgMembership.userId, userId),
        eq(orgMembership.organisationId, organisationId),
        eq(orgMembership.status, 'active'),
        isNull(orgMembership.deletedAt),
      ),
    )
    .limit(1);
  return found !== undefined;
}
