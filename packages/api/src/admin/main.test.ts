import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FAKE_DATABASE_URL } from './test-support.js';

/**
 * The program itself, as `pnpm --filter @osfpm/api admin` starts it: a real
 * process over `tsx`, to show that the entry point finds itself, hands the
 * process's arguments and environment to the command line, keeps the report on
 * standard output and the rest on standard error, and exits with the command's
 * code. The commands' own answers are tested in-process, in their own files.
 */
const API = fileURLToPath(new URL('../..', import.meta.url));

/** Runs the entry point with `args`, with no setting of ours in its environment but `extra`. */
function runProgram(args: string[], extra: Record<string, string> = {}) {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/admin/main.ts', ...args],
    {
      cwd: API,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        PATH: process.env.PATH ?? '',
        // Empty counts as not set, so nothing from the machine running the tests gets in.
        DATABASE_URL: '',
        OSFPM_DATA_DIR: '',
        OSFPM_KEYS_DIR: '',
        OSFPM_PUBLIC_URL: '',
        ...extra,
      },
    },
  );
  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe('the admin command line as a program', () => {
  it('prints the usage on standard output and exits 0 for --help', () => {
    const run = runProgram(['--help']);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Usage: pnpm --filter @osfpm/api admin');
    expect(run.stdout).toContain('rotate-data-key');
    expect(run.stdout).toContain('new-identity --confirm-new-identity');
    expect(run.stderr).toBe('');
  });

  it('exits 2 for a command it does not know, with the problem on standard error and nothing on standard output', () => {
    const run = runProgram(['frobnicate']);

    expect(run.code).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('That is not a command.');
  });

  it('exits 1 for settings that are not valid, with the server’s own message, and never prints a value', () => {
    const run = runProgram(['info'], {
      DATABASE_URL: FAKE_DATABASE_URL,
      OSFPM_DATA_DIR: './data',
    });

    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('Invalid configuration:');
    expect(run.stderr).toContain(
      'DATABASE_URL and OSFPM_DATA_DIR are both set: set exactly one',
    );
    expect(run.stderr).toContain('OSFPM_PUBLIC_URL: is required');
    expect(run.stderr).not.toContain('not-a-real-password-4711');
  });

  it('exits 1 and says why when the PGlite data directory holds no database, and makes nothing', () => {
    const run = runProgram(['doctor', '--json'], {
      OSFPM_DATA_DIR: 'does-not-exist-anywhere',
      OSFPM_PUBLIC_URL: 'http://localhost:3000',
    });

    expect(run.code).toBe(1);
    const report = JSON.parse(run.stdout) as {
      checks: { id: string; status: string }[];
    };
    expect(report.checks.find((check) => check.id === 'database')?.status).toBe(
      'fail',
    );
    expect(run.stderr).toBe('');
  });
});
