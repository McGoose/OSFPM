import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedUser } from '../access/test-fixtures.js';
import { markUserDeleted, markUserRestored } from '../auth/test-support.js';
import type { Database } from '../db/client.js';
import {
  accessGrant,
  auditEvent,
  userAccessProfile,
} from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { createAccessGrant, revokeAccessGrant } from './access-grants.js';
import {
  createAccessProfile,
  deleteAccessProfile,
  updateAccessProfile,
} from './access-profile.js';
import { AccountDeletedError } from './errors.js';
import { VALID_PAYLOADS } from './payload-fixtures.js';
import {
  ctxFor,
  seedAccessScene,
  seedProfileHolder,
  type AccessScene,
} from './test-support.js';

/**
 * The access profile and a deleted account (decision D-69, P-02l2). The four writers that
 * touch what an account shares take the account's user row `FOR KEY SHARE` first
 * (`holdAccount`), so none can wait on the deletion of the account while holding what the
 * deletion needs. The one that makes something derived from the account, `createAccessProfile`,
 * also refuses an account that is deleted (`AccountDeletedError`, audited as `access.refused`):
 * a profile made after the account's erasure would outlive it. The ones that only end or change
 * what exists do not look at the answer, because a deleted account may always end what it
 * shared. The lock order itself is tested on PostgreSQL (`profile-vs-deletion-race.test.ts`,
 * `revoke-vs-deletion-race.test.ts`).
 */
describe.each(testTargets)(
  'the access profile of a deleted account on $name',
  (target) => {
    let database: Database;
    let cleanup: () => Promise<void>;
    let scene: AccessScene;

    beforeAll(async () => {
      ({ database, cleanup } = await createMigratedDatabase(target));
      scene = await seedAccessScene(database);
    });
    afterAll(async () => {
      await cleanup();
    });

    const db = () => database.db;
    const PROFILE = VALID_PAYLOADS.accessibility;
    const errorOf = (call: Promise<unknown>): Promise<unknown> =>
      call.then(
        () => undefined,
        (error: unknown) => error,
      );
    const profileRowsOf = (userId: string) =>
      db()
        .select()
        .from(userAccessProfile)
        .where(eq(userAccessProfile.userId, userId));
    const grantsOf = async (personId: string) =>
      (await db().select().from(accessGrant)).filter(
        (row) => row.personId === personId,
      );
    const eventsAbout = async (userId: string, category: string) =>
      (await db().select().from(auditEvent))
        .filter(
          (event) => event.targetId === userId && event.category === category,
        )
        .sort((a, b) => a.id.localeCompare(b.id));

    it('refuses to create a profile for an account that is deleted, audits the refusal, and writes no profile', async () => {
      const userId = await seedUser(database);
      await markUserDeleted(database, userId);

      const refused = await errorOf(
        createAccessProfile(db(), ctxFor(userId), userId, PROFILE),
      );

      expect(refused).toBeInstanceOf(AccountDeletedError);
      expect(await profileRowsOf(userId)).toEqual([]);
      // The reason code and the category, as for every refusal of the grant model, and the
      // user it is about: no field, no value.
      const events = await eventsAbout(userId, 'access.refused');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: 'account-deleted',
        targetType: 'user',
      });
      expect(events[0]!.details).toEqual({
        reason: 'account-deleted',
        category: 'accessibility',
      });
      expect(await eventsAbout(userId, 'access.profile-created')).toEqual([]);
    });

    it('lets the person create the profile once the account is restored', async () => {
      const userId = await seedUser(database);
      await markUserDeleted(database, userId);
      expect(
        await errorOf(
          createAccessProfile(db(), ctxFor(userId), userId, PROFILE),
        ),
      ).toBeInstanceOf(AccountDeletedError);

      await markUserRestored(database, userId);
      const made = await createAccessProfile(
        db(),
        ctxFor(userId),
        userId,
        PROFILE,
      );

      expect(made.userId).toBe(userId);
      expect(await profileRowsOf(userId)).toHaveLength(1);
    });

    it('still lets a deleted account end what it shared: the profile deleted and its accessibility grants revoked', async () => {
      const ines = await seedProfileHolder(database, scene, 'Ines Kovac');
      await createAccessGrant(db(), ctxFor(ines.userId), {
        projectId: scene.projectId,
        personId: ines.personId,
        category: 'accessibility',
        roleId: scene.roles.production,
        fields: ['stepFreeRequired'],
      });
      // A deleted account whose sharing nobody ended: its profile and grant are still rows.
      await markUserDeleted(database, ines.userId);

      await deleteAccessProfile(db(), ctxFor(ines.userId), ines.userId);

      expect(await profileRowsOf(ines.userId)).toEqual([]);
      expect(await grantsOf(ines.personId)).toMatchObject([
        { revokedBy: ines.userId, version: 2 },
      ]);
      const [event] = await eventsAbout(ines.userId, 'access.profile-deleted');
      expect(event!.details).toEqual({ revokedGrants: 1 });
    });

    it('still lets a deleted account revoke a grant it made', async () => {
      const ines = await seedProfileHolder(database, scene, 'Ines Kovac');
      const key = {
        projectId: scene.projectId,
        personId: ines.personId,
        category: 'medical' as const,
        roleId: scene.roles.production,
      };
      await createAccessGrant(db(), ctxFor(ines.userId), {
        ...key,
        fields: ['conditions'],
      });
      await markUserDeleted(database, ines.userId);

      await revokeAccessGrant(db(), ctxFor(ines.userId), key);

      expect(await grantsOf(ines.personId)).toMatchObject([
        { revokedBy: ines.userId, version: 2 },
      ]);
    });

    it('still lets a live account change its profile, as before', async () => {
      const ines = await seedProfileHolder(database, scene, 'Ines Kovac');

      const updated = await updateAccessProfile(
        db(),
        ctxFor(ines.userId),
        ines.userId,
        { ...PROFILE, maxWalkMetres: 250 },
      );

      expect(updated.version).toBe(2);
      expect(updated.payload).toMatchObject({ maxWalkMetres: 250 });
    });
  },
);
