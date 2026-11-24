import { describe, expect, it, vi } from 'vitest';
import { createDatabase } from '@osfpm/core/src/db/client.js';
import {
  DatabaseInUseError,
  type InUseMarker,
} from '@osfpm/core/src/db/in-use.js';
import { buildApp } from './app.js';
import { TEST_KEYS_DIR, TEST_PUBLIC_ORIGIN } from './test-support.js';
import {
  runStartup,
  StartupAbortedError,
  type StartupSteps,
} from './startup.js';

/**
 * How start-up treats the marker that says the database is in use: it takes it
 * before anything else, and waits, as it does for an unreachable database, while
 * an admin command that needs every server stopped holds it. The marker is a
 * stand-in here, so the order and the waiting are seen without a second process;
 * `admin/in-use.test.ts` runs the real one.
 */
function makeApp() {
  const lines: string[] = [];
  const database = createDatabase({ driver: 'pglite' });
  const app = buildApp({
    db: database,
    publicOrigin: TEST_PUBLIC_ORIGIN,
    logger: {
      level: 'info',
      stream: { write: (line) => void lines.push(line) },
    },
  });
  return {
    app,
    records: () =>
      lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    close: async () => {
      await app.close();
      await database.close();
    },
  };
}

const nothing: StartupSteps['syncPermissions'] = () => Promise.resolve();

describe('start-up and the in-use marker', () => {
  it('takes the marker first, before the migrations and the permission sync', async () => {
    const { app, close } = makeApp();
    try {
      const order: string[] = [];
      const inUse: InUseMarker = {
        attach: () => {
          order.push('marker');
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
      };

      await runStartup(
        app,
        { autoMigrate: true, keysDir: TEST_KEYS_DIR, inUse },
        {
          migrate: () => {
            order.push('migrate');
            return Promise.resolve();
          },
          syncPermissions: () => {
            order.push('sync');
            return Promise.resolve();
          },
        },
      );

      expect(order.slice(0, 2)).toEqual(['marker', 'migrate']);
      expect(order.indexOf('sync')).toBeGreaterThan(1);
    } finally {
      await close();
    }
  });

  it('waits while an admin command holds the database, says so once for each attempt, and goes on when it is over', async () => {
    const { app, records, close } = makeApp();
    try {
      let refusals = 3;
      const inUse: InUseMarker = {
        attach: () =>
          refusals-- > 0
            ? Promise.reject(new DatabaseInUseError('postgres', 'server'))
            : Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const delays: number[] = [];
      const migrate = vi.fn(() => Promise.resolve());

      await runStartup(
        app,
        { autoMigrate: true, keysDir: TEST_KEYS_DIR, inUse },
        { migrate, syncPermissions: nothing },
        {
          retry: {
            initialMs: 100,
            maxMs: 250,
            sleep: (ms) => {
              delays.push(ms);
              return Promise.resolve();
            },
          },
        },
      );

      // The same doubling as for an unreachable database, up to the same cap.
      expect(delays).toEqual([100, 200, 250]);
      expect(migrate).toHaveBeenCalledTimes(1);
      const waiting = records().filter(
        (record) =>
          record.msg === 'an admin command is using the database, waiting',
      );
      expect(waiting.map((record) => record.attempt)).toEqual([1, 2, 3]);
      // Nothing about the command, the database or the connection.
      expect(Object.keys(waiting[0]!).sort()).toEqual(
        [
          'attempt',
          'hostname',
          'level',
          'msg',
          'pid',
          'retryInMs',
          'time',
        ].sort(),
      );
      expect(app.readiness.isReady()).toBe(true);
    } finally {
      await close();
    }
  });

  it('is ended by a stop signal while it waits, as a wait for an unreachable database is', async () => {
    const { app, close } = makeApp();
    try {
      const stop = new AbortController();
      const inUse: InUseMarker = {
        attach: () =>
          Promise.reject(new DatabaseInUseError('postgres', 'server')),
        close: () => Promise.resolve(),
      };

      const started = runStartup(
        app,
        { autoMigrate: true, keysDir: TEST_KEYS_DIR, inUse },
        { migrate: () => Promise.resolve(), syncPermissions: nothing },
        {
          signal: stop.signal,
          retry: {
            initialMs: 60_000,
            maxMs: 60_000,
            // The real wait, which the signal cuts short.
          },
        },
      );
      setTimeout(() => stop.abort(), 50);

      await expect(started).rejects.toBeInstanceOf(StartupAbortedError);
      expect(app.readiness.isReady()).toBe(false);
    } finally {
      await close();
    }
  });

  it('does not wait for an error that is not about the marker', async () => {
    const { app, close } = makeApp();
    try {
      const inUse: InUseMarker = {
        attach: () => Promise.reject(new Error('not about the marker')),
        close: () => Promise.resolve(),
      };

      await expect(
        runStartup(
          app,
          { autoMigrate: true, keysDir: TEST_KEYS_DIR, inUse },
          { migrate: () => Promise.resolve(), syncPermissions: nothing },
        ),
      ).rejects.toThrow('not about the marker');
    } finally {
      await close();
    }
  });
});
