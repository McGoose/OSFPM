import type { TestTarget } from '@osfpm/core/src/db/test-support.js';
import { buildApp } from './app.js';
import type { LogLevel } from './config.js';

/** Matches a UUIDv7, the form of every request ID. */
export const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * The public origin of every test app: the only `Origin` its requests with a
 * session cookie may carry. An invented host, never a real one.
 */
export const TEST_PUBLIC_ORIGIN = 'https://osfpm.example.test';

/**
 * An app over a throwaway, empty database on `target`, with the log lines it
 * writes collected in `lines`. The database is not migrated, and no start-up
 * runs, so the app is marked ready by hand where `runStartup` would do it, and
 * told setup is complete unless `setupComplete` says otherwise.
 * Only tests import this file.
 */
export async function createTestApp(
  target: TestTarget,
  options: {
    readonly logLevel?: LogLevel;
    /** Proxies whose `X-Forwarded-For` the app believes. None by default. */
    readonly trustedProxies?: readonly string[];
    /**
     * The coarse limit per address. A test app gets a limit it will not reach by
     * default, because a test sends far more requests than a client from one
     * address; a test of the limit passes `ADDRESS_RATE_LIMIT`.
     */
    readonly addressRateLimit?: {
      readonly max: number;
      readonly timeWindowMs: number;
    };
    /**
     * Whether the app is told first-run setup is complete, as the setup route
     * tells it. True by default, so a test that is not about setup is not
     * answered 503 `setup-required` and the app never asks the database; a test
     * of the gate or of the setup routes passes `false` and gives the database
     * the state it needs.
     */
    readonly setupComplete?: boolean;
  } = {},
) {
  const { database, cleanup } = await target.create();
  const lines: string[] = [];
  const app = buildApp({
    db: database,
    publicOrigin: TEST_PUBLIC_ORIGIN,
    addressRateLimit: options.addressRateLimit ?? {
      max: 1_000_000,
      timeWindowMs: 60_000,
    },
    ...(options.trustedProxies === undefined
      ? {}
      : { trustedProxies: options.trustedProxies }),
    logger: {
      level: options.logLevel ?? 'info',
      stream: { write: (line) => void lines.push(line) },
    },
  });
  app.readiness.markReady();
  if (options.setupComplete !== false) app.setup.markComplete();
  return {
    app,
    database,
    /** The raw text of every log line written so far. */
    lines,
    /** The log lines, parsed. */
    records: () =>
      lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    /** Closes the app, then drops the database. */
    close: async () => {
      await app.close();
      await cleanup();
    },
  };
}
