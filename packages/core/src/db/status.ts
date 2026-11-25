import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { SchemaDb } from './client.js';
import { MIGRATIONS_FOLDER } from './migrate.js';

/**
 * Read-only questions about the database as a whole, for the admin command line
 * (`doctor` and the guard that every other command runs): what has been
 * migrated, and what time the database thinks it is. Nothing here writes, locks
 * or migrates.
 */

type Rows<T> = { rows: T[] };

/** How many of the committed migrations a database has applied, and how many are still to run. */
export type MigrationStatus = {
  readonly applied: number;
  readonly pending: number;
};

/**
 * Counts the committed migrations (the journal in `migrationsFolder`) that the
 * database has applied and the ones it has not. Drizzle's migrator keeps the time
 * of the newest migration it applied in `drizzle.__drizzle_migrations`, and runs
 * every committed migration newer than that, so this counts the same way: a
 * database that has never been migrated has no such table and has every migration
 * pending. It does not look at what the migrations contain.
 *
 * Anyone may call it; it reads one drizzle bookkeeping table and takes no lock.
 *
 * @throws Error when the journal cannot be read, or the database cannot be reached.
 */
export async function migrationStatus(
  db: SchemaDb,
  migrationsFolder: string = MIGRATIONS_FOLDER,
): Promise<MigrationStatus> {
  const committed = readMigrationFiles({ migrationsFolder });
  const present = (await db.execute(
    sql`select to_regclass('drizzle.__drizzle_migrations') is not null as present`,
  )) as Rows<{ present: boolean }>;
  let newest = 0;
  if (present.rows[0]?.present === true) {
    // As text: `created_at` is a bigint, which a driver may hand back as a string.
    const result = (await db.execute(
      sql`select coalesce(max(created_at), 0)::text as newest from drizzle.__drizzle_migrations`,
    )) as Rows<{ newest: string }>;
    newest = Number(result.rows[0]?.newest ?? 0);
  }
  const applied = committed.filter(
    (migration) => migration.folderMillis <= newest,
  ).length;
  return { applied, pending: committed.length - applied };
}

/**
 * The database's own clock, from `now()`. Asking is also the cheapest check that
 * the database answers at all. The admin command line compares it with the local
 * clock: authenticator codes are checked against the server's time.
 *
 * @throws Error when the database cannot be reached.
 */
export async function databaseTime(db: SchemaDb): Promise<Date> {
  // Whole milliseconds as text, so no driver's date parsing is in the way.
  const result = (await db.execute(
    sql`select floor(extract(epoch from now()) * 1000)::text as ms`,
  )) as Rows<{ ms: string }>;
  return new Date(Number(result.rows[0]!.ms));
}
