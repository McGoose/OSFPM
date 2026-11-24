import type { AdminCommand } from '@osfpm/core/src/auth/admin-report.js';
import type { InUseRole } from '@osfpm/core/src/db/in-use.js';
import { loadConfig } from '../config.js';
import {
  parseAdminArguments,
  USAGE,
  UsageError,
  type AdminRequest,
} from './args.js';
import { runDoctor } from './doctor.js';
import { runInfo } from './info.js';
import {
  describeFailure,
  openAdminSession,
  requireMigrated,
  type AdminContext,
} from './session.js';

/**
 * The admin command line, as a function: arguments and a process in, an exit code
 * out (decision D-64: system administration in this phase is a command line, and
 * shell access to the server is the trust boundary). `main.ts` calls it with the
 * real process; tests call it with their own. Every command goes through the same
 * guards, in this order: the settings load (the server's own `loadConfig`, with its
 * own fixed messages), the database is marked as in use for the kind of command it
 * is, the database answers, and no migration is pending. The command line never
 * migrates. `doctor` is the exception to the last two, because it exists to say
 * what is wrong.
 */

/** The exit codes: 0 done, 1 refused or failed, 2 the arguments were wrong. */
export const EXIT = { done: 0, refused: 1, usage: 2 } as const;

/**
 * The commands that need every server stopped, because they change what a running
 * server keeps in memory. The others only read.
 */
const OFFLINE_COMMANDS: ReadonlySet<AdminCommand> = new Set([
  'rotate-data-key',
  'accept-data-key-loss',
  'new-identity',
]);

/** How the command uses the database: it needs the server stopped, or it only reads. */
function roleOf(command: AdminCommand): InUseRole {
  return OFFLINE_COMMANDS.has(command)
    ? 'offline-command'
    : 'read-only-command';
}

/** Runs a command that needs the database to be open, in use, answering and migrated. */
async function runGuarded(
  request: AdminRequest,
  context: AdminContext,
): Promise<number> {
  const config = loadConfig(context.env);
  const session = await openAdminSession(
    config,
    context,
    roleOf(request.command),
  );
  try {
    const migrations = await requireMigrated(session.database);
    switch (request.command) {
      case 'info':
        return await runInfo(
          { json: request.json, config, migrations },
          session,
          context,
        );
      default:
        // The parser only answers commands that have a case here.
        throw new Error('The command has no implementation');
    }
  } finally {
    await session.close();
  }
}

/**
 * Runs the admin command line with `argv` (the arguments after the script's name)
 * in `context`, and answers the exit code. Wrong arguments print the problem and
 * the usage on standard error (2); `--help` prints the usage on standard output
 * (0). A refusal or a failure prints one fixed message on standard error and
 * answers 1, whatever its cause: the message names the class of an unexpected
 * error and its system code, never its text, which can hold the database's
 * address or a password (`describeFailure`).
 */
export async function runAdmin(
  argv: readonly string[],
  context: AdminContext,
): Promise<number> {
  let request: ReturnType<typeof parseAdminArguments>;
  try {
    request = parseAdminArguments(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      context.stderr.write(`${error.message}\n\n${USAGE}`);
      return EXIT.usage;
    }
    throw error;
  }
  if ('help' in request) {
    context.stdout.write(USAGE);
    return EXIT.done;
  }
  try {
    return request.command === 'doctor'
      ? await runDoctor({ json: request.json }, context)
      : await runGuarded(request, context);
  } catch (error) {
    context.stderr.write(`${describeFailure(error)}\n`);
    return EXIT.refused;
  }
}
