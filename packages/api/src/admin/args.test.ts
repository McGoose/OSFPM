import { describe, expect, it } from 'vitest';
import { parseAdminArguments, USAGE, UsageError } from './args.js';
import { EXIT } from './run.js';
import { runCommand } from './test-support.js';

describe('the arguments of the admin command line', () => {
  it.each([
    [['info'], { command: 'info', json: false, confirmNewIdentity: false }],
    [
      ['info', '--json'],
      { command: 'info', json: true, confirmNewIdentity: false },
    ],
    [
      ['--json', 'doctor'],
      { command: 'doctor', json: true, confirmNewIdentity: false },
    ],
  ])('reads %j', (argv, expected) => {
    expect(parseAdminArguments(argv)).toEqual(expected);
  });

  it.each([[['--help']], [['-h']], [['info', '--help']], [['nonsense', '-h']]])(
    'answers a help request for %j, whatever else is there',
    (argv) => {
      expect(parseAdminArguments(argv)).toEqual({ help: true });
    },
  );

  it.each([
    [[], 'No command was given.'],
    [['info', 'doctor'], 'Give one command at a time.'],
    [['rotate'], 'That is not a command.'],
    [['constructor'], 'That is not a command.'],
    [['__proto__'], 'That is not a command.'],
    [
      ['info', '--confirm-new-identity'],
      'The command info does not take the option --confirm-new-identity.',
    ],
  ])('refuses %j as a usage error: %s', (argv, message) => {
    expect(() => parseAdminArguments(argv)).toThrow(
      expect.objectContaining({ name: 'UsageError', message }) as Error,
    );
  });

  it('reads --confirm-new-identity for new-identity, and for no other command', () => {
    expect(
      parseAdminArguments(['new-identity', '--confirm-new-identity']),
    ).toEqual({
      command: 'new-identity',
      json: false,
      confirmNewIdentity: true,
    });
    expect(parseAdminArguments(['new-identity'])).toMatchObject({
      command: 'new-identity',
      confirmNewIdentity: false,
    });
    for (const command of ['rotate-data-key', 'accept-data-key-loss']) {
      expect(() =>
        parseAdminArguments([command, '--confirm-new-identity']),
      ).toThrow(UsageError);
      expect(() => parseAdminArguments([command, '--json'])).toThrow(
        UsageError,
      );
    }
    expect(() => parseAdminArguments(['new-identity', '--json'])).toThrow(
      UsageError,
    );
  });

  it('refuses an option nobody declared, naming it', () => {
    let caught: unknown;
    try {
      parseAdminArguments(['info', '--verbose']);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(UsageError);
    expect((caught as UsageError).message).toContain('--verbose');
  });

  it('refuses an option that wants a value it was not given, and one given a value it does not take', () => {
    expect(() => parseAdminArguments(['info', '--json=yes'])).toThrow(
      UsageError,
    );
  });
});

describe('the exit codes of the admin command line', () => {
  const none = { env: {} };

  it('is 2 for a usage error, with the problem and the usage on standard error and nothing on standard output', async () => {
    const run = await runCommand(['frobnicate'], none);

    expect(run.code).toBe(EXIT.usage);
    expect(run.code).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('That is not a command.');
    expect(run.stderr).toContain(USAGE);
    // What the operator typed is not repeated: it may have been pasted by mistake.
    expect(run.stderr).not.toContain('frobnicate');
  });

  it('is 0 for --help, with the usage on standard output', async () => {
    const run = await runCommand(['--help'], none);

    expect(run).toEqual({ code: EXIT.done, stdout: USAGE, stderr: '' });
    expect(USAGE).toContain('info');
    expect(USAGE).toContain('doctor');
    expect(USAGE).toContain(
      'Exit codes: 0 done, 1 refused or failed, 2 usage error',
    );
  });

  it('is 1 when the settings are not valid, with the server’s own message, which names variables and no value', async () => {
    const run = await runCommand(['info'], {
      env: {
        DATABASE_URL:
          'postgres://osfpm:not-a-real-password-4711@db.example.test/x',
        OSFPM_DATA_DIR: './data',
      },
    });

    expect(run.code).toBe(EXIT.refused);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('Invalid configuration:');
    expect(run.stderr).toContain(
      'DATABASE_URL and OSFPM_DATA_DIR are both set: set exactly one',
    );
    expect(run.stderr).toContain('OSFPM_PUBLIC_URL: is required');
    expect(run.stderr).not.toContain('not-a-real-password-4711');
  });
});
