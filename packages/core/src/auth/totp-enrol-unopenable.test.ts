import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { auditEvent, totpCredential } from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import type { DataKeyRing } from '../keys/data-keys.js';
import { loadServerKeys } from '../keys/server-keys.js';
import {
  createTestKeyDirectory,
  type TestKeyDirectory,
} from '../keys/test-support.js';
import { AUTH_AUDIT } from './shared.js';
import {
  seedActiveUser,
  seedInstallation,
  seedTotp,
  setStoredTotpSecret,
  storedTotpSecret,
  totpCodeAt,
} from './test-support.js';
import { confirmTotp, enrolTotp, verifyTotp } from './totp.js';

const T0 = new Date('2026-03-02T09:00:15.000Z');
const SECOND = 1000;
const at = (ms: number) => new Date(T0.getTime() + ms);

/**
 * A person whose confirmed authenticator secret the server cannot open (the data
 * keys were lost, or a value was changed or copied) can set it up again once they
 * hold a session, without removing it first with a password they may not have. A
 * secret the server can open still blocks, as before (P-09a1, decision D-78).
 */
describe.each(testTargets)(
  'setting up an authenticator when the old secret cannot be opened, on $name',
  (target) => {
    let database: Database;
    let cleanup: () => Promise<void>;
    let scratch: TestKeyDirectory;
    let elsewhere: TestKeyDirectory;
    let dataKeys: DataKeyRing;
    let stranger: DataKeyRing;

    beforeEach(async () => {
      ({ database, cleanup } = await createMigratedDatabase(target));
      await seedInstallation(database);
      scratch = createTestKeyDirectory();
      elsewhere = createTestKeyDirectory();
      dataKeys = loadServerKeys(scratch.dir).dataKeys;
      stranger = loadServerKeys(elsewhere.dir).dataKeys;
    });
    afterEach(async () => {
      await cleanup();
      scratch.remove();
      elsewhere.remove();
    });

    const db = () => database.db;
    const credentialOf = async (userId: string) =>
      (
        await db()
          .select()
          .from(totpCredential)
          .where(eq(totpCredential.userId, userId))
      )[0]!;
    const enrolEvents = async (userId: string) =>
      (await db().select().from(auditEvent)).filter(
        (event) =>
          event.category === AUTH_AUDIT.totpEnrolled &&
          event.targetId === userId,
      );

    it('still answers already-enrolled for a confirmed secret it can open, and writes nothing', async () => {
      const userId = await seedActiveUser(database);
      await seedTotp(database, userId, { dataKeys, now: T0 });
      const before = await credentialOf(userId);

      const result = await enrolTotp(db(), userId, { now: T0, dataKeys });

      expect(result).toEqual({ ok: false, reason: 'already-enrolled' });
      expect(await credentialOf(userId)).toEqual(before);
      expect(await enrolEvents(userId)).toEqual([]);
    });

    it.each([
      [
        'a key the ring does not hold',
        async (userId: string) =>
          setStoredTotpSecret(
            database,
            userId,
            stranger.encrypt('JBSWY3DPEHPK3PXP', `totp_credential:${userId}`),
          ),
      ],
      [
        'a value that is not a sealed value',
        async (userId: string) =>
          setStoredTotpSecret(database, userId, 'v1.not.a.secret'),
      ],
      [
        'a value copied from another person’s row',
        async (userId: string) => {
          const owner = await seedActiveUser(database);
          await seedTotp(database, owner, { dataKeys, now: T0 });
          await setStoredTotpSecret(
            database,
            userId,
            await storedTotpSecret(database, owner),
          );
        },
      ],
      [
        'a secret that was never sealed',
        async (userId: string) =>
          setStoredTotpSecret(database, userId, 'JBSWY3DPEHPK3PXP'),
      ],
    ] as const)(
      'replaces a confirmed secret made of %s, as a new pending secret, and says why',
      async (_name, breakIt) => {
        const userId = await seedActiveUser(database);
        await seedTotp(database, userId, { dataKeys, now: T0 });
        await breakIt(userId);
        const before = await credentialOf(userId);

        const result = await enrolTotp(db(), userId, {
          now: at(SECOND),
          dataKeys,
        });

        if (!result.ok) throw new Error('not enrolled');
        const after = await credentialOf(userId);
        expect(after.id).toBe(before.id);
        // Sealed with the current key and bound to the row, and pending again.
        expect(after.secret.startsWith(`v1.${dataKeys.currentKeyId}.`)).toBe(
          true,
        );
        expect(after.secret).not.toContain(result.secret);
        expect(after.confirmedAt).toBeNull();
        expect(after.lastUsedStep).toBeNull();
        expect(after.version).toBe(before.version + 1);
        expect(after.updatedAt).toEqual(at(SECOND));
        // The trail says why, with the person as the actor, and holds no secret.
        const [event, ...rest] = await enrolEvents(userId);
        expect(rest).toEqual([]);
        expect(event).toMatchObject({
          action: 'enrol',
          actorType: 'user',
          actorId: userId,
          details: { replacedPending: false, reason: 'totp-undecryptable' },
        });
        expect(JSON.stringify(event)).not.toContain(result.secret);
      },
    );

    it('is pending until its first code: the new secret confirms and signs in, and the old one never did', async () => {
      const userId = await seedActiveUser(database);
      const oldSecret = await seedTotp(database, userId, {
        dataKeys: stranger,
        now: T0,
      });
      const result = await enrolTotp(db(), userId, { now: T0, dataKeys });
      if (!result.ok) throw new Error('not enrolled');

      // Nothing is confirmed yet, so there is no second step to pass.
      expect(
        await verifyTotp(db(), userId, totpCodeAt(result.secret, T0), {
          now: T0,
          dataKeys,
        }),
      ).toEqual({ ok: false, reason: 'code-incorrect' });
      // The old secret's code does not confirm the new one.
      expect(
        await confirmTotp(db(), {
          userId,
          code: totpCodeAt(oldSecret, T0),
          now: T0,
          dataKeys,
        }),
      ).toEqual({ ok: false, reason: 'code-incorrect' });
      expect(
        await confirmTotp(db(), {
          userId,
          code: totpCodeAt(result.secret, T0),
          now: T0,
          dataKeys,
        }),
      ).toEqual({ ok: true });
      expect(
        (
          await verifyTotp(
            db(),
            userId,
            totpCodeAt(result.secret, at(30 * SECOND)),
            { now: at(30 * SECOND), dataKeys },
          )
        ).ok,
      ).toBe(true);
    });

    it('is blocked again as soon as the new secret is confirmed', async () => {
      const userId = await seedActiveUser(database);
      await seedTotp(database, userId, { dataKeys: stranger, now: T0 });
      const result = await enrolTotp(db(), userId, { now: T0, dataKeys });
      if (!result.ok) throw new Error('not enrolled');
      await confirmTotp(db(), {
        userId,
        code: totpCodeAt(result.secret, T0),
        now: T0,
        dataKeys,
      });

      expect(await enrolTotp(db(), userId, { now: T0, dataKeys })).toEqual({
        ok: false,
        reason: 'already-enrolled',
      });
    });

    it('replaces a secret that was only pending as it always did: replacedPending, and no reason', async () => {
      const userId = await seedActiveUser(database);
      await seedTotp(database, userId, {
        dataKeys: stranger,
        now: T0,
        confirmed: false,
      });

      const result = await enrolTotp(db(), userId, { now: T0, dataKeys });

      expect(result.ok).toBe(true);
      const [event] = await enrolEvents(userId);
      expect(event!.details).toEqual({ replacedPending: true });
    });

    it('makes a first secret as it always did: no replacement, no reason', async () => {
      const userId = await seedActiveUser(database);

      await enrolTotp(db(), userId, { now: T0, dataKeys });

      const [event] = await enrolEvents(userId);
      expect(event!.details).toEqual({ replacedPending: false });
    });
  },
);
