import { and, eq, isNull } from 'drizzle-orm';
import type { Tx } from '../db/write.js';
import { orgMembership, role, rolePermission } from '../db/schema/index.js';

/**
 * True when `userId` has an active, undeleted membership in `organisationId`
 * whose organisation role holds `key`, in any department scope.
 *
 * A membership's role is the organisation template role (`role.project_id` is
 * NULL) with the same key as its `org_role`. Project roles never count here.
 * There is no bypass: owners and admins hold a permission only when their role
 * has it, like everyone else. Invited and removed members hold nothing, and
 * neither do members of other organisations.
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
      role,
      and(
        eq(role.organisationId, orgMembership.organisationId),
        // TODO: replace this key match with a link table between org
        // memberships and roles. A follow-up prompt changes the internals of
        // this function only; the signature stays.
        eq(role.key, orgMembership.orgRole),
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
