import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createDatabase, type Database } from './client.js';
import { migrate } from './migrate.js';

export type TestTarget = {
  readonly name: 'pglite' | 'postgres';
  /** Creates an empty, isolated database. Call `cleanup` when finished. */
  readonly create: () => Promise<{
    database: Database;
    cleanup: () => Promise<void>;
  }>;
};

const pgliteTarget: TestTarget = {
  name: 'pglite',
  create: () => {
    const database = createDatabase({ driver: 'pglite' });
    return Promise.resolve({ database, cleanup: () => database.close() });
  },
};

/**
 * Each call creates a throwaway database on the server named by `adminUrl`
 * and drops it afterwards, so existing data is never touched.
 */
function postgresTarget(adminUrl: string): TestTarget {
  return {
    name: 'postgres',
    create: async () => {
      const name = `osfpm_test_${randomBytes(6).toString('hex')}`;
      const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
      await admin.query(`create database ${name}`);
      const url = new URL(adminUrl);
      url.pathname = `/${name}`;
      const database = createDatabase({
        driver: 'postgres',
        url: url.toString(),
      });
      return {
        database,
        cleanup: async () => {
          await database.close();
          await admin.query(`drop database ${name} with (force)`);
          await admin.end();
        },
      };
    },
  };
}

/** PGlite always; PostgreSQL as well when `DATABASE_URL` is set. */
export const testTargets: TestTarget[] = [
  pgliteTarget,
  ...(process.env.DATABASE_URL
    ? [postgresTarget(process.env.DATABASE_URL)]
    : []),
];

export async function createMigratedDatabase(target: TestTarget) {
  const created = await target.create();
  await migrate(created.database);
  return created;
}

type DriverError = { code?: string; constraint?: string; cause?: unknown };

/** Finds the driver-level error (SQLSTATE code, constraint name) in a cause chain. */
function driverError(error: unknown): DriverError | undefined {
  let current: unknown = error;
  while (current && typeof current === 'object') {
    const candidate = current as DriverError;
    if (typeof candidate.code === 'string') return candidate;
    current = candidate.cause;
  }
  return undefined;
}

/** Runs `action` and returns the SQLSTATE code and constraint name it failed with. */
export async function failureOf(action: () => PromiseLike<unknown>) {
  try {
    await action();
  } catch (error) {
    const found = driverError(error);
    if (!found) throw error;
    return { code: found.code, constraint: found.constraint };
  }
  throw new Error('Expected the statement to fail, but it succeeded');
}

export const SQLSTATE = {
  foreignKeyViolation: '23503',
  uniqueViolation: '23505',
  checkViolation: '23514',
} as const;
