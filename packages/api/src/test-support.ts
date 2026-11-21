import type { TestTarget } from '@osfpm/core/src/db/test-support.js';
import { buildApp } from './app.js';
import type { LogLevel } from './config.js';

/** Matches a UUIDv7, the form of every request ID. */
export const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * An app over a throwaway, empty database on `target`, with the log lines it
 * writes collected in `lines`. The API serves no table yet, so the database is
 * not migrated. Only tests import this file.
 */
export async function createTestApp(
  target: TestTarget,
  options: { readonly logLevel?: LogLevel } = {},
) {
  const { database, cleanup } = await target.create();
  const lines: string[] = [];
  const app = buildApp({
    db: database,
    logger: {
      level: options.logLevel ?? 'info',
      stream: { write: (line) => void lines.push(line) },
    },
  });
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
