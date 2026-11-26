import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_COMMANDS } from '@osfpm/core/src/auth/admin-report.js';
import { bindServerKeys } from '@osfpm/core/src/auth/server-key-binding.js';
import {
  markSetupComplete,
  seedInstallation,
} from '@osfpm/core/src/auth/test-support.js';
import {
  markDatabaseInUse,
  PGLITE_LOCK_FILE,
} from '@osfpm/core/src/db/in-use.js';
import {
  createMigratedDatabase,
  inUseHolders,
  testTargets,
} from '@osfpm/core/src/db/test-support.js';
import { createTestKeyDirectory } from '@osfpm/core/src/keys/test-support.js';
import type { Config } from '../config.js';
import { startServer } from '../server.js';
import type { StartupSteps } from '../startup.js';
import { openAdminSession, roleOf, type AdminContext } from './session.js';
import { runCommand } from './test-support.js';
import type { DoctorReport } from './doctor.js';

/**
 * The guards every command goes through, with real databases and real servers: a
 * PGlite directory is never opened by two processes (a server and a command, two
 * commands), the command line never makes a database, and on PostgreSQL the
 * commands that only read run beside servers. The commands' own answers are in
 * their own test files.
 */
const keyDirectory = createTestKeyDirectory();
afterAll(() => keyDirectory.remove());

const PUBLIC_URL = 'http://localhost:3000';
const quiet = { stderr: { write: () => true } };
const NO_WORK: StartupSteps = {
  migrate: () => Promise.resolve(),
  syncPermissions: () => Promise.resolve(),
};

function serverConfig(database: Config['database']): Config {
  return {
    database,
    keysDir: keyDirectory.dir,
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    publicOrigin: PUBLIC_URL,
    autoMigrate: true,
    trustedProxies: [],
  };
}

describe('the in-use role of each command', () => {
  // A list that pins every command: a new command is listed here, with the role its
  // author chose, in the same commit. The role says what the command does to a
  // running server, not only whether it writes (decisions D-64 and D-81).
  it('is offline for the commands that change what a server keeps in memory, online for the ones that only write rows a server writes too, and read-only for the ones that only read', () => {
    const roles = Object.fromEntries(
      ADMIN_COMMANDS.map((command) => [command, roleOf(command)]),
    );

    expect(roles).toEqual({
      info: 'read-only-command',
      doctor: 'read-only-command',
      'rotate-data-key': 'offline-command',
      'accept-data-key-loss': 'offline-command',
      'new-identity': 'offline-command',
      'emergency-access': 'online-command',
      'revoke-sessions': 'online-command',
      'run-cleanups': 'online-command',
    });
  });

  it.each(ADMIN_COMMANDS)(
    'is the one openAdminSession marks the database with for %s: it is told the command, never a role',
    async (command) => {
      const dataDir = mkdtempSync(join(tmpdir(), 'osfpm-admin-role-'));
      // Enough to pass for a database: the marker is taken before it is opened.
      writeFileSync(join(dataDir, 'PG_VERSION'), '17\n');
      const config = serverConfig({ driver: 'pglite', dataDir });
      const context: AdminContext = {
        env: {},
        stdout: quiet.stderr,
        stderr: quiet.stderr,
      };
      // Held, so the session is refused, and the refusal names the role it asked with.
      const holder = markDatabaseInUse(config.database, 'server');
      try {
        await expect(
          openAdminSession(config, context, command),
        ).rejects.toMatchObject({
          name: 'DatabaseInUseError',
          role: roleOf(command),
        });
      } finally {
        await holder.close();
        rmSync(dataDir, { recursive: true, force: true });
      }
    },
  );
});

describe('the admin command line on a PGlite data directory', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'osfpm-admin-run-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const environment = () => ({
    OSFPM_DATA_DIR: dataDir,
    OSFPM_KEYS_DIR: keyDirectory.dir,
    OSFPM_PUBLIC_URL: PUBLIC_URL,
  });
  const lockFile = () => join(dataDir, PGLITE_LOCK_FILE);

  it.each([['info'], ['doctor']])(
    'never makes a database: %s on a directory with none is refused and leaves the directory as it was',
    async (command) => {
      const { code, stdout, stderr } = await runCommand([command, '--json'], {
        env: environment(),
      });

      expect(readdirSync(dataDir)).toEqual([]);
      if (command === 'info') {
        expect(code).toBe(1);
        expect(stdout).toBe('');
        expect(stderr).toContain('No database was found in OSFPM_DATA_DIR');
      } else {
        // `doctor` says what is wrong instead of refusing.
        const report = JSON.parse(stdout) as DoctorReport;
        expect(code).toBe(1);
        expect(
          report.checks.find((check) => check.id === 'database'),
        ).toMatchObject({
          status: 'fail',
          reason: expect.stringContaining('No database was found') as string,
        });
      }
    },
  );

  it('is refused by a running server, read-only commands too, and works once the server has stopped', async () => {
    const config = serverConfig({ driver: 'pglite', dataDir });
    // The real start-up: it migrates, and makes the installation and the keys.
    const server = await startServer(config, {
      signals: new EventEmitter(),
      ...quiet,
    });
    try {
      await server.ready;
      expect(existsSync(lockFile())).toBe(true);

      const info = await runCommand(['info'], { env: environment() });
      expect(info.code).toBe(1);
      expect(info.stdout).toBe('');
      expect(info.stderr).toContain(`process ${process.pid}`);
      expect(info.stderr).toContain(lockFile());

      const doctor = await runCommand(['doctor', '--json'], {
        env: environment(),
      });
      const report = JSON.parse(doctor.stdout) as DoctorReport;
      expect(doctor.code).toBe(1);
      expect(
        report.checks.find((check) => check.id === 'database')?.status,
      ).toBe('fail');
      expect(
        report.checks.find((check) => check.id === 'migrations')?.status,
      ).toBe('skipped');
      // The commands that change keys are refused the same way, and change nothing.
      const keyFilesBefore = readdirSync(
        join(keyDirectory.dir, 'data-keys'),
      ).sort();
      for (const command of [
        ['rotate-data-key'],
        ['accept-data-key-loss'],
        ['new-identity', '--confirm-new-identity'],
      ]) {
        const refused = await runCommand(command, { env: environment() });
        expect(refused.code, command[0]).toBe(1);
        expect(refused.stderr, command[0]).toContain(`process ${process.pid}`);
      }
      expect(readdirSync(join(keyDirectory.dir, 'data-keys')).sort()).toEqual(
        keyFilesBefore,
      );
      // The refusals left the server's lock where it was.
      expect(existsSync(lockFile())).toBe(true);
    } finally {
      await server.stop();
    }
    expect(existsSync(lockFile())).toBe(false);

    const after = await runCommand(['info', '--json'], { env: environment() });

    expect(after.code).toBe(0);
    expect(after.stderr).toBe('');
    const facts = JSON.parse(after.stdout) as {
      database: { driver: string };
      installationId: string | null;
      migrations: { pending: number };
    };
    expect(facts.database.driver).toBe('pglite');
    expect(facts.installationId).not.toBeNull();
    expect(facts.migrations.pending).toBe(0);
    // The command let go of the directory when it was done.
    expect(existsSync(lockFile())).toBe(false);
    expect((await runCommand(['info'], { env: environment() })).code).toBe(0);
  }, 90_000);

  it('is not kept out by the lock file of a process that is gone', async () => {
    const config = serverConfig({ driver: 'pglite', dataDir });
    const server = await startServer(config, {
      signals: new EventEmitter(),
      ...quiet,
    });
    await server.ready;
    await server.stop();
    // A server that was killed leaves its file; its number is nobody's now.
    const gone = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise((resolve) => gone.once('exit', resolve));
    writeFileSync(lockFile(), `${gone.pid}\n`);

    const run = await runCommand(['info'], { env: environment() });

    expect(run.code).toBe(0);
    expect(existsSync(lockFile())).toBe(false);
  }, 90_000);

  it('refuses the three commands that write rows too while a server holds the directory, and runs them once it has stopped', async () => {
    const config = serverConfig({ driver: 'pglite', dataDir });
    const server = await startServer(config, {
      signals: new EventEmitter(),
      ...quiet,
    });
    try {
      await server.ready;
      for (const command of [
        ['emergency-access', '--email', 'someone@example.test'],
        ['revoke-sessions', '--all'],
        ['run-cleanups'],
      ]) {
        const refused = await runCommand(command, { env: environment() });
        expect(refused.code, command[0]).toBe(1);
        expect(refused.stdout, command[0]).toBe('');
        expect(refused.stderr, command[0]).toContain(`process ${process.pid}`);
      }
      // The refusals left the server's lock where it was.
      expect(existsSync(lockFile())).toBe(true);
    } finally {
      await server.stop();
    }

    // Stopped, each opens the directory, runs and lets go of it again.
    for (const command of [['run-cleanups'], ['revoke-sessions', '--all']]) {
      const run = await runCommand(command, { env: environment() });
      expect(run.code, command[0]).toBe(0);
      expect(existsSync(lockFile()), command[0]).toBe(false);
    }
    // A started server has made the installation, and setup is not complete: this is
    // refused for its own reason, not for the lock.
    const emergency = await runCommand(
      ['emergency-access', '--email', 'someone@example.test'],
      { env: environment() },
    );
    expect(emergency.code).toBe(1);
    expect(emergency.stderr).toContain('First-run setup is not complete');
    expect(existsSync(lockFile())).toBe(false);
  }, 90_000);
});

/** The PostgreSQL target, when `DATABASE_URL` names a server. */
const postgres = testTargets.find((target) => target.name === 'postgres');

describe.skipIf(postgres === undefined)(
  'the commands that take no lock, on PostgreSQL',
  () => {
    let url: string;
    let cleanup: () => Promise<void>;
    let holders: () => Promise<number>;

    beforeEach(async () => {
      const created = await createMigratedDatabase(postgres!);
      url = created.url!;
      cleanup = created.cleanup;
      holders = () => inUseHolders(created.database.db);
      await seedInstallation(created.database);
      await bindServerKeys(created.database.db, {
        keysDir: keyDirectory.dir,
        now: new Date(),
      });
      await markSetupComplete(created.database);
    });
    afterEach(async () => {
      await cleanup();
    });

    const environment = () => ({
      DATABASE_URL: url,
      OSFPM_KEYS_DIR: keyDirectory.dir,
      OSFPM_PUBLIC_URL: PUBLIC_URL,
    });

    it('open their own connection from the settings, run beside a running server, and leave nothing held', async () => {
      const server = await startServer(
        serverConfig({ driver: 'postgres', url }),
        { signals: new EventEmitter(), startupSteps: NO_WORK, ...quiet },
      );
      try {
        await server.ready;
        expect(await holders()).toBe(1);

        const info = await runCommand(['info', '--json'], {
          env: environment(),
        });
        const doctor = await runCommand(['doctor'], { env: environment() });

        expect(info.code).toBe(0);
        expect(JSON.parse(info.stdout)).toMatchObject({
          database: { driver: 'postgres' },
          migrations: { pending: 0 },
        });
        expect(doctor.stdout).toContain('Audit: one admin.command-run event');
        // Only the server's lock: a read-only command takes none.
        expect(await holders()).toBe(1);
      } finally {
        await server.stop();
      }
      expect(await holders()).toBe(0);
    });

    it('lets the three commands that write rows run beside a running server, and leave nothing held', async () => {
      const server = await startServer(
        serverConfig({ driver: 'postgres', url }),
        { signals: new EventEmitter(), startupSteps: NO_WORK, ...quiet },
      );
      try {
        await server.ready;
        expect(await holders()).toBe(1);

        const cleanups = await runCommand(['run-cleanups'], {
          env: environment(),
        });
        const revoke = await runCommand(['revoke-sessions', '--all'], {
          env: environment(),
        });
        // Setup was marked complete and there is no one to give access to: refused for
        // that reason, which shows the lock did not stop it.
        const emergency = await runCommand(
          ['emergency-access', '--email', 'someone@example.test'],
          { env: environment() },
        );

        expect(cleanups.code).toBe(0);
        expect(revoke.code).toBe(0);
        expect(emergency.code).toBe(1);
        expect(emergency.stderr).toBe('No account matches.\n');
        // Only the server's lock: none of the three takes one.
        expect(await holders()).toBe(1);
      } finally {
        await server.stop();
      }
      expect(await holders()).toBe(0);
    });
  },
);
