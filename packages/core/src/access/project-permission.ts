import { and, eq, isNull, or } from 'drizzle-orm';
import type { Tx } from '../db/write.js';
import {
  projectMembership,
  projectMembershipRole,
  role,
  rolePermission,
} from '../db/schema/index.js';

/**
 * True when `userId` has an active membership on `projectId` with a role that
 * holds `key`, in any department scope. The role must be an organisation
 * template or belong to that project. Deleted rows grant nothing. Org owners
 * and admins get nothing extra: only project roles count.
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
  const [found] = await tx
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
  return found !== undefined;
}
