import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createDatabase, type Database } from '@osfpm/core/src/db/client.js';
import { buildApp, type App } from './app.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { errorClassName } from './logging.js';

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
};

/** A server that is listening. */
export type RunningServer = {
  readonly app: App;
  readonly database: Database;
  /**
   * Stops accepting requests, lets requests in flight finish, closes the app
   * and then the database. Safe to call more than once: later calls wait for
   * the first.
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
 * Opens the database, builds the app and listens, and on SIGTERM or SIGINT
 * shuts down in order: stop accepting requests, close the app, close the
 * database, then exit with code 0, or 1 if shutdown failed or took longer than
 * the limit. The database is not migrated here: setting one up is a separate
 * step.
 *
 * A PGlite data directory that cannot be opened fails here, before the server
 * listens, because it is a local fault that no retry will fix. An unreachable
 * PostgreSQL server does not: the server starts and `/health/ready` says 503
 * until it answers, which is what a readiness probe is for.
 *
 * The signal listeners stay registered through shutdown. With none left, Node
 * restores the default action, and a second Ctrl+C, or a supervisor sending
 * SIGTERM again, would end the process before the database is closed. A
 * signal that arrives during shutdown is ignored.
 *
 * @throws The listen or open error, for example when the port is taken, after
 * closing the database it had opened. Nothing is left running.
 */
export async function startServer(
  config: Config,
  options: StartOptions = {},
): Promise<RunningServer> {
  const signals = options.signals ?? process;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const timeoutMs = options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS;

  const database = createDatabase(config.database);
  const app = buildApp({ db: database, logger: { level: config.logLevel } });
  try {
    // Waits for PGlite's own start-up and surfaces its failure here, where it
    // is handled, instead of as an unhandled rejection after "listening".
    if (config.database.driver === 'pglite') {
      await database.db.execute('select 1');
    }
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    await quietly(() => app.close());
    await quietly(() => database.close());
    throw error;
  }

  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= (async () => {
      try {
        await app.close();
      } finally {
        await database.close();
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

  return { app, database, stop };
}

/**
 * The command-line entry. An invalid configuration prints its problems and
 * stops with code 1. They name variables and never show values. Any other
 * failure to start prints the error's class name and system code only, because
 * driver messages can hold connection details.
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
  try {
    await startServer(config);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    console.error(
      `The server could not start: ${errorClassName(error)}${typeof code === 'string' ? ` (${code})` : ''}`,
    );
    process.exitCode = 1;
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
