import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessDeniedError } from '../access/access-denied-error.js';
import { seedLocation } from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import { changeEvent, location } from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { VersionConflictError } from '../db/write.js';
import { LibraryInputError } from './errors.js';
import {
  getLocation,
  updateLocationAccess,
  verifyLocationAccess,
} from './locations.js';
import {
  ctxFor,
  NOW,
  seedLibraryScene,
  tokenFor,
  type LibraryScene,
} from './test-support.js';

/**
 * The location services of the library (decision D-69, P-02l2). The access answers of a
 * location are yes, no or unknown, written through the write helper by someone who holds
 * `locations:edit`, and checked as a separate act with a date. Any change to the answers
 * clears the verification in the same write, because it covered the answers as they were,
 * and the summary never presents an unverified answer as known.
 */

/** A value the tests look for in errors. It must never appear in one. */
const SECRET = 'secret-marker-4f9c';

const LATER = new Date('2026-11-16T08:30:00.000Z');

describe.each(testTargets)('the location services on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  let scene: LibraryScene;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    scene = await seedLibraryScene(database);
  });
  afterAll(async () => {
    await cleanup();
  });

  const db = () => database.db;
  const editor = () => ctxFor(scene.users.editor);

  /** A fresh location, so a test starts from nothing described. */
  const newLocation = (name = 'Harbour Warehouse') =>
    seedLocation(database, scene.organisationId, { name });

  const rowOf = async (id: string) =>
    (await db().select().from(location).where(eq(location.id, id)))[0]!;

  const changesOf = async (id: string) =>
    (await db().select().from(changeEvent))
      .filter(
        (event) => event.entityType === 'location' && event.entityId === id,
      )
      .sort((a, b) => a.id.localeCompare(b.id));

  describe('getLocation', () => {
    it('answers the location with its access summary, and without the raw answers beside it', async () => {
      const id = await newLocation();

      const view = await getLocation(db(), editor(), id);

      expect(view).toMatchObject({
        id,
        name: 'Harbour Warehouse',
        kind: 'location',
        organisationId: scene.organisationId,
      });
      expect(view.access.fields.stepFreeRoute).toEqual({
        stored: 'unknown',
        effective: 'unknown',
        verified: false,
      });
      // The answers are in the summary only, labelled stored and effective, so a reader
      // cannot take an unverified "yes" from a plain field.
      for (const name of [
        'stepFreeRoute',
        'accessibleToilet',
        'accessibleToiletDistanceM',
        'accessibleParking',
        'accessibleParkingSurface',
        'parkingHeightClearanceCm',
        'quietRoom',
        'seating',
        'accessVerifiedAt',
        'accessVerifiedBy',
      ]) {
        expect(view, name).not.toHaveProperty(name);
      }
      expect(view).toHaveProperty('accessNotes');
    });

    it('needs locations:read in the location’s organisation', async () => {
      const id = await newLocation();

      for (const userId of [scene.users.editor, scene.users.reader]) {
        expect((await getLocation(db(), ctxFor(userId), id)).id).toBe(id);
      }
      for (const userId of [scene.users.stranger, scene.users.otherEditor]) {
        await expect(
          getLocation(db(), ctxFor(userId), id),
        ).rejects.toBeInstanceOf(AccessDeniedError);
      }
    });

    it('answers a location that does not exist, one that is deleted and one of another organisation like a refusal', async () => {
      const deleted = await newLocation('Deleted Place');
      await db()
        .update(location)
        .set({ deletedAt: NOW })
        .where(eq(location.id, deleted));
      const otherOrganisation = await seedLocation(
        database,
        scene.otherOrganisationId,
      );
      const answers = new Set<string>();
      for (const id of [
        '0199a3c4-0000-7000-8000-00000000dead',
        'not-an-id',
        deleted,
        otherOrganisation,
      ]) {
        const failure = await getLocation(db(), editor(), id).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(failure, id).toBeInstanceOf(AccessDeniedError);
        answers.add(
          JSON.stringify([
            (failure as AccessDeniedError).message,
            (failure as AccessDeniedError).scope,
          ]),
        );
      }
      expect(answers.size).toBe(1);
    });
  });

  describe('updateLocationAccess', () => {
    it('sets the answers, and the summary still reads unknown until somebody verifies them', async () => {
      const id = await newLocation();

      const view = await updateLocationAccess(db(), editor(), id, {
        stepFreeRoute: 'yes',
        accessibleToilet: 'yes',
        accessibleToiletDistanceM: 40,
        accessibleParking: 'yes',
        accessibleParkingSurface: 'gravel',
        parkingHeightClearanceCm: 210,
        quietRoom: 'no',
        seating: 'yes',
      });

      expect(await rowOf(id)).toMatchObject({
        stepFreeRoute: 'yes',
        accessibleToilet: 'yes',
        accessibleToiletDistanceM: 40,
        accessibleParking: 'yes',
        accessibleParkingSurface: 'gravel',
        parkingHeightClearanceCm: 210,
        quietRoom: 'no',
        seating: 'yes',
        accessVerifiedAt: null,
        accessVerifiedBy: null,
      });
      expect(view.access.fields.stepFreeRoute).toEqual({
        stored: 'yes',
        effective: 'unknown',
        verified: false,
      });
      expect(view.access.fields.quietRoom).toEqual({
        stored: 'no',
        effective: 'unknown',
        verified: false,
      });
      expect(view.access.fields.accessibleToiletDistanceM).toEqual({
        stored: 40,
        effective: null,
        verified: false,
      });
      // The same through the read.
      const read = await getLocation(db(), editor(), id);
      expect(read.access).toEqual(view.access);
    });

    it('changes only the fields named, and leaves the others as they were', async () => {
      const id = await newLocation();
      await updateLocationAccess(db(), editor(), id, {
        stepFreeRoute: 'yes',
        seating: 'no',
      });

      await updateLocationAccess(db(), editor(), id, { quietRoom: 'yes' });

      expect(await rowOf(id)).toMatchObject({
        stepFreeRoute: 'yes',
        seating: 'no',
        quietRoom: 'yes',
        accessibleToilet: 'unknown',
      });
    });

    it('records the field changes in the change log, as the write helper does', async () => {
      const id = await newLocation();

      await updateLocationAccess(db(), editor(), id, {
        stepFreeRoute: 'yes',
        accessibleToilet: 'yes',
        accessibleToiletDistanceM: 25,
      });

      const [event] = await changesOf(id);
      expect(event).toMatchObject({
        action: 'update',
        actorType: 'user',
        actorId: scene.users.editor,
        entityVersion: 2,
      });
      expect([...event!.changedFields].sort()).toEqual([
        'accessible_toilet',
        'accessible_toilet_distance_m',
        'step_free_route',
      ]);
      expect(event!.before).toMatchObject({
        step_free_route: 'unknown',
        accessible_toilet: 'unknown',
        accessible_toilet_distance_m: null,
      });
      expect(event!.after).toMatchObject({
        step_free_route: 'yes',
        accessible_toilet: 'yes',
        accessible_toilet_distance_m: 25,
      });
    });

    it('clears the verification in the same write as any change to the answers', async () => {
      const id = await newLocation();
      await updateLocationAccess(db(), editor(), id, { stepFreeRoute: 'yes' });
      await verifyLocationAccess(db(), editor(), id);
      expect(await rowOf(id)).toMatchObject({ accessVerifiedAt: NOW });
      const before = await changesOf(id);

      const view = await updateLocationAccess(db(), editor(), id, {
        seating: 'yes',
      });

      const row = await rowOf(id);
      expect(row.accessVerifiedAt).toBeNull();
      expect(row.accessVerifiedBy).toBeNull();
      expect(row.seating).toBe('yes');
      // One write: one more event, one more version, with the answer and the clearing together.
      const after = await changesOf(id);
      expect(after).toHaveLength(before.length + 1);
      expect(after.at(-1)).toMatchObject({ entityVersion: row.version });
      expect([...after.at(-1)!.changedFields].sort()).toEqual([
        'access_verified_at',
        'access_verified_by',
        'seating',
      ]);
      // And the summary no longer vouches for anything, the old answers included.
      expect(view.access.verifiedAt).toBeNull();
      expect(view.access.fields.stepFreeRoute).toEqual({
        stored: 'yes',
        effective: 'unknown',
        verified: false,
      });
    });

    it('clears the verification for a change to a detail alone', async () => {
      const id = await newLocation();
      await updateLocationAccess(db(), editor(), id, {
        accessibleToilet: 'yes',
        accessibleToiletDistanceM: 10,
      });
      await verifyLocationAccess(db(), editor(), id);

      await updateLocationAccess(db(), editor(), id, {
        accessibleToiletDistanceM: 60,
      });

      expect((await rowOf(id)).accessVerifiedAt).toBeNull();
    });

    it('keeps the verification, and writes nothing, for a call that changes no answer', async () => {
      const id = await newLocation();
      await updateLocationAccess(db(), editor(), id, {
        stepFreeRoute: 'yes',
        accessibleToilet: 'yes',
        accessibleToiletDistanceM: 10,
      });
      await verifyLocationAccess(db(), editor(), id);
      const row = await rowOf(id);
      const events = (await changesOf(id)).length;

      await updateLocationAccess(db(), editor(), id, {});
      await updateLocationAccess(db(), editor(), id, {
        stepFreeRoute: 'yes',
        accessibleToiletDistanceM: 10,
      });

      expect(await rowOf(id)).toEqual(row);
      expect((await changesOf(id)).length).toBe(events);
      expect(row.accessVerifiedAt).toEqual(NOW);
    });

    it('clears the details of an answer when it stops being yes, in the same write', async () => {
      const id = await newLocation();
      await updateLocationAccess(db(), editor(), id, {
        accessibleToilet: 'yes',
        accessibleToiletDistanceM: 30,
        accessibleParking: 'yes',
        accessibleParkingSurface: 'paved',
        parkingHeightClearanceCm: 200,
      });

      await updateLocationAccess(db(), editor(), id, {
        accessibleToilet: 'no',
        accessibleParking: 'unknown',
      });

      expect(await rowOf(id)).toMatchObject({
        accessibleToilet: 'no',
        accessibleToiletDistanceM: null,
        accessibleParking: 'unknown',
        accessibleParkingSurface: null,
        parkingHeightClearanceCm: null,
      });
    });

    it('clears a detail on request, with null, and keeps the answer it belongs to', async () => {
      const id = await newLocation();
      await updateLocationAccess(db(), editor(), id, {
        accessibleParking: 'yes',
        accessibleParkingSurface: 'grass',
        parkingHeightClearanceCm: 250,
      });

      await updateLocationAccess(db(), editor(), id, {
        accessibleParkingSurface: null,
      });

      expect(await rowOf(id)).toMatchObject({
        accessibleParking: 'yes',
        accessibleParkingSurface: null,
        parkingHeightClearanceCm: 250,
      });
    });

    it.each([
      [
        'a detail with an answer that is not yes',
        { accessibleToilet: 'no', accessibleToiletDistanceM: 30 },
      ],
      [
        'a distance when the toilet is unknown',
        { accessibleToiletDistanceM: 30 },
      ],
      [
        'a surface when parking is unknown',
        { accessibleParkingSurface: 'paved' },
      ],
      [
        'a clearance when parking is unknown',
        { parkingHeightClearanceCm: 200 },
      ],
      [
        'a parking detail with parking answered no',
        { accessibleParking: 'no', parkingHeightClearanceCm: 200 },
      ],
      ['an answer that is none of the three', { quietRoom: 'maybe' }],
      [
        'a distance over the most',
        { accessibleToilet: 'yes', accessibleToiletDistanceM: 5001 },
      ],
      [
        'a negative distance',
        { accessibleToilet: 'yes', accessibleToiletDistanceM: -1 },
      ],
      [
        'a clearance under the least',
        { accessibleParking: 'yes', parkingHeightClearanceCm: 99 },
      ],
      [
        'a clearance over the most',
        { accessibleParking: 'yes', parkingHeightClearanceCm: 501 },
      ],
      [
        'a surface that is not on the list',
        { accessibleParking: 'yes', accessibleParkingSurface: 'sand' },
      ],
      ['a field the schema does not know', { name: 'Elsewhere' }],
      [
        'the verification, which only verifying sets',
        { accessVerifiedAt: NOW },
      ],
      ['something that is not an object', 'yes'],
      ['null', null],
    ])('refuses %s, and writes nothing', async (_label, fields) => {
      const id = await newLocation();
      const before = await rowOf(id);

      await expect(
        updateLocationAccess(db(), editor(), id, fields),
      ).rejects.toBeInstanceOf(LibraryInputError);

      expect(await rowOf(id)).toEqual(before);
      expect(await changesOf(id)).toEqual([]);
    });

    it('says in an error what is wrong and never a value that was sent', async () => {
      const id = await newLocation();

      for (const fields of [
        { quietRoom: SECRET },
        { [SECRET]: 'yes' },
        { accessibleParkingSurface: SECRET },
      ]) {
        const failure = await updateLocationAccess(
          db(),
          editor(),
          id,
          fields,
        ).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(LibraryInputError);
        expect((failure as Error).message).not.toContain(SECRET);
      }
    });

    it('needs locations:edit in the location’s organisation: read alone, a stranger and another organisation’s editor are refused', async () => {
      const id = await newLocation();
      const before = await rowOf(id);

      for (const userId of [
        scene.users.reader,
        scene.users.stranger,
        scene.users.otherEditor,
      ]) {
        await expect(
          updateLocationAccess(db(), ctxFor(userId), id, {
            stepFreeRoute: 'yes',
          }),
        ).rejects.toBeInstanceOf(AccessDeniedError);
      }
      expect(await rowOf(id)).toEqual(before);
    });

    it('answers a location that does not exist or is deleted like a refusal', async () => {
      const deleted = await newLocation('Deleted Place');
      await db()
        .update(location)
        .set({ deletedAt: NOW })
        .where(eq(location.id, deleted));
      for (const id of [
        '0199a3c4-0000-7000-8000-00000000dead',
        'not-an-id',
        deleted,
      ]) {
        await expect(
          updateLocationAccess(db(), editor(), id, { seating: 'yes' }),
          id,
        ).rejects.toBeInstanceOf(AccessDeniedError);
      }
    });

    it('checks the version it is given: a stale one is refused and nothing changes', async () => {
      const id = await newLocation();
      await updateLocationAccess(db(), editor(), id, { seating: 'yes' });
      const before = await rowOf(id);

      await expect(
        updateLocationAccess(
          db(),
          editor(),
          id,
          { seating: 'no' },
          { expectedVersion: 1 },
        ),
      ).rejects.toBeInstanceOf(VersionConflictError);
      expect(await rowOf(id)).toEqual(before);

      await updateLocationAccess(
        db(),
        editor(),
        id,
        { seating: 'no' },
        { expectedVersion: before.version },
      );
      expect((await rowOf(id)).seating).toBe('no');
    });

    it('goes through the credential of a personal API token: a token that can only read, or for another organisation, is refused; one that can write passes as its owner', async () => {
      const id = await newLocation();
      const readOnly = ctxFor(scene.users.editor, {
        credential: tokenFor(scene.organisationId, 'read'),
      });
      const elsewhere = ctxFor(scene.users.editor, {
        credential: tokenFor(scene.otherOrganisationId, 'write'),
      });
      const writer = ctxFor(scene.users.editor, {
        credential: tokenFor(scene.organisationId, 'write'),
      });

      for (const ctx of [readOnly, elsewhere]) {
        await expect(
          updateLocationAccess(db(), ctx, id, { seating: 'yes' }),
        ).rejects.toBeInstanceOf(AccessDeniedError);
      }
      await updateLocationAccess(db(), writer, id, { seating: 'yes' });

      // The token's write is the token's in the change log, made for its owner.
      const [event] = await changesOf(id);
      expect(event).toMatchObject({
        actorType: 'token',
        actorId: '0199a3c4-0000-7000-8000-0000000000dd',
      });
      expect((await rowOf(id)).updatedBy).toBe(scene.users.editor);
    });
  });

  describe('verifyLocationAccess', () => {
    it('sets who verified and when, in one write that the change log names', async () => {
      const id = await newLocation();
      await updateLocationAccess(db(), editor(), id, {
        stepFreeRoute: 'yes',
        quietRoom: 'no',
      });

      const view = await verifyLocationAccess(db(), editor(), id);

      const row = await rowOf(id);
      expect(row.accessVerifiedAt).toEqual(NOW);
      expect(row.accessVerifiedBy).toBe(scene.users.editor);
      expect(view.access.verifiedAt).toEqual(NOW);
      expect(view.access.verifiedBy).toBe(scene.users.editor);
      const events = await changesOf(id);
      expect([...events.at(-1)!.changedFields].sort()).toEqual([
        'access_verified_at',
        'access_verified_by',
      ]);
    });

    it('makes the summary present the answers as stored, the unverified yes included', async () => {
      const id = await newLocation();
      await updateLocationAccess(db(), editor(), id, {
        stepFreeRoute: 'yes',
        quietRoom: 'no',
        accessibleToilet: 'yes',
        accessibleToiletDistanceM: 15,
      });
      expect(
        (await getLocation(db(), editor(), id)).access.fields.stepFreeRoute
          .effective,
      ).toBe('unknown');

      await verifyLocationAccess(db(), editor(), id);

      const { fields } = (await getLocation(db(), editor(), id)).access;
      expect(fields.stepFreeRoute).toEqual({
        stored: 'yes',
        effective: 'yes',
        verified: true,
      });
      expect(fields.quietRoom).toEqual({
        stored: 'no',
        effective: 'no',
        verified: true,
      });
      expect(fields.seating).toEqual({
        stored: 'unknown',
        effective: 'unknown',
        verified: true,
      });
      expect(fields.accessibleToiletDistanceM).toEqual({
        stored: 15,
        effective: 15,
        verified: true,
      });
    });

    it('verifies again later: the date moves and the verifier is whoever did it', async () => {
      const id = await newLocation();
      await verifyLocationAccess(db(), editor(), id);

      await verifyLocationAccess(
        db(),
        ctxFor(scene.users.editor, { at: LATER }),
        id,
      );

      expect((await rowOf(id)).accessVerifiedAt).toEqual(LATER);
    });

    it('needs locations:edit: read alone, a stranger and another organisation’s editor are refused', async () => {
      const id = await newLocation();

      for (const userId of [
        scene.users.reader,
        scene.users.stranger,
        scene.users.otherEditor,
      ]) {
        await expect(
          verifyLocationAccess(db(), ctxFor(userId), id),
        ).rejects.toBeInstanceOf(AccessDeniedError);
      }
      expect((await rowOf(id)).accessVerifiedAt).toBeNull();
    });

    it('answers a location that does not exist or is deleted like a refusal', async () => {
      const deleted = await newLocation('Deleted Place');
      await db()
        .update(location)
        .set({ deletedAt: NOW })
        .where(eq(location.id, deleted));
      for (const id of [
        '0199a3c4-0000-7000-8000-00000000dead',
        'not-an-id',
        deleted,
      ]) {
        await expect(
          verifyLocationAccess(db(), editor(), id),
          id,
        ).rejects.toBeInstanceOf(AccessDeniedError);
      }
    });

    it('verifies only what the verifier saw: when the answers changed since, the version is stale and nothing is verified', async () => {
      const id = await newLocation();
      await updateLocationAccess(db(), editor(), id, { stepFreeRoute: 'yes' });
      const seen = (await rowOf(id)).version;
      // Someone else changes an answer after the verifier looked.
      await updateLocationAccess(db(), editor(), id, { stepFreeRoute: 'no' });

      await expect(
        verifyLocationAccess(db(), editor(), id, { expectedVersion: seen }),
      ).rejects.toBeInstanceOf(VersionConflictError);

      expect((await rowOf(id)).accessVerifiedAt).toBeNull();
    });

    it('goes through the credential of a personal API token, and is verified by the token’s owner', async () => {
      const id = await newLocation();
      const readOnly = ctxFor(scene.users.editor, {
        credential: tokenFor(scene.organisationId, 'read'),
      });
      const writer = ctxFor(scene.users.editor, {
        credential: tokenFor(scene.organisationId, 'write'),
      });

      await expect(
        verifyLocationAccess(db(), readOnly, id),
      ).rejects.toBeInstanceOf(AccessDeniedError);
      await verifyLocationAccess(db(), writer, id);

      expect((await rowOf(id)).accessVerifiedBy).toBe(scene.users.editor);
      const [event] = await changesOf(id);
      expect(event).toMatchObject({ actorType: 'token' });
    });
  });
});
