import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import {
  company,
  department,
  episode,
  location,
  orgMembership,
  orgMembershipRole,
  organisation,
  permission,
  person,
  project,
  projectMembership,
  projectMembershipRole,
  projectPerson,
  role,
  rolePermission,
  unit,
  user,
  type OrgMembershipStatus,
  type OrgRole,
  type ProjectMembershipStatus,
  type ProjectPersonEngagement,
  type ProjectPersonStatus,
} from '../db/schema/index.js';

/**
 * Seed helpers for tests. They insert straight into the tables, as the other
 * schema tests do. People and users here are invented, from the demo
 * production The Last Withdrawal.
 */

export const ORIGIN = newId();

export const base = (organisationId: string) => ({
  organisationId,
  ownerOrgId: organisationId,
  originServer: ORIGIN,
});

let counter = 0;
const next = () => (counter += 1);

export type SeedOrganisation = {
  organisationId: string;
  projectId: string;
  departmentId: string;
};

/** An organisation with one project ("The Last Withdrawal") and one department. */
export async function seedOrganisation(
  database: Database,
): Promise<SeedOrganisation> {
  const n = next();
  const organisationId = newId();
  await database.db.insert(organisation).values({
    id: organisationId,
    organisationId,
    ownerOrgId: organisationId,
    originServer: ORIGIN,
    slug: `fixture-org-${n}`,
    name: 'Demo Pictures',
    country: 'GB',
    defaultLocale: 'en-GB',
    defaultTimezone: 'Europe/London',
    baseCurrency: 'GBP',
    status: 'active',
  });
  const [p] = await database.db
    .insert(project)
    .values({
      ...base(organisationId),
      code: `TLW${n}`,
      title: 'The Last Withdrawal',
      format: 'feature',
      status: 'development',
      timezone: 'Europe/London',
      locale: 'en-GB',
      currency: 'GBP',
    })
    .returning();
  const [d] = await database.db
    .insert(department)
    .values({ ...base(organisationId), key: 'camera', name: 'Camera' })
    .returning();
  return { organisationId, projectId: p!.id, departmentId: d!.id };
}

/** Another project in the same organisation. */
export async function seedProject(
  database: Database,
  organisationId: string,
): Promise<string> {
  const n = next();
  const [p] = await database.db
    .insert(project)
    .values({
      ...base(organisationId),
      code: `TLW-B${n}`,
      title: 'The Last Withdrawal: Second Unit',
      format: 'feature',
      status: 'development',
      timezone: 'Europe/London',
      locale: 'en-GB',
      currency: 'GBP',
    })
    .returning();
  return p!.id;
}

export async function seedDepartment(
  database: Database,
  organisationId: string,
  key: string,
): Promise<string> {
  const [d] = await database.db
    .insert(department)
    .values({ ...base(organisationId), key, name: key })
    .returning();
  return d!.id;
}

export async function seedUser(database: Database): Promise<string> {
  const n = next();
  const [u] = await database.db
    .insert(user)
    .values({
      originServer: ORIGIN,
      email: `fixture.user${n}@example.test`,
      displayName: `Fixture User ${n}`,
      locale: 'en-GB',
      timezone: 'Europe/London',
      status: 'active',
    })
    .returning();
  return u!.id;
}

/** A library person, optionally linked to a user account. */
export async function seedPerson(
  database: Database,
  organisationId: string,
  options: { userId?: string; displayName?: string } = {},
): Promise<string> {
  const [per] = await database.db
    .insert(person)
    .values({
      ...base(organisationId),
      displayName: options.displayName ?? 'Alex Demo',
      userId: options.userId ?? null,
    })
    .returning();
  return per!.id;
}

/** A library company, such as a vendor. */
export async function seedCompany(
  database: Database,
  organisationId: string,
  options: { name?: string } = {},
): Promise<string> {
  const [c] = await database.db
    .insert(company)
    .values({
      ...base(organisationId),
      name: options.name ?? 'Demo Rentals Ltd',
      kind: 'vendor',
    })
    .returning();
  return c!.id;
}

/** A library location, such as a set. */
export async function seedLocation(
  database: Database,
  organisationId: string,
  options: { name?: string } = {},
): Promise<string> {
  const [l] = await database.db
    .insert(location)
    .values({
      ...base(organisationId),
      name: options.name ?? 'Harbour Warehouse',
      kind: 'location',
    })
    .returning();
  return l!.id;
}

/** A second unit of `projectId`; `key` must be new on that project. */
export async function seedUnit(
  database: Database,
  organisationId: string,
  projectId: string,
  key = 'second',
): Promise<string> {
  const [u] = await database.db
    .insert(unit)
    .values({
      ...base(organisationId),
      projectId,
      key,
      name: `Unit ${key}`,
      kind: 'second',
    })
    .returning();
  return u!.id;
}

/** An episode of `projectId`; `number` must be new on that project. */
export async function seedEpisode(
  database: Database,
  organisationId: string,
  projectId: string,
  number = '101',
): Promise<string> {
  const [e] = await database.db
    .insert(episode)
    .values({
      ...base(organisationId),
      projectId,
      number,
      status: 'planned',
    })
    .returning();
  return e!.id;
}

/** Engages `personId` on `projectId`. */
export async function engagePerson(
  database: Database,
  organisationId: string,
  projectId: string,
  personId: string,
  options: {
    engagement?: ProjectPersonEngagement;
    departmentId?: string | null;
    characterName?: string | null;
    status?: ProjectPersonStatus;
  } = {},
): Promise<string> {
  const [row] = await database.db
    .insert(projectPerson)
    .values({
      ...base(organisationId),
      projectId,
      personId,
      engagement: options.engagement ?? 'crew',
      departmentId: options.departmentId ?? null,
      characterName: options.characterName ?? null,
      status: options.status ?? 'confirmed',
    })
    .returning();
  return row!.id;
}

/** Makes sure the catalogue has rows for `keys`. Tests that bypass `syncPermissions` use it. */
export async function ensurePermissions(
  database: Database,
  keys: readonly string[],
): Promise<void> {
  for (const key of keys) {
    await database.db
      .insert(permission)
      .values({
        key,
        module: key.split(':')[0]!,
        description: key,
        grantsSensitive: key.startsWith('sensitive:'),
      })
      .onConflictDoNothing();
  }
}

/**
 * Gives `userId` a membership on `projectId` holding one new role with the
 * given permission keys. `departmentId` limits each permission to that
 * department. The keys must already be in the catalogue.
 */
export async function grantOnProject(
  database: Database,
  organisationId: string,
  projectId: string,
  userId: string,
  keys: readonly string[],
  options: {
    status?: ProjectMembershipStatus;
    departmentId?: string | null;
    roleProjectId?: string | null;
  } = {},
): Promise<{ membershipId: string; roleId: string }> {
  const n = next();
  const [r] = await database.db
    .insert(role)
    .values({
      ...base(organisationId),
      projectId:
        options.roleProjectId === undefined ? null : options.roleProjectId,
      key: `fixture-role-${n}`,
      name: `Fixture role ${n}`,
    })
    .returning();
  for (const key of keys) {
    await database.db.insert(rolePermission).values({
      ...base(organisationId),
      roleId: r!.id,
      permissionKey: key,
      departmentId: options.departmentId ?? null,
    });
  }
  const [m] = await database.db
    .insert(projectMembership)
    .values({
      ...base(organisationId),
      projectId,
      userId,
      status: options.status ?? 'active',
    })
    .returning();
  await database.db.insert(projectMembershipRole).values({
    ...base(organisationId),
    membershipId: m!.id,
    roleId: r!.id,
  });
  return { membershipId: m!.id, roleId: r!.id };
}

/**
 * Makes `userId` a member of the organisation with tier `orgRole`, and links
 * the membership to an organisation role named after that tier (one per
 * organisation, reused) holding the given permission keys. The keys must
 * already be in the catalogue.
 *
 * `linked: false` creates the membership and the role but no link, to show
 * that the tier alone grants nothing. `departmentId` limits each permission to
 * that department. `linkId` is null when no link was made.
 */
export async function grantOnOrganisation(
  database: Database,
  organisationId: string,
  userId: string,
  orgRole: OrgRole,
  keys: readonly string[],
  options: {
    status?: OrgMembershipStatus;
    deleted?: boolean;
    linked?: boolean;
    departmentId?: string | null;
  } = {},
): Promise<{ membershipId: string; roleId: string; linkId: string | null }> {
  const [existing] = await database.db
    .select()
    .from(role)
    .where(
      and(
        eq(role.organisationId, organisationId),
        eq(role.key, orgRole),
        isNull(role.projectId),
      ),
    );
  const roleRow =
    existing ??
    (
      await database.db
        .insert(role)
        .values({
          ...base(organisationId),
          projectId: null,
          key: orgRole,
          name: `Organisation ${orgRole}`,
        })
        .returning()
    )[0]!;
  for (const key of keys) {
    await database.db
      .insert(rolePermission)
      .values({
        ...base(organisationId),
        roleId: roleRow.id,
        permissionKey: key,
        departmentId: options.departmentId ?? null,
      })
      .onConflictDoNothing();
  }
  const [m] = await database.db
    .insert(orgMembership)
    .values({
      ...base(organisationId),
      userId,
      orgRole,
      status: options.status ?? 'active',
      deletedAt: options.deleted ? new Date() : null,
    })
    .returning();
  let linkId: string | null = null;
  if (options.linked ?? true) {
    const [link] = await database.db
      .insert(orgMembershipRole)
      .values({
        ...base(organisationId),
        membershipId: m!.id,
        roleId: roleRow.id,
      })
      .returning();
    linkId = link!.id;
  }
  return { membershipId: m!.id, roleId: roleRow.id, linkId };
}
