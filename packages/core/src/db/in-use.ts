import {
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import type { Database, DbConfig } from './client.js';
import { IN_USE_LOCK_KEY } from './migrate.js';

/**
 * Marks a database as in use, so that a command that changes what a running
 * server keeps in memory (the key commands, decision D-64, P-09a1) never runs
 * beside a server, and so that two processes never open one PGlite data
 * directory. One helper, `markDatabaseInUse`, decides what each driver and each
 * kind of process has to do; the server and the admin command line both call it.
 *
 * - **PostgreSQL:** a session-level advisory lock (`IN_USE_LOCK_KEY`) on a
 *   connection of its own that the process keeps, a `pg.Client` outside the pool
 *   (made with the same connection string, so the pool keeps its configured size).
 *   A server holds it *shared* for its whole life, so any number of servers
 *   coexist; a command that needs every server stopped holds it *exclusive* while
 *   it runs. The two exclude each other in both directions, and the database drops
 *   a lock whose process dies. A server whose connection ends loses the lock, and
 *   the server stops (see `onLost`).
 * - **PGlite:** PGlite itself does not refuse a second process on a data
 *   directory (tried with 0.5.16: the second process opened it and ran queries
 *   while the first held it open), so a lock file, `PGLITE_LOCK_FILE`, holds the
 *   number of the process that has the directory. Every role takes it, a
 *   read-only command too, because two processes must never open one directory.
 */

/**
 * What a process does with the database. `server` serves requests and may run
 * beside other servers. `offline-command` changes what a running server holds in
 * memory, so no server may run beside it. `read-only-command` only reads, so on
 * PostgreSQL it runs beside servers (on PGlite it still needs the directory to
 * itself).
 */
export type InUseRole = 'server' | 'offline-command' | 'read-only-command';

/** The name of the lock file inside a PGlite data directory. */
export const PGLITE_LOCK_FILE = 'osfpm.lock';

/**
 * How long a lock file whose content is not a process number is taken to be one
 * a starting process is still writing, rather than a leftover. `writeFileSync`
 * creates the file before it writes the number.
 */
const UNFINISHED_LOCK_MS = 5_000;

/**
 * What the process refused for: another process has the database or its data
 * directory. Carries only the driver, the role that was refused and, for PGlite,
 * the lock file's path and the other process's number: no URL, no setting, no
 * key. A `server` that gets it from the PostgreSQL lock is not failing but early:
 * start-up waits and tries again. Everything else stops the command or the start.
 */
export class DatabaseInUseError extends Error {
  constructor(
    readonly driver: 'postgres' | 'pglite',
    /** The role that could not take the marker. */
    readonly role: InUseRole,
    /** PGlite only: the lock file, and the process that holds it when its number is known. */
    readonly lock?: { readonly file: string; readonly pid?: number },
  ) {
    super(messageFor(driver, role, lock));
    this.name = 'DatabaseInUseError';
  }
}

/** The text the operator reads, fixed for each driver and role. */
function messageFor(
  driver: 'postgres' | 'pglite',
  role: InUseRole,
  lock: { readonly file: string; readonly pid?: number } | undefined,
): string {
  if (driver === 'postgres') {
    return role === 'server'
      ? 'An admin command is using this database. The server waits until it has finished.'
      : 'A server is using this database. Stop every server, run the command, then start them again.';
  }
  const holder =
    lock?.pid === undefined ? 'another process' : `process ${lock.pid}`;
  const remedy =
    lock === undefined
      ? ''
      : ` If no such process is running, delete the lock file ${lock.file}.`;
  return `The PGlite data directory is in use by ${holder}. A data directory is never opened by two processes: stop the server, or wait for the running command to finish, then try again.${remedy}`;
}

/**
 * The lock files this process holds. A file that carries this process's own
 * number is a lock held here only if it is in this set; otherwise it is the
 * leftover of an earlier life of a container that had the same number (the first
 * process of a container is always number 1, and a killed container leaves its
 * file behind), which must not keep a restarted server out for ever.
 */
const heldHere = new Set<string>();

/** The `code` of a system error, such as `EEXIST`, or undefined. */
function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

/** True when a process with this number exists. `EPERM` means it does, and is someone else's. */
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

/**
 * What a lock file holds: the process number, or null when the text is not one,
 * and how long ago the file was written. Null when the file is gone.
 */
function readHolder(
  file: string,
): { readonly pid: number | null; readonly ageMs: number } | null {
  try {
    const text = readFileSync(file, 'utf8').trim();
    const pid = /^\d{1,10}$/.test(text) ? Number(text) : 0;
    return {
      // A number below 1 would make `process.kill` signal a whole process group.
      pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
      ageMs: Date.now() - statSync(file).mtimeMs,
    };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

/** Removes the lock file, but only a file that still holds this process's number. */
function removeOwnLockFile(file: string): void {
  try {
    // A process that took the file for a leftover may have replaced it since.
    if (readFileSync(file, 'utf8').trim() === String(process.pid)) {
      unlinkSync(file);
    }
  } catch {
    // Already gone, or not ours to read: there is nothing of ours to remove.
  }
}

/**
 * Takes the lock file of a PGlite data directory: created with `wx`, so it fails
 * if the file is there, and holding this process's number. A file whose process is
 * no longer running (`process.kill(pid, 0)`) is a leftover of a crash and is
 * replaced; so is one that carries this process's own number but that this
 * process did not make (`heldHere`). The server makes the directory when it is
 * not there yet (a first start); a command never does, so a mistyped path does
 * not make a new database.
 *
 * Two processes that find the same leftover in the same few milliseconds can both
 * replace it; the window is real but tiny, and only a crash opens it.
 *
 * @throws DatabaseInUseError when a running process holds the file.
 */
function takePgliteLock(dataDir: string, role: InUseRole): () => void {
  if (role === 'server') mkdirSync(dataDir, { recursive: true });
  // Absolute, so the same file is the same entry of `heldHere` however it is spelled.
  const file = resolve(dataDir, PGLITE_LOCK_FILE);
  // A few tries: the holder may go away between our two looks, and a leftover is
  // removed before the next try. Three are enough; more would only hide a loop.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      writeFileSync(file, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
      heldHere.add(file);
      return () => {
        heldHere.delete(file);
        removeOwnLockFile(file);
      };
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    const holder = readHolder(file);
    if (holder === null) continue;
    const running =
      holder.pid === null
        ? holder.ageMs < UNFINISHED_LOCK_MS
        : holder.pid === process.pid
          ? heldHere.has(file)
          : processExists(holder.pid);
    if (running) {
      throw new DatabaseInUseError('pglite', role, {
        file,
        ...(holder.pid === null ? {} : { pid: holder.pid }),
      });
    }
    try {
      unlinkSync(file);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }
  throw new DatabaseInUseError('pglite', role, { file });
}

/** True for a data directory setting that names a folder, not `memory://` or another URL PGlite takes. */
function isFolder(dataDir: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:\/\//i.test(dataDir);
}

/** A PostgreSQL connection that holds the lock, and the way to give it up. */
type HeldLock = { readonly release: () => Promise<void> };

/**
 * Takes the in-use advisory lock on a connection of its own, a `pg.Client` made
 * from `connectionString` (the string the pool is made from), with
 * `pg_try_advisory_lock_shared` for a server and `pg_try_advisory_lock` for a
 * command: neither waits, both answer at once. The connection stays open until
 * `release`, because the lock lives as long as the connection's session. It is
 * not one of the pool's, which therefore keeps its configured size. TCP keep-alive
 * is on, so a connection that a network fault cut without a word is noticed.
 *
 * Answers null, and keeps nothing, when another process holds the lock the wrong
 * way round. `onLost` is called, once, with the error, when the connection ends or
 * fails while the lock is held: the lock went with it. The listener is there from
 * the start, because without one Node would end the process on the connection's
 * `error` event.
 *
 * @throws Error as the driver gives it when the connection cannot be made.
 */
async function takePostgresLock(
  connectionString: string,
  mode: 'shared' | 'exclusive',
  onLost: ((error: Error) => void) | undefined,
): Promise<HeldLock | null> {
  const client = new pg.Client({ connectionString, keepAlive: true });
  // Only a connection that holds the lock can lose it: an error while connecting
  // or while giving it up is not a loss.
  let holding = false;
  let lost = false;
  client.on('error', (error: Error) => {
    if (!holding || lost) return;
    // A dropped connection reports itself twice (the server's last message, then
    // the closed socket): say so once.
    lost = true;
    onLost?.(error);
  });
  // Ends the connection and does not mind how: it is dead, or about to be.
  const hangUp = async () => {
    holding = false;
    await client.end().catch(() => undefined);
  };
  let taken: boolean;
  try {
    await client.connect();
    const result = await client.query<{ taken: boolean }>(
      mode === 'shared'
        ? 'select pg_try_advisory_lock_shared($1::bigint) as taken'
        : 'select pg_try_advisory_lock($1::bigint) as taken',
      [IN_USE_LOCK_KEY],
    );
    taken = result.rows[0]?.taken === true;
  } catch (error) {
    await hangUp();
    throw error;
  }
  if (!taken) {
    await hangUp();
    return null;
  }
  holding = true;
  return {
    release: async () => {
      if (!lost) {
        // Not a loss from here on, whatever the connection says while it closes.
        holding = false;
        try {
          await client.query(
            mode === 'shared'
              ? 'select pg_advisory_unlock_shared($1::bigint)'
              : 'select pg_advisory_unlock($1::bigint)',
            [IN_USE_LOCK_KEY],
          );
        } catch {
          // Ending the connection drops the lock too.
        }
      }
      await hangUp();
    },
  };
}

/** What `markDatabaseInUse` hands back. */
export type InUseMarker = {
  /**
   * On PostgreSQL it takes the advisory lock on a connection of its own (a no-op for
   * a read-only command, and when the marker is held already); on PGlite there is
   * nothing left to do, because the lock file was taken before the directory was
   * opened.
   *
   * @throws DatabaseInUseError when another process holds the lock the wrong way
   * round. The driver's own errors, such as an unreachable host, are thrown as they
   * come.
   */
  readonly attach: () => Promise<void>;
  /**
   * Gives the marker up and closes `database`, in the order each driver needs:
   * PostgreSQL lets go of the lock first, so that a command that waits for it is
   * not kept waiting by a pool that is slow to end; PGlite closes the database
   * first and then removes the lock file, so another process never finds the
   * directory free while it is still open. Safe to call more than once. Leave
   * `database` out when it was never opened.
   */
  readonly close: (database?: Database) => Promise<void>;
};

/**
 * The one decision about marking a database as in use, for both drivers (see the
 * top of this file). The PGlite lock file is taken here, at once, so call this
 * before `createDatabase` opens the directory; a `memory://` data directory, or
 * PGlite over a client the caller made, has nothing to lock. On PostgreSQL
 * nothing happens until `attach`, which opens the lock's own connection.
 *
 * The server calls it with `server` and the admin command line with
 * `offline-command` or `read-only-command`; a read-only command on PostgreSQL
 * takes no lock.
 *
 * @param options.onLost PostgreSQL only: called, once, with the error, when the
 * connection that holds the lock ends or fails. The lock is gone then, and a command
 * could run beside the server, so the server stops (`startServer`). Logging the
 * error means its class name only.
 * @throws DatabaseInUseError when a running process holds the PGlite lock file.
 * @throws Error for a failure to make the lock file, for example a data directory
 * that is a file; the system's own error.
 */
export function markDatabaseInUse(
  config: DbConfig,
  role: InUseRole,
  options: { readonly onLost?: (error: Error) => void } = {},
): InUseMarker {
  if (config.driver === 'pglite') {
    const dataDir = 'dataDir' in config ? config.dataDir : undefined;
    const release =
      dataDir !== undefined && isFolder(dataDir)
        ? takePgliteLock(dataDir, role)
        : undefined;
    let released = false;
    return {
      attach: () => Promise.resolve(),
      close: async (database) => {
        try {
          await database?.close();
        } finally {
          if (!released) {
            released = true;
            release?.();
          }
        }
      },
    };
  }

  const connectionString = config.url;
  let held: HeldLock | undefined;
  let closed = false;
  return {
    attach: async () => {
      if (closed || held !== undefined || role === 'read-only-command') return;
      const taken = await takePostgresLock(
        connectionString,
        role === 'server' ? 'shared' : 'exclusive',
        options.onLost,
      );
      if (taken === null) throw new DatabaseInUseError('postgres', role);
      if (closed) {
        // `close` ran while the lock was being taken: give it straight back.
        await taken.release();
        return;
      }
      held = taken;
    },
    close: async (database) => {
      closed = true;
      const lock = held;
      held = undefined;
      try {
        await lock?.release();
      } finally {
        await database?.close();
      }
    },
  };
}
