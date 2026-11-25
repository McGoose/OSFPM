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
import { bindServerKeys } from '@osfpm/core/src/auth/server-key-binding.js';
import {
  markSetupComplete,
  seedInstallation,
} from '@osfpm/core/src/auth/test-support.js';
import { PGLITE_LOCK_FILE } from '@osfpm/core/src/db/in-use.js';
import {
  createMigratedDatabase,
  inUseHolders,
  testTargets,
} from '@osfpm/core/src/db/test-support.js';
import { createTestKeyDirectory } from '@osfpm/core/src/keys/test-support.js';
import type { Config } from '../config.js';
import { startServer } from '../server.js';
import type { StartupSteps } from '../startup.js';
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
});

/** The PostgreSQL target, when `DATABASE_URL` names a server. */
const postgres = testTargets.find((target) => target.name === 'postgres');

describe.skipIf(postgres === undefined)(
  'the commands that only read, on PostgreSQL',
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
  },
);
