import { and, asc, eq, isNull } from 'drizzle-orm';
import { AccessDeniedError } from '../access/access-denied-error.js';
import { hasOrganisationPermission } from '../access/organisation-permission.js';
import {
  orgMembership,
  orgMembershipRole,
  role,
  user,
  type OrgMembershipStatus,
  type OrgRole,
} from '../db/schema/index.js';
import type { Tx } from '../db/write.js';
import { MEMBERS_READ_PERMISSION } from './permissions.js';

/** The person listing members: the signed-in user, whose permission is checked in the organisation. */
export type MemberActor = {
  readonly userId: string;
};

/**
 * One member of an organisation, as a list shows them: who they are by name and
 * address, their tier, whether the membership is active, and the keys of the roles
 * they hold. Nothing about how they sign in (no password, authenticator, passkey or
 * recovery code, not even whether they have one), and no crew personal data, which
 * belongs to `person` and `sensitive:read:*` (CLAUDE.md, Privacy rule).
 */
export type MemberView = {
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
  /** The membership tier. It grants nothing by itself (decision D-51). */
  readonly tier: OrgRole;
  readonly status: OrgMembershipStatus;
  /** The keys of the live organisation roles linked to the membership, sorted. */
  readonly roleKeys: readonly string[];
};

/**
 * Lists the members of an organisation: every undeleted membership of it, active,
 * invited or removed, with the user's display name and address and the keys of
 * their live organisation roles, ordered by name and then address. Needs
 * `members:read` in the organisation. Only this organisation's members: a user
 * who belongs to several appears only where the membership is.
 *
 * The organisation was named by id, so a refusal carries no scope and is the same
 * for an organisation that does not exist, one the user is not a member of and
 * one they are a member of without the permission: it never says which. Not
 * audited: only sensitive data and legal holds audit a denial, and a member list
 * holds none (it reads the `user` table for a name and an address only).
 *
 * @throws AccessDeniedError, with no scope, without the permission.
 */
export async function listMembers(
  tx: Tx,
  actor: MemberActor,
  organisationId: string,
): Promise<MemberView[]> {
  if (
    !(await hasOrganisationPermission(
      tx,
      actor.userId,
      organisationId,
      MEMBERS_READ_PERMISSION,
    ))
  ) {
    throw new AccessDeniedError(MEMBERS_READ_PERMISSION);
  }
  const memberships = await tx
    .select({
      membershipId: orgMembership.id,
      userId: user.id,
      displayName: user.displayName,
      email: user.email,
      tier: orgMembership.orgRole,
      status: orgMembership.status,
    })
    .from(orgMembership)
    .innerJoin(user, eq(user.id, orgMembership.userId))
    .where(
      and(
        eq(orgMembership.organisationId, organisationId),
        isNull(orgMembership.deletedAt),
      ),
    )
    .orderBy(asc(user.displayName), asc(user.email));
  if (memberships.length === 0) return [];
  const links = await tx
    .select({ membershipId: orgMembershipRole.membershipId, key: role.key })
    .from(orgMembershipRole)
    .innerJoin(
      role,
      and(
        eq(role.organisationId, orgMembershipRole.organisationId),
        eq(role.id, orgMembershipRole.roleId),
        isNull(role.projectId),
        isNull(role.deletedAt),
      ),
    )
    .where(
      and(
        eq(orgMembershipRole.organisationId, organisationId),
        isNull(orgMembershipRole.deletedAt),
      ),
    );
  // A Map, because the ids come from the database and the keys are caller-made
  // names: neither belongs as a key of a plain object.
  const keysByMembership = new Map<string, string[]>();
  for (const link of links) {
    keysByMembership.set(link.membershipId, [
      ...(keysByMembership.get(link.membershipId) ?? []),
      link.key,
    ]);
  }
  return memberships.map(({ membershipId, ...member }) => ({
    ...member,
    roleKeys: (keysByMembership.get(membershipId) ?? []).sort(),
  }));
}
