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
 * runs, so the app is marked ready by hand where `runStartup` would do it.
 * Only tests import this file.
 */
export async function createTestApp(
  target: TestTarget,
  options: {
    readonly logLevel?: LogLevel;
    /** Proxies whose `X-Forwarded-For` the app believes. None by default. */
    readonly trustedProxies?: readonly string[];
  } = {},
) {
  const { database, cleanup } = await target.create();
  const lines: string[] = [];
  const app = buildApp({
    db: database,
    publicOrigin: TEST_PUBLIC_ORIGIN,
    ...(options.trustedProxies === undefined
      ? {}
      : { trustedProxies: options.trustedProxies }),
    logger: {
      level: options.logLevel ?? 'info',
      stream: { write: (line) => void lines.push(line) },
    },
  });
  app.readiness.markReady();
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
