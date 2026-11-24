import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { createDatabase, type Database, type SchemaDb } from './client.js';
import { IN_USE_LOCK_KEY, migrate } from './migrate.js';
import * as schema from './schema/index.js';
import type { Tx } from './write.js';

/**
 * Test helpers: a database to run against, ways to read a failure, and the
 * helpers that run two transactions against each other. Only tests import
 * this file.
 */

/** A database engine the tests run against: PGlite, or a PostgreSQL server. */
export type TestTarget = {
  readonly name: 'pglite' | 'postgres';
  /**
   * Creates an empty, isolated database. Call `cleanup` when finished. `url` is the
   * address of a PostgreSQL database, for a test that needs a second connection
   * pool of its own (a second process, as far as the database can tell); a PGlite
   * database has none.
   */
  readonly create: () => Promise<{
    database: Database;
    cleanup: () => Promise<void>;
    url?: string;
  }>;
};

/**
 * Handles the errors of a pool a test owns, for a test that drops its database with
 * `drop database ... with (force)`. That statement closes every connection to the
 * database, and PostgreSQL tells a connection that is still closing so (57P01, "terminating
 * connection due to administrator command"), which a pool with no handler turns into an
 * unhandled error that fails the whole run. Call the function this returns when the test
 * starts to tear down: from then on that one error is expected and let pass, on the pool
 * and on each of its connections. Any other error, and that one before teardown, is
 * rethrown and fails the run, as it would without a handler.
 */
export function guardTeardown(pool: pg.Pool): () => void {
  let tearingDown = false;
  const onError = (error: Error & { code?: string }) => {
    if (tearingDown && error.code === '57P01') return;
    throw error;
  };
  pool.on('error', onError);
  pool.on('connect', (client) => client.on('error', onError));
  return () => {
    tearingDown = true;
  };
}

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
      const beginTeardown = guardTeardown(pool);
      const database: Database = {
        driver: 'postgres',
        db: drizzlePg({ client: pool, schema }),
        close: () => pool.end(),
      };
      return {
        database,
        url: url.toString(),
        cleanup: async () => {
          beginTeardown();
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

/** A fresh, empty database on `target` with every migration applied. */
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

/**
 * Runs `action` and returns the SQLSTATE code and constraint name it failed
 * with.
 *
 * @throws Error when `action` succeeds. An error with no driver code is
 * rethrown as it is.
 */
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

/**
 * How many sessions of the test database hold the in-use advisory lock
 * (`IN_USE_LOCK_KEY`), shared or exclusive: the servers and the command that are
 * running against it. PostgreSQL only. The API's tests call this, because they
 * have no `sql` of their own.
 */
export async function inUseHolders(db: SchemaDb): Promise<number> {
  const result = (await db.execute(
    sql`select count(*)::int as held from pg_locks
        where locktype = 'advisory'
          and ((classid::bigint << 32) | objid::bigint) = ${IN_USE_LOCK_KEY}::bigint`,
  )) as { rows: { held: number }[] };
  return Number(result.rows[0]!.held);
}

/** SQLSTATE codes tests expect from `failureOf`. */
export const SQLSTATE = {
  foreignKeyViolation: '23503',
  uniqueViolation: '23505',
  checkViolation: '23514',
} as const;

/** Waits `ms` milliseconds. */
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A promise that is resolved from outside. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * How many sessions of the test database are waiting for a lock right now.
 * `interleave` uses it; a test that has to act between the block and the end of the
 * holder, which `interleave` does not allow, polls it itself.
 */
export async function lockWaiters(db: SchemaDb): Promise<number> {
  const result = await db.execute<{ waiting: number }>(
    sql`select count(*)::int as waiting
        from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'`,
  );
  // Both drivers return `{ rows }`, but the shared base type leaves it `unknown`.
  const { rows } = result as { rows: { waiting: number }[] };
  return Number(rows[0]!.waiting);
}

/**
 * Runs two pieces of work in two transactions on two connections, in a fixed
 * order. `holder` runs to the end of its work and keeps its transaction open.
 * Then `waiter` starts on the second connection. The call waits until the
 * waiter is blocked on a lock, which proves the two overlap, and only then lets
 * the holder commit. Returns both outcomes. If the waiter finishes while the
 * holder is still open, the lock did not do its job and the call throws.
 *
 * `whileBlocked`, when given, runs at the moment between those two, with the waiter
 * blocked and the holder still open, on connections of its own: for a test that has to
 * look at what the waiter holds while it waits (for instance, that it holds no row lock
 * yet, which is what keeps it from deadlocking with the holder). If it throws, both
 * transactions are finished first and the error is thrown after.
 */
export async function interleave(
  db: SchemaDb,
  holder: (tx: Tx) => Promise<unknown>,
  waiter: (tx: Tx) => Promise<unknown>,
  whileBlocked?: () => Promise<unknown>,
) {
  const holderDone = deferred();
  const commit = deferred();
  const first = db.transaction(async (tx) => {
    const result = await holder(tx);
    holderDone.resolve();
    await commit.promise;
    return result;
  });
  // A holder that fails before it is done rejects `first`, and the test with it.
  await Promise.race([holderDone.promise, first]);
  const second = db.transaction((tx) => waiter(tx));
  let secondSettled = false;
  second.then(
    () => {
      secondSettled = true;
    },
    () => {
      secondSettled = true;
    },
  );
  let observed: { error: unknown } | undefined;
  try {
    for (let waited = 0; ; waited += 25) {
      if (secondSettled) {
        throw new Error(
          'The second transaction finished while the first was still open: it did not wait for the lock',
        );
      }
      if ((await lockWaiters(db)) > 0) break;
      if (waited >= 10_000) {
        throw new Error('The second transaction never waited for a lock');
      }
      await sleep(25);
    }
    if (whileBlocked !== undefined) {
      try {
        await whileBlocked();
      } catch (error) {
        observed = { error };
      }
    }
  } finally {
    commit.resolve();
  }
  const outcomes = await Promise.allSettled([first, second]);
  if (observed !== undefined) throw observed.error;
  return outcomes;
}

/** How many of `outcomes` (from `interleave` or `Promise.allSettled`) succeeded. */
export const succeeded = (outcomes: PromiseSettledResult<unknown>[]) =>
  outcomes.filter((outcome) => outcome.status === 'fulfilled').length;
