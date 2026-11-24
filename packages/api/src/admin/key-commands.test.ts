import { EventEmitter } from 'node:events';
import {
  copyFileSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTH_AUDIT } from '@osfpm/core/src/auth/shared.js';
import { bindServerKeys } from '@osfpm/core/src/auth/server-key-binding.js';
import {
  seedActiveUser,
  seedInstallation,
  seedTotp,
  totpCodeAt,
} from '@osfpm/core/src/auth/test-support.js';
import { verifyTotp } from '@osfpm/core/src/auth/totp.js';
import { createDatabase, type Database } from '@osfpm/core/src/db/client.js';
import { markDatabaseInUse } from '@osfpm/core/src/db/in-use.js';
import { migrate } from '@osfpm/core/src/db/migrate.js';
import { installation } from '@osfpm/core/src/db/schema/index.js';
import {
  createMigratedDatabase,
  inUseHolders,
  testTargets,
} from '@osfpm/core/src/db/test-support.js';
import type { DataKeyRing } from '@osfpm/core/src/keys/data-keys.js';
import type { ServerIdentity } from '@osfpm/core/src/keys/identity.js';
import {
  loadServerKeys,
  readDataKeyRing,
  readServerIdentity,
  SERVER_KEY_FILES,
} from '@osfpm/core/src/keys/server-keys.js';
import {
  createTestKeyDirectory,
  type TestKeyDirectory,
} from '@osfpm/core/src/keys/test-support.js';
import { buildApp } from '../app.js';
import type { Config } from '../config.js';
import { startServer } from '../server.js';
import { runStartup, type StartupSteps } from '../startup.js';
import { TEST_PUBLIC_ORIGIN } from '../test-support.js';
import { NEW_IDENTITY_NEEDS_CONFIRMATION } from './key-commands.js';
import {
  adminEnvironment,
  auditEventsOf,
  DATABASE_URL_PARTS,
  partialMigrations,
  runCommand,
} from './test-support.js';

const T0 = new Date('2026-03-02T09:00:00.000Z');
const T1 = new Date('2026-03-03T09:00:00.000Z');

/** Every file under `dir`, relative to it, with its content: what a key command may change. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files[path.slice(dir.length)] = readFileSync(path, 'utf8');
  }
  return files;
}

const keyFiles = (dir: string) =>
  readdirSync(join(dir, SERVER_KEY_FILES.dataKeysDirectory)).filter((name) =>
    name.endsWith('.key'),
  );

describe.each(testTargets)(
  'the admin commands that change the data keys, on $name',
  (target) => {
    let database: Database;
    let cleanup: () => Promise<void>;
    let keyDirectory: TestKeyDirectory;
    let strangerDirectory: TestKeyDirectory;
    let ring: DataKeyRing;
    let identity: ServerIdentity;
    let installationId: string;

    beforeEach(async () => {
      ({ database, cleanup } = await createMigratedDatabase(target));
      keyDirectory = createTestKeyDirectory();
      strangerDirectory = createTestKeyDirectory();
      installationId = await seedInstallation(database);
      ({
        keys: { dataKeys: ring, identity },
      } = await bindServerKeys(database.db, {
        keysDir: keyDirectory.dir,
        now: T0,
      }));
    });
    afterEach(async () => {
      await cleanup();
      keyDirectory.remove();
      strangerDirectory.remove();
    });

    const run = (...argv: string[]) =>
      runCommand(argv, {
        env: adminEnvironment(target.name, keyDirectory.dir),
        database,
        now: () => T1,
      });
    const enrolled = async (sealedBy: DataKeyRing = ring) => {
      const userId = await seedActiveUser(database);
      const secret = await seedTotp(database, userId, {
        dataKeys: sealedBy,
        now: T0,
      });
      return { userId, secret };
    };

    describe('rotate-data-key', () => {
      it('adds a new current key, re-seals what it can, says how many, and reminds the operator to keep the old key files', async () => {
        const people = [await enrolled(), await enrolled()];
        const stranger = loadServerKeys(strangerDirectory.dir).dataKeys;
        await enrolled(stranger);

        const { code, stdout, stderr } = await run('rotate-data-key');

        expect(code).toBe(0);
        expect(stderr).toBe('');
        expect(stdout.trimEnd().split('\n')).toEqual([
          'Added a new data key and made it the current one.',
          'Re-sealed 2 authenticator secrets with it.',
          '1 authenticator secret cannot be opened with any key in the key directory and was left as it is.',
          'The old key files were kept. Keep them: an older backup of the database still needs them.',
        ]);
        expect(keyFiles(keyDirectory.dir)).toHaveLength(2);
        // What a server that starts next loads opens the re-sealed secrets.
        const after = readDataKeyRing(keyDirectory.dir)!;
        expect(after.currentKeyId).not.toBe(ring.currentKeyId);
        for (const person of people) {
          expect(
            (
              await verifyTotp(
                database.db,
                person.userId,
                totpCodeAt(person.secret, T1),
                { now: T1, dataKeys: after },
              )
            ).ok,
          ).toBe(true);
        }
      });

      it('says nothing about secrets that cannot be opened when there are none, and says 1 in the singular', async () => {
        await enrolled();

        const { stdout } = await run('rotate-data-key');

        expect(stdout).toContain('Re-sealed 1 authenticator secret with it.');
        expect(stdout).not.toContain('cannot be opened');
      });

      it('writes one auth.data-key-rotated event and no other, from the system, about the installation', async () => {
        await enrolled();

        await run('rotate-data-key');

        const events = await auditEventsOf(database, AUTH_AUDIT.dataKeyRotated);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          actorType: 'system',
          targetType: 'installation',
          targetId: installationId,
          occurredAt: T1,
          details: { resealed: 1, unopenable: 0 },
        });
        expect(
          await auditEventsOf(database, AUTH_AUDIT.adminCommandRun),
        ).toEqual([]);
      });

      it('prints no key, key id, secret, address or database URL, and the audit event has none', async () => {
        const person = await enrolled();
        const outputs = [
          await run('rotate-data-key'),
          await run('rotate-data-key', '--help'),
        ];
        const newKeyId = readDataKeyRing(keyDirectory.dir)!.currentKeyId;
        const everything = [
          ...outputs.map((output) => output.stdout + output.stderr),
          JSON.stringify(
            await auditEventsOf(database, AUTH_AUDIT.dataKeyRotated),
          ),
        ].join('\n');

        for (const forbidden of [
          person.secret,
          person.userId,
          ring.currentKeyId,
          newKeyId,
          'PRIVATE KEY',
          keyDirectory.dir,
          ...DATABASE_URL_PARTS,
        ]) {
          expect(everything).not.toContain(forbidden);
        }
      });

      it('does not take --json: only info and doctor do', async () => {
        const { code, stderr } = await run('rotate-data-key', '--json');

        expect(code).toBe(2);
        expect(stderr).toContain(
          'The command rotate-data-key does not take the option --json.',
        );
        expect(keyFiles(keyDirectory.dir)).toHaveLength(1);
      });

      it('is refused, with the reason, when the server has never started on the database, and writes no key', async () => {
        await database.db.delete(installation);
        const before = snapshot(keyDirectory.dir);

        const { code, stdout, stderr } = await run('rotate-data-key');

        expect(code).toBe(1);
        expect(stdout).toBe('');
        expect(stderr).toContain(
          'There is no installation on this database yet',
        );
        expect(snapshot(keyDirectory.dir)).toEqual(before);
        const [event] = await auditEventsOf(
          database,
          AUTH_AUDIT.adminCommandRun,
        );
        expect(event).toMatchObject({
          details: { command: 'rotate-data-key', outcome: 'refused' },
        });
      });

      it('is refused, with the path and nothing from the file, when a key file is not a key, and changes nothing', async () => {
        await enrolled();
        const bad = join(
          keyDirectory.dir,
          SERVER_KEY_FILES.dataKeysDirectory,
          '0198c1c0-0000-7000-8000-000000000001.key',
        );
        writeFileSync(bad, 'the content of a bad file\n', { mode: 0o600 });
        const before = snapshot(keyDirectory.dir);

        const { code, stdout, stderr } = await run('rotate-data-key');

        expect(code).toBe(1);
        expect(stdout).toBe('');
        expect(stderr).toContain('is not a valid key');
        expect(stderr).not.toContain('the content of a bad file');
        expect(snapshot(keyDirectory.dir)).toEqual(before);
      });
    });

    describe('accept-data-key-loss', () => {
      it('makes a fresh data key for an install whose keys are gone, says how many secrets cannot be opened, and lets the server start', async () => {
        await enrolled();
        await enrolled();
        rmSync(join(keyDirectory.dir, SERVER_KEY_FILES.dataKeysDirectory), {
          recursive: true,
        });
        // The server refuses to start without the keys.
        await expect(
          bindServerKeys(database.db, { keysDir: keyDirectory.dir, now: T1 }),
        ).rejects.toMatchObject({ reason: 'data-keys-missing' });

        const { code, stdout, stderr } = await run('accept-data-key-loss');

        expect(code).toBe(0);
        expect(stderr).toBe('');
        expect(stdout.trimEnd().split('\n')).toEqual([
          'Made a fresh data key and made it the current one. No row was changed.',
          '2 authenticator secrets cannot be opened and stay as they are: the people who set them up sign in with a passkey, a recovery code or a reset link, and set up their authenticator app again.',
          'The server can be started now.',
        ]);
        await expect(
          bindServerKeys(database.db, { keysDir: keyDirectory.dir, now: T1 }),
        ).resolves.toMatchObject({ secretsSealed: 0 });
        const [event] = await auditEventsOf(
          database,
          AUTH_AUDIT.dataKeyLossAccepted,
        );
        expect(event).toMatchObject({
          details: { unopenable: 2 },
          targetId: installationId,
        });
      });

      it('says that no secret is affected when there is none', async () => {
        rmSync(join(keyDirectory.dir, SERVER_KEY_FILES.dataKeysDirectory), {
          recursive: true,
        });

        const { code, stdout } = await run('accept-data-key-loss');

        expect(code).toBe(0);
        expect(stdout).toContain('No authenticator secret is affected.');
      });

      it('changes nothing when a usable current key exists, says how many secrets cannot be opened, and exits 0', async () => {
        await enrolled();
        const stranger = loadServerKeys(strangerDirectory.dir).dataKeys;
        await enrolled(stranger);
        const before = snapshot(keyDirectory.dir);

        const { code, stdout, stderr } = await run('accept-data-key-loss');

        expect(code).toBe(0);
        expect(stderr).toBe('');
        expect(stdout.trimEnd().split('\n')).toEqual([
          'Nothing to accept: the key directory has a usable current data key, and nothing was changed.',
          '1 authenticator secret cannot be opened with the keys it holds.',
        ]);
        expect(snapshot(keyDirectory.dir)).toEqual(before);
        expect(
          await auditEventsOf(database, AUTH_AUDIT.dataKeyLossAccepted),
        ).toEqual([]);
        const [event] = await auditEventsOf(
          database,
          AUTH_AUDIT.adminCommandRun,
        );
        expect(event).toMatchObject({
          details: {
            command: 'accept-data-key-loss',
            outcome: 'nothing-to-do',
            unopenable: 1,
          },
        });
      });

      it('prints no key, key id, secret, address or database URL', async () => {
        const person = await enrolled();
        rmSync(join(keyDirectory.dir, SERVER_KEY_FILES.dataKeysDirectory), {
          recursive: true,
        });
        const first = await run('accept-data-key-loss');
        const second = await run('accept-data-key-loss');
        const everything = [
          first.stdout + first.stderr,
          second.stdout + second.stderr,
          JSON.stringify(await database.db.select().from(installation)),
        ].join('\n');

        for (const forbidden of [
          person.secret,
          person.userId,
          ring.currentKeyId,
          readDataKeyRing(keyDirectory.dir)!.currentKeyId,
          'PRIVATE KEY',
          ...DATABASE_URL_PARTS,
        ]) {
          expect(everything).not.toContain(forbidden);
        }
      });
    });

    describe('new-identity', () => {
      const identityFile = () =>
        join(keyDirectory.dir, SERVER_KEY_FILES.identity);
      const storedKey = async () =>
        (await database.db.select().from(installation))[0]!.serverPublicKey;

      it('refuses without --confirm-new-identity before it touches anything: not the database, not a file', async () => {
        rmSync(identityFile());
        const before = snapshot(keyDirectory.dir);
        const touched = () =>
          Promise.reject(new Error('the database was touched'));
        const untouchable = {
          driver: 'postgres',
          db: { execute: touched, transaction: touched, select: touched },
          close: () => Promise.resolve(),
        } as unknown as Database;

        const refused = await runCommand(['new-identity'], {
          env: adminEnvironment('postgres', keyDirectory.dir),
          database: untouchable,
        });
        const real = await run('new-identity');

        for (const answer of [refused, real]) {
          expect(answer.code).toBe(1);
          expect(answer.stdout).toBe('');
          expect(answer.stderr).toBe(`${NEW_IDENTITY_NEEDS_CONFIRMATION}\n`);
        }
        expect(real.stderr).toContain('--confirm-new-identity');
        expect(snapshot(keyDirectory.dir)).toEqual(before);
        expect(await storedKey()).toBe(identity.publicKey);
        expect(
          await auditEventsOf(database, AUTH_AUDIT.adminCommandRun),
        ).toEqual([]);
      });

      it('replaces the identity of an install whose file is lost: warns on standard error, prints both fingerprints, and lets the server start', async () => {
        rmSync(identityFile());
        await expect(
          bindServerKeys(database.db, { keysDir: keyDirectory.dir, now: T1 }),
        ).rejects.toMatchObject({ reason: 'identity-missing' });

        const { code, stdout, stderr } = await run(
          'new-identity',
          '--confirm-new-identity',
        );

        const made = readServerIdentity(keyDirectory.dir)!;
        expect(code).toBe(0);
        expect(stderr).toContain(
          "Warning: the server's published identity is about to change.",
        );
        expect(stderr).toContain(
          `The old fingerprint is ${identity.fingerprint}.`,
        );
        expect(stderr).not.toContain(made.fingerprint);
        expect(stdout.trimEnd().split('\n')).toEqual([
          'Made a new server identity key and stored its public key.',
          `Old fingerprint: ${identity.fingerprint}`,
          `New fingerprint: ${made.fingerprint}`,
          "The server's published identity has changed. The server can be started now.",
        ]);
        expect(await storedKey()).toBe(made.publicKey);
        await expect(
          bindServerKeys(database.db, { keysDir: keyDirectory.dir, now: T1 }),
        ).resolves.toMatchObject({ identityBound: false });
        // `info` agrees.
        const info = await run('info', '--json');
        expect(JSON.parse(info.stdout)).toMatchObject({
          identity: {
            storedFingerprint: made.fingerprint,
            keyFile: 'matches',
          },
        });
      });

      it('writes one auth.server-identity-replaced event with both fingerprints, and prints and audits nothing secret', async () => {
        rmSync(identityFile());
        const answer = await run('new-identity', '--confirm-new-identity');

        const made = readServerIdentity(keyDirectory.dir)!;
        const events = await auditEventsOf(
          database,
          AUTH_AUDIT.serverIdentityReplaced,
        );
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          actorType: 'system',
          targetId: installationId,
          occurredAt: T1,
          details: {
            oldFingerprint: identity.fingerprint,
            newFingerprint: made.fingerprint,
          },
        });
        const everything = [
          answer.stdout,
          answer.stderr,
          JSON.stringify(events),
        ].join('\n');
        for (const forbidden of [
          made.publicKey,
          identity.publicKey,
          ring.currentKeyId,
          'PRIVATE KEY',
          ...DATABASE_URL_PARTS,
        ]) {
          expect(everything).not.toContain(forbidden);
        }
      });

      const existingIdentityFiles: [string, () => void][] = [
        ['one that matches the stored key', () => undefined],
        [
          'one that holds another key',
          () => {
            loadServerKeys(strangerDirectory.dir);
            rmSync(identityFile());
            copyFileSync(
              join(strangerDirectory.dir, SERVER_KEY_FILES.identity),
              identityFile(),
            );
          },
        ],
        [
          'one that is not a key',
          () => writeFileSync(identityFile(), 'not a key\n', { mode: 0o600 }),
        ],
      ];
      it.each(existingIdentityFiles)(
        'refuses when an identity file exists, %s: it never deletes or overwrites a key file, and says how to go on',
        async (_name, arrange) => {
          arrange();
          const before = snapshot(keyDirectory.dir);
          const keyBefore = await storedKey();

          const { code, stdout, stderr } = await run(
            'new-identity',
            '--confirm-new-identity',
          );

          expect(code).toBe(1);
          expect(stdout).toBe('');
          expect(stderr).toContain(identityFile());
          expect(stderr).toContain('never deletes or overwrites a key file');
          expect(stderr).toContain('move the file away yourself');
          // No warning: nothing was about to change.
          expect(stderr).not.toContain('is about to change');
          expect(snapshot(keyDirectory.dir)).toEqual(before);
          expect(await storedKey()).toBe(keyBefore);
          const [event] = await auditEventsOf(
            database,
            AUTH_AUDIT.adminCommandRun,
          );
          expect(event).toMatchObject({
            details: {
              command: 'new-identity',
              outcome: 'refused',
              reason: 'identity-file-exists',
            },
          });
        },
      );

      it('refuses when no key is stored yet, because start-up binds the first one', async () => {
        await database.db.update(installation).set({ serverPublicKey: null });
        rmSync(identityFile());

        const { code, stderr } = await run(
          'new-identity',
          '--confirm-new-identity',
        );

        expect(code).toBe(1);
        expect(stderr).toContain('stored no identity key yet');
        expect(stderr).toContain('Start the server');
        expect(await storedKey()).toBeNull();
        expect(readdirSync(keyDirectory.dir)).not.toContain(
          SERVER_KEY_FILES.identity,
        );
      });

      it('refuses when the server has never started on the database', async () => {
        await database.db.delete(installation);

        const { code, stderr } = await run(
          'new-identity',
          '--confirm-new-identity',
        );

        expect(code).toBe(1);
        expect(stderr).toContain(
          'There is no installation on this database yet',
        );
      });

      it('is what the next start publishes: the well-known route answers with the new public key', async () => {
        rmSync(identityFile());
        await run('new-identity', '--confirm-new-identity');
        const made = readServerIdentity(keyDirectory.dir)!;
        const app = buildApp({
          db: database,
          publicOrigin: TEST_PUBLIC_ORIGIN,
          logger: { level: 'silent' },
        });
        try {
          // The real start-up: it loads the keys against the database and finds them right.
          await runStartup(
            app,
            { autoMigrate: false, keysDir: keyDirectory.dir },
            undefined,
            { stderr: { write: () => true } },
          );

          const response = await app.inject({
            method: 'GET',
            url: '/.well-known/osfpm/server-key',
          });

          expect(response.statusCode).toBe(200);
          expect(response.json()).toEqual({
            serverId: installationId,
            algorithm: 'Ed25519',
            publicKey: made.publicKey,
            fingerprint: made.fingerprint,
          });
          expect(made.publicKey).not.toBe(identity.publicKey);
        } finally {
          await app.close();
        }
      });
    });

    describe('a key directory that lost both parts', () => {
      /** The whole directory is gone, with sealed secrets in the database that need the data keys. */
      async function loseEverything() {
        await enrolled();
        rmSync(keyDirectory.dir, { recursive: true });
      }
      const start = () =>
        bindServerKeys(database.db, { keysDir: keyDirectory.dir, now: T1 });

      it.each([
        [
          'the data keys first',
          ['accept-data-key-loss'],
          ['new-identity', '--confirm-new-identity'],
          'identity-missing',
        ],
        [
          'the identity first',
          ['new-identity', '--confirm-new-identity'],
          ['accept-data-key-loss'],
          'data-keys-missing',
        ],
      ] as const)(
        'needs both commands, in either order: %s',
        async (_name, first, second, stillRefusedWith) => {
          await loseEverything();
          // Start-up refuses with the first thing it misses.
          await expect(start()).rejects.toMatchObject({
            reason: 'identity-missing',
          });

          expect((await run(...first)).code).toBe(0);
          // One part is back, and start-up says which one is not.
          await expect(start()).rejects.toMatchObject({
            reason: stillRefusedWith,
          });

          expect((await run(...second)).code).toBe(0);
          const started = await start();

          expect(started.keys.identity.publicKey).toBe(
            (await database.db.select().from(installation))[0]!.serverPublicKey,
          );
          expect(started.keys.dataKeys.currentKeyId).toBeTruthy();
          // Both commands left their one event.
          expect(
            await auditEventsOf(database, AUTH_AUDIT.dataKeyLossAccepted),
          ).toHaveLength(1);
          expect(
            await auditEventsOf(database, AUTH_AUDIT.serverIdentityReplaced),
          ).toHaveLength(1);
        },
      );
    });

    it('refuses an offline command while migrations are pending, with the one message, changing nothing, and still lets doctor say what is wrong', async () => {
      const pending = await target.create();
      const partial = partialMigrations(30);
      await migrate(pending.database, partial.folder);
      try {
        const before = snapshot(keyDirectory.dir);
        for (const command of [
          ['rotate-data-key'],
          ['accept-data-key-loss'],
          ['new-identity', '--confirm-new-identity'],
          ['info'],
        ]) {
          const answer = await runCommand(command, {
            env: adminEnvironment(target.name, keyDirectory.dir),
            database: pending.database,
          });

          expect(answer.code, command[0]).toBe(1);
          expect(answer.stdout, command[0]).toBe('');
          expect(answer.stderr, command[0]).toContain('Start the server once');
        }
        expect(snapshot(keyDirectory.dir)).toEqual(before);
        const doctor = await runCommand(['doctor', '--json'], {
          env: adminEnvironment(target.name, keyDirectory.dir),
          database: pending.database,
          freeSpace: () => 50,
        });
        expect(doctor.code).toBe(1);
        expect(doctor.stdout).toContain('"migrations"');
      } finally {
        await pending.cleanup();
        rmSync(partial.root, { recursive: true, force: true });
      }
    });
  },
);

/** The PostgreSQL target, when `DATABASE_URL` names a server. */
const postgres = testTargets.find((target) => target.name === 'postgres');

describe.skipIf(postgres === undefined)(
  'an admin command that needs every server stopped, on PostgreSQL',
  () => {
    let url: string;
    let database: Database;
    let cleanup: () => Promise<void>;
    let keyDirectory: TestKeyDirectory;

    beforeEach(async () => {
      const created = await createMigratedDatabase(postgres!);
      ({ database, cleanup } = created);
      url = created.url!;
      keyDirectory = createTestKeyDirectory();
      await seedInstallation(database);
      await bindServerKeys(database.db, {
        keysDir: keyDirectory.dir,
        now: T0,
      });
    });
    afterEach(async () => {
      await cleanup();
      keyDirectory.remove();
    });

    const environment = () => ({
      DATABASE_URL: url,
      OSFPM_KEYS_DIR: keyDirectory.dir,
      OSFPM_PUBLIC_URL: 'http://localhost:3000',
    });
    const serverConfig = (): Config => ({
      database: { driver: 'postgres', url },
      keysDir: keyDirectory.dir,
      host: '127.0.0.1',
      port: 0,
      logLevel: 'silent',
      publicOrigin: 'http://localhost:3000',
      autoMigrate: true,
      trustedProxies: [],
    });
    const noWork: StartupSteps = {
      migrate: () => Promise.resolve(),
      syncPermissions: () => Promise.resolve(),
    };

    it.each([
      [['rotate-data-key']],
      [['accept-data-key-loss']],
      [['new-identity', '--confirm-new-identity']],
    ])(
      'refuses %j at once while a server is running, and changes nothing',
      async (command) => {
        // The identity command needs its file to be lost, as it is when it is wanted.
        if (command[0] === 'new-identity') {
          rmSync(join(keyDirectory.dir, SERVER_KEY_FILES.identity));
        }
        const server = await startServer(serverConfig(), {
          signals: new EventEmitter(),
          startupSteps: noWork,
          stderr: { write: () => true },
        });
        try {
          await server.ready;
          const before = snapshot(keyDirectory.dir);

          const run = await runCommand(command, { env: environment() });

          expect(run.code).toBe(1);
          expect(run.stdout).toBe('');
          expect(run.stderr).toBe(
            'A server is using this database. Stop every server, run the command, then start them again.\n',
          );
          expect(snapshot(keyDirectory.dir)).toEqual(before);
          expect(
            await auditEventsOf(database, AUTH_AUDIT.adminCommandRun),
          ).toEqual([]);
          expect(await inUseHolders(database.db)).toBe(1);
        } finally {
          await server.stop();
        }

        // With the server stopped the same command goes through, and lets go of the lock.
        const again = await runCommand(command, { env: environment() });
        expect(again.code).toBe(0);
        expect(await inUseHolders(database.db)).toBe(0);
      },
    );

    it('is refused by another admin command that is running, and not by a command that only reads', async () => {
      const running = markDatabaseInUse(
        { driver: 'postgres', url },
        'offline-command',
      );
      const own = createDatabase({ driver: 'postgres', url });
      await running.attach(own);
      try {
        const second = await runCommand(['rotate-data-key'], {
          env: environment(),
        });
        const reader = await runCommand(['info'], { env: environment() });

        expect(second.code).toBe(1);
        expect(second.stderr).toContain('A server is using this database');
        expect(reader.code).toBe(0);
      } finally {
        await running.close(own);
      }
    });
  },
);
