import { chmodSync, copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bindServerKeys } from '@osfpm/core/src/auth/server-key-binding.js';
import {
  markSetupComplete,
  seedActiveUser,
  seedInstallation,
  seedTotp,
} from '@osfpm/core/src/auth/test-support.js';
import { TOTP_SETTINGS } from '@osfpm/core/src/auth/totp.js';
import type { Database } from '@osfpm/core/src/db/client.js';
import { migrate } from '@osfpm/core/src/db/migrate.js';
import { installation } from '@osfpm/core/src/db/schema/index.js';
import {
  createMigratedDatabase,
  testTargets,
} from '@osfpm/core/src/db/test-support.js';
import {
  loadServerKeys,
  SERVER_KEY_FILES,
} from '@osfpm/core/src/keys/server-keys.js';
import {
  createTestKeyDirectory,
  type TestKeyDirectory,
} from '@osfpm/core/src/keys/test-support.js';
import {
  clockCheck,
  diskCheck,
  DOCTOR_CHECKS,
  MIN_FREE_DISK_PERCENT,
  publicUrlCheck,
  type CheckStatus,
  type DoctorReport,
} from './doctor.js';
import {
  adminEnvironment,
  auditEventsOf,
  DATABASE_URL_PARTS,
  FAKE_DATABASE_URL,
  partialMigrations,
  runCommand,
} from './test-support.js';

const T0 = new Date('2026-03-02T09:00:00.000Z');
const SECOND = 1000;

/** The status of each check by id, from a `--json` run. */
function statusesOf(report: DoctorReport): Record<string, CheckStatus> {
  return Object.fromEntries(
    report.checks.map((check) => [check.id, check.status]),
  );
}

describe.each(testTargets)('the admin command doctor on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  let keyDirectory: TestKeyDirectory;
  let otherKeyDirectory: TestKeyDirectory;
  let bound: Awaited<ReturnType<typeof bindServerKeys>>;
  let installationId: string;

  beforeEach(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    keyDirectory = createTestKeyDirectory();
    otherKeyDirectory = createTestKeyDirectory();
    installationId = await seedInstallation(database);
    bound = await bindServerKeys(database.db, {
      keysDir: keyDirectory.dir,
      now: T0,
    });
    await markSetupComplete(database, T0);
  });
  afterEach(async () => {
    await cleanup();
    keyDirectory.remove();
    otherKeyDirectory.remove();
  });

  /** Runs `doctor` with plenty of disk, as `--json`, unless `argv` says otherwise. */
  const run = (
    argv: string[] = ['doctor', '--json'],
    context: { now?: () => Date; freeSpace?: () => number | null } = {},
  ) =>
    runCommand(argv, {
      env: adminEnvironment(target.name, keyDirectory.dir),
      database,
      freeSpace: () => 50,
      ...context,
    });
  const report = async (context?: Parameters<typeof run>[1]) =>
    JSON.parse(
      (await run(['doctor', '--json'], context)).stdout,
    ) as DoctorReport;

  it('finds a healthy installation ok in every check, prints a line for each, and exits 0', async () => {
    const { code, stdout, stderr } = await run(['doctor']);

    expect(code).toBe(0);
    expect(stderr).toBe('');
    const lines = stdout.trimEnd().split('\n');
    for (const { title } of DOCTOR_CHECKS) {
      expect(
        lines.filter((line) => line.startsWith('ok') && line.includes(title)),
        title,
      ).toHaveLength(1);
    }
    expect(lines).toContain('Audit: one admin.command-run event was written.');
    expect(lines.at(-1)).toBe('11 ok, 0 warn, 0 fail, 0 skipped');
  });

  it('prints the same as JSON with --json, in a shape that does not change', async () => {
    const result = await report();

    expect(Object.keys(result)).toEqual([
      'command',
      'checks',
      'summary',
      'audit',
    ]);
    expect(result.command).toBe('doctor');
    expect(result.checks.map((check) => check.id)).toEqual(
      DOCTOR_CHECKS.map((check) => check.id),
    );
    for (const check of result.checks) {
      expect(Object.keys(check)).toEqual(['id', 'title', 'status', 'reason']);
      expect(check.reason.length).toBeGreaterThan(0);
      expect(check.reason).not.toContain('\n');
    }
    expect(result.summary).toEqual({ ok: 11, warn: 0, fail: 0, skipped: 0 });
    expect(result.audit).toEqual({ recorded: true, reason: null });
  });

  it('writes one admin.command-run event, from the system, with the totals', async () => {
    await run(['doctor']);

    const events = await auditEventsOf(database, 'admin.command-run');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'run',
      actorType: 'system',
      actorId: null,
      targetType: 'installation',
      targetId: installationId,
      details: {
        command: 'doctor',
        outcome: 'completed',
        ok: 11,
        warn: 0,
        fail: 0,
        skipped: 0,
      },
    });
  });

  it('warns, and still exits 0, when setup is not complete or no installation exists yet', async () => {
    await database.db.update(installation).set({ setupCompletedAt: null });
    expect(statusesOf(await report()).setup).toBe('warn');
    expect((await run(['doctor'])).code).toBe(0);

    await database.db.delete(installation);
    const result = await report();
    expect(statusesOf(result)).toMatchObject({
      setup: 'warn',
      // Nothing is stored to compare the identity file with.
      identity: 'warn',
    });
    expect(
      result.checks.find((check) => check.id === 'setup')?.reason,
    ).toContain('no installation yet');
  });

  it('warns with the count when a sealed secret cannot be opened, and exits 0', async () => {
    const stranger = loadServerKeys(otherKeyDirectory.dir).dataKeys;
    await seedTotp(database, await seedActiveUser(database), {
      dataKeys: bound.keys.dataKeys,
      now: T0,
    });
    await seedTotp(database, await seedActiveUser(database), {
      dataKeys: stranger,
      now: T0,
    });

    const result = await report();

    expect(statusesOf(result).secrets).toBe('warn');
    expect(
      result.checks.find((check) => check.id === 'secrets')?.reason,
    ).toContain('1 of 2 sealed secrets cannot be opened');
    expect((await run(['doctor'])).code).toBe(0);
  });

  it('fails, and exits 1, when sealed secrets exist and the data keys are gone', async () => {
    await seedTotp(database, await seedActiveUser(database), {
      dataKeys: bound.keys.dataKeys,
      now: T0,
    });
    rmSync(join(keyDirectory.dir, SERVER_KEY_FILES.dataKeysDirectory), {
      recursive: true,
    });

    const { code, stdout } = await run(['doctor']);
    const result = await report();

    expect(code).toBe(1);
    expect(statusesOf(result)).toMatchObject({
      'data-keys': 'fail',
      secrets: 'warn',
    });
    expect(stdout).toContain('accept-data-key-loss');
  });

  it('does not mind missing data keys while no secret is sealed: the server makes them', async () => {
    rmSync(join(keyDirectory.dir, SERVER_KEY_FILES.dataKeysDirectory), {
      recursive: true,
    });

    const result = await report();

    expect(statusesOf(result)['data-keys']).toBe('ok');
    expect((await run(['doctor'])).code).toBe(0);
  });

  it('fails when the identity file is missing, when it is another key, and when it cannot be used', async () => {
    const identityFile = join(keyDirectory.dir, SERVER_KEY_FILES.identity);

    rmSync(identityFile);
    expect(statusesOf(await report()).identity).toBe('fail');
    expect((await run(['doctor'])).code).toBe(1);

    // Another installation's key, which the stored one does not match.
    const other = loadServerKeys(otherKeyDirectory.dir);
    copyFileSync(
      join(otherKeyDirectory.dir, SERVER_KEY_FILES.identity),
      identityFile,
    );
    const mismatch = await report();
    expect(statusesOf(mismatch).identity).toBe('fail');
    expect(JSON.stringify(mismatch)).not.toContain(other.identity.fingerprint);
    expect(JSON.stringify(mismatch)).not.toContain(other.identity.publicKey);

    rmSync(identityFile);
    writeFileSync(identityFile, 'not a key', { mode: 0o600 });
    const invalid = await report();
    expect(statusesOf(invalid).identity).toBe('fail');
    expect(
      invalid.checks.find((check) => check.id === 'identity')?.reason,
    ).toContain('(invalid)');
  });

  it('fails when the key directory is gone and this installation needs its keys, and only warns when it does not', async () => {
    rmSync(keyDirectory.dir, { recursive: true });
    expect(statusesOf(await report())['key-directory']).toBe('fail');

    // Nothing stored and nothing sealed: the server makes the directory at its first start.
    await database.db.update(installation).set({ serverPublicKey: null });
    expect(statusesOf(await report())['key-directory']).toBe('warn');
  });

  it('warns when the local clock is more than one authenticator code period from the database, and not otherwise', async () => {
    const tenMinutes = 10 * 60 * SECOND;
    const ahead = await report({
      now: () => new Date(Date.now() + tenMinutes),
    });
    expect(statusesOf(ahead).clock).toBe('warn');
    expect(
      ahead.checks.find((check) => check.id === 'clock')?.reason,
    ).toContain(`${TOTP_SETTINGS.periodSeconds} seconds`);

    const behind = await report({
      now: () => new Date(Date.now() - tenMinutes),
    });
    expect(statusesOf(behind).clock).toBe('warn');

    const close = await report({
      now: () => new Date(Date.now() + 5 * SECOND),
    });
    expect(statusesOf(close).clock).toBe('ok');
    expect(close.summary.warn).toBe(0);
  });

  it('warns about a disk that is nearly full, and still exits 0', async () => {
    const result = await report({ freeSpace: () => MIN_FREE_DISK_PERCENT - 1 });

    expect(statusesOf(result).disk).toBe('warn');
    expect(
      result.checks.find((check) => check.id === 'disk')?.reason,
    ).toContain('key directory');
    expect(result.summary.fail).toBe(0);
  });

  it('puts what it cannot check after a failure as skipped, with the reason, and says no event was written for pending migrations', async () => {
    const partial = partialMigrations(30);
    const migrating = await createMigratedDatabaseWith(target, partial.folder);
    try {
      const { code, stdout } = await runCommand(['doctor', '--json'], {
        env: adminEnvironment(target.name, keyDirectory.dir),
        database: migrating.database,
        freeSpace: () => 50,
      });
      const result = JSON.parse(stdout) as DoctorReport;

      expect(code).toBe(1);
      expect(statusesOf(result)).toMatchObject({
        config: 'ok',
        database: 'ok',
        migrations: 'fail',
        setup: 'skipped',
        identity: 'skipped',
        'data-keys': 'skipped',
        secrets: 'skipped',
        'public-url': 'ok',
      });
      expect(
        result.checks.find((check) => check.id === 'migrations')?.reason,
      ).toMatch(/^\d+ pending: start the server once/);
      expect(result.checks.find((check) => check.id === 'setup')?.reason).toBe(
        'needs the migrations to be applied',
      );
      expect(result.audit.recorded).toBe(false);
      expect(result.audit.reason).toContain('migrations are not applied');
    } finally {
      await migrating.cleanup();
      rmSync(partial.root, { recursive: true, force: true });
    }
  });

  it('prints no key, key id, secret, address or database URL in any of its answers, or in its audit event', async () => {
    const secret = await seedTotp(database, await seedActiveUser(database), {
      dataKeys: bound.keys.dataKeys,
      now: T0,
    });
    const outputs = [
      await run(['doctor']),
      await run(['doctor', '--json']),
      await run(['doctor', '--help']),
    ];
    rmSync(join(keyDirectory.dir, SERVER_KEY_FILES.dataKeysDirectory), {
      recursive: true,
    });
    outputs.push(await run(['doctor']));
    const everything = [
      ...outputs.map((output) => output.stdout + output.stderr),
      JSON.stringify(await auditEventsOf(database, 'admin.command-run')),
    ].join('\n');

    expect(everything).not.toContain(secret);
    expect(everything).not.toContain(bound.keys.dataKeys.currentKeyId);
    expect(everything).not.toContain(bound.keys.identity.publicKey);
    expect(everything).not.toContain('PRIVATE KEY');
    for (const part of DATABASE_URL_PARTS) {
      expect(everything).not.toContain(part);
    }
  });

  describe.skipIf(process.platform === 'win32')(
    'on a system with file modes',
    () => {
      it('fails when a key file can be read by other users, and counts them', async () => {
        chmodSync(join(keyDirectory.dir, SERVER_KEY_FILES.identity), 0o644);

        const result = await report();

        expect(statusesOf(result)['key-directory']).toBe('fail');
        expect(
          result.checks.find((check) => check.id === 'key-directory')?.reason,
        ).toContain('1 key file is readable by other users');
        expect((await run(['doctor'])).code).toBe(1);
      });
    },
  );
});

/** A database on `target` with the migrations of `folder` applied, and nothing else. */
async function createMigratedDatabaseWith(
  target: (typeof testTargets)[number],
  folder: string,
) {
  const created = await target.create();
  await migrate(created.database, folder);
  return created;
}

describe('the admin command doctor without a working database', () => {
  const keys = createTestKeyDirectory();
  afterAll(() => keys.remove());

  it('reports an unreachable database as a failed check, skips what needs it, writes no event, and never repeats the address or the password', async () => {
    const refused = Object.assign(
      new Error(`connect ECONNREFUSED 10.1.2.3:5432 ${FAKE_DATABASE_URL}`),
      { code: 'ECONNREFUSED' },
    );
    const unreachable = {
      driver: 'postgres',
      db: { execute: () => Promise.reject(refused) },
      close: () => Promise.resolve(),
    } as unknown as Database;

    const { code, stdout, stderr } = await runCommand(['doctor', '--json'], {
      env: adminEnvironment('postgres', keys.dir),
      database: unreachable,
      freeSpace: () => 50,
    });

    const result = JSON.parse(stdout) as DoctorReport;
    expect(code).toBe(1);
    expect(statusesOf(result)).toMatchObject({
      config: 'ok',
      database: 'fail',
      migrations: 'skipped',
      setup: 'skipped',
      identity: 'skipped',
      'data-keys': 'skipped',
      secrets: 'skipped',
      clock: 'skipped',
    });
    expect(result.checks.find((check) => check.id === 'database')?.reason).toBe(
      'The database could not be reached: Error (ECONNREFUSED).',
    );
    expect(result.audit).toEqual({
      recorded: false,
      reason: 'the database could not be reached',
    });
    const everything = stdout + stderr;
    for (const part of [...DATABASE_URL_PARTS, '10.1.2.3']) {
      expect(everything).not.toContain(part);
    }
    // The text form says the same, in words.
    const text = await runCommand(['doctor'], {
      env: adminEnvironment('postgres', keys.dir),
      database: unreachable,
      freeSpace: () => 50,
    });
    expect(text.stdout).toContain(
      'Audit: no event was written (the database could not be reached).',
    );
  });

  it('reports invalid settings as the one failed check, skips the rest, and names the variable and never its value', async () => {
    const { code, stdout } = await runCommand(['doctor', '--json'], {
      env: {
        DATABASE_URL: FAKE_DATABASE_URL,
        OSFPM_KEYS_DIR: keys.dir,
        OSFPM_PUBLIC_URL: 'http://not-allowed.example.org',
      },
    });

    const result = JSON.parse(stdout) as DoctorReport;
    expect(code).toBe(1);
    expect(result.summary).toEqual({ ok: 0, warn: 0, fail: 1, skipped: 10 });
    expect(statusesOf(result).config).toBe('fail');
    const reason = result.checks[0]!.reason;
    expect(reason).toContain('OSFPM_PUBLIC_URL');
    expect(stdout).not.toContain('not-allowed.example.org');
    expect(result.audit.reason).toContain('settings are not valid');
  });
});

describe('the checks that need no database', () => {
  describe('publicUrlCheck', () => {
    it.each([
      ['https://osfpm.example.org', 'ok'],
      ['http://localhost:3000', 'ok'],
      ['http://127.0.0.1:8080', 'ok'],
      ['http://osfpm.example.org', 'warn'],
      ['http://localhost.example.org', 'warn'],
      ['not a url', 'fail'],
    ] as const)('says %s is %s', (origin, status) => {
      expect(publicUrlCheck(origin).status).toBe(status);
    });

    it('does not repeat the address in its reason', () => {
      const { reason } = publicUrlCheck('http://osfpm.example.org');

      expect(reason).not.toContain('osfpm.example.org');
      expect(reason).toContain('passkeys');
    });
  });

  describe('clockCheck', () => {
    const period = TOTP_SETTINGS.periodSeconds * SECOND;

    it('is ok up to one authenticator code period and warns beyond it, in either direction', () => {
      expect(clockCheck(1_000_000, 1_000_000).status).toBe('ok');
      expect(clockCheck(1_000_000, 1_000_000 + period).status).toBe('ok');
      expect(clockCheck(1_000_000, 1_000_000 - period).status).toBe('ok');
      expect(clockCheck(1_000_000, 1_000_000 + period + 1).status).toBe('warn');
      expect(clockCheck(1_000_000, 1_000_000 - period - 1).status).toBe('warn');
    });
  });

  describe('diskCheck', () => {
    const folders = [
      { name: 'data directory', path: '/data' },
      { name: 'key directory', path: '/keys' },
    ];

    it('is ok when every folder has at least the minimum free, and names each one', () => {
      const found = diskCheck(folders, () => MIN_FREE_DISK_PERCENT);

      expect(found.status).toBe('ok');
      expect(found.reason).toContain('data directory: 10 % free');
      expect(found.reason).toContain('key directory: 10 % free');
    });

    it('warns when one has less, with a decimal where it matters, and when one cannot be read', () => {
      const low = diskCheck(folders, (path) => (path === '/keys' ? 4.25 : 60));
      expect(low.status).toBe('warn');
      expect(low.reason).toContain('key directory: 4.3 % free');
      expect(low.reason).toContain('data directory: 60 % free');

      const unread = diskCheck(folders, () => null);
      expect(unread.status).toBe('warn');
      expect(unread.reason).toContain('could not be read');
    });

    it('reads the real disk when it is not told how, and answers a percentage it can print', () => {
      const found = diskCheck([{ name: 'here', path: process.cwd() }]);

      expect(['ok', 'warn']).toContain(found.status);
      expect(found.reason).toMatch(/^here: \d+(\.\d)? % free/);
    });
  });
});
