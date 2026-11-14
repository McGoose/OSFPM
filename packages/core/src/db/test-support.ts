import { randomBytes } from 'node:crypto';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { createDatabase, type Database } from './client.js';
import { migrate } from './migrate.js';
import * as schema from './schema/index.js';

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
      // The test owns its pool, so it can handle the shutdown error that
      // `drop database ... with (force)` sends to a connection that is still
      // closing (57P01). During teardown only, that one error is expected;
      // any other error is rethrown and fails the run, as before.
      const pool = new pg.Pool({ connectionString: url.toString() });
      let tearingDown = false;
      const onError = (error: Error & { code?: string }) => {
        if (tearingDown && error.code === '57P01') return;
        throw error;
      };
      pool.on('error', onError);
      pool.on('connect', (client) => client.on('error', onError));
      const database: Database = {
        driver: 'postgres',
        db: drizzlePg({ client: pool, schema }),
        close: () => pool.end(),
      };
      return {
        database,
        cleanup: async () => {
          tearingDown = true;
          // Close every connection to the test database before dropping it.
          await pool.end();
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
