import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PermissionSyncError } from '@osfpm/core/src/access/permission-sync.js';
import { ServerKeysError } from '@osfpm/core/src/keys/errors.js';
import type { ServerKeys } from '@osfpm/core/src/keys/server-keys.js';
import { createDatabase, type Database } from '@osfpm/core/src/db/client.js';
import {
  DatabaseInUseError,
  markDatabaseInUse,
} from '@osfpm/core/src/db/in-use.js';
import { buildApp, type App } from './app.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { errorClassName, type LoggerSettings } from './logging.js';
import {
  runStartup,
  StartupAbortedError,
  type StartupRetry,
  type StartupSteps,
} from './startup.js';

/** The signals that stop the server. The process is the usual source. */
type Signal = 'SIGINT' | 'SIGTERM';

/** Where stop signals come from. `process` fits; tests pass an `EventEmitter`. */
export type SignalSource = {
  on(signal: Signal, listener: () => void): unknown;
};

/**
 * How long shutdown may take before the process exits with code 1 anyway: a
 * request that never finishes, or a database query that never returns, must
 * not keep a stopped server alive for ever.
 */
const SHUTDOWN_TIMEOUT_MS = 10_000;

/** What `startServer` can be told, for tests. The defaults are the process. */
export type StartOptions = {
  readonly signals?: SignalSource;
  /** Called with the exit code once shutdown has finished. */
  readonly exit?: (code: number) => void;
  /** Overrides the shutdown limit. */
  readonly shutdownTimeoutMs?: number;
  /** Where log lines go. Defaults to standard output. Tests read the lines. */
  readonly logStream?: LoggerSettings['stream'];
  /** Replaces the migration and the permission sync, to watch or fail them. */
  readonly startupSteps?: StartupSteps;
  /**
   * The server keys, for a test that swaps the start-up steps and so never runs the
   * step that loads them. Only tests pass it; the server loads its keys at start-up.
   */
  readonly serverKeys?: ServerKeys;
  /** Replaces the waits between attempts while the database is unreachable. */
  readonly startupRetry?: StartupRetry;
  /**
   * Where the setup code is written. Defaults to the process's standard error,
   * which is where the server must print it: never the logger. Tests pass a sink.
   */
  readonly stderr?: { write(text: string): unknown };
};

/** A server that is listening. It may still be starting: see `ready`. */
export type RunningServer = {
  readonly app: App;
  readonly database: Database;
  /**
   * Settles when start-up is over. Resolves once the migrations and the
   * permission sync have finished and the server answers every route. Rejects
   * with the error when start-up fails for a reason that retrying does not cure
   * (the server keeps listening, answering 503 `starting`, until it is
   * stopped), and with a `StartupAbortedError` when `stop` ended it first.
   * Awaiting it is optional: a rejection nobody awaits is not unhandled.
   */
  readonly ready: Promise<void>;
  /**
   * Ends start-up if it is still going, stops accepting requests, lets
   * requests in flight finish, closes the app, lets go of the in-use marker and
   * closes the database. Safe to call more than once: later calls wait for the
   * first.
   */
  readonly stop: () => Promise<void>;
};

const SIGNALS: readonly Signal[] = ['SIGTERM', 'SIGINT'];

/** Runs `action` and ignores its failure: cleanup must not hide the error that made it necessary. */
async function quietly(action: () => PromiseLike<unknown>): Promise<void> {
  try {
    await action();
  } catch {
    // Deliberately empty: see above.
  }
}

/**
 * Opens the database, builds the app and listens, and then, in the background,
 * runs pending migrations (unless `config.autoMigrate` is false), syncs the
 * permission lists, makes the installation row and, until first-run setup is
 * complete, prints a setup code to standard error (see `runStartup`). The
 * returned server's `ready` settles when that is over. On SIGTERM or SIGINT it shuts down in order: end start-up
 * if it is still going, stop accepting requests, close the app, close the
 * database, then exit with code 0, or 1 if shutdown failed or took longer than
 * the limit.
 *
 * It listens first so a supervisor's probe finds a live process while the
 * migrations run. Until start-up has finished, `/health` answers, `/health/ready`
 * is a 503, and every other route is a 503 problem `starting`. If the database
 * cannot be reached, start-up waits and tries again (see `STARTUP_RETRY`)
 * instead of stopping the server. A failure that waiting does not cure, such as
 * a failed migration or a `PermissionSyncError`, is logged once, as one line
 * with no request in it that names the error's class and nothing else, and
 * rejects `ready`; the server then keeps answering 503 `starting` until it is
 * stopped. The command-line entry stops it and exits with code 1.
 *
 * A PGlite data directory that cannot be opened fails here, before the server
 * listens, because it is a local fault that no retry will fix. So does one that
 * another process has open (`DatabaseInUseError`): the server marks its data
 * directory with a lock file before it opens it, and never opens a directory that
 * a running server or an admin command holds. On PostgreSQL the server holds a
 * shared advisory lock on a connection of its own, outside its pool, for its whole life, which an
 * admin command that needs every server stopped finds and refuses on; the lock is
 * taken by start-up, in its retry loop, so a command that is running only makes the
 * server wait (see `runStartup`).
 *
 * The signal listeners stay registered through shutdown. With none left, Node
 * restores the default action, and a second Ctrl+C, or a supervisor sending
 * SIGTERM again, would end the process before the database is closed. A
 * signal that arrives during shutdown is ignored.
 *
 * @throws DatabaseInUseError when the PGlite data directory is in use by another
 * process, before anything is opened.
 * @throws The listen or open error, for example when the port is taken, after
 * one log line and closing the database it had opened. Nothing is left running.
 */
export async function startServer(
  config: Config,
  options: StartOptions = {},
): Promise<RunningServer> {
  const signals = options.signals ?? process;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const timeoutMs = options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS;

  // The PGlite lock file is taken here, before the directory is opened. The
  // PostgreSQL lock is taken by start-up, in its retry loop, once the server is listening.
  const inUse = markDatabaseInUse(config.database, 'server', {
    // The app exists by the time the lock is held, which is when this can run.
    onLost: () =>
      app.log.warn(
        'the connection that marks the database as in use was lost: an admin command could run beside this server until it restarts',
      ),
  });
  let database: Database;
  try {
    database = createDatabase(config.database);
  } catch (error) {
    await quietly(() => inUse.close());
    throw error;
  }
  const app = buildApp({
    db: database,
    publicOrigin: config.publicOrigin,
    trustedProxies: config.trustedProxies,
    ...(options.serverKeys ? { serverKeys: options.serverKeys } : {}),
    logger: {
      level: config.logLevel,
      ...(options.logStream ? { stream: options.logStream } : {}),
    },
  });
  try {
    // Waits for PGlite's own start-up and surfaces its failure here, where it
    // is handled, instead of as an unhandled rejection after "listening".
    if (config.database.driver === 'pglite') {
      await database.db.execute('select 1');
    }
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    // The class name only (see `loggerOptions`): a driver message can hold
    // SQL, and a PermissionSyncError names organisation ids.
    app.log.fatal({ err: error }, 'the server could not start');
    await quietly(() => app.close());
    await quietly(() => inUse.close(database));
    throw error;
  }

  // Start-up runs in the background. `stop` aborts it, so a wait between
  // attempts ends at once and a step that fails because the database is being
  // closed is not reported as a failure.
  const startup = new AbortController();
  const ready = runStartup(
    app,
    { autoMigrate: config.autoMigrate, keysDir: config.keysDir, inUse },
    options.startupSteps,
    {
      signal: startup.signal,
      ...(options.startupRetry ? { retry: options.startupRetry } : {}),
      ...(options.stderr ? { stderr: options.stderr } : {}),
    },
  );
  // Handled here, so a caller that never awaits `ready` does not crash the
  // process with an unhandled rejection. Awaiting it still rejects.
  ready.catch((error: unknown) => {
    if (error instanceof StartupAbortedError) return;
    // The class name only (see `loggerOptions`): a driver message can hold
    // SQL, and a PermissionSyncError names organisation ids.
    app.log.fatal({ err: error }, 'the server could not start');
  });

  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= (async () => {
      startup.abort();
      try {
        await app.close();
      } finally {
        // The marker lets go of the lock first on PostgreSQL, and removes the lock
        // file last on PGlite: `close` does each in its order.
        await inUse.close(database);
      }
    })();
    return stopping;
  };
  let signalled = false;
  function onSignal() {
    if (signalled) {
      app.log.info('stop signal ignored: already shutting down');
      return;
    }
    signalled = true;
    app.log.info('stop signal received, shutting down');
    const limit = setTimeout(() => {
      app.log.fatal('shutdown took too long, exiting');
      exit(1);
    }, timeoutMs);
    // The limit must not be what keeps a finished process alive.
    limit.unref();
    stop().then(
      () => {
        clearTimeout(limit);
        exit(0);
      },
      (error: unknown) => {
        clearTimeout(limit);
        app.log.fatal({ err: error }, 'shutdown failed');
        exit(1);
      },
    );
  }
  for (const signal of SIGNALS) signals.on(signal, onSignal);

  return { app, database, ready, stop };
}

/**
 * What the command-line entry prints when start-up fails, in `startServer` or
 * in the `ready` it returns. A
 * `PermissionSyncError` prints its own message and no stack: it names the
 * permission and the roles to fix, and holds no values. A `ServerKeysError` does
 * the same: its message is fixed text for the operator, and names the path of a
 * key file at most, never a key or what is in a file. So does a
 * `DatabaseInUseError`, whose message names the PGlite lock file and the other
 * process's number and nothing more. Anything else prints
 * the error's class name and system code only, because driver messages can
 * hold connection details and SQL.
 */
export function describeStartupFailure(error: unknown): string {
  if (error instanceof PermissionSyncError) return error.message;
  if (error instanceof ServerKeysError) return error.message;
  if (error instanceof DatabaseInUseError) return error.message;
  const code = (error as { code?: unknown } | null)?.code;
  return `The server could not start: ${errorClassName(error)}${typeof code === 'string' ? ` (${code})` : ''}`;
}

/**
 * The command-line entry. An invalid configuration prints its problems and
 * stops with code 1. They name variables and never show values. A failure to
 * start, whether the server could not listen or start-up failed for a reason
 * waiting does not cure, prints `describeStartupFailure`, stops the server and
 * exits with code 1. While the database is unreachable it neither fails nor
 * exits: it waits, and a stop signal ends it.
 */
async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  let server: RunningServer;
  try {
    server = await startServer(config);
  } catch (error) {
    console.error(describeStartupFailure(error));
    process.exitCode = 1;
    return;
  }
  try {
    await server.ready;
  } catch (error) {
    // Stopped by a signal: the signal handler is shutting the server down.
    if (error instanceof StartupAbortedError) return;
    console.error(describeStartupFailure(error));
    process.exitCode = 1;
    await quietly(() => server.stop());
  }
}

/** True when this file is the program being run, not a module a test imports. */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) await main();
