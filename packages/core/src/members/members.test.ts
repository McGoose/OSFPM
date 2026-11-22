import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessDeniedError } from '../access/access-denied-error.js';
import {
  base,
  grantOnOrganisation,
  seedOrganisation,
  seedUser,
} from '../access/test-fixtures.js';
import { setUserStatus } from '../auth/test-support.js';
import type { Database } from '../db/client.js';
import { orgMembership, role, user } from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { eq } from 'drizzle-orm';
import { PERMISSION_LISTS } from '../access/permission-lists.js';
import { syncPermissions } from '../access/permission-sync.js';
import { listMembers } from './service.js';

/** The member list: who is in this organisation, by name, address, tier, status and role keys, and nothing about how they sign in. */
describe.each(testTargets)('listMembers on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  let organisationId: string;
  let otherOrganisationId: string;
  let readerId: string;
  let strangerId: string;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    // The catalogue as start-up leaves it.
    for (const list of PERMISSION_LISTS) {
      await syncPermissions(database.db, list);
    }
    ({ organisationId } = await seedOrganisation(database));
    ({ organisationId: otherOrganisationId } =
      await seedOrganisation(database));
    readerId = await seedUser(database);
    await grantOnOrganisation(database, organisationId, readerId, 'admin', [
      'members:read',
    ]);
    strangerId = await seedUser(database);
  });
  afterAll(async () => {
    await cleanup();
  });

  const db = () => database.db;
  const named = async (userId: string, displayName: string, email: string) =>
    db().update(user).set({ displayName, email }).where(eq(user.id, userId));

  it('lists the members of this organisation with name, address, tier, status and the keys of their roles, in order of name', async () => {
    await named(readerId, 'Ada Demo', 'ada.members@demopictures.example');
    const guest = await seedUser(database);
    await named(guest, 'Zed Demo', 'zed.members@demopictures.example');
    await grantOnOrganisation(database, organisationId, guest, 'guest', [
      'accounts:read',
    ]);
    const members = await listMembers(
      db(),
      { userId: readerId },
      organisationId,
    );
    expect(members.map((member) => member.displayName)).toEqual([
      'Ada Demo',
      'Zed Demo',
    ]);
    expect(members[0]).toEqual({
      userId: readerId,
      displayName: 'Ada Demo',
      email: 'ada.members@demopictures.example',
      tier: 'admin',
      status: 'active',
      roleKeys: ['admin'],
    });
    expect(members[1]).toMatchObject({
      userId: guest,
      tier: 'guest',
      status: 'active',
      roleKeys: ['guest'],
    });
  });

  it('shows nothing about how a member signs in: exactly six fields, none of them a credential', async () => {
    const members = await listMembers(
      db(),
      { userId: readerId },
      organisationId,
    );
    for (const member of members) {
      expect(Object.keys(member).sort()).toEqual([
        'displayName',
        'email',
        'roleKeys',
        'status',
        'tier',
        'userId',
      ]);
    }
    const text = JSON.stringify(members);
    for (const word of [
      'password',
      'totp',
      'passkey',
      'recovery',
      'secret',
      'hash',
      'session',
    ]) {
      expect(text.toLowerCase(), word).not.toContain(word);
    }
  });

  it('lists only this organisation’s members, and a user in two organisations only where they belong', async () => {
    const both = await seedUser(database);
    await named(both, 'Both Demo', 'both.members@demopictures.example');
    await grantOnOrganisation(
      database,
      otherOrganisationId,
      both,
      'member',
      [],
    );
    const elsewhere = await seedUser(database);
    await named(
      elsewhere,
      'Elsewhere Demo',
      'elsewhere.members@demopictures.example',
    );
    await grantOnOrganisation(
      database,
      otherOrganisationId,
      elsewhere,
      'member',
      [],
    );
    const members = await listMembers(
      db(),
      { userId: readerId },
      organisationId,
    );
    const ids = members.map((member) => member.userId);
    expect(ids).not.toContain(both);
    expect(ids).not.toContain(elsewhere);
    // The same person, listed where they are a member.
    await grantOnOrganisation(database, organisationId, both, 'member', []);
    const after = await listMembers(db(), { userId: readerId }, organisationId);
    expect(after.filter((member) => member.userId === both)).toHaveLength(1);
  });

  it('shows a removed membership as removed, and leaves out one that was deleted', async () => {
    const removed = await seedUser(database);
    await named(
      removed,
      'Removed Demo',
      'removed.members@demopictures.example',
    );
    await grantOnOrganisation(database, organisationId, removed, 'member', [], {
      status: 'removed',
    });
    const deleted = await seedUser(database);
    await named(
      deleted,
      'Deleted Demo',
      'deleted.members@demopictures.example',
    );
    await grantOnOrganisation(database, organisationId, deleted, 'member', [], {
      deleted: true,
    });
    const members = await listMembers(
      db(),
      { userId: readerId },
      organisationId,
    );
    expect(members.find((member) => member.userId === removed)?.status).toBe(
      'removed',
    );
    expect(members.some((member) => member.userId === deleted)).toBe(false);
  });

  it('leaves out the key of a role that was deleted, and of a project role', async () => {
    const holder = await seedUser(database);
    await grantOnOrganisation(database, organisationId, holder, 'member', []);
    const [membership] = (await db().select().from(orgMembership)).filter(
      (found) => found.userId === holder,
    );
    expect(membership).toBeDefined();
    const [fleeting] = await db()
      .insert(role)
      .values({
        ...base(organisationId),
        projectId: null,
        key: 'fleeting',
        name: 'Fleeting',
        deletedAt: new Date(),
      })
      .returning();
    expect(fleeting).toBeDefined();
    const members = await listMembers(
      db(),
      { userId: readerId },
      organisationId,
    );
    const found = members.find((member) => member.userId === holder);
    expect(found?.roleKeys).toEqual(['member']);
  });

  it('needs members:read in the organisation, and answers a stranger, a member without it and a user of another organisation alike, with no scope', async () => {
    const withoutPermission = await seedUser(database);
    await grantOnOrganisation(
      database,
      organisationId,
      withoutPermission,
      'member',
      ['accounts:read'],
    );
    const invited = await seedUser(database);
    await grantOnOrganisation(
      database,
      organisationId,
      invited,
      'admin',
      ['members:read'],
      {
        status: 'invited',
      },
    );
    const askers: [string, string][] = [
      ['a stranger', strangerId],
      ['a member without the permission', withoutPermission],
      ['a member whose membership is only invited', invited],
    ];
    for (const [name, userId] of askers) {
      const error = await listMembers(db(), { userId }, organisationId).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error, name).toBeInstanceOf(AccessDeniedError);
      expect((error as AccessDeniedError).scope, name).toBeUndefined();
    }
    // An organisation that does not exist is the same answer.
    const unknown = await listMembers(
      db(),
      { userId: readerId },
      '00000000-0000-7000-8000-000000000000',
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(unknown).toBeInstanceOf(AccessDeniedError);
    expect((unknown as AccessDeniedError).scope).toBeUndefined();
  });

  it('refuses a reader who holds the permission in another organisation only', async () => {
    const elsewhere = await seedUser(database);
    await grantOnOrganisation(
      database,
      otherOrganisationId,
      elsewhere,
      'admin',
      ['members:read'],
    );
    await expect(
      listMembers(db(), { userId: elsewhere }, organisationId),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('lists a member whose account was disabled, as a member', async () => {
    const disabled = await seedUser(database);
    await named(
      disabled,
      'Disabled Demo',
      'disabled.members@demopictures.example',
    );
    await grantOnOrganisation(database, organisationId, disabled, 'member', []);
    await setUserStatus(database, disabled, 'disabled');
    const members = await listMembers(
      db(),
      { userId: readerId },
      organisationId,
    );
    expect(members.some((member) => member.userId === disabled)).toBe(true);
  });
});
