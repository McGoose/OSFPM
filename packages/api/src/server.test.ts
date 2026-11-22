import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { PERMISSION_LISTS } from '@osfpm/core/src/access/permission-lists.js';
import {
  PermissionSyncError,
  syncPermissions,
} from '@osfpm/core/src/access/permission-sync.js';
import { createSession } from '@osfpm/core/src/auth/sessions.js';
import { seedActiveUser } from '@osfpm/core/src/auth/test-support.js';
import type { Database } from '@osfpm/core/src/db/client.js';
import { migrate } from '@osfpm/core/src/db/migrate.js';
import { permission } from '@osfpm/core/src/db/schema/index.js';
import type { Config } from './config.js';
import { SESSION_COOKIE } from './auth/cookie.js';
import { describeStartupFailure, startServer } from './server.js';
import { StartupAbortedError, type StartupSteps } from './startup.js';

const opened = vi.hoisted(() => [] as Database[]);

// The real `createDatabase`, with each handle it returns noted, so a test can
// check that a server which failed to start closed its database.
vi.mock('@osfpm/core/src/db/client.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@osfpm/core/src/db/client.js')>();
  return {
    ...original,
    createDatabase: ((
      config: Parameters<typeof original.createDatabase>[0],
    ) => {
      const database = original.createDatabase(config);
      opened.push(database);
      return database;
    }) as typeof original.createDatabase,
  };
});

const config: Config = {
  database: { driver: 'pglite', dataDir: 'memory://' },
  host: '127.0.0.1',
  port: 0,
  logLevel: 'silent',
  publicOrigin: 'http://localhost:3000',
  autoMigrate: true,
  trustedProxies: [],
};

/**
 * Where the setup code goes in these tests: nowhere. A server that starts with
 * the real steps prints the code to standard error, which would fill the test
 * output; `first-run-startup.test.ts` reads it.
 */
const quiet = { stderr: { write: () => true } };

/** The URL the started server answers on. */
function baseUrl(server: Awaited<ReturnType<typeof startServer>>): string {
  const address = server.app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The server is not listening on a port');
  }
  return `http://127.0.0.1:${address.port}`;
}

/** A promise that is settled from outside, to hold a step half way. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** The error Node gives for a database that refuses the connection. */
const refused = () =>
  Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:5432'), {
    code: 'ECONNREFUSED',
  });

/** The records of a log, parsed. */
const parsed = (lines: string[]) =>
  lines.map((line) => JSON.parse(line) as Record<string, unknown>);

/** Resolves once `fn` has been called, or fails after two seconds. */
const called = (fn: ReturnType<typeof vi.fn>) =>
  vi.waitFor(() => expect(fn).toHaveBeenCalled(), 2_000);

describe('startServer', () => {
  it('listens, and stop() closes the app and then the database', async () => {
    const server = await startServer(config, {
      signals: new EventEmitter(),
      ...quiet,
    });
    await server.ready;
    const url = baseUrl(server);
    expect((await fetch(`${url}/nowhere`)).status).toBe(404);

    await server.stop();

    await expect(fetch(`${url}/nowhere`)).rejects.toThrow();
    await expect(server.database.db.execute('select 1')).rejects.toThrow();
  });

  it.each(['SIGTERM', 'SIGINT'] as const)(
    'on %s stops accepting requests, closes the app and the database, and exits 0',
    async (signal) => {
      const signals = new EventEmitter();
      const exit = vi.fn();
      const server = await startServer(config, { signals, exit, ...quiet });
      await server.ready;
      const url = baseUrl(server);

      signals.emit(signal);
      await called(exit);

      expect(exit).toHaveBeenCalledExactlyOnceWith(0);
      await expect(fetch(`${url}/nowhere`)).rejects.toThrow();
      await expect(server.database.db.execute('select 1')).rejects.toThrow();
    },
  );

  it('shuts down once when a second signal arrives during shutdown', async () => {
    const signals = new EventEmitter();
    const exit = vi.fn();
    const server = await startServer(config, { signals, exit, ...quiet });
    await server.ready;

    signals.emit('SIGINT');
    signals.emit('SIGTERM');
    await called(exit);
    // Give a second shutdown time to show itself, if there were one.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('keeps listening for stop signals during shutdown, so a second one cannot kill the process half way', async () => {
    const signals = new EventEmitter();
    const exit = vi.fn();
    const server = await startServer(config, { signals, exit, ...quiet });
    await server.ready;

    signals.emit('SIGTERM');
    await called(exit);

    // With no listener left, Node would restore the default action and the
    // next signal would end the process before the database is closed.
    expect(signals.listenerCount('SIGTERM')).toBeGreaterThan(0);
    expect(signals.listenerCount('SIGINT')).toBeGreaterThan(0);
  });

  it('exits 1 when shutdown takes longer than the limit', async () => {
    const signals = new EventEmitter();
    const exit = vi.fn();
    const server = await startServer(config, {
      signals,
      exit,
      shutdownTimeoutMs: 100,
      ...quiet,
    });
    await server.ready;
    // A database that never finishes closing, as a stuck query would cause.
    const realClose = server.database.close;
    Object.assign(server.database, {
      close: () => new Promise<void>(() => {}),
    });
    try {
      signals.emit('SIGTERM');
      await called(exit);
      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    } finally {
      await realClose();
    }
  });

  it('fails to start, without crashing the process, when the PGlite data directory cannot be opened', async () => {
    // A file where a directory should be.
    const notADirectory = fileURLToPath(
      new URL('../package.json', import.meta.url),
    );
    await expect(
      startServer(
        { ...config, database: { driver: 'pglite', dataDir: notADirectory } },
        { signals: new EventEmitter() },
      ),
    ).rejects.toThrow();
    // An unhandled rejection from PGlite's start-up shows up a moment later and
    // fails the whole test run.
    await new Promise((resolve) => setTimeout(resolve, 300));
  });

  it('serves the session routes over HTTP once it has started: me, then logout, then the old cookie is refused', async () => {
    const server = await startServer(config, {
      signals: new EventEmitter(),
      ...quiet,
    });
    try {
      await server.ready;
      // The installation row is there already: start-up made it.
      const userId = await seedActiveUser(server.database);
      const { token } = await createSession(server.database.db, {
        userId,
        method: 'password',
        now: new Date(),
      });
      const url = baseUrl(server);
      const cookie = `${SESSION_COOKIE}=${token}`;

      const me = await fetch(`${url}/api/v1/auth/me`, {
        headers: { cookie },
      });
      expect(me.status).toBe(200);
      expect(((await me.json()) as { id: string }).id).toBe(userId);
      expect((await fetch(`${url}/api/v1/auth/me`)).status).toBe(401);

      // The Origin a browser would send from the configured public URL.
      const out = await fetch(`${url}/api/v1/auth/logout`, {
        method: 'POST',
        headers: { cookie, origin: config.publicOrigin },
      });
      expect(out.status).toBe(204);
      expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
      const after = await fetch(`${url}/api/v1/auth/me`, {
        headers: { cookie },
      });
      expect(after.status).toBe(401);
    } finally {
      await server.stop();
    }
  });

  describe('start-up', () => {
    it('migrates and syncs the permissions, and then answers ready', async () => {
      const server = await startServer(config, {
        signals: new EventEmitter(),
        ...quiet,
      });
      try {
        await server.ready;
        const response = await fetch(`${baseUrl(server)}/api/v1/health/ready`);
        expect(response.status).toBe(200);
        const rows = await server.database.db
          .select({ key: permission.key })
          .from(permission);
        expect(rows).toHaveLength(
          PERMISSION_LISTS.reduce((total, list) => total + list.length, 0),
        );
      } finally {
        await server.stop();
      }
    });

    it('listens first: /health answers while start-up is held, every other route is a 503 problem "starting", and all of them open when it is done', async () => {
      const release = deferred();
      const server = await startServer(config, {
        signals: new EventEmitter(),
        startupSteps: {
          migrate: async (database) => {
            await release.promise;
            await migrate(database);
          },
          syncPermissions,
        },
      });
      try {
        const api = `${baseUrl(server)}/api/v1`;
        expect((await fetch(`${api}/health`)).status).toBe(200);
        expect((await fetch(`${api}/health/ready`)).status).toBe(503);
        for (const path of ['/meta', '/openapi.json', '/auth/me']) {
          const held = await fetch(`${api}${path}`);
          expect(held.status, path).toBe(503);
          expect(held.headers.get('content-type')).toMatch(
            /^application\/problem\+json/,
          );
          expect(((await held.json()) as { code: string }).code).toBe(
            'starting',
          );
        }

        release.resolve();
        await server.ready;
        expect((await fetch(`${api}/health/ready`)).status).toBe(200);
        expect((await fetch(`${api}/meta`)).status).toBe(200);
        expect((await fetch(`${api}/auth/me`)).status).toBe(401);
      } finally {
        await server.stop();
      }
    });

    it('runs no migration when autoMigrate is off', async () => {
      const steps: StartupSteps = {
        migrate: vi.fn(() => Promise.resolve()),
        syncPermissions: vi.fn(() => Promise.resolve()),
      };
      const server = await startServer(
        { ...config, autoMigrate: false },
        { signals: new EventEmitter(), startupSteps: steps },
      );
      try {
        await server.ready;
        expect(steps.migrate).not.toHaveBeenCalled();
        expect(steps.syncPermissions).toHaveBeenCalledTimes(
          PERMISSION_LISTS.length,
        );
      } finally {
        await server.stop();
      }
    });

    it('keeps retrying while the database is unreachable, stays 503 until it answers, and logs one line per attempt', async () => {
      const lines: string[] = [];
      const answers = deferred();
      let failures = 2;
      const server = await startServer(
        { ...config, logLevel: 'info' },
        {
          signals: new EventEmitter(),
          logStream: { write: (line) => void lines.push(line) },
          // A millisecond or two between attempts: only the order matters here.
          startupRetry: { initialMs: 1, maxMs: 2 },
          startupSteps: {
            migrate: async () => {
              if (failures-- > 0) throw refused();
              await answers.promise;
            },
            syncPermissions: () => Promise.resolve(),
          },
        },
      );
      try {
        const api = `${baseUrl(server)}/api/v1`;
        const retryLines = () =>
          parsed(lines).filter(
            (record) => record.level === 40 && 'attempt' in record,
          );
        // Two refusals have been logged, and the third attempt is waiting.
        await vi.waitFor(() => expect(retryLines()).toHaveLength(2), 2_000);
        expect((await fetch(`${api}/health/ready`)).status).toBe(503);
        expect((await fetch(`${api}/meta`)).status).toBe(503);

        answers.resolve();
        await server.ready;
        expect((await fetch(`${api}/health/ready`)).status).toBe(200);
        expect((await fetch(`${api}/meta`)).status).toBe(200);

        expect(retryLines().map((line) => line.attempt)).toEqual([1, 2]);
        expect(lines.join('')).not.toContain('10.1.2.3');
        // Retrying is not a failure to start.
        expect(parsed(lines).filter((record) => record.level === 60)).toEqual(
          [],
        );
      } finally {
        await server.stop();
      }
    });

    it('stops retrying when the server is stopped: no failure is logged, the database is closed', async () => {
      const lines: string[] = [];
      const server = await startServer(
        { ...config, logLevel: 'info' },
        {
          signals: new EventEmitter(),
          logStream: { write: (line) => void lines.push(line) },
          // A minute, so only stopping can end the wait.
          startupRetry: { initialMs: 60_000, maxMs: 60_000 },
          startupSteps: {
            migrate: () => Promise.reject(refused()),
            syncPermissions: () => Promise.resolve(),
          },
        },
      );
      await vi.waitFor(
        () => expect(lines.join('')).toContain('retrying'),
        2_000,
      );
      await server.stop();

      await expect(server.ready).rejects.toBeInstanceOf(StartupAbortedError);
      await expect(server.database.db.execute('select 1')).rejects.toThrow();
      expect(parsed(lines).filter((record) => record.level === 60)).toEqual([]);
    });

    it('fails with the PermissionSyncError when retrying cannot cure it: the server keeps answering 503 "starting", logs the class name only, and closes its database when stopped', async () => {
      const conflict = new PermissionSyncError([
        {
          permissionKey: 'sensitive:read:medical',
          roles: [
            { organisationId: 'org-id', roleKey: 'admin', removed: false },
          ],
        },
      ]);
      const lines: string[] = [];
      const server = await startServer(
        { ...config, logLevel: 'info' },
        {
          signals: new EventEmitter(),
          logStream: { write: (line) => void lines.push(line) },
          startupSteps: {
            migrate: () => Promise.resolve(),
            syncPermissions: () => Promise.reject(conflict),
          },
        },
      );
      try {
        await expect(server.ready).rejects.toBe(conflict);
        // Still listening, and still not open: the entry decides what to do.
        const held = await fetch(`${baseUrl(server)}/api/v1/meta`);
        expect(held.status).toBe(503);
        expect(((await held.json()) as { code: string }).code).toBe('starting');
      } finally {
        await server.stop();
      }
      await expect(server.database.db.execute('select 1')).rejects.toThrow();

      // One line, with no request in it, that names the class and nothing else.
      const fatal = parsed(lines).filter((record) => record.level === 60);
      expect(fatal).toHaveLength(1);
      expect(fatal[0]).toMatchObject({
        msg: 'the server could not start',
        err: { type: 'PermissionSyncError' },
      });
      expect(fatal[0]).not.toHaveProperty('requestId');
      const text = lines.join('');
      expect(text).not.toContain('sensitive:read:medical');
      expect(text).not.toContain('org-id');
    });
  });

  it('closes the database and rethrows when the port cannot be bound', async () => {
    const first = await startServer(config, {
      signals: new EventEmitter(),
      ...quiet,
    });
    await first.ready;
    const address = first.app.server.address() as { port: number };
    try {
      await expect(
        startServer(
          { ...config, port: address.port },
          { signals: new EventEmitter() },
        ),
      ).rejects.toThrow();
      const failed = opened.at(-1)!;
      expect(failed).not.toBe(first.database);
      await expect(failed.db.execute('select 1')).rejects.toThrow();
    } finally {
      await first.stop();
    }
  });
});

describe('describeStartupFailure', () => {
  it('gives the message of a PermissionSyncError, and no stack', () => {
    const error = new PermissionSyncError([
      {
        permissionKey: 'sensitive:read:medical',
        roles: [{ organisationId: 'org-id', roleKey: 'admin', removed: false }],
      },
    ]);
    const text = describeStartupFailure(error);
    expect(text).toBe(error.message);
    expect(text).toContain('sensitive:read:medical');
    expect(text).toContain('Remove those grants, then restart');
    expect(text).not.toMatch(/\n\s+at /);
    expect(text).not.toContain('PermissionSyncError');
  });

  it('is generic for any other failure: the class and the system code, never the message', () => {
    const driver = Object.assign(
      new Error('connect ECONNREFUSED postgres://osfpm:hunter2@db.internal'),
      { code: 'ECONNREFUSED' },
    );
    const text = describeStartupFailure(driver);
    expect(text).toContain('could not start');
    expect(text).toContain('Error');
    expect(text).toContain('ECONNREFUSED');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('db.internal');
  });

  it('copes with something that is not an error', () => {
    expect(describeStartupFailure('boom hunter2')).not.toContain('hunter2');
    expect(describeStartupFailure(null)).toContain('could not start');
  });
});
