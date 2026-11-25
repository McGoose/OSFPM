import {
  readInstallationId,
  recordAdminCommandRun,
} from '@osfpm/core/src/auth/admin-report.js';
import { TRANSIENT_CLEANUPS } from '@osfpm/core/src/retention/transient-cleanups.js';
import {
  failureDetail,
  type AdminContext,
  type AdminSession,
} from './session.js';

/**
 * The `run-cleanups` command (P-09a2, decision D-81): every cleanup of
 * `TRANSIENT_CLEANUPS` now, instead of when the worker next runs them, for an
 * operator who wants the working rows (ended sessions, spent or expired links, codes,
 * challenges and tokens) gone at once. What each cleanup deletes is the core's; this
 * file runs them, tells the counts, and writes one `admin.command-run` with them.
 *
 * All of them run with one clock, each in a transaction of its own, so one that fails
 * undoes only itself and the rest still run. The command only deletes rows no one can
 * use, so on PostgreSQL it runs beside a running server.
 */

/**
 * Runs `run-cleanups`: runs each cleanup in the registry's order, prints the number of
 * rows each deleted by the name of its table, and writes one `admin.command-run`
 * event, outcome `completed`, with the counts, how many cleanups failed and which
 * (table names are fixed words). A cleanup is housekeeping and writes no event of its
 * own. Exit code 0 when every cleanup ran, and 1 when any failed, after the others
 * ran: standard error then names each table that failed with the class and the
 * SQLSTATE of its error and nothing else (a driver's message can hold a value).
 *
 * @throws The database's own errors when the command's event cannot be written, which
 * the caller reports by class name.
 */
export async function runCleanups(
  session: AdminSession,
  context: AdminContext,
): Promise<number> {
  const clock = context.now ?? (() => new Date());
  // One clock for every cleanup, so a row is of no use to all of them or to none.
  const now = clock();
  const { db } = session.database;
  const counts = new Map<string, number>();
  const failed: string[] = [];
  const problems: string[] = [];

  for (const [table, cleanup] of TRANSIENT_CLEANUPS) {
    try {
      counts.set(table, await db.transaction((tx) => cleanup(tx, now)));
    } catch (error) {
      failed.push(table);
      problems.push(`The cleanup of ${table} failed: ${failureDetail(error)}.`);
      break;
    }
  }

  await db.transaction(async (tx) =>
    recordAdminCommandRun(tx, {
      command: 'run-cleanups',
      outcome: 'completed',
      installationId: await readInstallationId(tx),
      details: {
        // The names come from the registry, never from the operator.
        ...Object.fromEntries(counts),
        failed: failed.length,
        ...(failed.length === 0 ? {} : { failedTables: failed.join(',') }),
      },
      now: clock(),
    }),
  );

  // One line for each cleanup that ran; none when every one failed.
  if (counts.size > 0) {
    context.stdout.write(
      [...counts].map(([table, deleted]) => `${table}: ${deleted}`).join('\n') +
        '\n',
    );
  }
  if (problems.length > 0) {
    context.stderr.write(`${problems.join('\n')}\n`);
    // Exit code 1, as for every refusal or failure of the admin command line.
    return 1;
  }
  return 0;
}
