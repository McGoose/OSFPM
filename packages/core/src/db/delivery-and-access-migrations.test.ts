import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { rowsOf } from '../auth/test-support.js';
import type { Database } from './client.js';
import { newId } from './ids.js';
import { MIGRATIONS_FOLDER, migrate } from './migrate.js';
import { testTargets, type TestTarget } from './test-support.js';

/**
 * What migrations 0037 and 0038 do to rows that already exist (decision D-69, P-02l2). A
 * database is migrated to the point just before the migration, rows are written with plain
 * SQL so they do not depend on columns added later, and the rest of the migrations run. The
 * people and locations of an existing install keep everything they had, and nobody is
 * told they have chosen or verified anything.
 */

/** A database migrated up to, and not including, the migration `tag`, and what to do with it afterwards. */
async function databaseBefore(target: TestTarget, tag: string) {
  const { database, cleanup } = await target.create();
  const folder = mkdtempSync(join(tmpdir(), 'osfpm-migrations-'));
  try {
    // Stop one migration short: a copy of the folder whose journal ends before it.
    cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
    const journalPath = join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: { tag: string }[];
    };
    const cut = journal.entries.findIndex((entry) => entry.tag === tag);
    expect(cut).toBeGreaterThan(0);
    writeFileSync(
      journalPath,
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, cut) }),
    );
    await migrate(database, folder);
  } catch (error) {
    rmSync(folder, { recursive: true, force: true });
    await cleanup();
    throw error;
  }
  return {
    database,
    /** Runs the migrations that were held back. */
    upgrade: () => migrate(database),
    /** Removes the copy of the folder and drops the database. */
    finish: async () => {
      rmSync(folder, { recursive: true, force: true });
      await cleanup();
    },
  };
}

/** An organisation, with plain SQL, as it was written before the migrations under test. */
async function insertOrganisation(database: Database, origin: string) {
  const organisationId = newId();
  await database.db.execute(
    sql`insert into organisation (id, organisation_id, owner_org_id, origin_server,
          slug, name, country, default_locale, default_timezone, base_currency, status)
        values (${organisationId}, ${organisationId}, ${organisationId}, ${origin},
          'upgrade-org', 'Demo Pictures', 'GB', 'en-GB', 'Europe/London', 'GBP', 'active')`,
  );
  return organisationId;
}

describe.each(testTargets)(
  'the delivery preferences and location access migrations on $name',
  (target) => {
    it('0037 leaves every existing person with no preferences recorded, and makes the table for accounts, empty', async () => {
      const { database, upgrade, finish } = await databaseBefore(
        target,
        '0037_delivery_preferences',
      );
      try {
        const origin = newId();
        const organisationId = await insertOrganisation(database, origin);
        const userId = newId();
        await database.db.execute(
          sql`insert into "user" (id, origin_server, email, display_name, locale, timezone, status)
              values (${userId}, ${origin}, 'upgrade.mira@example.test', 'Mira Vukovic',
                'en-GB', 'Europe/London', 'active')`,
        );
        const withAccount = newId();
        const without = newId();
        await database.db.execute(
          sql`insert into person (id, organisation_id, owner_org_id, origin_server, display_name, user_id)
              values (${withAccount}, ${organisationId}, ${organisationId}, ${origin}, 'Mira Vukovic', ${userId}),
                     (${without}, ${organisationId}, ${organisationId}, ${origin}, 'Tomas Berg', null)`,
        );

        await upgrade();

        const people = await rowsOf(
          database,
          sql`select display_name, communication_preferences from person order by display_name`,
        );
        expect(people).toEqual([
          { display_name: 'Mira Vukovic', communication_preferences: null },
          { display_name: 'Tomas Berg', communication_preferences: null },
        ]);
        expect(
          await rowsOf(
            database,
            sql`select count(*)::int as n from user_preferences`,
          ),
        ).toEqual([{ n: 0 }]);
        // A row written after the migration starts in the account-lifetime class.
        const [later] = await rowsOf(
          database,
          sql`insert into user_preferences (id, origin_server, user_id, payload)
              values (${newId()}, ${origin}, ${userId}, '{"textSize": "large"}'::jsonb)
              returning retention_class`,
        );
        expect(later).toEqual({ retention_class: 'account-lifetime' });
      } finally {
        await finish();
      }
    });

    it('0038 leaves every existing location with its own columns, every answer unknown and nothing verified', async () => {
      const { database, upgrade, finish } = await databaseBefore(
        target,
        '0038_location_access',
      );
      try {
        const origin = newId();
        const organisationId = await insertOrganisation(database, origin);
        const locationId = newId();
        await database.db.execute(
          sql`insert into location (id, organisation_id, owner_org_id, origin_server,
                name, kind, access_notes, parking_notes)
              values (${locationId}, ${organisationId}, ${organisationId}, ${origin},
                'Harbour Warehouse', 'location', 'Use the side door', 'Street parking only')`,
        );

        await upgrade();

        const [row] = await rowsOf(
          database,
          sql`select name, kind, access_notes, parking_notes, step_free_route, accessible_toilet,
                accessible_toilet_distance_m, accessible_parking, accessible_parking_surface,
                parking_height_clearance_cm, quiet_room, seating, access_verified_at,
                access_verified_by
              from location where id = ${locationId}`,
        );
        expect(row).toEqual({
          name: 'Harbour Warehouse',
          kind: 'location',
          access_notes: 'Use the side door',
          parking_notes: 'Street parking only',
          step_free_route: 'unknown',
          accessible_toilet: 'unknown',
          accessible_toilet_distance_m: null,
          accessible_parking: 'unknown',
          accessible_parking_surface: null,
          parking_height_clearance_cm: null,
          quiet_room: 'unknown',
          seating: 'unknown',
          access_verified_at: null,
          access_verified_by: null,
        });
      } finally {
        await finish();
      }
    });
  },
);
