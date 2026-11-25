import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AdminCommand } from '@osfpm/core/src/auth/admin-report.js';
import { ServerKeysError } from '@osfpm/core/src/keys/errors.js';
import { createDatabase, type Database } from '@osfpm/core/src/db/client.js';
import {
  DatabaseInUseError,
  markDatabaseInUse,
  type InUseRole,
} from '@osfpm/core/src/db/in-use.js';
import {
  databaseTime,
  migrationStatus,
  type MigrationStatus,
} from '@osfpm/core/src/db/status.js';
import { ConfigError, type Config } from '../config.js';
import { errorClassName } from '../logging.js';
import { codeOf, isDatabaseUnreachable } from '../startup.js';

/**
 * What every admin command needs before it runs: the process around it
 * (`AdminContext`), a database that is open and marked as in use (`AdminSession`),
 * and the guards that refuse a command which must not go on. The commands
 * themselves are in their own files.
 */

/** The process the admin command line runs in. Tests pass their own. */
export type AdminContext = {
  /** The environment the settings are read from: the same variables the server reads. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Where the report goes. */
  readonly stdout: { write(text: string): unknown };
  /** Where errors, warnings and refusals go. */
  readonly stderr: { write(text: string): unknown };
  /** The local clock, for the clock check and the time of an audit event. Defaults to the system's. */
  readonly now?: () => Date;
  /**
   * A database that is open already. Only tests pass it, to run a command against the
   * database of the test; the command line opens its own from the settings and closes
   * it. The in-use marker is still taken, and still released, around it.
   */
  readonly database?: Database;
  /**
   * The share of the disk holding `path` that is free, in percent, or null when it
   * cannot be read. Only tests pass it, because the free space of the machine they
   * run on decides nothing about the code; `doctor` asks the system's own
   * (`fs.statfsSync`) by default.
   */
  readonly freeSpace?: (path: string) => number | null;
};

/**
 * The command was refused, or cannot go on, for a reason the operator can act on.
 * The message is fixed text for standard error and holds no setting, address or key.
 * The exit code is 1.
 */
export class AdminRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminRefusal';
  }
}

/** An open database and the way to let go of it and of the in-use marker. */
export type AdminSession = {
  readonly database: Database;
  /** Gives the in-use marker up and closes the database, unless a test supplied it. Safe to call twice. */
  readonly close: () => Promise<void>;
};

/** How long a command waits for the database to answer before it says it cannot be reached. */
const REACH_TIMEOUT_MS = 10_000;

/** How long a failed open waits for the connection to be given up before it moves on. */
const GIVE_UP_TIMEOUT_MS = 2_000;

/** Rejects with a `timed out` error, code `ETIMEDOUT`, if `promise` takes longer than `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error('failed'));
      },
    );
  });
}

/** True when the data directory setting names a folder PGlite would use, as opposed to `memory://`. */
function isFolder(dataDir: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:\/\//i.test(dataDir);
}

/**
 * How a command uses the database, as the role it marks the database in use with
 * (decisions D-64 and D-81). The key commands (`rotate-data-key`,
 * `accept-data-key-loss`, `new-identity`) change what a running server keeps in
 * memory, so they are `offline-command` and need every server stopped. The three
 * that only write rows a running server writes too, under the same locks
 * (`emergency-access`, `revoke-sessions`, `run-cleanups`), are `online-command`;
 * `info` and `doctor` only read, so they are `read-only-command`. Those two roles take
 * no lock on PostgreSQL, so they run beside servers. On PGlite every role takes the
 * lock file, because two processes never open one data directory.
 *
 * Every command asks here (`run.ts`, and `doctor.ts` for itself); no command names a
 * role of its own. The switch has no default, so a command added to `ADMIN_COMMANDS`
 * does not compile until it is given a role here.
 */
export function roleOf(command: AdminCommand): InUseRole {
  switch (command) {
    case 'rotate-data-key':
    case 'accept-data-key-loss':
    case 'new-identity':
      return 'offline-command';
    case 'emergency-access':
    case 'revoke-sessions':
    case 'run-cleanups':
      return 'online-command';
    case 'info':
    case 'doctor':
      return 'read-only-command';
  }
}

/**
 * Opens the database of `config` for a command and marks it as in use for `role`
 * (`markDatabaseInUse`): an `offline-command` takes the exclusive lock on PostgreSQL
 * and refuses at once if a server holds it; an `online-command` and a
 * `read-only-command` take none there; on PGlite every role takes the lock file,
 * because two processes must never open one data directory. The command line never
 * makes a database: a PGlite directory with no database in it is refused, so a
 * mistyped path does not make an empty one. It asks the database the time, which is
 * also the check that it answers.
 *
 * @throws AdminRefusal when a PGlite directory holds no database.
 * @throws DatabaseInUseError when another process has the database.
 * @throws Error as the driver gives it when the database cannot be reached; the
 * caller prints `describeFailure`, never the message.
 */
export async function openAdminSession(
  config: Config,
  context: AdminContext,
  role: InUseRole,
): Promise<AdminSession> {
  const target = config.database;
  if (
    target.driver === 'pglite' &&
    context.database === undefined &&
    isFolder(target.dataDir) &&
    !existsSync(join(target.dataDir, 'PG_VERSION'))
  ) {
    throw new AdminRefusal(
      'No database was found in OSFPM_DATA_DIR. Start the server once to make it, then run the command again.',
    );
  }
  const marker = markDatabaseInUse(target, role);
  const database = context.database ?? createDatabase(target);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    // A database a test supplied is the test's to close.
    await (context.database === undefined
      ? marker.close(database)
      : marker.close());
  };
  try {
    await withTimeout(
      (async () => {
        await marker.attach();
        await databaseTime(database.db);
      })(),
      REACH_TIMEOUT_MS,
    );
  } catch (error) {
    // Bounded: a connection that never came up is not worth waiting for.
    await withTimeout(close(), GIVE_UP_TIMEOUT_MS).catch(() => undefined);
    throw error;
  }
  return { database, close };
}

/**
 * Refuses a command when the database has migrations that are not applied: the
 * command line never migrates, and the tables a command reads may not be there or
 * may not be what it expects.
 *
 * @throws AdminRefusal when any migration is pending.
 */
export async function requireMigrated(
  database: Database,
): Promise<MigrationStatus> {
  const status = await migrationStatus(database.db);
  if (status.pending > 0) {
    throw new AdminRefusal(
      `The database has ${status.pending} migration${status.pending === 1 ? '' : 's'} that ${status.pending === 1 ? 'is' : 'are'} not applied yet. Start the server once, which applies them unless OSFPM_AUTO_MIGRATE is false, stop it, and run the command again.`,
    );
  }
  return status;
}

/**
 * What an error is called in a message the operator reads: the class name and the
 * short system code or SQLSTATE, as in `RecordWriteError (42P01)`, and nothing else,
 * because a driver's message can hold the connection's address, a user name or SQL
 * (CLAUDE.md, Privacy rule), and `DATABASE_URL` holds a password.
 */
export function failureDetail(error: unknown): string {
  const code = codeOf(error);
  return `${errorClassName(error)}${code === undefined ? '' : ` (${code})`}`;
}

/**
 * What to tell the operator about a failure, on one line or a few. A refusal, an
 * in-use error, a key refusal and an invalid configuration carry fixed text written
 * for the operator (the configuration's names the variables and the rules, never a
 * value), and that is printed. Anything else is the error's class name and its short
 * system code and nothing else (`failureDetail`).
 */
export function describeFailure(error: unknown): string {
  if (
    error instanceof AdminRefusal ||
    error instanceof DatabaseInUseError ||
    error instanceof ServerKeysError ||
    error instanceof ConfigError
  ) {
    return error.message;
  }
  const detail = failureDetail(error);
  return isDatabaseUnreachable(error)
    ? `The database could not be reached: ${detail}.`
    : `The command failed: ${detail}.`;
}
