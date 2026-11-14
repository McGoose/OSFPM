import { fileURLToPath } from 'node:url';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import type { Database } from './client.js';

/** Committed, forward-only migrations shared by both drivers. */
export const MIGRATIONS_FOLDER = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);

/** Applies all pending migrations. The same migration set serves both drivers. */
export async function migrate(
  database: Database,
  migrationsFolder: string = MIGRATIONS_FOLDER,
): Promise<void> {
  switch (database.driver) {
    case 'postgres':
      await migratePg(database.db, { migrationsFolder });
      return;
    case 'pglite':
      await migratePglite(database.db, { migrationsFolder });
      return;
  }
}
