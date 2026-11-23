import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { AccessCredential } from '../access/credential.js';
import { hasProjectPermission } from '../access/project-permission.js';
import {
  accessGrant,
  person,
  project,
  projectMembership,
  projectMembershipRole,
  projectPerson,
  role,
  user,
  type AccessGrantCategory,
} from '../db/schema/index.js';
import type { Tx } from '../db/write.js';
import { LIVE_ENGAGEMENT_STATUSES, projectIsOpen } from './liveness.js';
import { readPermissionKey } from './permissions.js';

/**
 * How access grants are read (decision D-69). A grant is live only when it is not revoked,
 * its project is open, its person is still engaged on the project and the person's account,
 * if they have one, is not deleted (`liveness.ts`); and it opens something to a reader only
 * through a role the reader holds in an active membership of that project, on a project
 * where they also hold the category's read permission. The permission alone is never enough
 * (CLAUDE.md, Data rules).
 *
 * Nothing here checks who may ask: the callers (`readSensitive`, `listGrantedAdjustments`)
 * have decided that, and write the audit event. Nothing here writes, locks or logs.
 */

/** One live grant: who it is for, where, which role it opens to, and which fields. */
export type LiveGrant = {
  readonly grantId: string;
  readonly projectId: string;
  readonly personId: string;
  readonly roleId: string;
  readonly fields: readonly string[];
};

/** Which grants to look at: those of one person, or those on one project, in one organisation. */
export type GrantFilter = {
  readonly organisationId: string;
  readonly personId?: string;
  readonly projectId?: string;
};

/**
 * The grants in `filter` and `category` that are live at `now`, in the order of their ids:
 * not revoked, on a project that is open, for a person who is not deleted, still has a
 * live engagement on that project and has no account that is deleted. Works the state out
 * from the rows as they are now, so a project that wrapped, a person who was released or
 * removed, an account that was deleted, or a grant that was revoked a moment ago stops
 * opening anything at once, and no job has to run. The account matters because the
 * organisation's medical record outlives it: without this a deleted account's medical grant
 * would go on opening that record, and every grant would open again on a restore.
 */
export async function liveGrants(
  tx: Tx,
  filter: GrantFilter,
  category: AccessGrantCategory,
  now: Date,
): Promise<LiveGrant[]> {
  const rows = await tx
    .select({
      grantId: accessGrant.id,
      projectId: accessGrant.projectId,
      personId: accessGrant.personId,
      roleId: accessGrant.roleId,
      fields: accessGrant.fields,
      deletedAt: project.deletedAt,
      status: project.status,
      wrapDate: project.wrapDate,
      timezone: project.timezone,
    })
    .from(accessGrant)
    .innerJoin(
      project,
      and(
        eq(project.organisationId, accessGrant.organisationId),
        eq(project.id, accessGrant.projectId),
      ),
    )
    .where(
      and(
        eq(accessGrant.organisationId, filter.organisationId),
        eq(accessGrant.category, category),
        isNull(accessGrant.revokedAt),
        filter.personId === undefined
          ? undefined
          : eq(accessGrant.personId, filter.personId),
        filter.projectId === undefined
          ? undefined
          : eq(accessGrant.projectId, filter.projectId),
      ),
    )
    .orderBy(accessGrant.id);
  const open = rows.filter((row) => projectIsOpen(row, now));
  if (open.length === 0) return [];

  const projectIds = [...new Set(open.map((row) => row.projectId))];
  const personIds = [...new Set(open.map((row) => row.personId))];
  const engaged = await tx
    .select({
      projectId: projectPerson.projectId,
      personId: projectPerson.personId,
    })
    .from(projectPerson)
    .where(
      and(
        eq(projectPerson.organisationId, filter.organisationId),
        inArray(projectPerson.projectId, projectIds),
        inArray(projectPerson.personId, personIds),
        inArray(projectPerson.status, [...LIVE_ENGAGEMENT_STATUSES]),
        isNull(projectPerson.deletedAt),
      ),
    );
  const engagedPairs = new Set(
    engaged.map((row) => `${row.projectId}:${row.personId}`),
  );
  const people = await tx
    .select({ id: person.id })
    .from(person)
    // A person without an account has no user row, so the join leaves `user.deleted_at`
    // null for them: only a deleted account takes its person out.
    .leftJoin(user, eq(user.id, person.userId))
    .where(
      and(
        eq(person.organisationId, filter.organisationId),
        inArray(person.id, personIds),
        isNull(person.deletedAt),
      ),
    );
  const livePeople = new Set(people.map((row) => row.id));
  return open
    .filter(
      (row) =>
        livePeople.has(row.personId) &&
        engagedPairs.has(`${row.projectId}:${row.personId}`),
    )
    .map((row) => ({
      grantId: row.grantId,
      projectId: row.projectId,
      personId: row.personId,
      roleId: row.roleId,
      fields: row.fields,
    }));
}

/**
 * The roles `userId` holds in an active membership of each of `projectIds`, by project:
 * a live role link of an active, undeleted membership, to a live role that is an
 * organisation template or belongs to that project (the same roles `hasProjectPermission`
 * counts). A role the person holds only in the organisation, with no project membership,
 * is not held here: a grant opens only to the people on the project.
 */
export async function rolesHeldOn(
  tx: Tx,
  userId: string,
  organisationId: string,
  projectIds: readonly string[],
): Promise<Map<string, Set<string>>> {
  const held = new Map<string, Set<string>>();
  if (projectIds.length === 0) return held;
  const rows = await tx
    .select({ projectId: projectMembership.projectId, roleId: role.id })
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
    .where(
      and(
        eq(projectMembership.organisationId, organisationId),
        eq(projectMembership.userId, userId),
        inArray(projectMembership.projectId, [...projectIds]),
        eq(projectMembership.status, 'active'),
        isNull(projectMembership.deletedAt),
      ),
    );
  for (const row of rows) {
    const roles = held.get(row.projectId) ?? new Set<string>();
    roles.add(row.roleId);
    held.set(row.projectId, roles);
  }
  return held;
}

/** Who is reading: the user, and the personal API token they read through, if any. */
export type GrantReader = {
  readonly userId: string;
  readonly credential?: AccessCredential;
};

/**
 * The fields of one person's `category` data that the reader may see through live grants:
 * the union, over the projects where the reader holds `sensitive:read:<category>` (with
 * their personal API token's sensitive scope, if they read through one) and holds a role
 * that a live grant names, of the fields of those grants. Fields granted to two roles the
 * reader holds on one project combine. Empty when there is no such grant, which is a
 * denial for the caller: default deny.
 */
export async function grantedFieldsFor(
  tx: Tx,
  reader: GrantReader,
  subject: { readonly id: string; readonly organisationId: string },
  category: AccessGrantCategory,
  now: Date,
): Promise<ReadonlySet<string>> {
  const fields = new Set<string>();
  const grants = await liveGrants(
    tx,
    { organisationId: subject.organisationId, personId: subject.id },
    category,
    now,
  );
  if (grants.length === 0) return fields;
  const projectIds = [...new Set(grants.map((grant) => grant.projectId))];
  const held = await rolesHeldOn(
    tx,
    reader.userId,
    subject.organisationId,
    projectIds,
  );
  const mayRead = new Set<string>();
  for (const projectId of projectIds) {
    if ((held.get(projectId)?.size ?? 0) === 0) continue;
    if (
      await hasProjectPermission(
        tx,
        reader.userId,
        projectId,
        readPermissionKey(category),
        reader.credential,
      )
    ) {
      mayRead.add(projectId);
    }
  }
  for (const grant of grants) {
    if (
      mayRead.has(grant.projectId) &&
      held.get(grant.projectId)?.has(grant.roleId)
    ) {
      for (const field of grant.fields) fields.add(field);
    }
  }
  return fields;
}
