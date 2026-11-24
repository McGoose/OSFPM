import { parseArgs } from 'node:util';
import type { AdminCommand } from '@osfpm/core/src/auth/admin-report.js';

/**
 * The arguments of the admin command line (decision D-64): one command, and the
 * options that command takes. Parsed with `node:util`'s `parseArgs`, in strict
 * mode, so an option nobody declared is an error and not a guess.
 */

/** What the arguments asked for, once they are valid. */
export type AdminRequest = {
  readonly command: AdminCommand;
  /** `--json`: print the report as JSON (`info` and `doctor`). */
  readonly json: boolean;
  /** `--confirm-new-identity`: the operator knows the server's published identity changes (`new-identity`). */
  readonly confirmNewIdentity: boolean;
};

/**
 * The arguments are not a command line this tool understands. The message is for
 * standard error and the exit code is 2. It names the option or the problem and
 * never a value the operator typed after one.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** The options each command takes, by command name. A map: the name comes from the operator. */
const COMMAND_OPTIONS = new Map<
  string,
  { readonly command: AdminCommand; readonly options: readonly string[] }
>([
  ['info', { command: 'info', options: ['json'] }],
  ['doctor', { command: 'doctor', options: ['json'] }],
]);

/** The text `--help` prints, and standard error prints after a usage error. */
export const USAGE = `Usage: pnpm --filter @osfpm/api admin <command> [options]

Commands that only read (a server may be running):
  info      Print what this installation holds: the version, the migrations,
            the setup state, the key files and the counts of secrets, organisations
            and users. No names and no addresses.
              --json   Print JSON instead of text.
  doctor    Check the installation and print ok, warn or fail for each check.
            Exits with 1 when a check fails.
              --json   Print JSON instead of text.

Options for every command:
  -h, --help  Print this text.

The settings are the server's own environment variables (DATABASE_URL or
OSFPM_DATA_DIR, OSFPM_KEYS_DIR, OSFPM_PUBLIC_URL, and the others in the
README of packages/api). Exit codes: 0 done, 1 refused or failed, 2 usage error.
With PGlite (OSFPM_DATA_DIR) the server must be stopped for every command.
`;

/** What `parseAdminArguments` answers when the operator asked for help. */
export type HelpRequest = { readonly help: true };

/**
 * Turns the arguments after the script name into a request. `--help` anywhere
 * answers a help request. Anything else that is not exactly one known command,
 * with options that command takes, is a `UsageError`.
 *
 * @throws UsageError for no command, an unknown command, more than one command, an
 * unknown option, or an option the command does not take.
 */
export function parseAdminArguments(
  argv: readonly string[],
): AdminRequest | HelpRequest {
  let parsed: ReturnType<typeof parseCommandLine>;
  try {
    parsed = parseCommandLine(argv);
  } catch (error) {
    // `parseArgs` throws a `TypeError` whose message names the option: that is
    // safe to show, and says what to fix.
    throw new UsageError(
      error instanceof Error ? error.message : 'The arguments are not valid.',
    );
  }
  const { values, positionals } = parsed;
  if (values.help === true) return { help: true };
  if (positionals.length === 0) throw new UsageError('No command was given.');
  if (positionals.length > 1) {
    throw new UsageError('Give one command at a time.');
  }
  const known = COMMAND_OPTIONS.get(positionals[0]!);
  if (known === undefined) throw new UsageError('That is not a command.');
  const taken = new Set(known.options);
  for (const [name, value] of Object.entries(values)) {
    if (name === 'help' || value === undefined) continue;
    if (!taken.has(name)) {
      throw new UsageError(
        `The command ${known.command} does not take the option --${name}.`,
      );
    }
  }
  return {
    command: known.command,
    json: values.json === true,
    confirmNewIdentity: values['confirm-new-identity'] === true,
  };
}

/** `parseArgs` over every option any command takes; which command takes which is checked after. */
function parseCommandLine(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      json: { type: 'boolean' },
      'confirm-new-identity': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
}
