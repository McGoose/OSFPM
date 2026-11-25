import { parseArgs } from 'node:util';
import { ACCESS_RESET_LIFETIME } from '@osfpm/core/src/auth/access-reset.js';
import type {
  AdminCommand,
  AdminPerson,
} from '@osfpm/core/src/auth/admin-report.js';

/**
 * The arguments of the admin command line (decision D-64): one command, and the
 * options that command takes. Parsed with `node:util`'s `parseArgs`, in strict
 * mode, so an option nobody declared is an error and not a guess. A value the
 * operator typed (an address, an id) is never repeated in a message: it may have
 * been pasted by mistake, and a terminal keeps what it prints.
 */

/** The commands that report on the installation or change the server's keys. */
export type ReportOrKeyRequest = {
  readonly command:
    | 'info'
    | 'doctor'
    | 'rotate-data-key'
    | 'accept-data-key-loss'
    | 'new-identity';
  /** `--json`: print the report as JSON (`info` and `doctor`). */
  readonly json: boolean;
  /** `--confirm-new-identity`: the operator knows the server's published identity changes (`new-identity`). */
  readonly confirmNewIdentity: boolean;
};

/** What `emergency-access` was asked for (P-09a2, decision D-81). */
export type EmergencyAccessRequest = {
  readonly command: 'emergency-access';
  /** `--email` or `--user`: the person the link is for. */
  readonly person: AdminPerson;
  /** `--organisation`: which organisation, for a person who belongs to more than one. */
  readonly organisationId: string | null;
  /** `--hours`: how long the link works, from 1 to 72; null for the command's own default. */
  readonly hours: number | null;
  /** `--remove-passkeys`: using the link also revokes the person's passkeys. */
  readonly removePasskeys: boolean;
};

/** What `revoke-sessions` was asked for (P-09a2, decision D-81). */
export type RevokeSessionsRequest = {
  readonly command: 'revoke-sessions';
  /** `--email` or `--user`: one person; `--all`: everyone. */
  readonly target: AdminPerson | { readonly kind: 'all' };
  /** `--include-api-tokens`: the personal API tokens end too. */
  readonly includeApiTokens: boolean;
};

/** What `run-cleanups` was asked for: nothing, it takes no option. */
export type RunCleanupsRequest = { readonly command: 'run-cleanups' };

/** What the arguments asked for, once they are valid. */
export type AdminRequest =
  | ReportOrKeyRequest
  | EmergencyAccessRequest
  | RevokeSessionsRequest
  | RunCleanupsRequest;

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
  ['rotate-data-key', { command: 'rotate-data-key', options: [] }],
  ['accept-data-key-loss', { command: 'accept-data-key-loss', options: [] }],
  [
    'new-identity',
    { command: 'new-identity', options: ['confirm-new-identity'] },
  ],
  [
    'emergency-access',
    {
      command: 'emergency-access',
      options: ['email', 'user', 'organisation', 'hours', 'remove-passkeys'],
    },
  ],
  [
    'revoke-sessions',
    {
      command: 'revoke-sessions',
      options: ['email', 'user', 'all', 'include-api-tokens'],
    },
  ],
  ['run-cleanups', { command: 'run-cleanups', options: [] }],
]);

/** The text `--help` prints, and standard error prints after a usage error. */
export const USAGE = `Usage: pnpm --filter @osfpm/api admin <command> [options]

Commands that only read (with PostgreSQL a server may be running):
  info      Print what this installation holds: the version, the migrations,
            the setup state, the key files and the counts of secrets, organisations
            and users. No names and no addresses.
              --json   Print JSON instead of text.
  doctor    Check the installation and print ok, warn, fail or skipped for each
            check. Exits with 1 when a check fails.
              --json   Print JSON instead of text.

Commands that only write rows a server writes too (with PostgreSQL a server may be
running; with PGlite stop it, as for every command):
  emergency-access (--email <address> | --user <id>)
                   [--organisation <id>] [--hours <n>] [--remove-passkeys]
            For an organisation whose sole administrator has lost every way to
            sign in: make a one-time reset link as the system, for an owner of the
            organisation or a member who holds its Administrator role. Anyone else
            is helped by their own administrator. The link is printed once, on
            standard error, and is the only secret the command prints; it works
            for one hour unless --hours (1 to 72) says otherwise. Using it ends
            the person's sessions and API tokens and clears their password,
            authenticator app and recovery codes; --remove-passkeys also revokes
            their passkeys. --organisation is needed for a person who belongs to
            more than one organisation. An earlier link of the person ends.
  revoke-sessions (--email <address> | --user <id> | --all)
                  [--include-api-tokens]
            End every live session of one person, or of everyone, and print how
            many, with user ids only. --include-api-tokens ends their personal API
            tokens too. With --all each person is done in a transaction of their
            own: a session made while it runs may survive, so stop the servers
            first for a hard cut-off.
  run-cleanups
            Delete now what is of no use in every table of working rows (ended
            sessions, spent or expired links and codes, expired challenges and
            tokens) and print how many were deleted from each. When one cleanup
            fails the others still run, and the command exits with 1 naming it.

Commands that change the server's keys. Every server must be stopped first: with
PostgreSQL the command refuses at once while a server is running; with PGlite the
data directory is never opened by two processes.
  rotate-data-key
            Add a new data key, make it the current one, and re-seal every
            authenticator secret that an older key sealed. Old key files are kept:
            an older backup of the database still needs them.
  accept-data-key-loss
            For an install whose data keys are gone (the server refuses to start
            with "data keys are missing"): make a fresh data key and make it the
            current one. No row changes. The authenticator secrets that cannot be
            opened stay as they are, and their people set up again. Changes
            nothing when a usable current key exists.
  new-identity --confirm-new-identity
            For an install whose identity key file is lost and cannot be restored
            from a backup (the server refuses to start with "identity key is
            missing"): make a new identity key and store its public key. The
            identity the server publishes changes, which cannot be undone, so the
            command does nothing without --confirm-new-identity. It refuses when
            an identity file exists, matching or not, and never deletes or
            overwrites a key file.

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
 * unknown option, an option the command does not take, and for the three commands
 * that name a person or a number (`emergency-access`, `revoke-sessions`): an option
 * given twice, a person named twice or not at all, an id that is not an id, and
 * `--hours` outside the lifetime of a reset link. The messages never repeat a value.
 */
export function parseAdminArguments(
  argv: readonly string[],
): AdminRequest | HelpRequest {
  let parsed: ReturnType<typeof parseCommandLine>;
  try {
    parsed = parseCommandLine(argv);
  } catch (error) {
    throw new UsageError(describeParseFailure(error));
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
  switch (known.command) {
    case 'emergency-access':
      return emergencyAccessRequest(values);
    case 'revoke-sessions':
      return revokeSessionsRequest(values);
    case 'run-cleanups':
      return { command: 'run-cleanups' };
    default:
      return {
        command: known.command,
        json: values.json === true,
        confirmNewIdentity: values['confirm-new-identity'] === true,
      };
  }
}

/** The values `parseCommandLine` read. */
type Values = ReturnType<typeof parseCommandLine>['values'];

/**
 * What to tell the operator when `parseArgs` refused the arguments. Its messages name
 * the option, which is safe to show and says what to fix, except one: the hint it
 * gives for a value that starts with a dash repeats the value, so that case says only
 * which option.
 */
function describeParseFailure(error: unknown): string {
  if (!(error instanceof Error)) return 'The arguments are not valid.';
  if (
    (error as { code?: unknown }).code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE'
  ) {
    // The message starts "Option '--name <value>' ...": take the name, plain string operations.
    const open = error.message.indexOf("'");
    const space = open < 0 ? -1 : error.message.indexOf(' ', open);
    const name =
      open < 0 || space < 0
        ? 'An option'
        : error.message.slice(open + 1, space);
    return `${name} needs a value, and one that starts with a dash must be written as ${name}=value.`;
  }
  return error.message;
}

/** What a UUID looks like, so an id that is not one is refused before anything is opened. */
const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The value of an option that takes text, or undefined when it was not given.
 * Given twice is an error, not a choice of the last: `--email a --email b` is a
 * mistake, and for the command that makes a link a wrong person is the worst one.
 */
function oneValue(
  values: Values,
  name: 'email' | 'user' | 'organisation' | 'hours',
): string | undefined {
  const given = values[name];
  if (given === undefined) return undefined;
  if (given.length > 1) {
    throw new UsageError(`--${name} was given more than once.`);
  }
  return given[0];
}

/** A person named by `--email` or `--user`, undefined when neither was given. */
function namedPerson(values: Values): AdminPerson | undefined {
  const email = oneValue(values, 'email');
  const userId = oneValue(values, 'user');
  if (email !== undefined && userId !== undefined) {
    throw new UsageError('Give --email or --user, not both.');
  }
  if (email !== undefined) {
    if (email.trim() === '') throw new UsageError('--email needs an address.');
    return { kind: 'email', email };
  }
  if (userId !== undefined) {
    if (!UUID_SHAPE.test(userId)) {
      throw new UsageError('--user must be the id of an account.');
    }
    return { kind: 'user', userId };
  }
  return undefined;
}

/** The request `emergency-access` makes of its arguments. */
function emergencyAccessRequest(values: Values): EmergencyAccessRequest {
  const person = namedPerson(values);
  if (person === undefined) {
    throw new UsageError('Name the person with --email or --user.');
  }
  const organisationId = oneValue(values, 'organisation');
  if (organisationId !== undefined && !UUID_SHAPE.test(organisationId)) {
    throw new UsageError('--organisation must be the id of an organisation.');
  }
  const hoursText = oneValue(values, 'hours');
  let hours: number | null = null;
  if (hoursText !== undefined) {
    // Plain digits only, so a number written any other way (1.5, 1e1, 0x10) is refused.
    const number = /^\d{1,3}$/.test(hoursText) ? Number(hoursText) : Number.NaN;
    if (!(
      number >= ACCESS_RESET_LIFETIME.minHours &&
      number <= ACCESS_RESET_LIFETIME.maxHours
    )) {
      throw new UsageError(
        `--hours must be a whole number from ${ACCESS_RESET_LIFETIME.minHours} to ${ACCESS_RESET_LIFETIME.maxHours}.`,
      );
    }
    hours = number;
  }
  return {
    command: 'emergency-access',
    person,
    organisationId: organisationId ?? null,
    hours,
    removePasskeys: values['remove-passkeys'] === true,
  };
}

/** The request `revoke-sessions` makes of its arguments. */
function revokeSessionsRequest(values: Values): RevokeSessionsRequest {
  const all = values.all === true;
  const given = [
    oneValue(values, 'email') !== undefined,
    oneValue(values, 'user') !== undefined,
    all,
  ].filter(Boolean).length;
  if (given > 1) {
    throw new UsageError('Give only one of --email, --user and --all.');
  }
  const person = namedPerson(values);
  if (person === undefined && !all) {
    throw new UsageError(
      'Name the person with --email or --user, or use --all.',
    );
  }
  return {
    command: 'revoke-sessions',
    target: person ?? { kind: 'all' },
    includeApiTokens: values['include-api-tokens'] === true,
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
      email: { type: 'string', multiple: true },
      user: { type: 'string', multiple: true },
      organisation: { type: 'string', multiple: true },
      hours: { type: 'string', multiple: true },
      'remove-passkeys': { type: 'boolean' },
      all: { type: 'boolean' },
      'include-api-tokens': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
}
