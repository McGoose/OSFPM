import { PGlite } from '@electric-sql/pglite';
import {
  drizzle as drizzlePglite,
  type PgliteDatabase,
} from 'drizzle-orm/pglite';
import {
  drizzle as drizzlePg,
  type NodePgDatabase,
} from 'drizzle-orm/node-postgres';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as schema from './schema/index.js';

/**
 * Database configuration. The driver is always chosen explicitly by the
 * caller's configuration; it is never guessed from the shape of a string.
 */
export type DbConfig =
  | { readonly driver: 'postgres'; readonly url: string }
  | {
      readonly driver: 'pglite';
      /** Data directory for a persistent database. Omit for in-memory. */
      readonly dataDir?: string;
    }
  | { readonly driver: 'pglite'; readonly client: PGlite };

/**
 * A PostgreSQL handle over a node-postgres pool. `close` ends the pool. `db`
 * also gives the pool as `$client`, which the migrator needs to hold its lock on
 * a connection of its own.
 */
export type PostgresDb = {
  readonly driver: 'postgres';
  readonly db: NodePgDatabase<typeof schema> & { readonly $client: pg.Pool };
  readonly close: () => Promise<void>;
};

/** A PGlite handle. `close` also closes a `client` the caller passed in. */
export type PgliteDb = {
  readonly driver: 'pglite';
  readonly db: PgliteDatabase<typeof schema>;
  readonly close: () => Promise<void>;
};

/**
 * The PostgreSQL base class both Drizzle instances extend. Code that only
 * runs queries should depend on this, not on a driver-specific type.
 */
export type SchemaDb = PgDatabase<PgQueryResultHKT, typeof schema>;

/** A database handle of either driver, with queries typed on the shared base. */
export type Database = {
  readonly driver: 'postgres' | 'pglite';
  readonly db: SchemaDb;
  readonly close: () => Promise<void>;
};

/**
 * Opens a database for the configured driver. It runs no migrations (see
 * `migrate`). The overloads only narrow the return type.
 *
 * A PostgreSQL pool logs an idle connection that fails, by error class only,
 * to standard error, and recovers by opening a new connection on the next
 * query. It does not crash the process.
 *
 * @throws Error for a driver other than `postgres` or `pglite`. The message
 * names the driver only, never the rest of the config.
 */
export function createDatabase(config: {
  driver: 'postgres';
  url: string;
}): PostgresDb;
/** PGlite overload: in memory, in `dataDir`, or over an existing client. */
export function createDatabase(
  config: Extract<DbConfig, { driver: 'pglite' }>,
): PgliteDb;
/** General overload, for a `DbConfig` whose driver is not known statically. */
export function createDatabase(config: DbConfig): Database;
export function createDatabase(config: DbConfig): PostgresDb | PgliteDb {
  switch (config.driver) {
    case 'postgres': {
      const pool = new pg.Pool({ connectionString: config.url });
      // An idle connection can fail while nothing is using it: the server
      // restarts, or the network drops. The pool then emits 'error', and with no
      // listener Node throws it and the whole process dies. The pool has already
      // dropped the broken client and opens a new one for the next query, so
      // the listener only has to say so. It names the error's class and nothing
      // else: driver messages carry host names, user names or query values.
      pool.on('error', (error: unknown) => {
        const name =
          error instanceof Error ? error.constructor.name || error.name : '';
        console.error(
          `Database pool error on an idle connection: ${name || 'unknown error'}`,
        );
      });
      return {
        driver: 'postgres',
        db: drizzlePg({ client: pool, schema }),
        close: () => pool.end(),
      };
    }
    case 'pglite': {
      const client =
        'client' in config ? config.client : new PGlite(config.dataDir);
      return {
        driver: 'pglite',
        db: drizzlePglite({ client, schema }),
        close: () => client.close(),
      };
    }
    default: {
      const unknown: never = config;
      // Report only the driver name: the rest of the config may hold credentials.
      throw new Error(
        `Unsupported database driver: ${String((unknown as { driver?: unknown }).driver)}`,
      );
    }
  }
}
