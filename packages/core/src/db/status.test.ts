import { rmSync } from 'node:fs';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { describe, expect, it } from 'vitest';
import { migrate, MIGRATIONS_FOLDER } from './migrate.js';
import { databaseTime, migrationStatus } from './status.js';
import {
  createMigratedDatabase,
  partialMigrations,
  testTargets,
} from './test-support.js';

/** How many migrations are committed: the journal's own count. */
const COMMITTED = readMigrationFiles({
  migrationsFolder: MIGRATIONS_FOLDER,
}).length;

describe.each(testTargets)('the database status on $name', (target) => {
  it('counts every committed migration as pending in a database that was never migrated', async () => {
    const { database, cleanup } = await target.create();
    try {
      expect(COMMITTED).toBeGreaterThan(30);

      expect(await migrationStatus(database.db)).toEqual({
        applied: 0,
        pending: COMMITTED,
      });
    } finally {
      await cleanup();
    }
  });

  it('counts the migrations of a partly migrated database on each side, and the rest are pending', async () => {
    const { database, cleanup } = await target.create();
    const partial = partialMigrations(12);
    try {
      await migrate(database, partial.folder);

      expect(await migrationStatus(database.db)).toEqual({
        applied: 12,
        pending: COMMITTED - 12,
      });
      // Looked at from the folder that was applied, nothing is pending.
      expect(await migrationStatus(database.db, partial.folder)).toEqual({
        applied: 12,
        pending: 0,
      });
    } finally {
      await cleanup();
      rmSync(partial.root, { recursive: true, force: true });
    }
  });

  it('has none pending after the full migration, and changes nothing by asking', async () => {
    const { database, cleanup } = await createMigratedDatabase(target);
    try {
      const first = await migrationStatus(database.db);
      const second = await migrationStatus(database.db);

      expect(first).toEqual({ applied: COMMITTED, pending: 0 });
      expect(second).toEqual(first);
    } finally {
      await cleanup();
    }
  });

  it('answers the database’s own time, within seconds of this machine’s', async () => {
    const { database, cleanup } = await target.create();
    try {
      const before = Date.now();
      const time = await databaseTime(database.db);

      expect(time).toBeInstanceOf(Date);
      expect(Math.abs(time.getTime() - before)).toBeLessThan(30_000);
    } finally {
      await cleanup();
    }
  });
});
