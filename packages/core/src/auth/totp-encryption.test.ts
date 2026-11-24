import { randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import { auditEvent, totpCredential } from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { DataKeyRing } from '../keys/data-keys.js';
import { ServerKeysError } from '../keys/errors.js';
import { loadServerKeys, SERVER_KEY_FILES } from '../keys/server-keys.js';
import {
  createTestKeyDirectory,
  type TestKeyDirectory,
} from '../keys/test-support.js';
import {
  consumeLoginChallenge,
  createLoginChallenge,
} from './login-challenge.js';
import { bindServerKeys } from './server-key-binding.js';
import { AUTH_AUDIT } from './shared.js';
import {
  everyRowAsText,
  seedActiveUser,
  seedInstallation,
  seedTotp,
  totpCodeAt,
} from './test-support.js';
import { confirmTotp, enrolTotp, verifyTotp } from './totp.js';

const T0 = new Date('2026-03-02T09:00:15.000Z');
const SECOND = 1000;
const at = (ms: number) => new Date(T0.getTime() + ms);
const SECRET_SHAPE = /^[A-Z2-7]{32}$/;

/** A key directory that lives until the end of the file, for a ring nobody else holds. */
const stray: TestKeyDirectory[] = [];
afterAll(() => stray.forEach((directory) => directory.remove()));
function createTestKeyDirectoryOnce(): string {
  const directory = createTestKeyDirectory();
  stray.push(directory);
  return directory.dir;
}

describe.each(testTargets)('TOTP secrets at rest on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  let scratch: TestKeyDirectory;
  let dataKeys: DataKeyRing;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    await seedInstallation(database);
    scratch = createTestKeyDirectory();
    dataKeys = loadServerKeys(scratch.dir).dataKeys;
  });
  afterAll(async () => {
    await cleanup();
    scratch.remove();
  });

  const db = () => database.db;
  const credentialOf = async (userId: string) =>
    (
      await db()
        .select()
        .from(totpCredential)
        .where(eq(totpCredential.userId, userId))
    )[0]!;
  const setSecret = (userId: string, secret: string) =>
    db()
      .update(totpCredential)
      .set({ secret })
      .where(eq(totpCredential.userId, userId));
  const failedSteps = async (userId: string) =>
    (await db().select().from(auditEvent)).filter(
      (event) =>
        event.category === AUTH_AUDIT.loginStepFailed &&
        event.targetId === userId,
    );

  /** A user with a confirmed, sealed authenticator; returns the base32 secret. */
  async function enrolledUser() {
    const userId = await seedActiveUser(database);
    const secret = await seedTotp(database, userId, { dataKeys, now: T0 });
    return { userId, secret };
  }

  it('stores the secret as v1.<key id>.<nonce>.<ciphertext>, with no base32 of it', async () => {
    const userId = await seedActiveUser(database);
    const result = await enrolTotp(db(), userId, { now: T0, dataKeys });
    if (!result.ok) throw new Error('not enrolled');

    const stored = (await credentialOf(userId)).secret;
    const parts = stored.split('.');
    expect(parts).toHaveLength(4);
    expect(parts.slice(0, 2)).toEqual(['v1', dataKeys.currentKeyId]);
    expect(stored).not.toContain(result.secret);
    // Nothing stores the base32 secret anywhere: only the sealed text.
    expect((await everyRowAsText(database)).split(result.secret)).toHaveLength(
      1,
    );
    // And what is shown to the person is the secret, once.
    expect(result.secret).toMatch(SECRET_SHAPE);
    expect(result.otpauthUri).toContain(`secret=${result.secret}`);
  });

  it('confirms with a code of the sealed secret, and signs in with it', async () => {
    const userId = await seedActiveUser(database);
    const result = await enrolTotp(db(), userId, { now: T0, dataKeys });
    if (!result.ok) throw new Error('not enrolled');

    expect(
      await confirmTotp(db(), {
        userId,
        code: totpCodeAt(result.secret, T0),
        now: T0,
        dataKeys,
      }),
    ).toEqual({ ok: true });
    // The confirmation used up the step of its code; the next step's code signs in.
    const { challenge } = await createLoginChallenge(db(), userId, {
      kind: 'totp',
      now: at(30 * SECOND),
    });
    const signedIn = await consumeLoginChallenge(db(), {
      challenge,
      code: totpCodeAt(result.secret, at(30 * SECOND)),
      now: at(30 * SECOND),
      dataKeys,
    });
    expect(signedIn.ok).toBe(true);
  });

  it('seals again with a new nonce when an unconfirmed secret is replaced, and the new secret works', async () => {
    const userId = await seedActiveUser(database);
    const first = await enrolTotp(db(), userId, { now: T0, dataKeys });
    const second = await enrolTotp(db(), userId, { now: at(SECOND), dataKeys });
    if (!first.ok || !second.ok) throw new Error('not enrolled');

    expect(second.secret).not.toBe(first.secret);
    expect(
      await confirmTotp(db(), {
        userId,
        code: totpCodeAt(first.secret, T0),
        now: T0,
        dataKeys,
      }),
    ).toEqual({ ok: false, reason: 'code-incorrect' });
    expect(
      await confirmTotp(db(), {
        userId,
        code: totpCodeAt(second.secret, at(2 * SECOND)),
        now: at(2 * SECOND),
        dataKeys,
      }),
    ).toEqual({ ok: true });
  });

  describe('a secret that cannot be opened', () => {
    it('does not open a ciphertext copied to another user’s row, because it is bound to its row', async () => {
      const owner = await enrolledUser();
      const other = await enrolledUser();
      await setSecret(other.userId, (await credentialOf(owner.userId)).secret);

      // The code is right for the copied secret; it must still not be accepted.
      expect(
        await verifyTotp(db(), other.userId, totpCodeAt(owner.secret, T0), {
          now: T0,
          dataKeys,
        }),
      ).toEqual({ ok: false, reason: 'secret-undecryptable' });
      // The row it was copied from still works.
      expect(
        (
          await verifyTotp(db(), owner.userId, totpCodeAt(owner.secret, T0), {
            now: T0,
            dataKeys,
          })
        ).ok,
      ).toBe(true);
    });

    it('gives the uniform sign-in failure with the reason totp-undecryptable for a key id the ring does not hold', async () => {
      const { userId, secret } = await enrolledUser();
      const elsewhere = loadServerKeys(createTestKeyDirectoryOnce()).dataKeys;
      await setSecret(
        userId,
        elsewhere.encrypt(secret, `totp_credential:${userId}`),
      );
      const { challenge } = await createLoginChallenge(db(), userId, {
        kind: 'totp',
        now: T0,
      });

      const result = await consumeLoginChallenge(db(), {
        challenge,
        code: totpCodeAt(secret, T0),
        now: at(SECOND),
        dataKeys,
      });

      expect(result).toEqual({ ok: false });
      const [event] = await failedSteps(userId);
      expect(event).toMatchObject({
        actorType: 'system',
        details: { method: 'totp', reason: 'totp-undecryptable' },
      });
      // The reason only: no key id, no ciphertext, no secret, no code.
      const text = JSON.stringify(event);
      expect(text).not.toContain(secret);
      expect(text).not.toContain(elsewhere.currentKeyId);
      expect(text).not.toContain(totpCodeAt(secret, T0));
    });

    it('does not count it as a wrong guess, so it never closes the account', async () => {
      const { userId, secret } = await enrolledUser();
      await setSecret(userId, 'v1.not.a.secret');
      for (let attempt = 0; attempt < 7; attempt += 1) {
        const { challenge } = await createLoginChallenge(db(), userId, {
          kind: 'totp',
          now: at(attempt * SECOND),
        });
        expect(
          await consumeLoginChallenge(db(), {
            challenge,
            code: totpCodeAt(secret, at(attempt * SECOND)),
            now: at(attempt * SECOND),
            dataKeys,
          }),
        ).toEqual({ ok: false });
      }
      const events = await failedSteps(userId);
      expect(events.map((event) => event.details)).toEqual(
        Array(7).fill({ method: 'totp', reason: 'totp-undecryptable' }),
      );
    });

    it('treats a secret that is still plain as no valid authenticator', async () => {
      const userId = await seedActiveUser(database);
      const secret = await seedTotp(database, userId, {
        dataKeys,
        now: T0,
        plain: true,
      });

      expect(
        await verifyTotp(db(), userId, totpCodeAt(secret, T0), {
          now: T0,
          dataKeys,
        }),
      ).toEqual({ ok: false, reason: 'secret-undecryptable' });
    });

    it('refuses to confirm a pending secret it cannot open, as a wrong code', async () => {
      const userId = await seedActiveUser(database);
      const secret = await seedTotp(database, userId, {
        dataKeys,
        now: T0,
        confirmed: false,
      });
      await setSecret(userId, 'v1.broken.broken.broken');

      expect(
        await confirmTotp(db(), {
          userId,
          code: totpCodeAt(secret, T0),
          now: T0,
          dataKeys,
        }),
      ).toEqual({ ok: false, reason: 'code-incorrect' });
      expect((await credentialOf(userId)).confirmedAt).toBeNull();
    });
  });

  it('opens what an older key sealed after a new current key is added, and seals new secrets with the new key', async () => {
    const oldRing = dataKeys;
    const { userId, secret } = await enrolledUser();

    // What a later rotation tool will do: a new key file, then `current`.
    const newKeyId = newId();
    const folder = join(scratch.dir, SERVER_KEY_FILES.dataKeysDirectory);
    writeFileSync(
      join(folder, `${newKeyId}.key`),
      `${randomBytes(32).toString('base64')}\n`,
      { mode: 0o600 },
    );
    writeFileSync(join(folder, SERVER_KEY_FILES.current), `${newKeyId}\n`, {
      mode: 0o600,
    });
    const ring = loadServerKeys(scratch.dir).dataKeys;
    expect(ring.currentKeyId).toBe(newKeyId);

    // The old row still signs in, with the ring that holds both keys.
    expect(
      (
        await verifyTotp(db(), userId, totpCodeAt(secret, T0), {
          now: T0,
          dataKeys: ring,
        })
      ).ok,
    ).toBe(true);
    // A new secret is sealed with the new key.
    const fresh = await seedActiveUser(database);
    const enrolled = await enrolTotp(db(), fresh, { now: T0, dataKeys: ring });
    if (!enrolled.ok) throw new Error('not enrolled');
    expect((await credentialOf(fresh)).secret.split('.')[1]).toBe(newKeyId);
    await confirmTotp(db(), {
      userId: fresh,
      code: totpCodeAt(enrolled.secret, T0),
      now: T0,
      dataKeys: ring,
    });
    // A ring that only has the old key cannot open it.
    expect(
      await verifyTotp(
        db(),
        fresh,
        totpCodeAt(enrolled.secret, at(30 * SECOND)),
        {
          now: at(30 * SECOND),
          dataKeys: oldRing,
        },
      ),
    ).toEqual({ ok: false, reason: 'secret-undecryptable' });
  });
});

describe.each(testTargets)(
  'sealing the plain secrets at start-up on $name',
  (target) => {
    let database: Database;
    let cleanup: () => Promise<void>;
    let scratch: TestKeyDirectory;

    beforeEach(async () => {
      ({ database, cleanup } = await createMigratedDatabase(target));
      await seedInstallation(database);
      scratch = createTestKeyDirectory();
    });
    afterEach(async () => {
      await cleanup();
      scratch.remove();
    });

    const db = () => database.db;
    const sealedEvents = async () =>
      (await db().select().from(auditEvent)).filter(
        (event) => event.category === AUTH_AUDIT.totpSecretsEncrypted,
      );
    const secretOf = async (userId: string) =>
      (
        await db()
          .select({ secret: totpCredential.secret })
          .from(totpCredential)
          .where(eq(totpCredential.userId, userId))
      )[0]!.secret;

    it('seals every plain secret with the current key, keeps it working, and writes one event with the count and no id', async () => {
      // The shape of an install made before the secrets were sealed, plus one that is sealed.
      const first = await seedActiveUser(database);
      const second = await seedActiveUser(database);
      const third = await seedActiveUser(database);
      const keys = loadServerKeys(scratch.dir);
      const secrets = new Map([
        [
          first,
          await seedTotp(database, first, {
            dataKeys: keys.dataKeys,
            now: T0,
            plain: true,
          }),
        ],
        [
          second,
          await seedTotp(database, second, {
            dataKeys: keys.dataKeys,
            now: T0,
            plain: true,
            confirmed: false,
          }),
        ],
      ]);
      await seedTotp(database, third, { dataKeys: keys.dataKeys, now: T0 });
      const sealedBefore = await secretOf(third);

      const bound = await bindServerKeys(db(), {
        keysDir: scratch.dir,
        now: T0,
      });

      expect(bound.secretsSealed).toBe(2);
      for (const [userId, secret] of secrets) {
        const stored = await secretOf(userId);
        expect(
          stored.startsWith(`v1.${bound.keys.dataKeys.currentKeyId}.`),
        ).toBe(true);
        expect(stored).not.toContain(secret);
      }
      // One that was sealed is not touched.
      expect(await secretOf(third)).toBe(sealedBefore);
      // The sealed secret is the same secret: its code still works.
      const firstSecret = secrets.get(first)!;
      expect(
        (
          await verifyTotp(db(), first, totpCodeAt(firstSecret, T0), {
            now: T0,
            dataKeys: bound.keys.dataKeys,
          })
        ).ok,
      ).toBe(true);
      const events = await sealedEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actorType: 'system',
        actorId: null,
        targetType: null,
        targetId: null,
        details: { count: 2 },
      });
      const text = JSON.stringify(events);
      for (const id of [first, second, third]) expect(text).not.toContain(id);
      for (const secret of secrets.values()) expect(text).not.toContain(secret);
    });

    it('does nothing at the next start: no further rewrite, no further event', async () => {
      const userId = await seedActiveUser(database);
      const keys = loadServerKeys(scratch.dir);
      await seedTotp(database, userId, {
        dataKeys: keys.dataKeys,
        now: T0,
        plain: true,
      });
      await bindServerKeys(db(), { keysDir: scratch.dir, now: T0 });
      const stored = await secretOf(userId);

      const again = await bindServerKeys(db(), {
        keysDir: scratch.dir,
        now: at(SECOND),
      });

      expect(again.secretsSealed).toBe(0);
      expect(await secretOf(userId)).toBe(stored);
      expect(await sealedEvents()).toHaveLength(1);
    });

    it('refuses to start when sealed secrets exist and the data keys are gone, and makes no new keys', async () => {
      const userId = await seedActiveUser(database);
      const first = await bindServerKeys(db(), {
        keysDir: scratch.dir,
        now: T0,
      });
      await seedTotp(database, userId, {
        dataKeys: first.keys.dataKeys,
        now: T0,
      });
      rmSync(join(scratch.dir, SERVER_KEY_FILES.dataKeysDirectory), {
        recursive: true,
      });

      const error = await bindServerKeys(db(), {
        keysDir: scratch.dir,
        now: at(SECOND),
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ServerKeysError);
      expect((error as ServerKeysError).reason).toBe('data-keys-missing');
      expect((error as ServerKeysError).message).toContain('OSFPM_KEYS_DIR');
      expect((error as ServerKeysError).message).toContain('backup');
      expect(await credentialRowCount(), 'the row is kept as it was').toBe(1);
      // Nothing was made in the key directory.
      expect(() =>
        loadServerKeys(scratch.dir, { identity: true, dataKeys: false }),
      ).toThrow(ServerKeysError);
    });

    it('makes fresh data keys, and seals the plain secrets with them, when no secret is sealed yet', async () => {
      const userId = await seedActiveUser(database);
      const earlier = loadServerKeys(scratch.dir);
      const secret = await seedTotp(database, userId, {
        dataKeys: earlier.dataKeys,
        now: T0,
        plain: true,
      });
      rmSync(join(scratch.dir, SERVER_KEY_FILES.dataKeysDirectory), {
        recursive: true,
      });

      const bound = await bindServerKeys(db(), {
        keysDir: scratch.dir,
        now: T0,
      });

      expect(bound.keys.dataKeys.currentKeyId).not.toBe(
        earlier.dataKeys.currentKeyId,
      );
      expect(bound.secretsSealed).toBe(1);
      expect(
        (
          await verifyTotp(db(), userId, totpCodeAt(secret, T0), {
            now: T0,
            dataKeys: bound.keys.dataKeys,
          })
        ).ok,
      ).toBe(true);
    });

    it('keeps every key, secret and base32 out of the audit trail and out of the error a refusal throws', async () => {
      const userId = await seedActiveUser(database);
      const first = await bindServerKeys(db(), {
        keysDir: scratch.dir,
        now: T0,
      });
      const secret = await seedTotp(database, userId, {
        dataKeys: first.keys.dataKeys,
        now: T0,
      });
      rmSync(join(scratch.dir, SERVER_KEY_FILES.dataKeysDirectory), {
        recursive: true,
      });
      const error = await bindServerKeys(db(), {
        keysDir: scratch.dir,
        now: at(SECOND),
      }).catch((caught: unknown) => caught as Error);

      const written = [
        JSON.stringify(await db().select().from(auditEvent)),
        (error as Error).message,
        String((error as Error).stack),
      ].join('\n');
      expect(written).not.toContain(secret);
      expect(written).not.toContain(await secretOf(userId));
      expect(written).not.toContain(first.keys.dataKeys.currentKeyId);
      expect(written).not.toContain('PRIVATE KEY');
    });

    /** How many rows `totp_credential` holds. */
    async function credentialRowCount() {
      return (await db().select().from(totpCredential)).length;
    }
  },
);
