import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { PostgresDb } from './client.js';
import { MIGRATION_LOCK_KEY, MIGRATIONS_FOLDER, migrate } from './migrate.js';
import { testTargets } from './test-support.js';

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
      try {
        // Another server, half way through its own migration.
        const holder = await world.pool.connect();
        await holder.query('select pg_advisory_lock($1::bigint)', [
          MIGRATION_LOCK_KEY,
        ]);
        let finished = false;
        const migrating = migrate(world.database).then(() => {
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

        await holder.query('select pg_advisory_unlock($1::bigint)', [
          MIGRATION_LOCK_KEY,
        ]);
        holder.release();
        await migrating;

        expect(finished).toBe(true);
        expect(await world.appliedMigrations()).toBe(MIGRATION_COUNT);
        expect(await world.tableExists('session')).toBe(true);
        // And it let go of the lock itself: nobody is left waiting, and the
        // lock can be taken again at once.
        expect(await world.lockIsFree()).toBe(true);
      } finally {
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

/**
 * A stand-in for the pool, to see the order of what `migrate` does around the
 * migrator without a server. The folder has no journal, so the migrator throws
 * before it touches the database: what is left to watch is the lock.
 */
function fakePostgres(options: { unlockFails?: boolean } = {}) {
  const events: string[] = [];
  const holder = {
    query: (text: string) => {
      const name = /pg_advisory_(\w+)/.exec(text)?.[1] ?? text;
      events.push(`query ${name}`);
      return name === 'unlock' && options.unlockFails
        ? Promise.reject(new Error('the connection dropped'))
        : Promise.resolve({ rows: [] });
    },
    release: (error?: unknown) => {
      events.push(error === undefined ? 'release' : 'destroy');
    },
  };
  const pool = {
    connect: () => {
      events.push('connect');
      return Promise.resolve(holder);
    },
  };
  const database = {
    driver: 'postgres',
    db: { $client: pool },
    close: () => Promise.resolve(),
  } as unknown as PostgresDb;
  return { database, events };
}

describe('migrate on PostgreSQL, around the migrator', () => {
  const NO_FOLDER = '/this/folder/does/not/exist';

  it('takes the lock on a connection of its own first, and lets it go and gives the connection back after', async () => {
    const { database, events } = fakePostgres();
    await expect(migrate(database, NO_FOLDER)).rejects.toThrow();
    expect(events).toEqual([
      'connect',
      'query lock',
      'query unlock',
      'release',
    ]);
  });

  it('asks for the one key', async () => {
    const asked: unknown[][] = [];
    const { database } = fakePostgres();
    const pool = (
      database.db as unknown as {
        $client: {
          connect: () => Promise<{ query: (...args: unknown[]) => unknown }>;
        };
      }
    ).$client;
    const connect = pool.connect.bind(pool);
    pool.connect = async () => {
      const holder = await connect();
      const query = holder.query.bind(holder);
      holder.query = (...args: unknown[]) => {
        asked.push(args);
        return query(...args);
      };
      return holder;
    };
    await expect(migrate(database, NO_FOLDER)).rejects.toThrow();
    expect(asked.map((args) => args[1])).toEqual([
      [MIGRATION_LOCK_KEY],
      [MIGRATION_LOCK_KEY],
    ]);
    // The ASCII of OSFPMMIG, read as a 64-bit number, and under 2^63 so it is a valid bigint key.
    expect(MIGRATION_LOCK_KEY).toBe(
      Buffer.from('OSFPMMIG').readBigUInt64BE().toString(),
    );
    expect(BigInt(MIGRATION_LOCK_KEY)).toBeLessThan(2n ** 63n);
  });

  it('destroys the connection when letting go of the lock fails, and still throws the migration error', async () => {
    const { database, events } = fakePostgres({ unlockFails: true });
    await expect(migrate(database, NO_FOLDER)).rejects.toThrow(/journal|meta/i);
    expect(events).toEqual([
      'connect',
      'query lock',
      'query unlock',
      'destroy',
    ]);
  });
});
