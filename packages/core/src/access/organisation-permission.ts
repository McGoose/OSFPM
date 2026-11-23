import { and, eq, isNull } from 'drizzle-orm';
import type { Tx } from '../db/write.js';
import { credentialPermits, type AccessCredential } from './credential.js';
import {
  orgMembership,
  orgMembershipRole,
  role,
  rolePermission,
  type RolePermissionReach,
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
 * organisations. A grant's `reach` makes no difference here: `own-scope` and
 * `all-projects` grants both count at organisation level. Whether an
 * organisation role also grants on projects is `hasProjectPermission`'s
 * question, and only an `all-projects` grant does.
 *
 * With a `credential` that is a personal API token, the answer is narrowed first
 * (`credentialPermits`): a token passes only in its own organisation, never at
 * organisation level if it is a project token, never a write permission if it can only
 * read, and a sensitive permission only through its explicit sensitive scope with the
 * organisation's sensitive switch on. It is then the owner's own answer, so a token
 * never passes what its owner does not hold. Without a credential, or with a session's,
 * the answer is not narrowed.
 *
 * Server-side only: permission checks never run on a client (CLAUDE.md, Data
 * rules). The general policy engine comes later and may reuse this.
 */
export async function hasOrganisationPermission(
  tx: Tx,
  userId: string,
  organisationId: string,
  key: string,
  credential?: AccessCredential,
): Promise<boolean> {
  if (
    !(await credentialPermits(
      tx,
      credential,
      { organisationId, projectId: null },
      key,
    ))
  ) {
    return false;
  }
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

/**
 * The permissions `userId` holds in `organisationId`, each with the widest reach
 * they hold it at, read the way `hasOrganisationPermission` reads one: an active,
 * undeleted membership, linked through a live `org_membership_role` to a live
 * organisation role (`role.project_id` is NULL), holding a live grant with no
 * department scope. `all-projects` wins over `own-scope` when a user holds both
 * through different roles. Answers an empty map for a user who is not an active
 * member. Used to check that an invite gives nothing the person making it lacks.
 *
 * Server-side only, like `hasOrganisationPermission`. It reads without a lock.
 */
export async function organisationPermissionReaches(
  tx: Tx,
  userId: string,
  organisationId: string,
): Promise<ReadonlyMap<string, RolePermissionReach>> {
  const found = await tx
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
    );
  // A Map, because the keys come from the catalogue and a plain object would
  // take `__proto__` as one (CLAUDE.md, Data rules).
  const reaches = new Map<string, RolePermissionReach>();
  for (const row of found) {
    if (reaches.get(row.key) !== 'all-projects')
      reaches.set(row.key, row.reach);
  }
  return reaches;
}
