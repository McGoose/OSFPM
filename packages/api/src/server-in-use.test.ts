import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createDatabase } from '@osfpm/core/src/db/client.js';
import {
  DatabaseInUseError,
  markDatabaseInUse,
  PGLITE_LOCK_FILE,
} from '@osfpm/core/src/db/in-use.js';
import {
  createMigratedDatabase,
  inUseHolders,
  testTargets,
} from '@osfpm/core/src/db/test-support.js';
import { createTestKeyDirectory } from '@osfpm/core/src/keys/test-support.js';
import type { Config } from './config.js';
import { describeStartupFailure, startServer } from './server.js';
import type { StartupSteps } from './startup.js';

/**
 * What a server does about the marker that says its database is in use: a PGlite
 * data directory is never opened by two servers, and on PostgreSQL the server
 * holds the shared advisory lock for its whole life and waits while an admin
 * command holds it exclusively. The steps are swapped for ones that do nothing,
 * because the start-up work is not what is under test.
 */
const keyDirectory = createTestKeyDirectory();
afterAll(() => keyDirectory.remove());

const BASE: Omit<Config, 'database'> = {
  keysDir: keyDirectory.dir,
  host: '127.0.0.1',
  port: 0,
  logLevel: 'silent',
  publicOrigin: 'http://localhost:3000',
  autoMigrate: true,
  trustedProxies: [],
};

const NO_WORK: StartupSteps = {
  migrate: () => Promise.resolve(),
  syncPermissions: () => Promise.resolve(),
};

const quiet = { stderr: { write: () => true } };

describe('a server on a PGlite data directory', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'osfpm-server-in-use-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const config = (): Config => ({
    ...BASE,
    database: { driver: 'pglite', dataDir },
  });
  const lockFile = () => join(dataDir, PGLITE_LOCK_FILE);

  it('marks the directory while it runs and lets go when it stops', async () => {
    const server = await startServer(config(), {
      signals: new EventEmitter(),
      startupSteps: NO_WORK,
      ...quiet,
    });
    try {
      await server.ready;
      expect(existsSync(lockFile())).toBe(true);
    } finally {
      await server.stop();
    }
    expect(existsSync(lockFile())).toBe(false);
  });

  it('refuses a second server on the same directory before it opens anything, and says which process has it', async () => {
    const first = await startServer(config(), {
      signals: new EventEmitter(),
      startupSteps: NO_WORK,
      ...quiet,
    });
    try {
      await first.ready;

      const error = await startServer(config(), {
        signals: new EventEmitter(),
        startupSteps: NO_WORK,
        ...quiet,
      }).then(
        () => undefined,
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(DatabaseInUseError);
      expect(describeStartupFailure(error)).toContain(`process ${process.pid}`);
      expect(describeStartupFailure(error)).toContain(lockFile());
      // The refused server did not take the first one's lock with it.
      expect(existsSync(lockFile())).toBe(true);
    } finally {
      await first.stop();
    }
    await expect(
      startServer(config(), {
        signals: new EventEmitter(),
        startupSteps: NO_WORK,
        ...quiet,
      }).then((again) => again.stop()),
    ).resolves.toBeUndefined();
  });

  it('lets go of the directory when it fails to start, for example because its port is taken', async () => {
    const first = await startServer(config(), {
      signals: new EventEmitter(),
      startupSteps: NO_WORK,
      ...quiet,
    });
    try {
      await first.ready;
      const address = first.app.server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const other = mkdtempSync(join(tmpdir(), 'osfpm-server-in-use-'));
      try {
        await expect(
          startServer(
            {
              ...BASE,
              port,
              database: { driver: 'pglite', dataDir: other },
            },
            { signals: new EventEmitter(), startupSteps: NO_WORK, ...quiet },
          ),
        ).rejects.toThrow();
        expect(existsSync(join(other, PGLITE_LOCK_FILE))).toBe(false);
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    } finally {
      await first.stop();
    }
  });
});

/** The PostgreSQL target, when `DATABASE_URL` names a server. */
const postgres = testTargets.find((target) => target.name === 'postgres');

describe.skipIf(postgres === undefined)('a server on PostgreSQL', () => {
  let url: string;
  let cleanup: () => Promise<void>;
  let holders: () => Promise<number>;

  beforeEach(async () => {
    const created = await createMigratedDatabase(postgres!);
    url = created.url!;
    cleanup = created.cleanup;
    holders = () => inUseHolders(created.database.db);
  });
  afterEach(async () => {
    await cleanup();
  });

  const config = (): Config => ({
    ...BASE,
    database: { driver: 'postgres', url },
  });

  it('holds the shared lock while it runs and gives it back when it stops, so a stopped server never blocks a command', async () => {
    const server = await startServer(config(), {
      signals: new EventEmitter(),
      startupSteps: NO_WORK,
      ...quiet,
    });
    await server.ready;
    expect(await holders()).toBe(1);

    await server.stop();

    expect(await holders()).toBe(0);
  });

  it('is refused by a command that needs every server stopped, for as long as it runs', async () => {
    const server = await startServer(config(), {
      signals: new EventEmitter(),
      startupSteps: NO_WORK,
      ...quiet,
    });
    try {
      await server.ready;
      const command = markDatabaseInUse(
        { driver: 'postgres', url },
        'offline-command',
      );

      await expect(command.attach(server.database)).rejects.toBeInstanceOf(
        DatabaseInUseError,
      );
      await command.close();
    } finally {
      await server.stop();
    }
  });

  it('waits while an admin command holds the database, then starts, and then keeps a command out', async () => {
    const lines: string[] = [];
    const command = markDatabaseInUse(
      { driver: 'postgres', url },
      'offline-command',
    );
    // The command's own connection pool, the one a second process would have.
    const commandDatabase = createDatabase({ driver: 'postgres', url });
    await command.attach(commandDatabase);

    const server = await startServer(
      { ...config(), logLevel: 'info' },
      {
        signals: new EventEmitter(),
        startupSteps: NO_WORK,
        startupRetry: { initialMs: 20, maxMs: 40 },
        logStream: { write: (line: string) => void lines.push(line) },
        ...quiet,
      },
    );
    try {
      await vi.waitFor(
        () =>
          expect(
            lines.some((line) =>
              line.includes('an admin command is using the database'),
            ),
          ).toBe(true),
        5_000,
      );
      expect(server.app.readiness.isReady()).toBe(false);
      expect(await holders()).toBe(1);
      // The line says an admin command is running, and nothing of the database.
      const text = lines.join('');
      expect(text).not.toContain(new URL(url).pathname.slice(1));
      expect(text).not.toContain('postgres://');

      await command.close(commandDatabase);
      await server.ready;

      expect(server.app.readiness.isReady()).toBe(true);
      expect(await holders()).toBe(1);
    } finally {
      await server.stop();
    }
  });
});
