import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  engagePerson,
  seedOrganisation,
  seedPerson,
} from '../access/test-fixtures.js';
import { markUserDeleted, markUserRestored } from '../auth/test-support.js';
import type { Database } from '../db/client.js';
import {
  accessGrant,
  auditEvent,
  userAccessProfile,
} from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { PREFERENCE_DEFAULTS } from '../preferences/schemas.js';
import {
  readOwnPreferences,
  saveOwnPreferences,
} from '../preferences/service.js';
import {
  createAccessGrant,
  revokeAccessGrant,
  type AccessConsent,
} from './access-grants.js';
import {
  createAccessProfile,
  deleteAccessProfile,
  readAccessProfile,
} from './access-profile.js';
import { endAccountAccessSharing } from './account-sharing.js';
import { SensitiveAccessDeniedError } from './errors.js';
import { leafStrings, VALID_PAYLOADS } from './payload-fixtures.js';
import { readPermissionKey } from './permissions.js';
import { readSensitive, writeSensitive } from './service.js';
import {
  ctxFor,
  NOW,
  seedAccessScene,
  seedProfileHolder,
  seedRole,
  type AccessScene,
} from './test-support.js';

/**
 * Ending an account's access sharing (decision D-69, carry-over A of P-02l2). Accounts are
 * only soft-deleted, so the grants of a deleted account would stay live, and would open its
 * profile again if the account were restored. `endAccountAccessSharing` is the door's
 * function for the account-deletion service that does not exist yet: it revokes every live
 * accessibility and medical grant of the person, in every project of every organisation, and
 * erases the profile, in the caller's transaction, and writes one event of counts.
 */

const PROFILE = VALID_PAYLOADS.accessibility;
const MEDICAL = VALID_PAYLOADS.medical;
const CONSENT: AccessConsent = {
  method: 'in-person',
  at: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
};
const HOUR = 60 * 60 * 1000;
/** What the deletion service tells the door: the one reason there is today. */
const REASON = 'account-deleted';

describe.each(testTargets)(
  'ending an account’s access sharing on $name',
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

    /** A person with an account who is on the project and has made a profile. A fresh one for each test. */
    const newHolder = (displayName: string) =>
      seedProfileHolder(database, scene, displayName);
    type Holder = Awaited<ReturnType<typeof newHolder>>;

    /** The person grants `fields` to a role, of the project given or the scene's. */
    const grant = (
      who: Holder,
      roleId: string,
      fields: string[],
      options: {
        category?: 'accessibility' | 'medical';
        projectId?: string;
      } = {},
    ) =>
      createAccessGrant(db(), ctxFor(who.userId), {
        projectId: options.projectId ?? scene.projectId,
        personId: who.personId,
        category: options.category ?? 'accessibility',
        roleId,
        fields,
      });

    /** The grant rows of these people, by id, which is the order they were made in. */
    const grantsOf = async (...personIds: string[]) =>
      (await db().select().from(accessGrant))
        .filter((row) => personIds.includes(row.personId))
        .sort((a, b) => a.id.localeCompare(b.id));

    /** The audit events of one category that name a user, by id. */
    const eventsAbout = async (userId: string, category: string) =>
      (await db().select().from(auditEvent))
        .filter(
          (event) => event.targetId === userId && event.category === category,
        )
        .sort((a, b) => a.id.localeCompare(b.id));

    /** The profile rows of a user, whether or not the account counts as live. */
    const profileRowsOf = async (userId: string) =>
      db()
        .select()
        .from(userAccessProfile)
        .where(eq(userAccessProfile.userId, userId));

    /** What the producer, who holds the read permissions, reads of a person's data, or `denied`. */
    const producerSees = async (
      personId: string,
      category: 'accessibility' | 'medical',
    ) => {
      try {
        return (
          (
            await readSensitive(
              db(),
              ctxFor(scene.users.producer),
              personId,
              category,
            )
          )?.payload ?? null
        );
      } catch (error) {
        if (error instanceof SensitiveAccessDeniedError) return 'denied';
        throw error;
      }
    };

    /** Ends the sharing of an account, at the moment every context here says it is. */
    const end = (userId: string) =>
      endAccountAccessSharing(db(), userId, REASON, { now: NOW });

    it('revokes every live accessibility and medical grant of the account, in every project and every organisation, erases the profile, and writes one event of counts', async () => {
      const mira = await newHolder('Mira Vukovic');
      // A second project of the same organisation.
      await engagePerson(
        database,
        scene.organisationId,
        scene.otherProjectId,
        mira.personId,
      );
      // A second organisation, where the same account is a person too.
      const elsewhere = await seedOrganisation(database);
      const miraThere = await seedPerson(database, elsewhere.organisationId, {
        userId: mira.userId,
        displayName: 'Mira Vukovic',
      });
      await engagePerson(
        database,
        elsewhere.organisationId,
        elsewhere.projectId,
        miraThere,
      );
      const roleThere = await seedRole(
        database,
        elsewhere.organisationId,
        'camera',
        [readPermissionKey('accessibility'), readPermissionKey('medical')],
      );

      await grant(mira, scene.roles.production, ['stepFreeRequired']);
      await grant(mira, scene.roles.camera, ['quietSpace']);
      await grant(mira, scene.roles.production, ['maxWalkMetres'], {
        projectId: scene.otherProjectId,
      });
      await createAccessGrant(db(), ctxFor(mira.userId), {
        projectId: elsewhere.projectId,
        personId: miraThere,
        category: 'accessibility',
        roleId: roleThere,
        fields: ['stepFreeRequired'],
      });
      await grant(mira, scene.roles.production, ['conditions'], {
        category: 'medical',
      });
      await createAccessGrant(db(), ctxFor(mira.userId), {
        projectId: elsewhere.projectId,
        personId: miraThere,
        category: 'medical',
        roleId: roleThere,
        fields: ['medication'],
      });
      // People the call is not about: another account holder with a profile and two grants,
      // and a person without an account whom staff recorded a grant for.
      const tomas = await newHolder('Tomas Berg');
      await grant(tomas, scene.roles.production, ['stepFreeRequired']);
      await grant(tomas, scene.roles.production, ['conditions'], {
        category: 'medical',
      });
      await createAccessGrant(db(), ctxFor(scene.users.coordinator), {
        projectId: scene.projectId,
        personId: scene.people.crew.personId,
        category: 'accessibility',
        roleId: scene.roles.camera,
        fields: ['seatingNeeded'],
        consent: CONSENT,
      });
      const neighbours = await grantsOf(
        tomas.personId,
        scene.people.crew.personId,
      );
      expect(neighbours).toHaveLength(3);
      const tomasProfile = await profileRowsOf(tomas.userId);
      const revokeEvents = async () =>
        (await db().select().from(auditEvent)).filter(
          (event) => event.category === 'access.grant-revoked',
        ).length;
      const revokeEventsBefore = await revokeEvents();
      expect(await grantsOf(mira.personId, miraThere)).toHaveLength(6);

      const result = await end(mira.userId);

      expect(result).toEqual({
        accessibilityGrants: 4,
        medicalGrants: 2,
        profileErased: true,
      });
      const mine = await grantsOf(mira.personId, miraThere);
      expect(mine).toHaveLength(6);
      for (const row of mine) {
        expect(row.revokedAt).toEqual(NOW);
        // The account holder's own end of sharing: nobody on staff revoked it.
        expect(row.revokedBy).toBe(mira.userId);
        expect(row.version).toBe(2);
        expect(row.updatedBy).toBe(mira.userId);
        expect(row.updatedAt).toEqual(NOW);
      }
      // Nobody else's grant or profile moved.
      expect(
        await grantsOf(tomas.personId, scene.people.crew.personId),
      ).toEqual(neighbours);
      expect(await profileRowsOf(tomas.userId)).toEqual(tomasProfile);
      expect(await profileRowsOf(mira.userId)).toEqual([]);

      // One event, with counts and the reason, and nothing that says what was shared.
      const events = await eventsAbout(
        mira.userId,
        'access.account-sharing-ended',
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actorType: 'system',
        actorId: null,
        targetType: 'user',
        occurredAt: NOW,
      });
      expect(events[0]!.details).toEqual({
        reason: REASON,
        accessibilityGrants: 4,
        medicalGrants: 2,
        profileErased: true,
      });
      expect(await revokeEvents()).toBe(revokeEventsBefore);
      const text = JSON.stringify(events);
      for (const name of [
        ...Object.keys(PROFILE),
        ...leafStrings(PROFILE),
        ...Object.keys(MEDICAL),
        ...leafStrings(MEDICAL),
        scene.roles.production,
        scene.roles.camera,
        roleThere,
      ]) {
        expect(text).not.toContain(name);
      }
    });

    it('erases the account’s delivery preferences too, with an event of their own, and the person starts again from the defaults', async () => {
      const ines = await newHolder('Ines Kovac');
      await saveOwnPreferences(db(), ctxFor(ines.userId), {
        documentFormat: 'easy-read',
        textSize: 'large',
      });
      const tomas = await newHolder('Tomas Berg');
      await saveOwnPreferences(db(), ctxFor(tomas.userId), {
        textSize: 'extra-large',
      });

      await markUserDeleted(database, ines.userId);
      const result = await end(ines.userId);
      await markUserRestored(database, ines.userId);

      // Restored, the person has chosen nothing: the row is gone, not hidden.
      expect(await readOwnPreferences(db(), ctxFor(ines.userId))).toEqual({
        stored: {},
        effective: PREFERENCE_DEFAULTS,
      });
      // The count of what was shared is as it was: the preferences have an event of their own.
      expect(result).toEqual({
        accessibilityGrants: 0,
        medicalGrants: 0,
        profileErased: true,
      });
      const [erased] = await eventsAbout(ines.userId, 'preferences.erased');
      expect(erased).toMatchObject({
        actorType: 'system',
        actorId: null,
        targetType: 'user',
        occurredAt: NOW,
      });
      expect(JSON.stringify(erased)).not.toContain('easy-read');
      // Nobody else's went.
      expect(
        (await readOwnPreferences(db(), ctxFor(tomas.userId))).stored,
      ).toEqual({ textSize: 'extra-large' });
    });

    it('ends the sharing of an account that is already marked deleted, because the caller may mark it first', async () => {
      const ines = await newHolder('Ines Kovac');
      await grant(ines, scene.roles.production, ['stepFreeRequired']);
      await markUserDeleted(database, ines.userId);

      const result = await end(ines.userId);

      expect(result).toEqual({
        accessibilityGrants: 1,
        medicalGrants: 0,
        profileErased: true,
      });
      expect(await profileRowsOf(ines.userId)).toEqual([]);
      expect(await grantsOf(ines.personId)).toMatchObject([
        { revokedAt: NOW, version: 2 },
      ]);
    });

    it('leaves the organisation’s medical record alone: the grants that opened it end, the record stays', async () => {
      const ines = await newHolder('Ines Kovac');
      await writeSensitive(
        db(),
        ctxFor(ines.userId),
        ines.personId,
        'medical',
        MEDICAL,
        { legalBasis: 'consent' },
      );
      await grant(ines, scene.roles.production, ['conditions'], {
        category: 'medical',
      });
      expect(await producerSees(ines.personId, 'medical')).toEqual({
        conditions: 'Asthma',
      });

      await end(ines.userId);

      expect(await producerSees(ines.personId, 'medical')).toBe('denied');
      // The person still reads all of the record, which belongs to the organisation.
      const own = await readSensitive(
        db(),
        ctxFor(ines.userId),
        ines.personId,
        'medical',
      );
      expect(own?.payload).toEqual(MEDICAL);
    });

    it('leaves a grant that was already revoked as it was, and does not count it', async () => {
      const ines = await newHolder('Ines Kovac');
      await grant(ines, scene.roles.production, ['stepFreeRequired']);
      await grant(ines, scene.roles.camera, ['quietSpace']);
      await grant(ines, scene.roles.production, ['conditions'], {
        category: 'medical',
      });
      const earlier = new Date(NOW.getTime() - 3 * HOUR);
      await revokeAccessGrant(db(), ctxFor(ines.userId, { at: earlier }), {
        projectId: scene.projectId,
        personId: ines.personId,
        category: 'accessibility',
        roleId: scene.roles.camera,
      });

      const result = await end(ines.userId);

      expect(result).toEqual({
        accessibilityGrants: 1,
        medicalGrants: 1,
        profileErased: true,
      });
      const rows = await grantsOf(ines.personId);
      expect(
        rows.find((row) => row.roleId === scene.roles.camera),
      ).toMatchObject({ revokedAt: earlier, version: 2 });
    });

    it('writes the event with zeros when the account had shared nothing and had no profile', async () => {
      const ines = await newHolder('Ines Kovac');
      // The person deletes the profile themselves, as they may.
      await deleteAccessProfile(db(), ctxFor(ines.userId), ines.userId);

      const result = await end(ines.userId);

      expect(result).toEqual({
        accessibilityGrants: 0,
        medicalGrants: 0,
        profileErased: false,
      });
      const [event] = await eventsAbout(
        ines.userId,
        'access.account-sharing-ended',
      );
      expect(event!.details).toEqual({
        reason: REASON,
        accessibilityGrants: 0,
        medicalGrants: 0,
        profileErased: false,
      });
    });

    it('ends sharing for good: the account is deleted, then restored, and nothing opens until the person grants again', async () => {
      const ines = await newHolder('Ines Kovac');
      await writeSensitive(
        db(),
        ctxFor(ines.userId),
        ines.personId,
        'medical',
        MEDICAL,
        { legalBasis: 'consent' },
      );
      await grant(ines, scene.roles.production, ['stepFreeRequired']);
      await grant(ines, scene.roles.production, ['conditions'], {
        category: 'medical',
      });
      expect(await producerSees(ines.personId, 'accessibility')).toEqual({
        stepFreeRequired: true,
      });
      expect(await producerSees(ines.personId, 'medical')).toEqual({
        conditions: 'Asthma',
      });

      // The account is deleted, and the account-deletion service that will exist calls the door.
      await markUserDeleted(database, ines.userId);
      await end(ines.userId);
      expect(await producerSees(ines.personId, 'accessibility')).toBe('denied');
      expect(await producerSees(ines.personId, 'medical')).toBe('denied');

      // Restored: nothing comes back. There is no profile, and no grant is live.
      await markUserRestored(database, ines.userId);
      expect(
        await readAccessProfile(db(), ctxFor(ines.userId), ines.userId),
      ).toBeNull();
      expect(await producerSees(ines.personId, 'accessibility')).toBe('denied');
      expect(await producerSees(ines.personId, 'medical')).toBe('denied');

      // A profile made again opens nothing: the grants that opened the old one are revoked.
      await createAccessProfile(
        db(),
        ctxFor(ines.userId),
        ines.userId,
        PROFILE,
      );
      expect(await producerSees(ines.personId, 'accessibility')).toBe('denied');
      expect(await producerSees(ines.personId, 'medical')).toBe('denied');

      // Only new grants open them again.
      await grant(ines, scene.roles.production, ['stepFreeRequired']);
      await grant(ines, scene.roles.production, ['conditions'], {
        category: 'medical',
      });
      expect(await producerSees(ines.personId, 'accessibility')).toEqual({
        stepFreeRequired: true,
      });
      expect(await producerSees(ines.personId, 'medical')).toEqual({
        conditions: 'Asthma',
      });
    });

    it('shows the hazard the call ends: a restore alone reopens what the account had shared', async () => {
      // The control for the test above. The account is deleted and restored and nobody ends
      // its sharing, so the profile and the grants are as they were and open again.
      const ines = await newHolder('Ines Kovac');
      await grant(ines, scene.roles.production, ['stepFreeRequired']);
      await markUserDeleted(database, ines.userId);
      // The grant is not revoked, but it is not live while the account is deleted, so it
      // opens nothing: a denial (`account-deleted-grants.test.ts` pins the rule).
      expect(await producerSees(ines.personId, 'accessibility')).toBe('denied');
      expect(await grantsOf(ines.personId)).toMatchObject([
        { revokedAt: null },
      ]);

      await markUserRestored(database, ines.userId);

      expect(await producerSees(ines.personId, 'accessibility')).toEqual({
        stepFreeRequired: true,
      });
    });

    it('is one step with the caller’s transaction: when it is rolled back, the profile is back, so is every grant, and there is no event', async () => {
      const ines = await newHolder('Ines Kovac');
      await grant(ines, scene.roles.production, ['stepFreeRequired']);
      await grant(ines, scene.roles.production, ['conditions'], {
        category: 'medical',
      });
      const grantsBefore = await grantsOf(ines.personId);
      const profileBefore = await profileRowsOf(ines.userId);

      await expect(
        db().transaction(async (tx) => {
          await endAccountAccessSharing(tx, ines.userId, REASON, { now: NOW });
          throw new Error('rolled back');
        }),
      ).rejects.toThrow('rolled back');

      expect(await grantsOf(ines.personId)).toEqual(grantsBefore);
      expect(grantsBefore.every((row) => row.revokedAt === null)).toBe(true);
      expect(await profileRowsOf(ines.userId)).toEqual(profileBefore);
      expect(profileBefore).toHaveLength(1);
      expect(
        await eventsAbout(ines.userId, 'access.account-sharing-ended'),
      ).toEqual([]);
    });

    it('takes the time from the call when it is given none, and does not need one', async () => {
      const ines = await newHolder('Ines Kovac');
      await grant(ines, scene.roles.production, ['stepFreeRequired']);
      const before = Date.now();

      await endAccountAccessSharing(db(), ines.userId, REASON);

      const [row] = await grantsOf(ines.personId);
      expect(row!.revokedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(row!.revokedAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    });

    it('refuses a reason that is not on the closed list, and an id that is not a user’s, and writes nothing', async () => {
      const ines = await newHolder('Ines Kovac');
      await grant(ines, scene.roles.production, ['stepFreeRequired']);
      const before = await grantsOf(ines.personId);

      await expect(
        endAccountAccessSharing(
          db(),
          ines.userId,
          'because' as unknown as typeof REASON,
        ),
      ).rejects.toThrow(RangeError);
      await expect(
        endAccountAccessSharing(db(), 'not-an-id', REASON),
      ).rejects.toThrow(RangeError);

      expect(await grantsOf(ines.personId)).toEqual(before);
      expect(await profileRowsOf(ines.userId)).toHaveLength(1);
    });
  },
);
