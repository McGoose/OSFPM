import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import {
  auditEvent,
  installation,
  totpCredential,
} from '../db/schema/index.js';
import {
  createMigratedDatabase,
  interleave,
  succeeded,
  testTargets,
} from '../db/test-support.js';
import { DataKeyRing } from '../keys/data-keys.js';
import { ServerKeysError } from '../keys/errors.js';
import { publicKeyFingerprint } from '../keys/identity.js';
import {
  loadServerKeys,
  readDataKeyRing,
  readServerIdentity,
  SERVER_KEY_FILES,
} from '../keys/server-keys.js';
import {
  createTestKeyDirectory,
  type TestKeyDirectory,
} from '../keys/test-support.js';
import {
  acceptDataKeyLoss,
  replaceServerIdentity,
  rotateDataKey,
} from './server-key-admin.js';
import { bindServerKeys } from './server-key-binding.js';
import { AUTH_AUDIT } from './shared.js';
import {
  everyRowAsText,
  seedActiveUser,
  seedInstallation,
  seedTotp,
  storedTotpSecret,
  totpCodeAt,
} from './test-support.js';
import { verifyTotp } from './totp.js';

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

/** The names of the data key files in `dir`. */
const keyFiles = (dir: string) =>
  readdirSync(join(dir, SERVER_KEY_FILES.dataKeysDirectory))
    .filter((name) => name.endsWith('.key'))
    .sort();

/** The key id a stored sealed secret names. */
const keyIdOf = (stored: string) => stored.split('.')[1];

/**
 * The key commands' database work: rotating the data key, and accepting the loss of
 * the data keys. Every command is tried against the key directory it changes and the
 * rows it re-seals, and against the one audit event it writes.
 */
describe.each(testTargets)('the data key commands on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  let scratch: TestKeyDirectory;
  let stranger: TestKeyDirectory;
  let ring: DataKeyRing;
  let installationId: string;

  beforeEach(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    scratch = createTestKeyDirectory();
    stranger = createTestKeyDirectory();
    installationId = await seedInstallation(database);
    ({
      keys: { dataKeys: ring },
    } = await bindServerKeys(database.db, { keysDir: scratch.dir, now: T0 }));
  });
  afterEach(async () => {
    await cleanup();
    scratch.remove();
    stranger.remove();
  });

  const db = () => database.db;
  const events = async (category: string) =>
    (await db().select().from(auditEvent)).filter(
      (event) => event.category === category,
    );
  const secretsOf = async () =>
    Object.fromEntries(
      (
        await db()
          .select({
            userId: totpCredential.userId,
            secret: totpCredential.secret,
          })
          .from(totpCredential)
      ).map((row) => [row.userId, row.secret]),
    );
  /** A user with a confirmed authenticator sealed by `with`, the base32 secret returned. */
  async function enrolledUser(sealedBy: DataKeyRing = ring) {
    const userId = await seedActiveUser(database);
    const secret = await seedTotp(database, userId, {
      dataKeys: sealedBy,
      now: T0,
    });
    return { userId, secret };
  }

  describe('rotateDataKey', () => {
    it('adds a new current data key, keeps every old key file, and re-seals each openable secret under the new key', async () => {
      const first = await enrolledUser();
      const second = await enrolledUser();
      const oldFiles = keyFiles(scratch.dir);
      const oldContent = snapshot(scratch.dir);

      const result = await rotateDataKey(db(), {
        keysDir: scratch.dir,
        now: T1,
      });

      expect(result).toEqual({ ok: true, resealed: 2, unopenable: 0 });
      const after = readDataKeyRing(scratch.dir)!;
      expect(after.currentKeyId).not.toBe(ring.currentKeyId);
      // Both files are there, and the old one is byte for byte what it was.
      expect(keyFiles(scratch.dir)).toHaveLength(2);
      expect(keyFiles(scratch.dir)).toEqual(expect.arrayContaining(oldFiles));
      for (const [path, content] of Object.entries(oldContent)) {
        if (path.endsWith('.key')) {
          expect(snapshot(scratch.dir)[path]).toBe(content);
        }
      }
      // Every secret now names the new key, and the ring that only had the old key cannot open it.
      const stored = await secretsOf();
      for (const user of [first, second]) {
        expect(keyIdOf(stored[user.userId]!)).toBe(after.currentKeyId);
        expect(
          await verifyTotp(db(), user.userId, totpCodeAt(user.secret, T1), {
            now: T1,
            dataKeys: ring,
          }),
        ).toEqual({ ok: false, reason: 'secret-undecryptable' });
        // ... and the new ring opens it: the same secret, sealed again.
        expect(
          (
            await verifyTotp(db(), user.userId, totpCodeAt(user.secret, T1), {
              now: T1,
              dataKeys: after,
            })
          ).ok,
        ).toBe(true);
      }
    });

    it('leaves a secret that no key opens exactly as it is, and counts it', async () => {
      const mine = await enrolledUser();
      const other = loadServerKeys(stranger.dir).dataKeys;
      const lost = await enrolledUser(other);
      const lostBefore = (await secretsOf())[lost.userId];

      const result = await rotateDataKey(db(), {
        keysDir: scratch.dir,
        now: T1,
      });

      expect(result).toEqual({ ok: true, resealed: 1, unopenable: 1 });
      const stored = await secretsOf();
      expect(stored[lost.userId]).toBe(lostBefore);
      expect(keyIdOf(stored[mine.userId]!)).toBe(
        readDataKeyRing(scratch.dir)!.currentKeyId,
      );
    });

    it('leaves a plain secret, and a pending one it can open is re-sealed too', async () => {
      const userId = await seedActiveUser(database);
      await seedTotp(database, userId, {
        dataKeys: ring,
        now: T0,
        plain: true,
      });
      const pending = await seedActiveUser(database);
      await seedTotp(database, pending, {
        dataKeys: ring,
        now: T0,
        confirmed: false,
      });
      const plainBefore = (await secretsOf())[userId];

      const result = await rotateDataKey(db(), {
        keysDir: scratch.dir,
        now: T1,
      });

      expect(result).toEqual({ ok: true, resealed: 1, unopenable: 0 });
      const stored = await secretsOf();
      expect(stored[userId]).toBe(plainBefore);
      expect(keyIdOf(stored[pending]!)).toBe(
        readDataKeyRing(scratch.dir)!.currentKeyId,
      );
    });

    it('writes one auth.data-key-rotated event with the two counts, and no key, key id, secret or person', async () => {
      const user = await enrolledUser();
      await rotateDataKey(db(), { keysDir: scratch.dir, now: T1 });

      const written = await events(AUTH_AUDIT.dataKeyRotated);
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({
        action: 'rotate',
        actorType: 'system',
        actorId: null,
        targetType: 'installation',
        targetId: installationId,
        occurredAt: T1,
        details: { resealed: 1, unopenable: 0 },
      });
      expect(Object.keys(written[0]!.details as object).sort()).toEqual([
        'resealed',
        'unopenable',
      ]);
      // It is the only event of the command.
      expect(await events(AUTH_AUDIT.adminCommandRun)).toEqual([]);
      const text = JSON.stringify(await db().select().from(auditEvent));
      const newKeyId = readDataKeyRing(scratch.dir)!.currentKeyId;
      for (const secret of [
        user.secret,
        user.userId,
        ring.currentKeyId,
        newKeyId,
      ]) {
        expect(text).not.toContain(secret);
      }
    });

    it('changes only the secret column and the time of the rows it re-seals', async () => {
      const user = await enrolledUser();
      const [before] = await db()
        .select()
        .from(totpCredential)
        .where(eq(totpCredential.userId, user.userId));

      await rotateDataKey(db(), { keysDir: scratch.dir, now: T1 });

      const [after] = await db()
        .select()
        .from(totpCredential)
        .where(eq(totpCredential.userId, user.userId));
      expect({ ...after, secret: '', updatedAt: null }).toEqual({
        ...before,
        secret: '',
        updatedAt: null,
      });
      expect(after!.secret).not.toBe(before!.secret);
      expect(after!.updatedAt).toEqual(T1);
    });

    it('rotates again, keeping every key it has added', async () => {
      const user = await enrolledUser();

      await rotateDataKey(db(), { keysDir: scratch.dir, now: T0 });
      const second = await rotateDataKey(db(), {
        keysDir: scratch.dir,
        now: T1,
      });

      expect(second).toEqual({ ok: true, resealed: 1, unopenable: 0 });
      expect(keyFiles(scratch.dir)).toHaveLength(3);
      const current = readDataKeyRing(scratch.dir)!;
      expect(keyIdOf((await secretsOf())[user.userId]!)).toBe(
        current.currentKeyId,
      );
    });

    it('is harmless when the transaction fails after the key files were written: current names the new key, the ring still holds the old, and the rows are as they were', async () => {
      const user = await enrolledUser();
      const stored = (await secretsOf())[user.userId];

      await expect(
        db().transaction(async (tx) => {
          await rotateDataKey(tx, { keysDir: scratch.dir, now: T1 });
          throw new Error('the transaction fails after the command');
        }),
      ).rejects.toThrow('after the command');

      // The files were written, and are not rolled back with the rows.
      const ringNow = readDataKeyRing(scratch.dir)!;
      expect(ringNow.currentKeyId).not.toBe(ring.currentKeyId);
      expect(keyFiles(scratch.dir)).toHaveLength(2);
      // The rows and the audit trail are as they were.
      expect((await secretsOf())[user.userId]).toBe(stored);
      expect(await events(AUTH_AUDIT.dataKeyRotated)).toEqual([]);
      // Every secret still opens with the ring the directory now gives.
      expect(
        (
          await verifyTotp(db(), user.userId, totpCodeAt(user.secret, T1), {
            now: T1,
            dataKeys: ringNow,
          })
        ).ok,
      ).toBe(true);
      // And running the command again finishes the job.
      expect(
        await rotateDataKey(db(), { keysDir: scratch.dir, now: T1 }),
      ).toEqual({ ok: true, resealed: 1, unopenable: 0 });
    });

    it('makes a start-up that follows work: the server loads the new key and a person signs in with the same authenticator', async () => {
      const user = await enrolledUser();
      await rotateDataKey(db(), { keysDir: scratch.dir, now: T1 });

      const restarted = await bindServerKeys(db(), {
        keysDir: scratch.dir,
        now: T1,
      });

      expect(restarted.secretsSealed).toBe(0);
      expect(
        (
          await verifyTotp(db(), user.userId, totpCodeAt(user.secret, T1), {
            now: T1,
            dataKeys: restarted.keys.dataKeys,
          })
        ).ok,
      ).toBe(true);
    });

    it('is refused before anything is written when a key file cannot be used', async () => {
      await enrolledUser();
      const bad = join(
        scratch.dir,
        SERVER_KEY_FILES.dataKeysDirectory,
        `${'0198c1c0-0000-7000-8000-000000000001'}.key`,
      );
      writeFileSync(bad, 'garbage\n', { mode: 0o600 });
      const before = snapshot(scratch.dir);
      const rowsBefore = await secretsOf();

      const error = await rotateDataKey(db(), {
        keysDir: scratch.dir,
        now: T1,
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ServerKeysError);
      expect((error as ServerKeysError).reason).toBe('invalid');
      expect(snapshot(scratch.dir)).toEqual(before);
      expect(await secretsOf()).toEqual(rowsBefore);
      expect(await events(AUTH_AUDIT.dataKeyRotated)).toEqual([]);
    });

    it('is refused when the server has never started on the database, writes no key file, and records the refusal', async () => {
      await db().delete(installation);
      const before = snapshot(scratch.dir);

      const result = await rotateDataKey(db(), {
        keysDir: scratch.dir,
        now: T1,
      });

      expect(result).toEqual({ ok: false, reason: 'installation-missing' });
      expect(snapshot(scratch.dir)).toEqual(before);
      const [event] = await events(AUTH_AUDIT.adminCommandRun);
      expect(event).toMatchObject({
        targetType: null,
        details: {
          command: 'rotate-data-key',
          outcome: 'refused',
          reason: 'installation-missing',
        },
      });
    });
  });

  describe('acceptDataKeyLoss', () => {
    /** Two sealed secrets, then the data keys are lost, as when a volume is replaced. */
    async function loseTheKeys() {
      const first = await enrolledUser();
      const second = await enrolledUser();
      rmSync(join(scratch.dir, SERVER_KEY_FILES.dataKeysDirectory), {
        recursive: true,
      });
      return [first, second];
    }

    it('is what a start-up that refuses with data-keys-missing needs: it makes a fresh current key, touches no row, and then start-up goes on', async () => {
      await loseTheKeys();
      const before = await secretsOf();
      const refused = await bindServerKeys(db(), {
        keysDir: scratch.dir,
        now: T1,
      }).catch((caught: unknown) => caught);
      expect((refused as ServerKeysError).reason).toBe('data-keys-missing');

      const result = await acceptDataKeyLoss(db(), {
        keysDir: scratch.dir,
        now: T1,
      });

      expect(result).toEqual({ ok: true, accepted: true, unopenable: 2 });
      expect(readDataKeyRing(scratch.dir)).not.toBeNull();
      expect(keyFiles(scratch.dir)).toHaveLength(1);
      expect(await secretsOf()).toEqual(before);
      const started = await bindServerKeys(db(), {
        keysDir: scratch.dir,
        now: T1,
      });
      expect(started.keys.dataKeys.currentKeyId).not.toBe(ring.currentKeyId);
    });

    it('writes one auth.data-key-loss-accepted event with the count, and nothing that names a key or a person', async () => {
      const [first] = await loseTheKeys();
      await acceptDataKeyLoss(db(), { keysDir: scratch.dir, now: T1 });

      const written = await events(AUTH_AUDIT.dataKeyLossAccepted);
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({
        action: 'accept',
        actorType: 'system',
        actorId: null,
        targetType: 'installation',
        targetId: installationId,
        occurredAt: T1,
        details: { unopenable: 2 },
      });
      expect(Object.keys(written[0]!.details as object)).toEqual([
        'unopenable',
      ]);
      expect(await events(AUTH_AUDIT.adminCommandRun)).toEqual([]);
      const text = JSON.stringify(await db().select().from(auditEvent));
      expect(text).not.toContain(first!.userId);
      expect(text).not.toContain(ring.currentKeyId);
      expect(text).not.toContain(readDataKeyRing(scratch.dir)!.currentKeyId);
    });

    it('leaves the people it affected with a secret that no key opens: the sign-in answer is the one for a wrong code', async () => {
      const [first] = await loseTheKeys();
      await acceptDataKeyLoss(db(), { keysDir: scratch.dir, now: T1 });

      expect(
        await verifyTotp(db(), first!.userId, totpCodeAt(first!.secret, T1), {
          now: T1,
          dataKeys: readDataKeyRing(scratch.dir)!,
        }),
      ).toEqual({ ok: false, reason: 'secret-undecryptable' });
    });

    it('changes nothing when a usable current key exists, says how many secrets cannot be opened, and records that it had nothing to do', async () => {
      await enrolledUser();
      const other = loadServerKeys(stranger.dir).dataKeys;
      await enrolledUser(other);
      const before = snapshot(scratch.dir);
      const rowsBefore = await secretsOf();

      const result = await acceptDataKeyLoss(db(), {
        keysDir: scratch.dir,
        now: T1,
      });

      expect(result).toEqual({ ok: true, accepted: false, unopenable: 1 });
      expect(snapshot(scratch.dir)).toEqual(before);
      expect(await secretsOf()).toEqual(rowsBefore);
      expect(await events(AUTH_AUDIT.dataKeyLossAccepted)).toEqual([]);
      const [event] = await events(AUTH_AUDIT.adminCommandRun);
      expect(event).toMatchObject({
        targetId: installationId,
        details: {
          command: 'accept-data-key-loss',
          outcome: 'nothing-to-do',
          unopenable: 1,
        },
      });
    });

    it('keeps a key file that is still there, so what it sealed opens again, and counts only what no key opens', async () => {
      const kept = await enrolledUser();
      const other = loadServerKeys(stranger.dir).dataKeys;
      await enrolledUser(other);
      // The pointer is gone, the key files are not.
      rmSync(
        join(
          scratch.dir,
          SERVER_KEY_FILES.dataKeysDirectory,
          SERVER_KEY_FILES.current,
        ),
      );
      expect(readDataKeyRing(scratch.dir)).toBeNull();

      const result = await acceptDataKeyLoss(db(), {
        keysDir: scratch.dir,
        now: T1,
      });

      expect(result).toEqual({ ok: true, accepted: true, unopenable: 1 });
      expect(keyFiles(scratch.dir)).toHaveLength(2);
      expect(
        (
          await verifyTotp(db(), kept.userId, totpCodeAt(kept.secret, T1), {
            now: T1,
            dataKeys: readDataKeyRing(scratch.dir)!,
          })
        ).ok,
      ).toBe(true);
    });

    it('never reads, makes or changes the identity file, whether there is one or not', async () => {
      await loseTheKeys();
      const identity = join(scratch.dir, SERVER_KEY_FILES.identity);
      const identityBefore = readFileSync(identity, 'utf8');

      await acceptDataKeyLoss(db(), { keysDir: scratch.dir, now: T1 });
      expect(readFileSync(identity, 'utf8')).toBe(identityBefore);

      rmSync(identity);
      rmSync(join(scratch.dir, SERVER_KEY_FILES.dataKeysDirectory), {
        recursive: true,
      });
      await acceptDataKeyLoss(db(), { keysDir: scratch.dir, now: T1 });
      expect(readdirSync(scratch.dir)).toEqual([
        SERVER_KEY_FILES.dataKeysDirectory,
      ]);
    });

    it('makes the directory itself when the whole of it is gone', async () => {
      const gone = join(scratch.dir, 'a', 'b', 'keys');

      const result = await acceptDataKeyLoss(db(), { keysDir: gone, now: T1 });

      expect(result).toEqual({ ok: true, accepted: true, unopenable: 0 });
      expect(readDataKeyRing(gone)).not.toBeNull();
    });

    it('refuses a current that is not a key id, as a bad file and not as a loss, and writes nothing', async () => {
      await enrolledUser();
      writeFileSync(
        join(
          scratch.dir,
          SERVER_KEY_FILES.dataKeysDirectory,
          SERVER_KEY_FILES.current,
        ),
        'not a key id\n',
      );
      const before = snapshot(scratch.dir);

      const error = await acceptDataKeyLoss(db(), {
        keysDir: scratch.dir,
        now: T1,
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ServerKeysError);
      expect((error as ServerKeysError).reason).toBe('invalid');
      expect(snapshot(scratch.dir)).toEqual(before);
      expect(await events(AUTH_AUDIT.dataKeyLossAccepted)).toEqual([]);
    });

    it('is refused when the server has never started on the database, and records the refusal', async () => {
      await db().delete(installation);

      const result = await acceptDataKeyLoss(db(), {
        keysDir: scratch.dir,
        now: T1,
      });

      expect(result).toEqual({ ok: false, reason: 'installation-missing' });
      const [event] = await events(AUTH_AUDIT.adminCommandRun);
      expect(event).toMatchObject({
        details: {
          command: 'accept-data-key-loss',
          outcome: 'refused',
          reason: 'installation-missing',
        },
      });
    });
  });

  describe('replaceServerIdentity', () => {
    const identityPath = () => join(scratch.dir, SERVER_KEY_FILES.identity);
    const storedKey = async () =>
      (await db().select().from(installation))[0]!.serverPublicKey;
    /** The identity file is lost, as when a volume is replaced. */
    const loseTheIdentity = () => rmSync(identityPath());

    it('makes a new identity file and replaces the stored key, for an install whose identity file is lost, and then start-up goes on', async () => {
      const oldKey = await storedKey();
      loseTheIdentity();
      const refused = await bindServerKeys(db(), {
        keysDir: scratch.dir,
        now: T1,
      }).catch((caught: unknown) => caught);
      expect((refused as ServerKeysError).reason).toBe('identity-missing');

      const result = await replaceServerIdentity(db(), {
        keysDir: scratch.dir,
        now: T1,
      });

      const made = readServerIdentity(scratch.dir)!;
      expect(result).toEqual({
        ok: true,
        oldFingerprint: publicKeyFingerprint(oldKey!),
        newFingerprint: made.fingerprint,
      });
      expect(await storedKey()).toBe(made.publicKey);
      expect(made.publicKey).not.toBe(oldKey);
      const started = await bindServerKeys(db(), {
        keysDir: scratch.dir,
        now: T1,
      });
      expect(started.identityBound).toBe(false);
      expect(started.keys.identity.publicKey).toBe(made.publicKey);
    });

    it.skipIf(process.platform === 'win32')(
      'writes the new key file as 0600, and the directory as 0700 when it makes it too',
      async () => {
        const gone = join(scratch.dir, 'not', 'there', 'keys');

        await replaceServerIdentity(db(), { keysDir: gone, now: T1 });

        expect(
          statSync(join(gone, SERVER_KEY_FILES.identity)).mode & 0o777,
        ).toBe(0o600);
        expect(statSync(gone).mode & 0o777).toBe(0o700);
      },
    );

    it('writes one auth.server-identity-replaced event with the old and the new fingerprint, and no key', async () => {
      const oldFingerprint = publicKeyFingerprint((await storedKey())!);
      loseTheIdentity();

      await replaceServerIdentity(db(), { keysDir: scratch.dir, now: T1 });

      const written = await events(AUTH_AUDIT.serverIdentityReplaced);
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({
        action: 'replace',
        actorType: 'system',
        actorId: null,
        targetType: 'installation',
        targetId: installationId,
        occurredAt: T1,
        details: {
          oldFingerprint,
          newFingerprint: readServerIdentity(scratch.dir)!.fingerprint,
        },
      });
      expect(await events(AUTH_AUDIT.adminCommandRun)).toEqual([]);
      const text = JSON.stringify(await db().select().from(auditEvent));
      expect(text).not.toContain('PRIVATE KEY');
      expect(text).not.toContain(readServerIdentity(scratch.dir)!.publicKey);
    });

    it('says what it is about to do only when every check has passed, and before anything changes', async () => {
      const oldKey = await storedKey();
      loseTheIdentity();
      const seen: { oldFingerprint: string; stored: string | null }[] = [];
      const stored = await Promise.resolve(oldKey);

      await replaceServerIdentity(db(), {
        keysDir: scratch.dir,
        now: T1,
        announce: ({ oldFingerprint }) => {
          // Nothing has changed yet: there is no file, and the old key is stored.
          expect(existsSync(identityPath())).toBe(false);
          seen.push({ oldFingerprint, stored });
        },
      });

      expect(seen).toEqual([
        { oldFingerprint: publicKeyFingerprint(oldKey!), stored: oldKey },
      ]);
      expect(await storedKey()).not.toBe(oldKey);
    });

    const existingIdentityFiles: [string, () => void][] = [
      ['a file that holds this installation’s own key', () => undefined],
      [
        'a file that holds another installation’s key',
        () => {
          loadServerKeys(stranger.dir);
          rmSync(identityPath());
          copyFileSync(
            join(stranger.dir, SERVER_KEY_FILES.identity),
            identityPath(),
          );
        },
      ],
      [
        'a file that is not a key at all',
        () => writeFileSync(identityPath(), 'not a key\n', { mode: 0o600 }),
      ],
      [
        'an empty file',
        () => writeFileSync(identityPath(), '', { mode: 0o600 }),
      ],
      [
        'a directory',
        () => {
          rmSync(identityPath());
          mkdirSync(identityPath());
        },
      ],
    ];
    it.each(existingIdentityFiles)(
      'refuses when there is %s: it writes no key, changes no row and no file, and records the refusal',
      async (_name, arrange) => {
        arrange();
        const before = snapshot(scratch.dir);
        const keyBefore = await storedKey();
        const announced: unknown[] = [];

        const result = await replaceServerIdentity(db(), {
          keysDir: scratch.dir,
          now: T1,
          announce: (about) => announced.push(about),
        });

        expect(result).toEqual({ ok: false, reason: 'identity-file-exists' });
        expect(announced).toEqual([]);
        expect(snapshot(scratch.dir)).toEqual(before);
        expect(await storedKey()).toBe(keyBefore);
        expect(await events(AUTH_AUDIT.serverIdentityReplaced)).toEqual([]);
        const [event] = await events(AUTH_AUDIT.adminCommandRun);
        expect(event).toMatchObject({
          targetId: installationId,
          details: {
            command: 'new-identity',
            outcome: 'refused',
            reason: 'identity-file-exists',
          },
        });
      },
    );

    it.skipIf(process.platform === 'win32')(
      'refuses when the path holds a link to nowhere, which is something, and never makes a file through it',
      async () => {
        rmSync(identityPath());
        symlinkSync(join(scratch.dir, 'nowhere.pem'), identityPath());
        const keyBefore = await storedKey();

        const result = await replaceServerIdentity(db(), {
          keysDir: scratch.dir,
          now: T1,
        });

        expect(result).toEqual({ ok: false, reason: 'identity-file-exists' });
        expect(existsSync(join(scratch.dir, 'nowhere.pem'))).toBe(false);
        expect(await storedKey()).toBe(keyBefore);
      },
    );

    it('refuses when the installation has stored no key yet, because start-up binds the first one', async () => {
      await db().update(installation).set({ serverPublicKey: null });
      loseTheIdentity();

      const result = await replaceServerIdentity(db(), {
        keysDir: scratch.dir,
        now: T1,
      });

      expect(result).toEqual({ ok: false, reason: 'no-stored-identity' });
      expect(existsSync(identityPath())).toBe(false);
      expect(await storedKey()).toBeNull();
      const [event] = await events(AUTH_AUDIT.adminCommandRun);
      expect(event).toMatchObject({
        details: { outcome: 'refused', reason: 'no-stored-identity' },
      });
    });

    it('refuses when the server has never started on the database', async () => {
      await db().delete(installation);

      const result = await replaceServerIdentity(db(), {
        keysDir: scratch.dir,
        now: T1,
      });

      expect(result).toEqual({ ok: false, reason: 'installation-missing' });
      const [event] = await events(AUTH_AUDIT.adminCommandRun);
      expect(event).toMatchObject({
        targetType: null,
        details: { outcome: 'refused', reason: 'installation-missing' },
      });
    });

    it('takes the update and the event back when the key file cannot be written, so nothing is left behind', async () => {
      const keyBefore = await storedKey();
      // A file where a parent folder of the key directory should be.
      const blocker = join(scratch.dir, 'blocker');
      writeFileSync(blocker, 'a file');
      const unwritable = join(blocker, 'keys');

      const error = await db()
        .transaction((tx) =>
          replaceServerIdentity(tx, { keysDir: unwritable, now: T1 }),
        )
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ServerKeysError);
      expect((error as ServerKeysError).reason).toBe('unreadable');
      expect(await storedKey()).toBe(keyBefore);
      expect(await events(AUTH_AUDIT.serverIdentityReplaced)).toEqual([]);
    });
  });

  it('keeps every key, key id and secret out of every row it writes, apart from the secrets it re-seals', async () => {
    const user = await enrolledUser();
    await rotateDataKey(db(), { keysDir: scratch.dir, now: T1 });
    const stored = await storedTotpSecret(database, user.userId);

    const text = await everyRowAsText(database);

    // The secret is stored only sealed, and its base32 nowhere.
    expect(text).not.toContain(user.secret);
    expect(text).toContain(stored);
    expect(text).not.toContain('PRIVATE KEY');
  });
});

/** The PostgreSQL target, when `DATABASE_URL` names a server. */
const postgres = testTargets.find((target) => target.name === 'postgres');

describe.skipIf(postgres === undefined)(
  'the data key commands and the installation row, on PostgreSQL',
  () => {
    let database: Database;
    let cleanup: () => Promise<void>;
    let scratch: TestKeyDirectory;

    beforeEach(async () => {
      ({ database, cleanup } = await createMigratedDatabase(postgres!));
      scratch = createTestKeyDirectory();
      await seedInstallation(database);
      await bindServerKeys(database.db, { keysDir: scratch.dir, now: T0 });
    });
    afterEach(async () => {
      await cleanup();
      scratch.remove();
    });

    it('takes the installation row before it writes a key file, so a command that waits for it has written nothing', async () => {
      let filesWhileWaiting: string[] | undefined;

      const outcomes = await interleave(
        database.db,
        // Another writer that holds the installation row, as start-up does.
        async (tx) => {
          await tx
            .select({ id: installation.id })
            .from(installation)
            .for('update');
        },
        (tx) => rotateDataKey(tx, { keysDir: scratch.dir, now: T1 }),
        () => {
          filesWhileWaiting = keyFiles(scratch.dir);
          return Promise.resolve();
        },
      );

      expect(succeeded(outcomes)).toBe(2);
      // While it waited, the directory still held the one key start-up made.
      expect(filesWhileWaiting).toHaveLength(1);
      expect(keyFiles(scratch.dir)).toHaveLength(2);
    });

    it('takes turns with another key command: the second finds what the first did', async () => {
      const outcomes = await interleave(
        database.db,
        (tx) => rotateDataKey(tx, { keysDir: scratch.dir, now: T1 }),
        (tx) => rotateDataKey(tx, { keysDir: scratch.dir, now: T1 }),
      );

      expect(succeeded(outcomes)).toBe(2);
      expect(keyFiles(scratch.dir)).toHaveLength(3);
    });
  },
);
