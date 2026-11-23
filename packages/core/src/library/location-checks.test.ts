import { eq, getTableName, sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  seedLocation,
  seedOrganisation,
  seedUser,
} from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import {
  ACCESSIBLE_TOILET_DISTANCE_MAX_M,
  LOCATION_ACCESS_ANSWERS,
  location,
  PARKING_CLEARANCE_MAX_CM,
  PARKING_CLEARANCE_MIN_CM,
  PARKING_SURFACES,
} from '../db/schema/index.js';
import {
  createMigratedDatabase,
  failureOf,
  SQLSTATE,
  testTargets,
} from '../db/test-support.js';

/**
 * The CHECKs on a location's access columns (decision D-69, P-02l2): the five answers are
 * yes, no or unknown and never empty; a detail exists only under the answer it describes;
 * the numbers have a range; and the verification is both who and when, or neither. The
 * database holds the rules whatever the service does, so these go straight at the table.
 */

const NOT_NULL = '23502';

/** The five answer columns, by database name. */
const ANSWER_COLUMNS = [
  'step_free_route',
  'accessible_toilet',
  'accessible_parking',
  'quiet_room',
  'seating',
] as const;

describe.each(testTargets)(
  'the access columns of a location on $name',
  (target) => {
    let database: Database;
    let cleanup: () => Promise<void>;
    let organisationId: string;

    beforeAll(async () => {
      ({ database, cleanup } = await createMigratedDatabase(target));
      ({ organisationId } = await seedOrganisation(database));
    });
    afterAll(async () => {
      await cleanup();
    });

    const db = () => database.db;
    const fresh = () => seedLocation(database, organisationId);

    /** Updates a location with raw SQL fragments for the `set` list, answering the failure if there is one. */
    const update = (id: string, set: ReturnType<typeof sql>) =>
      failureOf(() =>
        db().execute(sql`update location set ${set} where id = ${id}`),
      );
    const rowOf = async (id: string) =>
      (await db().select().from(location).where(eq(location.id, id)))[0]!;

    it('start unknown, with no details and no verification, for a location nobody has described', async () => {
      const row = await rowOf(await fresh());
      expect(row).toMatchObject({
        stepFreeRoute: 'unknown',
        accessibleToilet: 'unknown',
        accessibleToiletDistanceM: null,
        accessibleParking: 'unknown',
        accessibleParkingSurface: null,
        parkingHeightClearanceCm: null,
        quietRoom: 'unknown',
        seating: 'unknown',
        accessVerifiedAt: null,
        accessVerifiedBy: null,
      });
    });

    it('allows yes, no and unknown for each answer, and nothing else', async () => {
      expect([...LOCATION_ACCESS_ANSWERS]).toEqual(['yes', 'no', 'unknown']);
      for (const column of ANSWER_COLUMNS) {
        const id = await fresh();
        for (const answer of LOCATION_ACCESS_ANSWERS) {
          expect(
            await db().execute(
              sql`update location set ${sql.identifier(column)} = ${answer} where id = ${id}`,
            ),
            `${column} ${answer}`,
          ).toBeDefined();
        }
        for (const bad of ['maybe', '', 'YES', 'true']) {
          expect(
            await update(id, sql`${sql.identifier(column)} = ${bad}`),
            `${column} ${bad}`,
          ).toEqual({
            code: SQLSTATE.checkViolation,
            constraint: `location_${column}_check`,
          });
        }
      }
    });

    it('never leave an answer empty', async () => {
      for (const column of ANSWER_COLUMNS) {
        const id = await fresh();
        expect(
          await update(id, sql`${sql.identifier(column)} = null`),
        ).toMatchObject({ code: NOT_NULL });
      }
    });

    describe('the distance to an accessible toilet', () => {
      it('is a whole number of metres from 0 to the most, and only when the toilet is yes', async () => {
        expect(ACCESSIBLE_TOILET_DISTANCE_MAX_M).toBe(5000);
        const id = await fresh();
        for (const metres of [0, 1, 5000]) {
          await db().execute(
            sql`update location set accessible_toilet = 'yes', accessible_toilet_distance_m = ${metres} where id = ${id}`,
          );
        }
        for (const metres of [-1, 5001]) {
          expect(
            await update(
              id,
              sql`accessible_toilet = 'yes', accessible_toilet_distance_m = ${metres}`,
            ),
            String(metres),
          ).toEqual({
            code: SQLSTATE.checkViolation,
            constraint: 'location_toilet_distance_check',
          });
        }
      });

      it.each(['no', 'unknown'])(
        'is refused while the toilet is %s, and so is leaving a distance behind when the answer stops being yes',
        async (answer) => {
          const id = await fresh();
          expect(
            await update(
              id,
              sql`accessible_toilet = ${answer}, accessible_toilet_distance_m = 10`,
            ),
          ).toEqual({
            code: SQLSTATE.checkViolation,
            constraint: 'location_toilet_distance_check',
          });
          await db().execute(
            sql`update location set accessible_toilet = 'yes', accessible_toilet_distance_m = 10 where id = ${id}`,
          );
          expect(await update(id, sql`accessible_toilet = ${answer}`)).toEqual({
            code: SQLSTATE.checkViolation,
            constraint: 'location_toilet_distance_check',
          });
          // Both together are fine: the detail goes with the answer.
          await db().execute(
            sql`update location set accessible_toilet = ${answer}, accessible_toilet_distance_m = null where id = ${id}`,
          );
        },
      );
    });

    describe('the surface of an accessible parking space', () => {
      it('is paved, gravel, grass or other, and only when parking is yes', async () => {
        expect([...PARKING_SURFACES]).toEqual([
          'paved',
          'gravel',
          'grass',
          'other',
        ]);
        const id = await fresh();
        for (const surface of PARKING_SURFACES) {
          await db().execute(
            sql`update location set accessible_parking = 'yes', accessible_parking_surface = ${surface} where id = ${id}`,
          );
        }
        for (const bad of ['sand', '', 'PAVED']) {
          expect(
            await update(
              id,
              sql`accessible_parking = 'yes', accessible_parking_surface = ${bad}`,
            ),
            bad,
          ).toEqual({
            code: SQLSTATE.checkViolation,
            constraint: 'location_parking_surface_check',
          });
        }
      });

      it.each(['no', 'unknown'])(
        'is refused while parking is %s',
        async (answer) => {
          const id = await fresh();
          expect(
            await update(
              id,
              sql`accessible_parking = ${answer}, accessible_parking_surface = 'paved'`,
            ),
          ).toEqual({
            code: SQLSTATE.checkViolation,
            constraint: 'location_parking_surface_check',
          });
        },
      );
    });

    describe('the height clearance of an accessible parking space', () => {
      it('is a whole number of centimetres from the least to the most, and only when parking is yes', async () => {
        expect(PARKING_CLEARANCE_MIN_CM).toBe(100);
        expect(PARKING_CLEARANCE_MAX_CM).toBe(500);
        const id = await fresh();
        for (const centimetres of [100, 210, 500]) {
          await db().execute(
            sql`update location set accessible_parking = 'yes', parking_height_clearance_cm = ${centimetres} where id = ${id}`,
          );
        }
        for (const centimetres of [0, 99, 501]) {
          expect(
            await update(
              id,
              sql`accessible_parking = 'yes', parking_height_clearance_cm = ${centimetres}`,
            ),
            String(centimetres),
          ).toEqual({
            code: SQLSTATE.checkViolation,
            constraint: 'location_parking_clearance_check',
          });
        }
      });

      it.each(['no', 'unknown'])(
        'is refused while parking is %s',
        async (answer) => {
          const id = await fresh();
          expect(
            await update(
              id,
              sql`accessible_parking = ${answer}, parking_height_clearance_cm = 200`,
            ),
          ).toEqual({
            code: SQLSTATE.checkViolation,
            constraint: 'location_parking_clearance_check',
          });
        },
      );
    });

    describe('the verification', () => {
      it('is who and when together, or neither', async () => {
        const id = await fresh();
        const verifier = await seedUser(database);
        expect(await update(id, sql`access_verified_at = now()`)).toEqual({
          code: SQLSTATE.checkViolation,
          constraint: 'location_access_verified_check',
        });
        expect(await update(id, sql`access_verified_by = ${verifier}`)).toEqual(
          {
            code: SQLSTATE.checkViolation,
            constraint: 'location_access_verified_check',
          },
        );
        await db().execute(
          sql`update location set access_verified_at = now(), access_verified_by = ${verifier} where id = ${id}`,
        );
        expect(await rowOf(id)).toMatchObject({ accessVerifiedBy: verifier });
        await db().execute(
          sql`update location set access_verified_at = null, access_verified_by = null where id = ${id}`,
        );
        expect(await rowOf(id)).toMatchObject({
          accessVerifiedAt: null,
          accessVerifiedBy: null,
        });
      });

      it('names a user that exists, through the foreign key location_access_verified_by_fk', async () => {
        const id = await fresh();
        expect(
          await update(
            id,
            sql`access_verified_at = now(), access_verified_by = '0199a3c4-0000-7000-8000-00000000dead'`,
          ),
        ).toEqual({
          code: SQLSTATE.foreignKeyViolation,
          constraint: 'location_access_verified_by_fk',
        });
        expect(
          getTableConfig(location).foreignKeys.map((fk) => fk.getName()),
        ).toContain('location_access_verified_by_fk');
        expect(getTableName(location)).toBe('location');
      });
    });
  },
);
