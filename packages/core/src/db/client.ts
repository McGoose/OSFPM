import { PGlite } from '@electric-sql/pglite';
import {
  drizzle as drizzlePglite,
  type PgliteDatabase,
} from 'drizzle-orm/pglite';
import {
  drizzle as drizzlePg,
  type NodePgDatabase,
} from 'drizzle-orm/node-postgres';
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

export type PostgresDb = {
  readonly driver: 'postgres';
  readonly db: NodePgDatabase<typeof schema>;
  readonly close: () => Promise<void>;
};

export type PgliteDb = {
  readonly driver: 'pglite';
  readonly db: PgliteDatabase<typeof schema>;
  readonly close: () => Promise<void>;
};

export type Database = PostgresDb | PgliteDb;

export function createDatabase(config: {
  driver: 'postgres';
  url: string;
}): PostgresDb;
export function createDatabase(
  config: Extract<DbConfig, { driver: 'pglite' }>,
): PgliteDb;
export function createDatabase(config: DbConfig): Database;
export function createDatabase(config: DbConfig): Database {
  switch (config.driver) {
    case 'postgres': {
      const pool = new pg.Pool({ connectionString: config.url });
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
