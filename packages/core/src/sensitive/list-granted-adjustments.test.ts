import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { engagePerson, seedPerson } from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import { accessGrant, auditEvent, projectPerson } from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import {
  createAccessGrant,
  revokeAccessGrant,
  type AccessConsent,
} from './access-grants.js';
import { listGrantedAdjustments } from './adjustments.js';
import { createAccessProfile } from './access-profile.js';
import { SensitiveAccessDeniedError } from './errors.js';
import { leafStrings, VALID_PAYLOADS } from './payload-fixtures.js';
import { ACCESS_FIELDS } from './schemas.js';
import { writeSensitive } from './service.js';
import {
  ctxFor,
  NOW,
  seedAccessScene,
  tokenFor,
  updateProject,
  type AccessScene,
} from './test-support.js';

/**
 * The constraint view (decision D-69): for each person on a project, only the adjustments
 * they granted to a role the reader holds there, which a schedule or call sheet check can
 * plan around. No reasons, no medical data, and no field that was not granted.
 */

const CONSENT: AccessConsent = {
  method: 'written',
  at: new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000),
};
const CREW_ACCESS = {
  breakEveryMinutes: 90,
  seatingNeeded: true,
  extraThinkingTime: true,
  notes: 'Mornings are hard',
};

describe.each(testTargets)('the constraint view on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  let scene: AccessScene;
  /** A third person on the project, who has granted nobody anything. */
  let quiet: string;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    scene = await seedAccessScene(database);
    const { holder, crew } = scene.people;
    await createAccessProfile(
      database.db,
      ctxFor(holder.userId),
      holder.userId,
      VALID_PAYLOADS.accessibility,
    );
    await writeSensitive(
      database.db,
      ctxFor(scene.users.coordinator),
      crew.personId,
      'accessibility',
      CREW_ACCESS,
      { legalBasis: 'consent' },
    );
    quiet = await seedPerson(database, scene.organisationId, {
      displayName: 'Ines Kovac',
    });
    await engagePerson(database, scene.organisationId, scene.projectId, quiet);
    await writeSensitive(
      database.db,
      ctxFor(scene.users.coordinator),
      quiet,
      'accessibility',
      { noiseSensitive: true },
      { legalBasis: 'consent' },
    );
  });
  afterAll(async () => {
    await cleanup();
  });
  afterEach(async () => {
    await database.db.delete(accessGrant);
    await updateProject(database, scene.projectId, {
      wrapDate: null,
      status: 'development',
    });
    await database.db
      .update(projectPerson)
      .set({ status: 'confirmed' })
      .where(eq(projectPerson.projectId, scene.projectId));
  });

  const db = () => database.db;
  const holder = () => scene.people.holder;
  const crew = () => scene.people.crew;

  const grantAsHolder = (roleId: string, fields: string[]) =>
    createAccessGrant(db(), ctxFor(holder().userId), {
      projectId: scene.projectId,
      personId: holder().personId,
      category: 'accessibility',
      roleId,
      fields,
    });
  const grantForCrew = (roleId: string, fields: string[]) =>
    createAccessGrant(db(), ctxFor(scene.users.coordinator), {
      projectId: scene.projectId,
      personId: crew().personId,
      category: 'accessibility',
      roleId,
      fields,
      consent: CONSENT,
    });
  const list = (
    userId: string,
    projectId = scene.projectId,
    credential?: ReturnType<typeof tokenFor>,
  ) =>
    listGrantedAdjustments(
      db(),
      ctxFor(userId, credential === undefined ? {} : { credential }),
      projectId,
    );
  const events = async (category: string) =>
    (await db().select().from(auditEvent))
      .filter((event) => event.category === category)
      .sort((a, b) => a.id.localeCompare(b.id));
  /** The people of the view as person to adjustments, whatever the order. */
  const byPerson = (view: Awaited<ReturnType<typeof list>>) =>
    Object.fromEntries(
      view.people.map((entry) => [entry.personId, entry.adjustments]),
    );

  it('lists, for each person, only the fields granted to a role the reader holds, from the profile or the production record', async () => {
    await grantAsHolder(scene.roles.production, [
      'stepFreeRequired',
      'quietSpace',
    ]);
    await grantForCrew(scene.roles.production, ['seatingNeeded', 'notes']);
    const view = await list(scene.users.producer);
    expect(view.projectId).toBe(scene.projectId);
    expect(byPerson(view)).toEqual({
      [holder().personId]: { stepFreeRequired: true, quietSpace: true },
      [crew().personId]: {
        seatingNeeded: true,
        notes: CREW_ACCESS.notes,
      },
    });
    // The person who granted nothing is not on it, though they have filled things in.
    expect(Object.keys(byPerson(view))).not.toContain(quiet);
    // In the order of the person ids.
    const ids = view.people.map((entry) => entry.personId);
    expect(ids).toEqual([...ids].sort());
  });

  it('combines the fields of two roles the reader holds, and gives each reader only their own', async () => {
    await grantAsHolder(scene.roles.production, ['stepFreeRequired']);
    await grantAsHolder(scene.roles.camera, ['quietSpace']);
    expect(byPerson(await list(scene.users.both))).toEqual({
      [holder().personId]: { stepFreeRequired: true, quietSpace: true },
    });
    expect(byPerson(await list(scene.users.producer))).toEqual({
      [holder().personId]: { stepFreeRequired: true },
    });
    expect(byPerson(await list(scene.users.cameraLead))).toEqual({
      [holder().personId]: { quietSpace: true },
    });
  });

  it('is empty, and no denial, for a reader who holds the permission but no role a grant names', async () => {
    await grantAsHolder(scene.roles.production, ['stepFreeRequired']);
    for (const reader of [scene.users.plainReader, scene.users.coordinator]) {
      expect((await list(reader)).people).toEqual([]);
    }
  });

  it('is empty for a person who granted fields they have not filled in, and for a project nobody granted on', async () => {
    await grantAsHolder(scene.roles.production, ['previewLocation']);
    expect((await list(scene.users.producer)).people).toEqual([]);
  });

  it('is denied, and audited, to everyone without the read permission on the project, owner and administrator included', async () => {
    const seen = (await events('sensitive.denied')).length;
    const denied = [
      scene.users.owner,
      scene.users.admin,
      scene.users.stranger,
      // Holds the permission on another project only.
      scene.users.elsewhere,
    ];
    for (const other of denied) {
      await expect(list(other)).rejects.toBeInstanceOf(
        SensitiveAccessDeniedError,
      );
    }
    await expect(
      list(scene.users.producer, '0199a3c4-0000-7000-8000-00000000dead'),
    ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
    await expect(
      list(scene.users.producer, 'not an id'),
    ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
    const logged = (await events('sensitive.denied')).slice(seen);
    expect(logged).toHaveLength(denied.length + 2);
    expect(logged[0]).toMatchObject({
      action: 'read',
      targetType: 'project',
      targetId: scene.projectId,
      projectId: scene.projectId,
      details: { category: 'accessibility' },
    });
  });

  it('stops listing a person at once when they revoke, when the project wraps, and when they are released', async () => {
    await grantAsHolder(scene.roles.production, ['stepFreeRequired']);
    await grantForCrew(scene.roles.production, ['seatingNeeded']);
    expect(
      Object.keys(byPerson(await list(scene.users.producer))),
    ).toHaveLength(2);

    await db()
      .update(projectPerson)
      .set({ status: 'released' })
      .where(eq(projectPerson.personId, crew().personId));
    expect(byPerson(await list(scene.users.producer))).toEqual({
      [holder().personId]: { stepFreeRequired: true },
    });

    await revokeAccessGrant(db(), ctxFor(holder().userId), {
      projectId: scene.projectId,
      personId: holder().personId,
      category: 'accessibility',
      roleId: scene.roles.production,
    });
    expect((await list(scene.users.producer)).people).toEqual([]);

    await db()
      .update(projectPerson)
      .set({ status: 'confirmed' })
      .where(
        and(
          eq(projectPerson.personId, crew().personId),
          eq(projectPerson.projectId, scene.projectId),
        ),
      );
    expect(
      Object.keys(byPerson(await list(scene.users.producer))),
    ).toHaveLength(1);
    await updateProject(database, scene.projectId, { wrapDate: '2026-11-01' });
    expect((await list(scene.users.producer)).people).toEqual([]);
  });

  it('gives no medical data, no reason and no field that was not granted, whatever else is stored or granted', async () => {
    await writeSensitive(
      db(),
      ctxFor(holder().userId),
      holder().personId,
      'medical',
      VALID_PAYLOADS.medical,
      { legalBasis: 'consent' },
    );
    await createAccessGrant(db(), ctxFor(holder().userId), {
      projectId: scene.projectId,
      personId: holder().personId,
      category: 'medical',
      roleId: scene.roles.production,
      fields: ['conditions', 'medication', 'notes'],
    });
    await grantAsHolder(scene.roles.production, ['maxWorkingHours']);
    const view = await list(scene.users.producer);
    const text = JSON.stringify(view);
    for (const value of leafStrings(VALID_PAYLOADS.medical)) {
      expect(text).not.toContain(value);
    }
    expect(text).not.toContain('conditions');
    expect(byPerson(view)).toEqual({
      [holder().personId]: { maxWorkingHours: 10 },
    });
  });

  it('audits each person returned as one read with a count of fields, and writes nothing when nobody is returned', async () => {
    await grantAsHolder(scene.roles.production, [
      'stepFreeRequired',
      'quietSpace',
    ]);
    await grantForCrew(scene.roles.production, ['seatingNeeded']);
    const seen = (await events('sensitive.read')).length;
    await list(scene.users.producer);
    const reads = (await events('sensitive.read')).slice(seen);
    expect(reads).toHaveLength(2);
    expect(reads.map((event) => event.targetId).sort()).toEqual(
      [holder().personId, crew().personId].sort(),
    );
    const counts = new Map(
      reads.map((event) => [event.targetId, event.details] as const),
    );
    expect(counts.get(holder().personId)).toEqual({
      category: 'accessibility',
      fieldCount: 2,
    });
    expect(counts.get(crew().personId)).toEqual({
      category: 'accessibility',
      fieldCount: 1,
    });
    for (const event of reads) {
      expect(event).toMatchObject({ projectId: scene.projectId });
      const text = JSON.stringify(event);
      for (const entry of ACCESS_FIELDS) expect(text).not.toContain(entry.key);
    }
    const before = (await events('sensitive.read')).length;
    await db().delete(accessGrant);
    await list(scene.users.producer);
    expect((await events('sensitive.read')).length).toBe(before);
  });

  describe('through a personal API token', () => {
    const scope = ['sensitive:read:accessibility'];

    it('lists what its owner would, through the scope', async () => {
      await grantAsHolder(scene.roles.production, ['stepFreeRequired']);
      const token = tokenFor(scene.organisationId, scope);
      const seen = (await events('sensitive.read')).length;
      expect(
        byPerson(await list(scene.users.producer, scene.projectId, token)),
      ).toEqual({ [holder().personId]: { stepFreeRequired: true } });
      const [read] = (await events('sensitive.read')).slice(seen);
      expect(read).toMatchObject({
        actorType: 'token',
        actorId: token.tokenId,
      });
    });

    it('is refused without the key in its scope, for another project, and for a project it was not made for', async () => {
      for (const token of [
        tokenFor(scene.organisationId, []),
        tokenFor(scene.organisationId, ['sensitive:read:medical']),
        tokenFor(scene.organisationId, scope, {
          projectId: scene.otherProjectId,
        }),
      ]) {
        await expect(
          list(scene.users.producer, scene.projectId, token),
        ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
      }
    });
  });
});
