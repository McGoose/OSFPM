import { copyFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedOrganisation } from '@osfpm/core/src/access/test-fixtures.js';
import { bindServerKeys } from '@osfpm/core/src/auth/server-key-binding.js';
import {
  markSetupComplete,
  markUserDeleted,
  seedActiveUser,
  seedInstallation,
  seedTotp,
  seedUserWithStatus,
} from '@osfpm/core/src/auth/test-support.js';
import type { Database } from '@osfpm/core/src/db/client.js';
import { migrate } from '@osfpm/core/src/db/migrate.js';
import {
  installation,
  totpCredential,
  user,
} from '@osfpm/core/src/db/schema/index.js';
import {
  createMigratedDatabase,
  testTargets,
} from '@osfpm/core/src/db/test-support.js';
import type { ServerKeys } from '@osfpm/core/src/keys/server-keys.js';
import {
  loadServerKeys,
  SERVER_KEY_FILES,
} from '@osfpm/core/src/keys/server-keys.js';
import {
  createTestKeyDirectory,
  type TestKeyDirectory,
} from '@osfpm/core/src/keys/test-support.js';
import { PACKAGE_VERSION } from '../package-info.js';
import {
  adminEnvironment,
  auditEventsOf,
  DATABASE_URL_PARTS,
  partialMigrations,
  runCommand,
} from './test-support.js';

const T0 = new Date('2026-03-02T09:00:00.000Z');

describe.each(testTargets)('the admin command info on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  let keyDirectory: TestKeyDirectory;
  let otherKeyDirectory: TestKeyDirectory;
  let bound: { keys: ServerKeys };
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
  });
  afterEach(async () => {
    await cleanup();
    keyDirectory.remove();
    otherKeyDirectory.remove();
  });

  const run = (...argv: string[]) =>
    runCommand(argv, {
      env: adminEnvironment(target.name, keyDirectory.dir),
      database,
      now: () => T0,
    });

  /** Four kinds of user and secret, one organisation, setup complete. Returns what a name or an address would have been. */
  async function populate() {
    const stranger = loadServerKeys(otherKeyDirectory.dir).dataKeys;
    const dataKeys = bound.keys.dataKeys;
    const a = await seedActiveUser(database);
    const b = await seedActiveUser(database);
    const invited = await seedUserWithStatus(database, 'invited');
    const disabled = await seedUserWithStatus(database, 'disabled');
    const gone = await seedActiveUser(database);
    await markUserDeleted(database, gone, T0);
    await seedTotp(database, a, { dataKeys, now: T0 });
    await seedTotp(database, b, { dataKeys, now: T0, confirmed: false });
    await seedTotp(database, invited, { dataKeys, now: T0, plain: true });
    // Sealed with a key this server does not hold.
    await seedTotp(database, disabled, { dataKeys: stranger, now: T0 });
    await seedOrganisation(database);
    await markSetupComplete(database, T0);
  }

  it('prints what the installation holds, as text, and exits 0', async () => {
    await populate();

    const { code, stdout, stderr } = await run('info');

    expect(code).toBe(0);
    expect(stderr).toBe('');
    const lines = stdout.trimEnd().split('\n');
    expect(lines[0]).toBe(`OSFPM ${PACKAGE_VERSION}`);
    expect(lines).toContain(`Installation id: ${installationId}`);
    expect(lines).toContain(`Database: ${target.name}`);
    expect(lines).toContain(`Setup: complete since ${T0.toISOString()}`);
    expect(lines).toContain(`Identity key: ${bound.keys.identity.fingerprint}`);
    expect(lines).toContain('Identity key file: matches the stored key');
    expect(lines).toContain('Data key files: 1');
    expect(lines).toContain(
      'Authenticator secrets: 3 sealed, 1 plain, 1 sealed but cannot be opened',
    );
    expect(lines).toContain('Organisations: 1');
    expect(lines).toContain(
      'Users: 2 active, 1 invited, 1 disabled, 1 deleted',
    );
    expect(lines.find((line) => line.startsWith('Migrations: '))).toMatch(
      /^Migrations: \d+ applied, 0 pending$/,
    );
  });

  it('prints the same facts as JSON with --json, in a shape that does not change', async () => {
    await populate();

    const { code, stdout, stderr } = await run('info', '--json');

    expect(code).toBe(0);
    expect(stderr).toBe('');
    const report = JSON.parse(stdout) as Record<string, unknown>;
    expect(Object.keys(report)).toEqual([
      'command',
      'product',
      'version',
      'installationId',
      'database',
      'migrations',
      'setup',
      'identity',
      'dataKeys',
      'totpSecrets',
      'organisations',
      'users',
    ]);
    const { migrations, ...rest } = report;
    expect(migrations).toMatchObject({ pending: 0 });
    expect((migrations as { applied: number }).applied).toBeGreaterThan(30);
    expect(rest).toEqual({
      command: 'info',
      product: 'OSFPM',
      version: PACKAGE_VERSION,
      installationId,
      database: { driver: target.name },
      setup: { complete: true, completedAt: T0.toISOString() },
      identity: {
        storedFingerprint: bound.keys.identity.fingerprint,
        keyFile: 'matches',
        keyFileProblem: null,
      },
      dataKeys: { files: 1 },
      totpSecrets: { sealed: 3, plain: 1, unopenable: 1 },
      organisations: 1,
      users: { invited: 1, active: 2, disabled: 1, deleted: 1 },
    });
  });

  it('writes one admin.command-run event, from the system, with the counts, and changes nothing else', async () => {
    await populate();
    const before = {
      secrets: await database.db.select().from(totpCredential),
      installation: await database.db.select().from(installation),
      users: await database.db
        .select({ id: user.id, status: user.status })
        .from(user),
    };

    await run('info');

    const events = await auditEventsOf(database, 'admin.command-run');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'run',
      actorType: 'system',
      actorId: null,
      targetType: 'installation',
      targetId: installationId,
      occurredAt: T0,
      details: {
        command: 'info',
        outcome: 'completed',
        sealed: 3,
        plain: 1,
        unopenable: 1,
        organisations: 1,
        users: 4,
      },
    });
    expect({
      secrets: await database.db.select().from(totpCredential),
      installation: await database.db.select().from(installation),
      users: await database.db
        .select({ id: user.id, status: user.status })
        .from(user),
    }).toEqual(before);
  });

  it('prints no name, address, key, key id, secret or database address, in the text, the JSON, the log of errors or the audit event', async () => {
    await populate();
    const people = await database.db
      .select({ email: user.email, displayName: user.displayName })
      .from(user);
    const stored = await database.db
      .select({ secret: totpCredential.secret })
      .from(totpCredential);
    const outputs = [
      await run('info'),
      await run('info', '--json'),
      await run('info', '--help'),
    ];
    const everything = [
      ...outputs.map((output) => output.stdout + output.stderr),
      JSON.stringify(await auditEventsOf(database, 'admin.command-run')),
    ].join('\n');

    expect(people.length).toBeGreaterThan(3);
    for (const person of people) {
      expect(everything).not.toContain(person.email);
      expect(everything).not.toContain(person.displayName);
    }
    for (const { secret } of stored) expect(everything).not.toContain(secret);
    expect(everything).not.toContain(bound.keys.dataKeys.currentKeyId);
    expect(everything).not.toContain('PRIVATE KEY');
    expect(everything).not.toContain(keyDirectory.dir);
    for (const part of DATABASE_URL_PARTS) {
      expect(everything).not.toContain(part);
    }
  });

  it('counts every sealed secret as one that cannot be opened when the data keys are gone, and says how many data key files there are', async () => {
    await populate();
    rmSync(join(keyDirectory.dir, SERVER_KEY_FILES.dataKeysDirectory), {
      recursive: true,
    });

    const { code, stdout } = await run('info', '--json');

    expect(code).toBe(0);
    const report = JSON.parse(stdout) as {
      totpSecrets: unknown;
      dataKeys: unknown;
    };
    expect(report.totpSecrets).toEqual({ sealed: 3, plain: 1, unopenable: 3 });
    expect(report.dataKeys).toEqual({ files: 0 });
  });

  describe('the identity key file', () => {
    const keyFile = async () => {
      const { stdout } = await run('info', '--json');
      return (JSON.parse(stdout) as { identity: unknown }).identity;
    };

    it('is missing when the installation stored a key and the file is gone', async () => {
      rmSync(join(keyDirectory.dir, SERVER_KEY_FILES.identity));

      expect(await keyFile()).toEqual({
        storedFingerprint: bound.keys.identity.fingerprint,
        keyFile: 'missing',
        keyFileProblem: null,
      });
    });

    it('does not match when the file holds another installation’s key', async () => {
      rmSync(join(keyDirectory.dir, SERVER_KEY_FILES.identity));
      const other = loadServerKeys(otherKeyDirectory.dir);
      copyFileSync(
        join(otherKeyDirectory.dir, SERVER_KEY_FILES.identity),
        join(keyDirectory.dir, SERVER_KEY_FILES.identity),
      );

      const identity = (await keyFile()) as { keyFile: string };

      expect(identity.keyFile).toBe('does-not-match');
      // The fingerprint printed is the stored one, not the file's.
      expect(JSON.stringify(identity)).not.toContain(
        other.identity.fingerprint,
      );
    });

    it('cannot be used when it is not an identity key, and says only why in a fixed word', async () => {
      rmSync(join(keyDirectory.dir, SERVER_KEY_FILES.identity));
      writeFileSync(
        join(keyDirectory.dir, SERVER_KEY_FILES.identity),
        'not a key at all',
        { mode: 0o600 },
      );

      const { stdout } = await run('info');

      expect(stdout).toContain('Identity key file: cannot be used (invalid)');
      expect(stdout).not.toContain('not a key at all');
    });

    it('cannot be compared when the installation has stored no key yet', async () => {
      await database.db.update(installation).set({ serverPublicKey: null });

      expect(await keyFile()).toEqual({
        storedFingerprint: null,
        keyFile: 'not-stored',
        keyFileProblem: null,
      });
    });
  });

  it('works on a database no server has started on: no installation, nothing counted', async () => {
    await database.db.delete(installation);

    const { code, stdout } = await run('info', '--json');

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      installationId: null,
      setup: { complete: false, completedAt: null },
      identity: { storedFingerprint: null },
      organisations: 0,
    });
    const [event] = await auditEventsOf(database, 'admin.command-run');
    expect(event).toMatchObject({ targetType: null, targetId: null });
  });
});

describe.each(testTargets)(
  'the admin command line with migrations pending on $name',
  (target) => {
    let database: Database;
    let cleanup: () => Promise<void>;
    let keyDirectory: TestKeyDirectory;
    let partial: { folder: string; root: string };

    beforeEach(async () => {
      ({ database, cleanup } = await target.create());
      // Far enough for the audit log to exist, so that "nothing was written" can be looked at.
      partial = partialMigrations(30);
      await migrate(database, partial.folder);
      keyDirectory = createTestKeyDirectory();
    });
    afterEach(async () => {
      await cleanup();
      keyDirectory.remove();
      rmSync(partial.root, { recursive: true, force: true });
    });

    it('refuses info, tells the operator to start the server, and writes nothing', async () => {
      const { code, stdout, stderr } = await runCommand(['info'], {
        env: adminEnvironment(target.name, keyDirectory.dir),
        database,
        now: () => T0,
      });

      expect(code).toBe(1);
      expect(stdout).toBe('');
      expect(stderr).toMatch(/migrations? that (is|are) not applied yet/);
      expect(stderr).toContain('Start the server once');
      expect(await auditEventsOf(database, 'admin.command-run')).toEqual([]);
      // Nothing was made in the key directory either.
      expect(readdirSync(keyDirectory.dir)).toEqual([]);
    });
  },
);
