import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { hasOrganisationPermission } from './organisation-permission.js';
import {
  ensurePermissions,
  grantOnOrganisation,
  grantOnProject,
  seedOrganisation,
  seedUser,
} from './test-fixtures.js';

const KEY = 'legal-hold:manage';
const OTHER_KEY = 'budget:read';

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
});
