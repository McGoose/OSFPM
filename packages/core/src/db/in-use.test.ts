import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createDatabase, type Database } from './client.js';
import {
  DatabaseInUseError,
  markDatabaseInUse,
  PGLITE_LOCK_FILE,
  type InUseRole,
} from './in-use.js';
import {
  createMigratedDatabase,
  endInUseHolders,
  inUseHolders,
  testTargets,
} from './test-support.js';

const ROLES: readonly InUseRole[] = [
  'server',
  'offline-command',
  'online-command',
  'read-only-command',
];

/** What a command line holds for another process: one that sleeps until it is killed. */
function sleepingProcess(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
}

/**
 * A port of this machine that nothing listens on: the system picks a free one, which is
 * then given back. A fixed port could be taken by something the machine runs.
 */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

/** The number of a process that has run and ended, so no process has it now. */
async function deadProcessNumber(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid!;
}

describe('the lock file of a PGlite data directory', () => {
  let root: string;
  let dataDir: string;
  const children: ChildProcess[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'osfpm-in-use-'));
    dataDir = join(root, 'data');
    mkdirSync(dataDir);
  });
  afterEach(() => {
    for (const child of children.splice(0)) child.kill();
    rmSync(root, { recursive: true, force: true });
  });

  const lockFile = () => join(dataDir, PGLITE_LOCK_FILE);
  const config = () => ({ driver: 'pglite', dataDir }) as const;
  /** A database that notes when it is closed, and whether the lock file was still there. */
  function fakeDatabase(events: string[]): Database {
    return {
      driver: 'pglite',
      db: {},
      close: () => {
        events.push(existsSync(lockFile()) ? 'closed, lock held' : 'closed');
        return Promise.resolve();
      },
    } as unknown as Database;
  }

  it.each(ROLES)(
    'is taken by a %s with its process number, and removed when it closes',
    async (role) => {
      const marker = markDatabaseInUse(config(), role);
      await marker.attach();

      expect(readFileSync(lockFile(), 'utf8').trim()).toBe(String(process.pid));

      await marker.close();
      expect(existsSync(lockFile())).toBe(false);
    },
  );

  it('is removed after the database has been closed, never before', async () => {
    const events: string[] = [];
    const marker = markDatabaseInUse(config(), 'server');

    await marker.close(fakeDatabase(events));

    expect(events).toEqual(['closed, lock held']);
    expect(existsSync(lockFile())).toBe(false);
  });

  it('is safe to close twice, and the second close does not remove a file that is not ours any more', async () => {
    const marker = markDatabaseInUse(config(), 'offline-command');
    await marker.close();
    const other = sleepingProcess();
    children.push(other);
    writeFileSync(lockFile(), `${other.pid}\n`);

    await marker.close();

    expect(readFileSync(lockFile(), 'utf8').trim()).toBe(String(other.pid));
  });

  it('is made, with its directory, by a server on a first start', async () => {
    const fresh = join(root, 'not', 'there', 'yet');

    const marker = markDatabaseInUse(
      { driver: 'pglite', dataDir: fresh },
      'server',
    );

    expect(existsSync(join(fresh, PGLITE_LOCK_FILE))).toBe(true);
    await marker.close();
  });

  it.each(['offline-command', 'online-command', 'read-only-command'] as const)(
    'is not made by a %s for a directory that is not there: a mistyped path never makes a database',
    (role) => {
      const missing = join(root, 'mistyped');

      expect(() =>
        markDatabaseInUse({ driver: 'pglite', dataDir: missing }, role),
      ).toThrow(expect.objectContaining({ code: 'ENOENT' }) as Error);
      expect(existsSync(missing)).toBe(false);
    },
  );

  it.each(ROLES)(
    'refuses a %s while another running process holds it, and says which process and which file',
    (role) => {
      const other = sleepingProcess();
      children.push(other);
      writeFileSync(lockFile(), `${other.pid}\n`);

      const error = (() => {
        try {
          markDatabaseInUse(config(), role);
        } catch (caught) {
          return caught;
        }
        throw new Error('expected a refusal');
      })() as DatabaseInUseError;

      expect(error).toBeInstanceOf(DatabaseInUseError);
      expect(error).toMatchObject({
        driver: 'pglite',
        role,
        lock: { file: lockFile(), pid: other.pid },
      });
      expect(error.message).toContain(`process ${other.pid}`);
      expect(error.message).toContain(lockFile());
      // The other process still has it.
      expect(readFileSync(lockFile(), 'utf8').trim()).toBe(String(other.pid));
    },
  );

  it('refuses a process that finds its own number in the file, as it is not a leftover', () => {
    const first = markDatabaseInUse(config(), 'server');

    expect(() => markDatabaseInUse(config(), 'read-only-command')).toThrow(
      DatabaseInUseError,
    );
    void first.close();
  });

  it('replaces a file that carries this process’s own number but that this process did not make, as a restarted container leaves one', async () => {
    // A killed container leaves its file, and the next container's first process
    // has the same number.
    writeFileSync(lockFile(), `${process.pid}\n`);

    const marker = markDatabaseInUse(config(), 'server');

    expect(readFileSync(lockFile(), 'utf8').trim()).toBe(String(process.pid));
    await marker.close();
    expect(existsSync(lockFile())).toBe(false);
  });

  it('replaces a leftover whose process is gone', async () => {
    writeFileSync(lockFile(), `${await deadProcessNumber()}\n`);

    const marker = markDatabaseInUse(config(), 'offline-command');

    expect(readFileSync(lockFile(), 'utf8').trim()).toBe(String(process.pid));
    await marker.close();
    expect(existsSync(lockFile())).toBe(false);
  });

  it('does not take a file that holds no process number for a leftover while it is new, and does once it is old', async () => {
    // A starting process creates the file before it writes its number.
    writeFileSync(lockFile(), '');
    expect(() => markDatabaseInUse(config(), 'server')).toThrow(
      DatabaseInUseError,
    );

    const old = new Date(Date.now() - 60_000);
    utimesSync(lockFile(), old, old);
    const marker = markDatabaseInUse(config(), 'server');

    expect(readFileSync(lockFile(), 'utf8').trim()).toBe(String(process.pid));
    await marker.close();
  });

  it.each(['0', '-1', '12abc', '99999999999999999999'])(
    'treats %s as no process number, and so as a leftover once the file is old',
    async (text) => {
      writeFileSync(lockFile(), text);
      const old = new Date(Date.now() - 60_000);
      utimesSync(lockFile(), old, old);

      const marker = markDatabaseInUse(config(), 'server');

      expect(readFileSync(lockFile(), 'utf8').trim()).toBe(String(process.pid));
      await marker.close();
    },
  );

  it('takes nothing for a data directory that is a URL, such as memory://', async () => {
    const marker = markDatabaseInUse(
      { driver: 'pglite', dataDir: 'memory://' },
      'server',
    );
    const events: string[] = [];

    await marker.attach();
    await marker.close(fakeDatabase(events));

    expect(events).toEqual(['closed']);
    expect(existsSync(join(process.cwd(), 'memory:'))).toBe(false);
  });

  it('takes nothing for a database with no data directory', async () => {
    const marker = markDatabaseInUse({ driver: 'pglite' }, 'server');
    await marker.attach();
    await marker.close();
  });
});

describe('which roles take the PostgreSQL lock', () => {
  // A port of this machine where nothing listens: a role that tries to take the lock
  // opens a connection and is refused, so what the marker does shows without a server.
  let url: string;
  beforeAll(async () => {
    url = `postgres://osfpm:none@127.0.0.1:${await closedPort()}/none`;
  });
  const config = () => ({ driver: 'postgres', url }) as const;

  it.each(['online-command', 'read-only-command'] as const)(
    'takes none for the %s role, which runs beside servers: it never opens the lock connection',
    async (role) => {
      const marker = markDatabaseInUse(config(), role);

      await expect(marker.attach()).resolves.toBeUndefined();
      await marker.close();
    },
  );

  it.each(['server', 'offline-command'] as const)(
    'takes it for the %s role, which is what makes the case above prove something',
    async (role) => {
      const marker = markDatabaseInUse(config(), role);

      await expect(marker.attach()).rejects.toMatchObject({
        code: 'ECONNREFUSED',
      });
      await marker.close();
    },
  );
});

/** The PostgreSQL target, when `DATABASE_URL` names a server. PGlite has one connection and one process. */
const postgres = testTargets.find((target) => target.name === 'postgres');

describe.skipIf(postgres === undefined)(
  'the in-use marker on PostgreSQL',
  () => {
    let database: Database;
    let url: string;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      const created = await createMigratedDatabase(postgres!);
      database = created.database;
      cleanup = created.cleanup;
      url = created.url!;
    });
    afterEach(async () => {
      await cleanup();
    });

    // Each marker has a connection of its own, so two markers are two processes as
    // far as the database can tell.
    const config = () => ({ driver: 'postgres', url }) as const;
    const holders = () => inUseHolders(database.db);

    it('lets any number of servers hold it together', async () => {
      const a = markDatabaseInUse(config(), 'server');
      const b = markDatabaseInUse(config(), 'server');

      await a.attach();
      await b.attach();

      expect(await holders()).toBe(2);
      await a.close();
      await b.close();
    });

    it('refuses a command while a server holds it, and tells the operator to stop every server', async () => {
      const server = markDatabaseInUse(config(), 'server');
      await server.attach();
      const command = markDatabaseInUse(config(), 'offline-command');

      const error = await command.attach().then(
        () => undefined,
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(DatabaseInUseError);
      expect((error as DatabaseInUseError).message).toBe(
        'A server is using this database. Stop every server, run the command, then start them again.',
      );
      expect(await holders()).toBe(1);
      await command.close();
      await server.close();
    });

    it('refuses a server while a command holds it, which start-up takes for "not ready yet"', async () => {
      const command = markDatabaseInUse(config(), 'offline-command');
      await command.attach();
      const server = markDatabaseInUse(config(), 'server');

      const error = await server.attach().then(
        () => undefined,
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(DatabaseInUseError);
      expect(error).toMatchObject({ driver: 'postgres', role: 'server' });
      await server.close();
      await command.close();
    });

    it('refuses a second command while one runs', async () => {
      const one = markDatabaseInUse(config(), 'offline-command');
      await one.attach();
      const two = markDatabaseInUse(config(), 'offline-command');

      await expect(two.attach()).rejects.toBeInstanceOf(DatabaseInUseError);
      await two.close();
      await one.close();
    });

    it.each(['online-command', 'read-only-command'] as const)(
      'takes nothing for the %s role, which runs beside a server and beside a command',
      async (role) => {
        const server = markDatabaseInUse(config(), 'server');
        await server.attach();
        const beside = markDatabaseInUse(config(), role);
        await beside.attach();
        expect(await holders()).toBe(1);

        await server.close();
        const command = markDatabaseInUse(config(), 'offline-command');
        await command.attach();
        await beside.attach();
        expect(await holders()).toBe(1);

        await beside.close();
        await command.close();
      },
    );

    it('lets the next one in as soon as the holder has closed, and lets go of the lock itself', async () => {
      const command = markDatabaseInUse(config(), 'offline-command');
      await command.attach();
      await command.close();
      expect(await holders()).toBe(0);

      const server = markDatabaseInUse(config(), 'server');
      await server.attach();
      expect(await holders()).toBe(1);
      await server.close();
      expect(await holders()).toBe(0);
    });

    it('holds one lock however often it is attached, and gives it back when closed along with the database', async () => {
      const own = createDatabase({ driver: 'postgres', url });
      const server = markDatabaseInUse(config(), 'server');

      await server.attach();
      await server.attach();
      expect(await holders()).toBe(1);

      await server.close(own);
      expect(await holders()).toBe(0);
    });

    it('reports a connection that ended once, with the error, without a crash, and is no longer in the way of a command', async () => {
      const onLost = vi.fn<(error: Error) => void>();
      const server = markDatabaseInUse(config(), 'server', { onLost });
      await server.attach();
      expect(await holders()).toBe(1);

      // Another session ends the one that holds the lock, as a database restart would.
      expect(await endInUseHolders(database.db)).toBe(1);
      await vi.waitFor(() => expect(onLost).toHaveBeenCalled(), 5_000);

      // The lock went with the connection, so a command is no longer kept out.
      expect(await holders()).toBe(0);
      const command = markDatabaseInUse(config(), 'offline-command');
      await command.attach();
      await command.close();
      // Giving up a lost marker does not throw, and says nothing more.
      await server.close();
      expect(onLost).toHaveBeenCalledTimes(1);
      expect(onLost.mock.calls[0]![0]).toBeInstanceOf(Error);
    });

    it('does not call onLost for a connection it ends itself', async () => {
      const onLost = vi.fn();
      const server = markDatabaseInUse(config(), 'server', { onLost });
      await server.attach();

      await server.close();
      // Give a late error event the time it would need.
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(onLost).not.toHaveBeenCalled();
    });
  },
);
