import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import { auditEvent, session, totpCredential } from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { AuthStateError } from './errors.js';
import { createSession, validateSession } from './sessions.js';
import { AUTH_AUDIT } from './shared.js';
import {
  emailOf,
  everyRowAsText,
  seedActiveUser,
  seedInstallation,
  seedPassword,
  seedTotp,
  setUserStatus,
  totpCodeAt,
} from './test-support.js';
import { LOGIN_THROTTLE } from './throttle.js';
import {
  confirmTotp,
  enrolTotp,
  removeTotp,
  TOTP_SETTINGS,
  verifyTotp,
} from './totp.js';
import { useTestServerKeys } from '../keys/test-support.js';

/** The server keys of this test file, in a key directory that is deleted afterwards. */
const serverKeys = useTestServerKeys();

// An invented password, free of any word of the fixture addresses.
const PASSWORD = 'harbour-warehouse-night-shoot';

const T0 = new Date('2026-03-02T09:00:15.000Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const STEP = TOTP_SETTINGS.periodSeconds * SECOND;
const at = (ms: number) => new Date(T0.getTime() + ms);

describe('TOTP_SETTINGS', () => {
  it('is what every authenticator app supports: SHA-1, six digits, thirty seconds, one step either side', () => {
    expect(TOTP_SETTINGS).toMatchObject({
      algorithm: 'SHA1',
      digits: 6,
      periodSeconds: 30,
      window: 1,
    });
  });
});

describe.each(testTargets)('TOTP on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    await seedInstallation(database);
  });
  afterAll(async () => {
    await cleanup();
  });

  const db = () => database.db;

  const credentialOf = async (userId: string) => {
    const [row] = await db()
      .select()
      .from(totpCredential)
      .where(eq(totpCredential.userId, userId));
    return row;
  };

  const eventsAbout = async (userId: string, category: string) =>
    (await db().select().from(auditEvent)).filter(
      (event) => event.targetId === userId && event.category === category,
    );

  /** A user with a confirmed authenticator; returns the secret. */
  async function enrolled() {
    const userId = await seedActiveUser(database);
    const secret = await seedTotp(database, userId, {
      now: T0,
      dataKeys: serverKeys().dataKeys,
    });
    return { userId, secret };
  }

  describe('verifyTotp', () => {
    it('accepts the code of the current step, and records the step', async () => {
      const { userId, secret } = await enrolled();
      expect(
        (
          await verifyTotp(db(), userId, totpCodeAt(secret, T0), {
            now: T0,
            dataKeys: serverKeys().dataKeys,
          })
        ).ok,
      ).toBe(true);
      const row = await credentialOf(userId);
      expect(row!.lastUsedStep).toBe(Math.floor(T0.getTime() / STEP));
    });

    it('accepts a code one step early or one step late, and refuses two steps either way', async () => {
      for (const [offset, accepted] of [
        [-STEP, true],
        [STEP, true],
        [-2 * STEP, false],
        [2 * STEP, false],
        [-3 * STEP, false],
      ] as const) {
        const { userId, secret } = await enrolled();
        expect(
          (
            await verifyTotp(db(), userId, totpCodeAt(secret, at(offset)), {
              now: T0,
              dataKeys: serverKeys().dataKeys,
            })
          ).ok,
          `offset ${offset / STEP} steps`,
        ).toBe(accepted);
      }
    });

    it('never accepts the same step twice', async () => {
      const { userId, secret } = await enrolled();
      const code = totpCodeAt(secret, T0);
      expect(
        (
          await verifyTotp(db(), userId, code, {
            now: T0,
            dataKeys: serverKeys().dataKeys,
          })
        ).ok,
      ).toBe(true);
      expect(
        (
          await verifyTotp(db(), userId, code, {
            now: T0,
            dataKeys: serverKeys().dataKeys,
          })
        ).ok,
      ).toBe(false);
      // Nor a moment later, while the code is still in its window.
      expect(
        (
          await verifyTotp(db(), userId, code, {
            now: at(STEP),
            dataKeys: serverKeys().dataKeys,
          })
        ).ok,
      ).toBe(false);
    });

    it('never accepts an older step once a newer one was used', async () => {
      const { userId, secret } = await enrolled();
      // A phone whose clock runs ahead: the code of the next step is accepted.
      expect(
        (
          await verifyTotp(db(), userId, totpCodeAt(secret, at(STEP)), {
            now: T0,
            dataKeys: serverKeys().dataKeys,
          })
        ).ok,
      ).toBe(true);
      // The code of the current step, and the one before it, are now older.
      expect(
        (
          await verifyTotp(db(), userId, totpCodeAt(secret, T0), {
            now: T0,
            dataKeys: serverKeys().dataKeys,
          })
        ).ok,
      ).toBe(false);
      expect(
        (
          await verifyTotp(db(), userId, totpCodeAt(secret, at(-STEP)), {
            now: T0,
            dataKeys: serverKeys().dataKeys,
          })
        ).ok,
      ).toBe(false);
      // The step after the one used is fine.
      expect(
        (
          await verifyTotp(db(), userId, totpCodeAt(secret, at(2 * STEP)), {
            now: at(STEP),
            dataKeys: serverKeys().dataKeys,
          })
        ).ok,
      ).toBe(true);
    });

    it('lets only one of two requests with the same code through', async () => {
      const { userId, secret } = await enrolled();
      const code = totpCodeAt(secret, T0);
      const results = await Promise.all([
        verifyTotp(db(), userId, code, {
          now: T0,
          dataKeys: serverKeys().dataKeys,
        }),
        verifyTotp(db(), userId, code, {
          now: T0,
          dataKeys: serverKeys().dataKeys,
        }),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
    });

    it('accepts the code with a space in the middle, as an app shows it', async () => {
      const { userId, secret } = await enrolled();
      const code = totpCodeAt(secret, T0);
      const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
      expect(
        (
          await verifyTotp(db(), userId, spaced, {
            now: T0,
            dataKeys: serverKeys().dataKeys,
          })
        ).ok,
      ).toBe(true);
    });

    it('refuses anything that is not six digits, without looking anything up', async () => {
      const { userId, secret } = await enrolled();
      const real = totpCodeAt(secret, T0);
      for (const bad of [
        '',
        '12345',
        `${real}0`,
        'abcdef',
        `${real.slice(0, 5)}x`,
        '１２３４５６',
        'x'.repeat(5000),
        undefined as never,
        123456 as never,
      ]) {
        expect(
          (
            await verifyTotp(db(), userId, bad, {
              now: T0,
              dataKeys: serverKeys().dataKeys,
            })
          ).ok,
        ).toBe(false);
      }
      expect((await credentialOf(userId))!.lastUsedStep).toBeNull();
    });

    it('refuses a secret that is still being set up, and a user with none', async () => {
      const userId = await seedActiveUser(database);
      const secret = await seedTotp(database, userId, {
        confirmed: false,
        dataKeys: serverKeys().dataKeys,
      });
      expect(
        (
          await verifyTotp(db(), userId, totpCodeAt(secret, T0), {
            now: T0,
            dataKeys: serverKeys().dataKeys,
          })
        ).ok,
      ).toBe(false);
      expect(
        (
          await verifyTotp(db(), newId(), totpCodeAt(secret, T0), {
            now: T0,
            dataKeys: serverKeys().dataKeys,
          })
        ).ok,
      ).toBe(false);
    });

    it('refuses the code of another user’s secret', async () => {
      const first = await enrolled();
      const second = await enrolled();
      expect(
        (
          await verifyTotp(db(), second.userId, totpCodeAt(first.secret, T0), {
            now: T0,
            dataKeys: serverKeys().dataKeys,
          })
        ).ok,
      ).toBe(false);
    });
  });

  describe('enrolTotp', () => {
    it('makes a new unconfirmed secret and returns it, with the address for an app, once', async () => {
      const userId = await seedActiveUser(database);
      const result = await enrolTotp(db(), userId, {
        now: T0,
        dataKeys: serverKeys().dataKeys,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // 20 random bytes in base32.
      expect(result.secret).toMatch(/^[A-Z2-7]{32}$/);
      const uri = new URL(result.otpauthUri);
      expect(uri.protocol).toBe('otpauth:');
      expect(uri.host).toBe('totp');
      expect(decodeURIComponent(uri.pathname)).toBe(
        `/${TOTP_SETTINGS.issuer}:${await emailOf(database, userId)}`,
      );
      expect(Object.fromEntries(uri.searchParams)).toEqual({
        secret: result.secret,
        issuer: TOTP_SETTINGS.issuer,
        algorithm: 'SHA1',
        digits: '6',
        period: '30',
      });
      const row = await credentialOf(userId);
      // Stored sealed, never as the base32 the person is shown.
      expect(row!.secret).toMatch(/^v1\./);
      expect(row!.secret).not.toContain(result.secret);
      expect(row!.confirmedAt).toBeNull();
      expect(row!.lastUsedStep).toBeNull();
    });

    it('audits it without the secret', async () => {
      const userId = await seedActiveUser(database);
      const result = await enrolTotp(db(), userId, {
        now: T0,
        dataKeys: serverKeys().dataKeys,
      });
      const [event] = await eventsAbout(userId, AUTH_AUDIT.totpEnrolled);
      expect(event).toMatchObject({
        action: 'enrol',
        actorType: 'user',
        actorId: userId,
        details: { replacedPending: false },
      });
      if (!result.ok) throw new Error('not enrolled');
      expect(
        JSON.stringify(await db().select().from(auditEvent)),
      ).not.toContain(result.secret);
    });

    it('replaces a secret that was never confirmed, so the old one stops working', async () => {
      const userId = await seedActiveUser(database);
      const first = await enrolTotp(db(), userId, {
        now: T0,
        dataKeys: serverKeys().dataKeys,
      });
      const second = await enrolTotp(db(), userId, {
        now: at(MINUTE),
        dataKeys: serverKeys().dataKeys,
      });
      if (!first.ok || !second.ok) throw new Error('not enrolled');
      expect(second.secret).not.toBe(first.secret);
      expect(
        await db()
          .select()
          .from(totpCredential)
          .where(eq(totpCredential.userId, userId)),
      ).toHaveLength(1);
      expect(
        await confirmTotp(db(), {
          userId,
          code: totpCodeAt(first.secret, at(MINUTE)),
          now: at(MINUTE),
          dataKeys: serverKeys().dataKeys,
        }),
      ).toEqual({ ok: false, reason: 'code-incorrect' });
      expect(
        await confirmTotp(db(), {
          userId,
          code: totpCodeAt(second.secret, at(MINUTE)),
          now: at(MINUTE),
          dataKeys: serverKeys().dataKeys,
        }),
      ).toEqual({ ok: true });
      const events = await eventsAbout(userId, AUTH_AUDIT.totpEnrolled);
      expect(
        events
          .map(
            (event) =>
              (event.details as { replacedPending: boolean }).replacedPending,
          )
          .sort(),
      ).toEqual([false, true]);
    });

    it('refuses to start again once an authenticator is confirmed, and leaves it as it is', async () => {
      const { userId } = await enrolled();
      const stored = (await credentialOf(userId))!.secret;
      const before = (await eventsAbout(userId, AUTH_AUDIT.totpEnrolled))
        .length;
      expect(
        await enrolTotp(db(), userId, {
          now: T0,
          dataKeys: serverKeys().dataKeys,
        }),
      ).toEqual({
        ok: false,
        reason: 'already-enrolled',
      });
      expect((await credentialOf(userId))!.secret).toBe(stored);
      expect((await eventsAbout(userId, AUTH_AUDIT.totpEnrolled)).length).toBe(
        before,
      );
    });

    it('refuses an unknown or a disabled user with a typed error', async () => {
      await expect(
        enrolTotp(db(), newId(), { now: T0, dataKeys: serverKeys().dataKeys }),
      ).rejects.toMatchObject({
        reason: 'user-not-found',
      });
      const disabled = await seedActiveUser(database);
      await setUserStatus(database, disabled, 'disabled');
      const error = await enrolTotp(db(), disabled, {
        now: T0,
        dataKeys: serverKeys().dataKeys,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AuthStateError);
      expect(await credentialOf(disabled)).toBeUndefined();
    });
  });

  describe('confirmTotp', () => {
    async function pending() {
      const userId = await seedActiveUser(database);
      const result = await enrolTotp(db(), userId, {
        now: T0,
        dataKeys: serverKeys().dataKeys,
      });
      if (!result.ok) throw new Error('not enrolled');
      return { userId, secret: result.secret };
    }

    it('confirms with the right code and uses up that step, so it cannot be used to sign in', async () => {
      const { userId, secret } = await pending();
      const code = totpCodeAt(secret, at(SECOND));
      expect(
        await confirmTotp(db(), {
          userId,
          code,
          now: at(SECOND),
          dataKeys: serverKeys().dataKeys,
        }),
      ).toEqual({ ok: true });
      const row = await credentialOf(userId);
      expect(row!.confirmedAt).toEqual(at(SECOND));
      expect(row!.lastUsedStep).toBe(Math.floor(at(SECOND).getTime() / STEP));
      expect(
        (
          await verifyTotp(db(), userId, code, {
            now: at(2 * SECOND),
            dataKeys: serverKeys().dataKeys,
          })
        ).ok,
      ).toBe(false);
      const [event] = await eventsAbout(userId, AUTH_AUDIT.totpConfirmed);
      expect(event).toMatchObject({
        action: 'confirm',
        actorId: userId,
        details: {},
      });
    });

    it('accepts a code one step either side, as signing in does', async () => {
      const { userId, secret } = await pending();
      expect(
        await confirmTotp(db(), {
          userId,
          code: totpCodeAt(secret, at(STEP)),
          now: T0,
          dataKeys: serverKeys().dataKeys,
        }),
      ).toEqual({ ok: true });
    });

    it('answers code-incorrect for a wrong code and stays unconfirmed, writing no event', async () => {
      const { userId, secret } = await pending();
      const right = totpCodeAt(secret, T0);
      const wrong = right === '000000' ? '000001' : '000000';
      expect(
        await confirmTotp(db(), {
          userId,
          code: wrong,
          now: T0,
          dataKeys: serverKeys().dataKeys,
        }),
      ).toEqual({
        ok: false,
        reason: 'code-incorrect',
      });
      expect(
        await confirmTotp(db(), {
          userId,
          code: 'not a code',
          now: T0,
          dataKeys: serverKeys().dataKeys,
        }),
      ).toEqual({ ok: false, reason: 'code-incorrect' });
      expect((await credentialOf(userId))!.confirmedAt).toBeNull();
      expect(await eventsAbout(userId, AUTH_AUDIT.totpConfirmed)).toEqual([]);
    });

    it('says when nothing is being set up, and when it is already confirmed', async () => {
      const none = await seedActiveUser(database);
      expect(
        await confirmTotp(db(), {
          userId: none,
          code: '123456',
          now: T0,
          dataKeys: serverKeys().dataKeys,
        }),
      ).toEqual({ ok: false, reason: 'no-pending-enrolment' });
      const { userId, secret } = await enrolled();
      expect(
        await confirmTotp(db(), {
          userId,
          code: totpCodeAt(secret, T0),
          now: T0,
          dataKeys: serverKeys().dataKeys,
        }),
      ).toEqual({ ok: false, reason: 'already-enrolled' });
    });

    it('makes a recovery session full, and only when the code was right', async () => {
      const { userId, secret } = await pending();
      const recovery = await createSession(db(), {
        userId,
        method: 'recovery',
        now: T0,
      });
      const options = {
        userId,
        session: { id: recovery.session.id, scope: 'recovery' as const },
        now: at(MINUTE),
      };
      await confirmTotp(db(), {
        ...options,
        code: '000000',
        dataKeys: serverKeys().dataKeys,
      });
      expect(
        (await validateSession(db(), recovery.token, at(MINUTE)))!.session
          .scope,
      ).toBe('recovery');
      expect(
        await confirmTotp(db(), {
          ...options,
          code: totpCodeAt(secret, at(MINUTE)),
          dataKeys: serverKeys().dataKeys,
        }),
      ).toEqual({ ok: true });
      expect(
        (await validateSession(db(), recovery.token, at(MINUTE)))!.session
          .scope,
      ).toBe('full');
    });
  });

  describe('removeTotp', () => {
    it('needs the password: a wrong one removes nothing, is audited as a failed re-check and counts toward the throttle', async () => {
      const { userId } = await enrolled();
      await seedPassword(database, userId, PASSWORD);
      expect(
        await removeTotp(db(), {
          userId,
          password: 'not-the-password-x',
          now: T0,
        }),
      ).toEqual({ ok: false, reason: 'current-password-incorrect' });
      expect(await credentialOf(userId)).toBeDefined();
      const [failure] = await eventsAbout(userId, AUTH_AUDIT.loginStepFailed);
      expect(failure!.details).toEqual({
        method: 'password',
        reason: 'wrong-secret',
        purpose: 'reauthenticate',
      });
      expect(await eventsAbout(userId, AUTH_AUDIT.totpRemoved)).toEqual([]);
    });

    it('removes it with the right password, revokes the other sessions and keeps this one, and audits it', async () => {
      const { userId } = await enrolled();
      await seedPassword(database, userId, PASSWORD);
      const other = await createSession(db(), {
        userId,
        method: 'password',
        now: T0,
      });
      const mine = await createSession(db(), {
        userId,
        method: 'password+totp',
        now: T0,
      });
      expect(
        await removeTotp(db(), {
          userId,
          password: PASSWORD,
          session: { id: mine.session.id },
          now: at(MINUTE),
        }),
      ).toEqual({ ok: true });
      expect(await credentialOf(userId)).toBeUndefined();
      expect(
        await validateSession(db(), other.token, at(2 * MINUTE)),
      ).toBeNull();
      expect(
        await validateSession(db(), mine.token, at(2 * MINUTE)),
      ).not.toBeNull();
      const [revoked] = await db()
        .select()
        .from(session)
        .where(eq(session.id, other.session.id));
      expect(revoked!.revokedReason).toBe('totp-removed');
      const [event] = await eventsAbout(userId, AUTH_AUDIT.totpRemoved);
      expect(event).toMatchObject({
        action: 'remove',
        actorId: userId,
        details: { wasConfirmed: true },
      });
    });

    it('removes a secret that was only being set up', async () => {
      const userId = await seedActiveUser(database);
      await seedPassword(database, userId, PASSWORD);
      await enrolTotp(db(), userId, {
        now: T0,
        dataKeys: serverKeys().dataKeys,
      });
      expect(
        await removeTotp(db(), { userId, password: PASSWORD, now: T0 }),
      ).toEqual({ ok: true });
      expect(await credentialOf(userId)).toBeUndefined();
      const [event] = await eventsAbout(userId, AUTH_AUDIT.totpRemoved);
      expect(event!.details).toEqual({ wasConfirmed: false });
    });

    it('says not-enrolled when there is nothing to remove, without checking the password', async () => {
      const userId = await seedActiveUser(database);
      await seedPassword(database, userId, PASSWORD);
      expect(
        await removeTotp(db(), {
          userId,
          password: 'not-the-password-x',
          now: T0,
        }),
      ).toEqual({ ok: false, reason: 'not-enrolled' });
      expect(await eventsAbout(userId, AUTH_AUDIT.loginStepFailed)).toEqual([]);
    });

    it('refuses a user with no password to give, and a throttled account even with the right one', async () => {
      const noPassword = await enrolled();
      expect(
        await removeTotp(db(), {
          userId: noPassword.userId,
          password: PASSWORD,
          now: T0,
        }),
      ).toEqual({ ok: false, reason: 'current-password-incorrect' });
      expect(await credentialOf(noPassword.userId)).toBeDefined();

      const { userId } = await enrolled();
      await seedPassword(database, userId, PASSWORD);
      for (let i = 0; i < LOGIN_THROTTLE.maxFailures; i += 1) {
        await removeTotp(db(), {
          userId,
          password: 'not-the-password-x',
          now: at(i * SECOND),
        });
      }
      expect(
        await removeTotp(db(), {
          userId,
          password: PASSWORD,
          now: at(10 * SECOND),
        }),
      ).toEqual({ ok: false, reason: 'current-password-incorrect' });
      expect(await credentialOf(userId)).toBeDefined();
    });
  });

  it('keeps the plain secret out of every table and every event', async () => {
    const userId = await seedActiveUser(database);
    const result = await enrolTotp(db(), userId, {
      now: T0,
      dataKeys: serverKeys().dataKeys,
    });
    if (!result.ok) throw new Error('not enrolled');
    await confirmTotp(db(), {
      userId,
      code: totpCodeAt(result.secret, T0),
      now: T0,
      dataKeys: serverKeys().dataKeys,
    });
    expect(JSON.stringify(await db().select().from(auditEvent))).not.toContain(
      result.secret,
    );
    // It is stored sealed, in `totp_credential.secret`, a sensitive column: the
    // plain base32 is in no table at all.
    const everything = await everyRowAsText(database);
    expect(everything.split(result.secret)).toHaveLength(1);
    expect(everything).toContain('v1.');
  });
});
