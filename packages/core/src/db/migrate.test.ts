import { readFileSync } from 'node:fs';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { PostgresDb } from './client.js';
import { MIGRATION_LOCK_KEY, MIGRATIONS_FOLDER, migrate } from './migrate.js';
import * as schema from './schema/index.js';
import { guardTeardown, testTargets } from './test-support.js';

/** The PostgreSQL target, when `DATABASE_URL` names a server. PGlite has one connection, so it cannot run this. */
const postgres = testTargets.find((target) => target.name === 'postgres');

/** How many migrations the folder holds, from its journal. */
const MIGRATION_COUNT = (
  JSON.parse(
    readFileSync(`${MIGRATIONS_FOLDER}/meta/_journal.json`, 'utf8'),
  ) as { entries: unknown[] }
).entries.length;

/**
 * Two API servers that start at the same moment must not both run the
 * migrations: the second used to find nothing applied, run them again and fail
 * on the first table that exists. A migrator now holds an advisory lock for its
 * whole run, so the second waits and then finds everything applied. Only a
 * server with real concurrent sessions can show it, so these tests run on
 * PostgreSQL and are skipped on PGlite, where `migrate` takes no lock.
 */
describe.skipIf(postgres === undefined)(
  'migrate with concurrent starts, on PostgreSQL',
  () => {
    /** A fresh, empty database, and a way to count what is waiting on the migration lock. */
    async function emptyDatabase() {
      const { database, cleanup } = await postgres!.create();
      const pool = (database.db as PostgresDb['db']).$client;
      const waitingForTheLock = async () => {
        const result = await pool.query<{ waiting: number }>(
          `select count(*)::int as waiting
           from pg_locks
           where locktype = 'advisory' and not granted
             and database = (select oid from pg_database where datname = current_database())`,
        );
        return result.rows[0]!.waiting;
      };
      const appliedMigrations = async () => {
        const result = await pool.query<{ applied: number }>(
          'select count(*)::int as applied from drizzle.__drizzle_migrations',
        );
        return result.rows[0]!.applied;
      };
      // Takes the lock and lets it go again on a connection of its own, so the
      // probe never leaves the lock held by a pooled connection.
      const lockIsFree = async () => {
        const connection = await pool.connect();
        try {
          const result = await connection.query<{ got: boolean }>(
            'select pg_try_advisory_lock($1::bigint) as got',
            [MIGRATION_LOCK_KEY],
          );
          if (!result.rows[0]!.got) return false;
          await connection.query('select pg_advisory_unlock($1::bigint)', [
            MIGRATION_LOCK_KEY,
          ]);
          return true;
        } finally {
          connection.release();
        }
      };
      const tableExists = async (name: string) => {
        const result = await pool.query<{ found: string | null }>(
          'select to_regclass($1)::text as found',
          [`public.${name}`],
        );
        return result.rows[0]!.found !== null;
      };
      return {
        database,
        pool,
        cleanup,
        waitingForTheLock,
        lockIsFree,
        appliedMigrations,
        tableExists,
      };
    }

    it('waits while another session holds the lock, migrates nothing meanwhile, and goes on when it is let go', async () => {
      const world = await emptyDatabase();
      // Another server, half way through its own migration.
      const holder = await world.pool.connect();
      let held = true;
      /** Lets go of the lock and gives the connection back, once, whatever the test did. */
      const letGo = async () => {
        if (!held) return;
        held = false;
        try {
          await holder.query('select pg_advisory_unlock($1::bigint)', [
            MIGRATION_LOCK_KEY,
          ]);
        } finally {
          holder.release();
        }
      };
      let migrating: Promise<void> | undefined;
      try {
        await holder.query('select pg_advisory_lock($1::bigint)', [
          MIGRATION_LOCK_KEY,
        ]);
        let finished = false;
        migrating = migrate(world.database).then(() => {
          finished = true;
        });

        // It is blocked on the lock, not busy: the database shows it waiting.
        await vi.waitFor(
          async () => expect(await world.waitingForTheLock()).toBe(1),
          10_000,
        );
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(finished).toBe(false);
        expect(await world.tableExists('session')).toBe(false);

        await letGo();
        await migrating;

        expect(finished).toBe(true);
        expect(await world.appliedMigrations()).toBe(MIGRATION_COUNT);
        expect(await world.tableExists('session')).toBe(true);
        // And it let go of the lock itself: nobody is left waiting, and the
        // lock can be taken again at once.
        expect(await world.lockIsFree()).toBe(true);
      } finally {
        // If an assertion failed above, the holder must not stay checked out:
        // closing the pool would wait for it until the test timed out.
        await letGo();
        await migrating?.catch(() => undefined);
        await world.cleanup();
      }
    }, 60_000);

    it('lets two migrators start at once: both succeed, and each migration is applied once', async () => {
      const world = await emptyDatabase();
      try {
        const outcomes = await Promise.allSettled([
          migrate(world.database),
          migrate(world.database),
        ]);
        expect(outcomes.map((outcome) => outcome.status)).toEqual([
          'fulfilled',
          'fulfilled',
        ]);
        expect(await world.appliedMigrations()).toBe(MIGRATION_COUNT);
        expect(await world.tableExists('session')).toBe(true);
      } finally {
        await world.cleanup();
      }
    }, 60_000);

    it('lets several migrators start at once on a database that is already migrated, and changes nothing', async () => {
      const world = await emptyDatabase();
      try {
        await migrate(world.database);
        const outcomes = await Promise.allSettled([
          migrate(world.database),
          migrate(world.database),
          migrate(world.database),
        ]);
        expect(
          outcomes.every((outcome) => outcome.status === 'fulfilled'),
        ).toBe(true);
        expect(await world.appliedMigrations()).toBe(MIGRATION_COUNT);
      } finally {
        await world.cleanup();
      }
    }, 60_000);

    it('migrates through a pool of one connection: the migration runs on the connection that holds the lock', async () => {
      const world = await emptyDatabase();
      // A pool that can give out one connection, to the same database. If the
      // lock took that connection and the migrator asked the pool for another,
      // the migration would wait for itself for ever.
      const single = new pg.Pool({
        connectionString: world.pool.options.connectionString,
        max: 1,
      });
      // This pool is the test's own, so it gets the handler the test target's pool has: a
      // 57P01 (the shutdown error of a forced drop) at teardown must not fail the run.
      const beginTeardown = guardTeardown(single);
      try {
        await migrate({
          driver: 'postgres',
          db: drizzlePg({ client: single, schema }),
          close: () => single.end(),
        });
        expect(await world.appliedMigrations()).toBe(MIGRATION_COUNT);
        expect(await world.tableExists('session')).toBe(true);
        expect(await world.lockIsFree()).toBe(true);
      } finally {
        beginTeardown();
        await single.end();
        await world.cleanup();
      }
    }, 60_000);

    it('lets go of the lock when a migration fails, so the next start is not stuck behind it', async () => {
      const world = await emptyDatabase();
      try {
        // A folder with no journal: the migrator throws after it has the lock.
        await expect(
          migrate(world.database, '/this/folder/does/not/exist'),
        ).rejects.toThrow();
        expect(await world.lockIsFree()).toBe(true);
        // And a real migration still goes through afterwards.
        await migrate(world.database);
        expect(await world.appliedMigrations()).toBe(MIGRATION_COUNT);
      } finally {
        await world.cleanup();
      }
    }, 60_000);
  },
);
