import { fileURLToPath } from 'node:url';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import type { Database, PgliteDb, PostgresDb } from './client.js';

/** Committed, forward-only migrations shared by both drivers. */
export const MIGRATIONS_FOLDER = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);

/** Applies all pending migrations. The same migration set serves both drivers. */
export async function migrate(
  database: Database | PostgresDb | PgliteDb,
  migrationsFolder: string = MIGRATIONS_FOLDER,
): Promise<void> {
  // The migrators need the driver-specific type. `driver` always names the
  // instance that `createDatabase` built, so narrowing here is safe.
  switch (database.driver) {
    case 'postgres':
      await migratePg(database.db as PostgresDb['db'], { migrationsFolder });
      return;
    case 'pglite':
      await migratePglite(database.db as PgliteDb['db'], { migrationsFolder });
      return;
  }
}
