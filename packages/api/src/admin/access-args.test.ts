import { describe, expect, it } from 'vitest';
import { parseAdminArguments, USAGE, UsageError } from './args.js';
import { EXIT } from './run.js';
import { runCommand } from './test-support.js';

/**
 * The arguments of the three commands that make an emergency access link, end
 * sessions and run the cleanups (P-09a2, decision D-81). Each refusal is a usage
 * error, exit code 2, whose message names the option and never repeats what the
 * operator typed: an address pasted by mistake must not end up in a terminal log.
 */

const USER = '01a21347-bb08-7167-bc54-000000000001';
const ORGANISATION = '01a21347-bb08-7167-bc54-000000000002';

describe('the arguments of emergency-access', () => {
  it.each([
    [
      ['emergency-access', '--user', USER],
      {
        command: 'emergency-access',
        person: { kind: 'user', userId: USER },
        organisationId: null,
        hours: null,
        removePasskeys: false,
      },
    ],
    [
      ['emergency-access', '--email', 'ada.demo@example.test'],
      {
        command: 'emergency-access',
        person: { kind: 'email', email: 'ada.demo@example.test' },
        organisationId: null,
        hours: null,
        removePasskeys: false,
      },
    ],
    [
      [
        '--remove-passkeys',
        'emergency-access',
        '--user',
        USER,
        '--organisation',
        ORGANISATION,
        '--hours',
        '72',
      ],
      {
        command: 'emergency-access',
        person: { kind: 'user', userId: USER },
        organisationId: ORGANISATION,
        hours: 72,
        removePasskeys: true,
      },
    ],
    [
      ['emergency-access', '--user', USER, '--hours=1'],
      {
        command: 'emergency-access',
        person: { kind: 'user', userId: USER },
        organisationId: null,
        hours: 1,
        removePasskeys: false,
      },
    ],
  ])('reads %j', (argv, expected) => {
    expect(parseAdminArguments(argv)).toEqual(expected);
  });

  it.each([
    [['emergency-access'], 'Name the person with --email or --user.'],
    [
      ['emergency-access', '--email', 'a@example.test', '--user', USER],
      'Give --email or --user, not both.',
    ],
    [['emergency-access', '--email', ''], '--email needs an address.'],
    [['emergency-access', '--email', '   '], '--email needs an address.'],
    [
      ['emergency-access', '--user', 'not-an-id'],
      '--user must be the id of an account.',
    ],
    [
      ['emergency-access', '--user', USER, '--organisation', 'not-an-id'],
      '--organisation must be the id of an organisation.',
    ],
    [
      [
        'emergency-access',
        '--email',
        'a@example.test',
        '--email',
        'b@example.test',
      ],
      '--email was given more than once.',
    ],
    [
      ['emergency-access', '--user', USER, '--user', USER],
      '--user was given more than once.',
    ],
    [
      ['emergency-access', '--user', USER, '--hours', '1', '--hours', '2'],
      '--hours was given more than once.',
    ],
    [
      ['emergency-access', '--user', USER, '--all'],
      'The command emergency-access does not take the option --all.',
    ],
    [
      ['emergency-access', '--user', USER, '--json'],
      'The command emergency-access does not take the option --json.',
    ],
    [
      ['emergency-access', '--user', USER, '--include-api-tokens'],
      'The command emergency-access does not take the option --include-api-tokens.',
    ],
  ])('refuses %j as a usage error: %s', (argv, message) => {
    expect(() => parseAdminArguments(argv)).toThrow(
      expect.objectContaining({ name: 'UsageError', message }) as Error,
    );
  });

  // The lifetime is one the reset links already have: 1 to 72 hours.
  it.each([
    ['0'],
    ['73'],
    ['1.5'],
    ['-1'],
    ['abc'],
    [''],
    [' 2'],
    ['1e1'],
    ['0x10'],
  ])('refuses --hours=%j, saying the range and never the value', (hours) => {
    let caught: unknown;
    try {
      parseAdminArguments([
        'emergency-access',
        '--user',
        USER,
        `--hours=${hours}`,
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UsageError);
    expect((caught as UsageError).message).toBe(
      '--hours must be a whole number from 1 to 72.',
    );
  });

  it('refuses a value that looks like an option without repeating it: the parser’s own hint would', () => {
    let caught: unknown;
    try {
      parseAdminArguments([
        'emergency-access',
        '--user',
        USER,
        '--hours',
        '-5',
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UsageError);
    expect((caught as UsageError).message).not.toContain('-5');
    expect((caught as UsageError).message).toContain('--hours');
  });

  it('takes the bounds of --hours from the lifetime of a reset link: 1 and 72 are the edges', () => {
    for (const hours of ['1', '72']) {
      expect(
        parseAdminArguments([
          'emergency-access',
          '--user',
          USER,
          '--hours',
          hours,
        ]),
      ).toMatchObject({ hours: Number(hours) });
    }
  });
});

describe('the arguments of revoke-sessions', () => {
  it.each([
    [
      ['revoke-sessions', '--user', USER],
      {
        command: 'revoke-sessions',
        target: { kind: 'user', userId: USER },
        includeApiTokens: false,
      },
    ],
    [
      [
        'revoke-sessions',
        '--email',
        'ada.demo@example.test',
        '--include-api-tokens',
      ],
      {
        command: 'revoke-sessions',
        target: { kind: 'email', email: 'ada.demo@example.test' },
        includeApiTokens: true,
      },
    ],
    [
      ['revoke-sessions', '--all'],
      {
        command: 'revoke-sessions',
        target: { kind: 'all' },
        includeApiTokens: false,
      },
    ],
    [
      ['--include-api-tokens', 'revoke-sessions', '--all'],
      {
        command: 'revoke-sessions',
        target: { kind: 'all' },
        includeApiTokens: true,
      },
    ],
  ])('reads %j', (argv, expected) => {
    expect(parseAdminArguments(argv)).toEqual(expected);
  });

  it.each([
    [
      ['revoke-sessions'],
      'Name the person with --email or --user, or use --all.',
    ],
    [
      ['revoke-sessions', '--include-api-tokens'],
      'Name the person with --email or --user, or use --all.',
    ],
    [
      ['revoke-sessions', '--all', '--user', USER],
      'Give only one of --email, --user and --all.',
    ],
    [
      ['revoke-sessions', '--all', '--email', 'a@example.test'],
      'Give only one of --email, --user and --all.',
    ],
    [
      ['revoke-sessions', '--email', 'a@example.test', '--user', USER],
      'Give only one of --email, --user and --all.',
    ],
    [
      ['revoke-sessions', '--user', 'not-an-id'],
      '--user must be the id of an account.',
    ],
    [['revoke-sessions', '--email', ''], '--email needs an address.'],
    [
      ['revoke-sessions', '--user', USER, '--organisation', ORGANISATION],
      'The command revoke-sessions does not take the option --organisation.',
    ],
    [
      ['revoke-sessions', '--all', '--hours', '2'],
      'The command revoke-sessions does not take the option --hours.',
    ],
    [
      ['revoke-sessions', '--all', '--remove-passkeys'],
      'The command revoke-sessions does not take the option --remove-passkeys.',
    ],
  ])('refuses %j as a usage error: %s', (argv, message) => {
    expect(() => parseAdminArguments(argv)).toThrow(
      expect.objectContaining({ name: 'UsageError', message }) as Error,
    );
  });
});

describe('the arguments of run-cleanups', () => {
  it('reads the command, which takes no option', () => {
    expect(parseAdminArguments(['run-cleanups'])).toEqual({
      command: 'run-cleanups',
    });
    for (const option of ['--all', '--json', '--user']) {
      expect(() =>
        parseAdminArguments(
          option === '--user'
            ? ['run-cleanups', option, USER]
            : ['run-cleanups', option],
        ),
      ).toThrow(UsageError);
    }
  });

  it('is not taken by the commands that came before it, which refuse the options of these', () => {
    for (const command of ['info', 'doctor', 'rotate-data-key']) {
      expect(() => parseAdminArguments([command, '--user', USER])).toThrow(
        UsageError,
      );
      expect(() => parseAdminArguments([command, '--all'])).toThrow(UsageError);
    }
  });
});

describe('the exit code and the words of a wrong command line, for the three commands', () => {
  const none = { env: {} };

  it.each([
    ['emergency-access', '--user', 'not-an-id'],
    [
      'emergency-access',
      '--email',
      'someone.private@example.test',
      '--hours',
      '99',
    ],
    ['revoke-sessions'],
    ['revoke-sessions', '--all', '--email', 'someone.private@example.test'],
  ])(
    'is 2 for %j, with the problem and the usage on standard error and nothing on standard output',
    async (...argv) => {
      const run = await runCommand(argv, none);

      expect(run.code).toBe(EXIT.usage);
      expect(run.stdout).toBe('');
      expect(run.stderr).toContain(USAGE);
      // What the operator typed is not repeated.
      expect(run.stderr).not.toContain('someone.private');
      expect(run.stderr).not.toContain('not-an-id');
    },
  );

  it('describes the three commands in the usage', () => {
    expect(USAGE).toContain('emergency-access');
    expect(USAGE).toContain('revoke-sessions');
    expect(USAGE).toContain('run-cleanups');
    expect(USAGE).toContain('--include-api-tokens');
    expect(USAGE).toContain('--remove-passkeys');
    // The server may run beside them on PostgreSQL, and not on PGlite.
    expect(USAGE).toContain('PostgreSQL');
  });
});
