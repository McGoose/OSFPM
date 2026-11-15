import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { orgMembershipRole, role, rolePermission } from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { hasOrganisationPermission } from './organisation-permission.js';
import {
  base,
  ensurePermissions,
  grantOnOrganisation,
  grantOnProject,
  seedOrganisation,
  seedUser,
} from './test-fixtures.js';

const KEY = 'legal-hold:manage';
const OTHER_KEY = 'budget:read';

/** An organisation role (no project) holding `keys` without a department scope. */
async function seedOrganisationRole(
  database: Database,
  organisationId: string,
  key: string,
  keys: readonly string[],
): Promise<string> {
  const [r] = await database.db
    .insert(role)
    .values({ ...base(organisationId), projectId: null, key, name: key })
    .returning({ id: role.id });
  for (const permissionKey of keys) {
    await database.db.insert(rolePermission).values({
      ...base(organisationId),
      roleId: r!.id,
      permissionKey,
      departmentId: null,
    });
  }
  return r!.id;
}

async function linkRole(
  database: Database,
  organisationId: string,
  membershipId: string,
  roleId: string,
): Promise<string> {
  const [link] = await database.db
    .insert(orgMembershipRole)
    .values({ ...base(organisationId), membershipId, roleId })
    .returning({ id: orgMembershipRole.id });
  return link!.id;
}

describe.each(testTargets)('organisation permissions on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    await ensurePermissions(database, [KEY, OTHER_KEY]);
  });
  afterAll(async () => {
    await cleanup();
  });

  const check = (userId: string, organisationId: string, key = KEY) =>
    hasOrganisationPermission(database.db, userId, organisationId, key);

  it('grants a permission through the member organisation role', async () => {
    const { organisationId } = await seedOrganisation(database);
    const userId = await seedUser(database);
    await grantOnOrganisation(database, organisationId, userId, 'admin', [KEY]);
    expect(await check(userId, organisationId)).toBe(true);
  });

  it('refuses a permission the role does not hold, even for an owner', async () => {
    const { organisationId } = await seedOrganisation(database);
    const owner = await seedUser(database);
    await grantOnOrganisation(database, organisationId, owner, 'owner', [
      OTHER_KEY,
    ]);
    expect(await check(owner, organisationId)).toBe(false);
    expect(await check(owner, organisationId, OTHER_KEY)).toBe(true);
  });

  it('refuses a user with no membership', async () => {
    const { organisationId } = await seedOrganisation(database);
    const member = await seedUser(database);
    await grantOnOrganisation(database, organisationId, member, 'admin', [KEY]);
    const stranger = await seedUser(database);
    expect(await check(stranger, organisationId)).toBe(false);
  });

  it('refuses a member of another organisation', async () => {
    const first = await seedOrganisation(database);
    const second = await seedOrganisation(database);
    const userId = await seedUser(database);
    await grantOnOrganisation(database, first.organisationId, userId, 'admin', [
      KEY,
    ]);
    expect(await check(userId, first.organisationId)).toBe(true);
    expect(await check(userId, second.organisationId)).toBe(false);
  });

  it('refuses a soft-deleted membership', async () => {
    const { organisationId } = await seedOrganisation(database);
    const userId = await seedUser(database);
    await grantOnOrganisation(
      database,
      organisationId,
      userId,
      'admin',
      [KEY],
      { deleted: true },
    );
    expect(await check(userId, organisationId)).toBe(false);
  });

  it('refuses invited and removed members', async () => {
    const { organisationId } = await seedOrganisation(database);
    const invited = await seedUser(database);
    const removed = await seedUser(database);
    await grantOnOrganisation(
      database,
      organisationId,
      invited,
      'member',
      [KEY],
      { status: 'invited' },
    );
    await grantOnOrganisation(
      database,
      organisationId,
      removed,
      'guest',
      [KEY],
      { status: 'removed' },
    );
    expect(await check(invited, organisationId)).toBe(false);
    expect(await check(removed, organisationId)).toBe(false);
  });

  it('does not count a permission held only through a project role', async () => {
    const { organisationId, projectId } = await seedOrganisation(database);
    const userId = await seedUser(database);
    await grantOnProject(database, organisationId, projectId, userId, [KEY]);
    expect(await check(userId, organisationId)).toBe(false);
  });

  it('grants through a linked role that is not named after the membership tier', async () => {
    const { organisationId } = await seedOrganisation(database);
    const userId = await seedUser(database);
    const { membershipId } = await grantOnOrganisation(
      database,
      organisationId,
      userId,
      'member',
      [],
      { linked: false },
    );
    const finance = await seedOrganisationRole(
      database,
      organisationId,
      'finance',
      [KEY],
    );
    expect(await check(userId, organisationId)).toBe(false);
    await linkRole(database, organisationId, membershipId, finance);
    expect(await check(userId, organisationId)).toBe(true);
  });

  it('grants when any one of several linked roles holds the permission', async () => {
    const { organisationId } = await seedOrganisation(database);
    const userId = await seedUser(database);
    const { membershipId } = await grantOnOrganisation(
      database,
      organisationId,
      userId,
      'member',
      [],
      { linked: false },
    );
    const other = await seedOrganisationRole(
      database,
      organisationId,
      'budget-reader',
      [OTHER_KEY],
    );
    const finance = await seedOrganisationRole(
      database,
      organisationId,
      'finance',
      [KEY],
    );
    await linkRole(database, organisationId, membershipId, other);
    expect(await check(userId, organisationId)).toBe(false);
    await linkRole(database, organisationId, membershipId, finance);
    expect(await check(userId, organisationId)).toBe(true);
    expect(await check(userId, organisationId, OTHER_KEY)).toBe(true);
  });

  it('refuses without a link, even when org_role equals the key of a role that holds the permission', async () => {
    const { organisationId } = await seedOrganisation(database);
    const userId = await seedUser(database);
    await grantOnOrganisation(
      database,
      organisationId,
      userId,
      'admin',
      [KEY],
      {
        linked: false,
      },
    );
    expect(await check(userId, organisationId)).toBe(false);
  });

  it('refuses a membership linked only to other roles, even when a role has the key of its org_role', async () => {
    const { organisationId } = await seedOrganisation(database);
    const holder = await seedUser(database);
    // Creates the organisation role "admin" holding KEY, linked to `holder`.
    await grantOnOrganisation(database, organisationId, holder, 'admin', [KEY]);
    const userId = await seedUser(database);
    // Same tier "admin", reusing that role, but not linked to it.
    const { membershipId } = await grantOnOrganisation(
      database,
      organisationId,
      userId,
      'admin',
      [],
      { linked: false },
    );
    const viewer = await seedOrganisationRole(
      database,
      organisationId,
      'viewer',
      [OTHER_KEY],
    );
    await linkRole(database, organisationId, membershipId, viewer);
    expect(await check(holder, organisationId)).toBe(true);
    expect(await check(userId, organisationId)).toBe(false);
    expect(await check(userId, organisationId, OTHER_KEY)).toBe(true);
  });

  it('refuses when the link is soft-deleted, and grants again when it is restored', async () => {
    const { organisationId } = await seedOrganisation(database);
    const userId = await seedUser(database);
    const { linkId } = await grantOnOrganisation(
      database,
      organisationId,
      userId,
      'admin',
      [KEY],
    );
    const setDeleted = (deletedAt: Date | null) =>
      database.db
        .update(orgMembershipRole)
        .set({ deletedAt })
        .where(eq(orgMembershipRole.id, linkId!));
    expect(await check(userId, organisationId)).toBe(true);
    await setDeleted(new Date());
    expect(await check(userId, organisationId)).toBe(false);
    await setDeleted(null);
    expect(await check(userId, organisationId)).toBe(true);
  });

  it('refuses when the role is soft-deleted, and grants again when it is restored', async () => {
    const { organisationId } = await seedOrganisation(database);
    const userId = await seedUser(database);
    const { roleId } = await grantOnOrganisation(
      database,
      organisationId,
      userId,
      'admin',
      [KEY],
    );
    const setDeleted = (deletedAt: Date | null) =>
      database.db.update(role).set({ deletedAt }).where(eq(role.id, roleId));
    expect(await check(userId, organisationId)).toBe(true);
    await setDeleted(new Date());
    expect(await check(userId, organisationId)).toBe(false);
    await setDeleted(null);
    expect(await check(userId, organisationId)).toBe(true);
  });

  it('refuses when the role permission is soft-deleted', async () => {
    const { organisationId } = await seedOrganisation(database);
    const userId = await seedUser(database);
    const { roleId } = await grantOnOrganisation(
      database,
      organisationId,
      userId,
      'admin',
      [KEY],
    );
    await database.db
      .update(rolePermission)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(rolePermission.roleId, roleId),
          eq(rolePermission.permissionKey, KEY),
        ),
      );
    expect(await check(userId, organisationId)).toBe(false);
  });

  it('does not count a department-scoped grant, only an organisation-wide one', async () => {
    const { organisationId, departmentId } = await seedOrganisation(database);
    const userId = await seedUser(database);
    const { roleId } = await grantOnOrganisation(
      database,
      organisationId,
      userId,
      'admin',
      [KEY],
      { departmentId },
    );
    expect(await check(userId, organisationId)).toBe(false);
    await database.db.insert(rolePermission).values({
      ...base(organisationId),
      roleId,
      permissionKey: KEY,
      departmentId: null,
    });
    expect(await check(userId, organisationId)).toBe(true);
  });
});
