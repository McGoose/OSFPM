import type { EventEmitter } from 'node:events';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createDatabase, type Database } from './client.js';
import { newId } from './ids.js';
import { installation } from './schema/index.js';
import { createMigratedDatabase, testTargets } from './test-support.js';

/** The PostgreSQL target, when `DATABASE_URL` names a server. */
const postgres = testTargets.find((target) => target.name === 'postgres');

/** The `pg` pool inside a PostgreSQL `Database`, which Drizzle keeps as `$client`. */
const poolOf = (database: Database) =>
  (database.db as unknown as { $client: EventEmitter }).$client;

describe('createDatabase', () => {
  it('opens an in-memory PGlite database when configured', async () => {
    const database = createDatabase({ driver: 'pglite' });
    const result = await database.db.execute(sql`select 1 as one`);
    expect(result.rows[0]).toEqual({ one: 1 });
    await database.close();
  });

  it('rejects an unknown driver without echoing the configuration', () => {
    const bad = { driver: 'sqlite', url: 'postgres://user:secret@host/db' };
    expect(() => createDatabase(bad as never)).toThrow(/sqlite/);
    expect(() => createDatabase(bad as never)).not.toThrow(/secret/);
  });
});

describe.each(testTargets)('shared Database type on $name', (target) => {
  it('supports insert ... returning()', async () => {
    const { database, cleanup } = await createMigratedDatabase(target);
    try {
      const id = newId();
      const [row] = await database.db
        .insert(installation)
        .values({ id, baseUrl: 'https://osfpm.example.test' })
        .returning();
      expect(row?.id).toBe(id);
      expect(row?.baseUrl).toBe('https://osfpm.example.test');
    } finally {
      await cleanup();
    }
  });
});

describe('the PostgreSQL pool', () => {
  it('has an error listener, so a failing idle connection cannot crash the process', async () => {
    // The pool connects only when it is used, so nothing listens on this port.
    const database = createDatabase({
      driver: 'postgres',
      url: 'postgres://osfpm:secret-password@127.0.0.1:1/osfpm',
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // With no listener, emitting 'error' throws it, as Node does for an
      // idle client that fails.
      expect(() =>
        poolOf(database).emit(
          'error',
          new TypeError('boom at 127.0.0.1 with secret-password'),
        ),
      ).not.toThrow();
      expect(logged).toHaveBeenCalledTimes(1);
      const line = logged.mock.calls[0]!.join(' ');
      expect(line).toContain('TypeError');
      for (const forbidden of ['boom', '127.0.0.1', 'secret-password']) {
        expect(line).not.toContain(forbidden);
      }
    } finally {
      logged.mockRestore();
      await database.close();
    }
  });
});

/**
 * A real idle connection that the server ends. Only a server can do that, so
 * the test runs on PostgreSQL and is skipped on PGlite.
 */
describe.skipIf(postgres === undefined)(
  'an idle PostgreSQL connection that the server ends, on PostgreSQL',
  () => {
    const pidOf = async (database: Database) => {
      const result = await database.db.execute<{ pid: number }>(
        sql`select pg_backend_pid() as pid`,
      );
      return Number((result as { rows: { pid: number }[] }).rows[0]!.pid);
    };

    it('is logged by class only, does not crash the process, and the pool recovers', async () => {
      const url = process.env.DATABASE_URL!;
      const database = createDatabase({ driver: 'postgres', url });
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        // One query leaves one idle client in the pool.
        const before = await pidOf(database);

        // End that backend from a second connection. Only its own pid.
        const killer = new pg.Client({ connectionString: url });
        await killer.connect();
        try {
          await killer.query('select pg_terminate_backend($1)', [before]);
        } finally {
          await killer.end();
        }

        // Without a listener this error is thrown and the test run fails.
        await vi.waitFor(() => expect(logged).toHaveBeenCalled(), 10_000);
        const line = logged.mock.calls[0]!.join(' ');
        expect(line).toMatch(/Error/);
        expect(line).not.toMatch(/terminating|administrator|postgres:\/\//);

        // The pool dropped the broken client and opens a new one.
        const after = await pidOf(database);
        expect(after).not.toBe(before);
      } finally {
        logged.mockRestore();
        await database.close();
      }
    });
  },
);
