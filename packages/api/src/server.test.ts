import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@osfpm/core/src/db/client.js';
import type { Config } from './config.js';
import { startServer } from './server.js';

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
};

/** The URL the started server answers on. */
function baseUrl(server: Awaited<ReturnType<typeof startServer>>): string {
  const address = server.app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The server is not listening on a port');
  }
  return `http://127.0.0.1:${address.port}`;
}

/** Resolves once `fn` has been called, or fails after two seconds. */
const called = (fn: ReturnType<typeof vi.fn>) =>
  vi.waitFor(() => expect(fn).toHaveBeenCalled(), 2_000);

describe('startServer', () => {
  it('listens, and stop() closes the app and then the database', async () => {
    const server = await startServer(config, { signals: new EventEmitter() });
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
      const server = await startServer(config, { signals, exit });
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
    await startServer(config, { signals, exit });

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
    await startServer(config, { signals, exit });

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
    });
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

  it('closes the database and rethrows when the port cannot be bound', async () => {
    const first = await startServer(config, { signals: new EventEmitter() });
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
