import { fileURLToPath } from 'node:url';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import pg from 'pg';
import type { Database, PgliteDb, PostgresDb } from './client.js';

/** Committed, forward-only migrations shared by both drivers. */
export const MIGRATIONS_FOLDER = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);

/**
 * The PostgreSQL advisory lock a migrator holds for the whole of its run: the
 * ASCII of `OSFPMMIG`, which fits the `bigint` the lock functions take. An
 * advisory lock belongs to one database, so it never meets another database's
 * migration, and nothing else in OSFPM takes this key. It is a string because a
 * `bigint` this size is not safe as a JavaScript number.
 */
export const MIGRATION_LOCK_KEY = BigInt('0x4f5346504d4d4947').toString();

/**
 * Applies all pending migrations. The same migration set serves both drivers.
 * Migrations are forward-only: never edit one that has been applied (CLAUDE.md,
 * Data rules). A failing statement is thrown as the driver reports it.
 *
 * On PostgreSQL the whole run is inside a session-level advisory lock
 * (`MIGRATION_LOCK_KEY`), so servers that start at the same moment take turns:
 * the second waits, then finds everything applied and does nothing. Without it
 * both would read "nothing applied" and the second would fail on the first
 * table that exists. The migration runs on the very connection that holds the
 * lock, so it needs one connection from the pool and a pool of one is enough; a
 * second connection, asked for while the first is held, would wait for itself
 * for ever. The lock is let go of when the migration ends, however it ends; if
 * the process dies, the connection closes and PostgreSQL drops the lock. Waiting
 * has no time limit, because another server's migration may be long. PGlite
 * takes no lock: it has one connection and one process.
 *
 * @throws Error when a migration fails, or the database cannot be reached.
 * Nothing is left locked.
 */
export async function migrate(
  database: Database | PostgresDb | PgliteDb,
  migrationsFolder: string = MIGRATIONS_FOLDER,
): Promise<void> {
  // The migrators need the driver-specific type. `driver` always names the
  // instance that `createDatabase` built, so narrowing here is safe.
  switch (database.driver) {
    case 'postgres': {
      const db = database.db as PostgresDb['db'];
      await withMigrationLock(db.$client, (connection) =>
        // The same drizzle, over the locked connection instead of the pool: it
        // runs its queries and its transaction on that one connection.
        migratePg(drizzlePg({ client: connection }), { migrationsFolder }),
      );
      return;
    }
    case 'pglite':
      await migratePglite(database.db as PgliteDb['db'], { migrationsFolder });
      return;
  }
}

/**
 * Runs `work` while holding the migration lock on a connection taken from
 * `pool`, and hands `work` that connection to do everything on, so the pool is
 * asked for one connection and no more. If letting go of the lock fails, the
 * connection is destroyed instead of returned to the pool, which also drops the
 * lock.
 */
async function withMigrationLock(
  pool: pg.Pool,
  work: (connection: pg.PoolClient) => Promise<void>,
): Promise<void> {
  const holder = await pool.connect();
  try {
    await holder.query('select pg_advisory_lock($1::bigint)', [
      MIGRATION_LOCK_KEY,
    ]);
    await work(holder);
  } finally {
    try {
      await holder.query('select pg_advisory_unlock($1::bigint)', [
        MIGRATION_LOCK_KEY,
      ]);
      holder.release();
    } catch (error) {
      // Never hides the error from `work`, which is thrown after this block.
      holder.release(error instanceof Error ? error : true);
    }
  }
}
