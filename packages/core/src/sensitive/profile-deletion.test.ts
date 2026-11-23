import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  engagePerson,
  seedOrganisation,
  seedPerson,
} from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import { accessGrant, auditEvent } from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import {
  createAccessGrant,
  revokeAccessGrant,
  type AccessConsent,
} from './access-grants.js';
import {
  createAccessProfile,
  deleteAccessProfile,
  loadProfile,
} from './access-profile.js';
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
 * Deleting an access profile ends what it opened (decision D-69). A grant only chooses who
 * sees which fields of the profile, so one that outlived the profile would open the next
 * profile the person makes, which they never agreed to. The deletion therefore revokes all
 * of the person's accessibility grants, in every project of every organisation they are in,
 * in the same transaction, and writes one event with the number it ended. Medical grants
 * belong to the organisation's record, not to the profile, and are left alone.
 */

const PROFILE = VALID_PAYLOADS.accessibility;
const CONSENT: AccessConsent = {
  method: 'in-person',
  at: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
};
const HOUR = 60 * 60 * 1000;

describe.each(testTargets)('deleting an access profile on $name', (target) => {
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

  /** What the producer, who holds a role with the read permission, reads of a person's accessibility data. */
  const producerSees = async (personId: string) => {
    try {
      return (
        (
          await readSensitive(
            db(),
            ctxFor(scene.users.producer),
            personId,
            'accessibility',
          )
        )?.payload ?? null
      );
    } catch (error) {
      if (error instanceof SensitiveAccessDeniedError) return 'denied';
      throw error;
    }
  };

  it('revokes every live accessibility grant of the person, in every project and every organisation they are in, and writes one event with the count', async () => {
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
      [readPermissionKey('accessibility')],
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
    // People the deletion is not about: another account holder with a profile and a
    // grant, and a person without an account whom staff recorded a grant for.
    const tomas = await newHolder('Tomas Berg');
    await grant(tomas, scene.roles.production, ['stepFreeRequired']);
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
    expect(neighbours).toHaveLength(2);
    const revokeEvents = async () =>
      (await db().select().from(auditEvent)).filter(
        (event) => event.category === 'access.grant-revoked',
      ).length;
    const revokeEventsBefore = await revokeEvents();
    expect(await grantsOf(mira.personId, miraThere)).toHaveLength(4);

    await deleteAccessProfile(db(), ctxFor(mira.userId), mira.userId);

    const mine = await grantsOf(mira.personId, miraThere);
    expect(mine).toHaveLength(4);
    for (const row of mine) {
      expect(row.revokedAt).toEqual(NOW);
      expect(row.revokedBy).toBe(mira.userId);
      expect(row.version).toBe(2);
      expect(row.updatedBy).toBe(mira.userId);
    }
    // Nobody else's grant moved.
    expect(await grantsOf(tomas.personId, scene.people.crew.personId)).toEqual(
      neighbours,
    );

    // One event, with the number it ended and nothing that says what was shared.
    const events = await eventsAbout(mira.userId, 'access.profile-deleted');
    expect(events).toHaveLength(1);
    expect(events[0]!.details).toEqual({ revokedGrants: 4 });
    expect(await revokeEvents()).toBe(revokeEventsBefore);
    const text = JSON.stringify(events);
    for (const name of [
      ...Object.keys(PROFILE),
      ...leafStrings(PROFILE),
      scene.roles.production,
      scene.roles.camera,
      roleThere,
    ]) {
      expect(text).not.toContain(name);
    }
  });

  it('leaves a medical grant alone: it opens the organisation’s record, not the profile', async () => {
    const ines = await newHolder('Ines Kovac');
    await writeSensitive(
      db(),
      ctxFor(ines.userId),
      ines.personId,
      'medical',
      VALID_PAYLOADS.medical,
      { legalBasis: 'consent' },
    );
    await grant(ines, scene.roles.production, ['stepFreeRequired']);
    await grant(ines, scene.roles.production, ['conditions'], {
      category: 'medical',
    });
    const [medicalBefore] = (await grantsOf(ines.personId)).filter(
      (row) => row.category === 'medical',
    );

    await deleteAccessProfile(db(), ctxFor(ines.userId), ines.userId);

    const rows = await grantsOf(ines.personId);
    expect(rows.find((row) => row.category === 'medical')).toEqual(
      medicalBefore,
    );
    expect(medicalBefore!.revokedAt).toBeNull();
    expect(rows.find((row) => row.category === 'accessibility')).toMatchObject({
      revokedAt: NOW,
      version: 2,
    });
    const read = await readSensitive(
      db(),
      ctxFor(scene.users.producer),
      ines.personId,
      'medical',
    );
    expect(read?.payload).toEqual({ conditions: 'Asthma' });
    const [event] = await eventsAbout(ines.userId, 'access.profile-deleted');
    expect(event!.details).toEqual({ revokedGrants: 1 });
  });

  it('leaves a grant that was already revoked as it was, and does not count it', async () => {
    const ines = await newHolder('Ines Kovac');
    await grant(ines, scene.roles.production, ['stepFreeRequired']);
    await grant(ines, scene.roles.camera, ['quietSpace']);
    const earlier = new Date(NOW.getTime() - 3 * HOUR);
    await revokeAccessGrant(db(), ctxFor(ines.userId, { at: earlier }), {
      projectId: scene.projectId,
      personId: ines.personId,
      category: 'accessibility',
      roleId: scene.roles.camera,
    });

    await deleteAccessProfile(db(), ctxFor(ines.userId), ines.userId);

    const rows = await grantsOf(ines.personId);
    expect(rows.find((row) => row.roleId === scene.roles.camera)).toMatchObject(
      { revokedAt: earlier, version: 2 },
    );
    expect(
      rows.find((row) => row.roleId === scene.roles.production),
    ).toMatchObject({ revokedAt: NOW, version: 2 });
    const [event] = await eventsAbout(ines.userId, 'access.profile-deleted');
    expect(event!.details).toEqual({ revokedGrants: 1 });
  });

  it('writes the count even when the person had shared nothing', async () => {
    const ines = await newHolder('Ines Kovac');
    await deleteAccessProfile(db(), ctxFor(ines.userId), ines.userId);
    const [event] = await eventsAbout(ines.userId, 'access.profile-deleted');
    expect(event!.details).toEqual({ revokedGrants: 0 });
  });

  it('leaves a new profile closed until new grants are made: delete, grants revoked, make it again, nothing opens, then a new grant opens it', async () => {
    const ines = await newHolder('Ines Kovac');
    await grant(ines, scene.roles.production, ['stepFreeRequired']);
    expect(await producerSees(ines.personId)).toEqual({
      stepFreeRequired: true,
    });

    await deleteAccessProfile(db(), ctxFor(ines.userId), ines.userId);
    expect(await loadProfile(db(), ines.userId)).toBeUndefined();
    expect(await producerSees(ines.personId)).toBe('denied');

    await createAccessProfile(db(), ctxFor(ines.userId), ines.userId, PROFILE);
    // The same profile again, and the grant that opened the old one does not open it.
    expect(await producerSees(ines.personId)).toBe('denied');

    await grant(ines, scene.roles.production, ['stepFreeRequired']);
    expect(await producerSees(ines.personId)).toEqual({
      stepFreeRequired: true,
    });
  });

  it('is one step with the deletion: when the caller’s transaction is rolled back, the profile is back and so is every grant', async () => {
    const ines = await newHolder('Ines Kovac');
    await grant(ines, scene.roles.production, ['stepFreeRequired']);
    const before = await grantsOf(ines.personId);

    await expect(
      db().transaction(async (tx) => {
        await deleteAccessProfile(tx, ctxFor(ines.userId), ines.userId);
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');

    expect(await loadProfile(db(), ines.userId)).toBeDefined();
    expect(await grantsOf(ines.personId)).toEqual(before);
    expect(before[0]!.revokedAt).toBeNull();
    expect(await eventsAbout(ines.userId, 'access.profile-deleted')).toEqual(
      [],
    );
  });

  it('revokes nothing when the deletion is refused: another user cannot end a person’s grants by deleting their profile', async () => {
    const ines = await newHolder('Ines Kovac');
    await grant(ines, scene.roles.production, ['stepFreeRequired']);
    const before = await grantsOf(ines.personId);

    await expect(
      deleteAccessProfile(db(), ctxFor(scene.users.owner), ines.userId),
    ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);

    expect(await loadProfile(db(), ines.userId)).toBeDefined();
    expect(await grantsOf(ines.personId)).toEqual(before);
  });
});
