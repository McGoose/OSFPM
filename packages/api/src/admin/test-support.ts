import { auditEvent } from '@osfpm/core/src/db/schema/index.js';
import type { Database } from '@osfpm/core/src/db/client.js';
import { runAdmin } from './run.js';
import type { AdminContext } from './session.js';

export { partialMigrations } from '@osfpm/core/src/db/test-support.js';

/**
 * Helpers for the tests of the admin command line. Only tests import this file.
 * Every address, password and URL in it is invented.
 */

/**
 * A database address that no output, log line, audit event or error may repeat: a
 * made-up password and host, in the shape a real `DATABASE_URL` has.
 */
export const FAKE_DATABASE_URL =
  'postgres://osfpm:not-a-real-password-4711@db.example.test:5432/osfpm';

/** The strings from `FAKE_DATABASE_URL` that identify it, each of which must stay out of every output. */
export const DATABASE_URL_PARTS = [
  'not-a-real-password-4711',
  'db.example.test',
  'postgres://',
];

/**
 * The environment of a command run: the server's own variables. With PostgreSQL it
 * carries `FAKE_DATABASE_URL`, which is never opened because the test gives the
 * command a database of its own; with PGlite, an in-memory data directory.
 */
export function adminEnvironment(
  driver: 'postgres' | 'pglite',
  keysDir: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    OSFPM_PUBLIC_URL: 'https://osfpm.example.test',
    OSFPM_KEYS_DIR: keysDir,
    ...(driver === 'postgres'
      ? { DATABASE_URL: FAKE_DATABASE_URL }
      : { OSFPM_DATA_DIR: 'memory://' }),
    ...extra,
  };
}

/** What a command run printed and answered. */
export type CommandRun = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

/**
 * Runs the admin command line with `argv` in-process, over `context` (an
 * environment, and a database or settings that open one), and collects what it
 * printed.
 */
export async function runCommand(
  argv: readonly string[],
  context: Omit<AdminContext, 'stdout' | 'stderr'>,
): Promise<CommandRun> {
  let stdout = '';
  let stderr = '';
  const code = await runAdmin(argv, {
    ...context,
    stdout: { write: (text) => void (stdout += text) },
    stderr: { write: (text) => void (stderr += text) },
  });
  return { code, stdout, stderr };
}

/** The audit events of one category, oldest first. */
export async function auditEventsOf(
  database: Database,
  category: string,
): Promise<(typeof auditEvent.$inferSelect)[]> {
  return (await database.db.select().from(auditEvent))
    .filter((event) => event.category === category)
    .sort((a, b) => a.id.localeCompare(b.id));
}
