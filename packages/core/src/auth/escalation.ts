import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  orgMembership,
  orgMembershipRole,
  role,
  rolePermission,
  type RolePermissionReach,
} from '../db/schema/index.js';
import type { Tx } from '../db/write.js';

/**
 * The rule against escalation, shared by the services that hand access on (SC-10,
 * decision D-57): an invite may give only what the person making it holds
 * (`createInvite`), and a reset link may be made only for a person who holds
 * nothing the person making it lacks (`createAccessReset`). Both ask the same
 * question: of the grants somebody would hold, which does the person acting not
 * cover? A grant is covered when they hold the permission in the organisation, and,
 * for a grant that reaches every project, hold it at that reach too. A tier adds
 * nothing: it grants no permission (decision D-51), so there is no exception for
 * owners. These functions read without a lock: a change to the roles of the person
 * acting a moment later is not what the rule guards.
 */

/** One grant of a permission, with the reach it was given. */
export type GrantReach = {
  /** The permission key. */
  readonly key: string;
  readonly reach: RolePermissionReach;
};

/**
 * The permission keys of `wanted` that `held` does not cover, sorted, each once.
 * `held` is what the person acting holds in the organisation, with the widest reach
 * of each (`organisationPermissionReaches`). A key is missing when they do not hold
 * it, or when the grant reaches every project (`all-projects`) and they hold it
 * only for the organisation. Reads nothing; anyone may call it.
 */
export function uncoveredPermissions(
  held: ReadonlyMap<string, RolePermissionReach>,
  wanted: readonly GrantReach[],
): string[] {
  const missing = new Set<string>();
  for (const grant of wanted) {
    const reach = held.get(grant.key);
    if (
      reach === undefined ||
      (grant.reach === 'all-projects' && reach !== 'all-projects')
    ) {
      missing.add(grant.key);
    }
  }
  return [...missing].sort();
}

/**
 * Every live grant of the given organisation roles, a department-scoped one too
 * (it needs the permission, at any reach): what an invite that carries these roles
 * would give. An empty list of roles holds nothing. Never writes.
 */
export async function grantsOfRoles(
  tx: Tx,
  organisationId: string,
  roleIds: readonly string[],
): Promise<GrantReach[]> {
  if (roleIds.length === 0) return [];
  return tx
    .select({
      key: rolePermission.permissionKey,
      reach: rolePermission.reach,
    })
    .from(rolePermission)
    .where(
      and(
        eq(rolePermission.organisationId, organisationId),
        inArray(rolePermission.roleId, [...roleIds]),
        isNull(rolePermission.deletedAt),
      ),
    );
}

/**
 * Every live grant a member holds in the organisation, a department-scoped one too:
 * the grants of the live organisation roles linked to their active, undeleted
 * membership, which is what a reset link for them would put in someone else's
 * hands. A member who is not active (invited or removed) holds nothing, as at every
 * permission check. Never writes.
 */
export async function grantsOfMember(
  tx: Tx,
  organisationId: string,
  userId: string,
): Promise<GrantReach[]> {
  return tx
    .select({
      key: rolePermission.permissionKey,
      reach: rolePermission.reach,
    })
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
    );
}
