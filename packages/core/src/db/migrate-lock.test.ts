import { beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import type { PostgresDb } from './client.js';
import { MIGRATION_LOCK_KEY, MIGRATIONS_FOLDER, migrate } from './migrate.js';

// The migrator is replaced, so what is left to watch is what `migrate` does
// around it: which connection it takes, in what order, and what it hands over.
// The real migrator under the real lock is tested in `migrate.test.ts`, on
// PostgreSQL.
vi.mock('drizzle-orm/node-postgres/migrator', () => ({ migrate: vi.fn() }));
const migrator = vi.mocked(migratePg);

/** A stand-in for a PostgreSQL handle: a pool that has one connection to give, and a log of what happened. */
function fakePostgres(
  options: { unlockFails?: boolean; lockFails?: boolean } = {},
) {
  const events: string[] = [];
  const holder = {
    query: (text: string) => {
      const name = /pg_advisory_(\w+)/.exec(text)?.[1] ?? text;
      events.push(`query ${name}`);
      if (name === 'lock' && options.lockFails) {
        return Promise.reject(new Error('the connection dropped'));
      }
      return name === 'unlock' && options.unlockFails
        ? Promise.reject(new Error('the connection dropped'))
        : Promise.resolve({ rows: [] });
    },
    release: (error?: unknown) => {
      events.push(error === undefined ? 'release' : 'destroy');
    },
  };
  let connects = 0;
  const pool = {
    connect: () => {
      connects += 1;
      events.push('connect');
      return Promise.resolve(holder);
    },
  };
  const database = {
    driver: 'postgres',
    db: { $client: pool },
    close: () => Promise.resolve(),
  } as unknown as PostgresDb;
  return { database, holder, events, connects: () => connects };
}

describe('migrate on PostgreSQL, around the migrator', () => {
  beforeEach(() => {
    migrator.mockReset();
    migrator.mockResolvedValue(undefined);
  });

  /** The `db` the migrator was handed, and its second argument. */
  const handedOver = () => {
    const [db, config] = migrator.mock.calls[0]!;
    return { db: db as unknown as { $client: unknown }, config };
  };

  it('takes the lock, migrates, and lets the lock go and gives the connection back, in that order', async () => {
    const { database, events: log } = fakePostgres();
    migrator.mockImplementation(() => {
      log.push('migrate');
      return Promise.resolve();
    });
    await migrate(database);
    expect(log).toEqual([
      'connect',
      'query lock',
      'migrate',
      'query unlock',
      'release',
    ]);
  });

  it('migrates on the very connection that holds the lock, and asks the pool for no other, so a pool of one is enough', async () => {
    const { database, holder, connects } = fakePostgres();
    await migrate(database);
    expect(migrator).toHaveBeenCalledTimes(1);
    // The migrator works through the locked connection, not through the pool.
    expect(handedOver().db.$client).toBe(holder);
    expect(connects()).toBe(1);
  });

  it('hands the migrator the folder it was given, and the standard one by default', async () => {
    await migrate(fakePostgres().database, '/some/folder');
    expect(handedOver().config).toEqual({ migrationsFolder: '/some/folder' });
    migrator.mockClear();
    await migrate(fakePostgres().database);
    expect(handedOver().config).toEqual({
      migrationsFolder: MIGRATIONS_FOLDER,
    });
  });

  it('asks for the one key, to take the lock and to let it go', async () => {
    const asked: unknown[][] = [];
    const { database, holder } = fakePostgres();
    const query = holder.query.bind(holder);
    holder.query = (...args: [string, ...unknown[]]) => {
      asked.push(args);
      return query(args[0]);
    };
    await migrate(database);
    expect(asked.map((args) => args[1])).toEqual([
      [MIGRATION_LOCK_KEY],
      [MIGRATION_LOCK_KEY],
    ]);
    // The ASCII of OSFPMMIG, read as a 64-bit number, and under 2^63 so it is a valid bigint key.
    expect(MIGRATION_LOCK_KEY).toBe(
      Buffer.from('OSFPMMIG').readBigUInt64BE().toString(),
    );
    expect(BigInt(MIGRATION_LOCK_KEY)).toBeLessThan(2n ** 63n);
  });

  it('lets the lock go and gives the connection back when the migration fails, and throws that error', async () => {
    const { database, events: log } = fakePostgres();
    const failure = new Error('migration 12 failed');
    migrator.mockImplementation(() => {
      log.push('migrate');
      return Promise.reject(failure);
    });
    await expect(migrate(database)).rejects.toBe(failure);
    expect(log).toEqual([
      'connect',
      'query lock',
      'migrate',
      'query unlock',
      'release',
    ]);
  });

  it('destroys the connection when letting go of the lock fails, and still throws the migration error', async () => {
    const { database, events: log } = fakePostgres({ unlockFails: true });
    const failure = new Error('migration 12 failed');
    migrator.mockRejectedValue(failure);
    await expect(migrate(database)).rejects.toBe(failure);
    expect(log).toEqual(['connect', 'query lock', 'query unlock', 'destroy']);
  });

  it('does not migrate when the lock cannot be taken, and throws the error of the lock', async () => {
    const { database, events: log } = fakePostgres({ lockFails: true });
    await expect(migrate(database)).rejects.toThrow('the connection dropped');
    expect(migrator).not.toHaveBeenCalled();
    expect(log).not.toContain('migrate');
    // It still tries to let go, which is harmless if the lock was never taken,
    // and gives the connection back.
    expect(log).toEqual(['connect', 'query lock', 'query unlock', 'release']);
  });
});
