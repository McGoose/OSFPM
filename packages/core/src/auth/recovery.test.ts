import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import { auditEvent, recoveryCode, session, user } from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import {
  consumeRecoveryCode,
  generateRecoveryCodes,
  RECOVERY_CODE_COUNT,
  verifyRecoveryLogin,
} from './recovery.js';
import { createSession, validateSession } from './sessions.js';
import { AUTH_AUDIT } from './shared.js';
import {
  emailOf,
  everyRowAsText,
  seedActiveUser,
  seedInstallation,
  setUserStatus,
} from './test-support.js';
import { LOGIN_THROTTLE, recordLoginFailure } from './throttle.js';
import { hashHumanCode, normaliseHumanCode } from './tokens.js';

const T0 = new Date('2026-03-02T09:00:00.000Z');
const LATER = new Date('2026-03-02T10:00:00.000Z');

describe.each(testTargets)('recovery codes on $name', (target) => {
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
  const rowsOfUser = (userId: string) =>
    db().select().from(recoveryCode).where(eq(recoveryCode.userId, userId));

  describe('generateRecoveryCodes', () => {
    it('returns 10 different codes and stores only their hashes', async () => {
      const userId = await seedActiveUser(database);
      const codes = await generateRecoveryCodes(db(), userId, { now: T0 });
      expect(RECOVERY_CODE_COUNT).toBe(10);
      expect(codes).toHaveLength(10);
      expect(new Set(codes).size).toBe(10);
      for (const code of codes) {
        expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
      }
      const stored = await rowsOfUser(userId);
      expect(stored).toHaveLength(10);
      expect(stored.map((row) => row.codeHash).sort()).toEqual(
        codes.map((code) => hashHumanCode(code)!).sort(),
      );
      expect(stored.every((row) => row.usedAt === null)).toBe(true);
      const text = await everyRowAsText(database);
      for (const code of codes) {
        expect(text).not.toContain(code);
        expect(text).not.toContain(normaliseHumanCode(code)!);
      }
    });

    it('replaces an earlier set: the old codes stop working, used or not', async () => {
      const userId = await seedActiveUser(database);
      const first = await generateRecoveryCodes(db(), userId, { now: T0 });
      expect(
        await consumeRecoveryCode(db(), userId, first[0]!, { now: T0 }),
      ).toBe(true);
      const second = await generateRecoveryCodes(db(), userId, { now: LATER });
      expect(second.some((code) => first.includes(code))).toBe(false);
      // Ten rows, not twenty, and none of them is the used one.
      const stored = await rowsOfUser(userId);
      expect(stored).toHaveLength(10);
      expect(stored.every((row) => row.usedAt === null)).toBe(true);
      for (const old of first) {
        expect(
          await consumeRecoveryCode(db(), userId, old, { now: LATER }),
        ).toBe(false);
      }
      expect(
        await consumeRecoveryCode(db(), userId, second[0]!, { now: LATER }),
      ).toBe(true);
    });

    it('leaves another user’s codes alone', async () => {
      const first = await seedActiveUser(database);
      const second = await seedActiveUser(database);
      const theirs = await generateRecoveryCodes(db(), second, { now: T0 });
      await generateRecoveryCodes(db(), first, { now: T0 });
      await generateRecoveryCodes(db(), first, { now: LATER });
      expect(await rowsOfUser(second)).toHaveLength(10);
      expect(
        await consumeRecoveryCode(db(), second, theirs[0]!, { now: LATER }),
      ).toBe(true);
    });

    it('leaves one set of ten when two requests run at once', async () => {
      const userId = await seedActiveUser(database);
      await Promise.all([
        generateRecoveryCodes(db(), userId, { now: T0 }),
        generateRecoveryCodes(db(), userId, { now: T0 }),
      ]);
      expect(await rowsOfUser(userId)).toHaveLength(10);
    });

    it('refuses an unknown user, and writes nothing', async () => {
      await expect(
        generateRecoveryCodes(db(), newId(), { now: T0 }),
      ).rejects.toMatchObject({ reason: 'user-not-found' });
    });
  });

  describe('consumeRecoveryCode', () => {
    it('accepts a code once, and records when', async () => {
      const userId = await seedActiveUser(database);
      const [code] = await generateRecoveryCodes(db(), userId, { now: T0 });
      expect(
        await consumeRecoveryCode(db(), userId, code!, { now: LATER }),
      ).toBe(true);
      expect(
        await consumeRecoveryCode(db(), userId, code!, { now: LATER }),
      ).toBe(false);
      const used = (await rowsOfUser(userId)).filter((row) => row.usedAt);
      expect(used).toHaveLength(1);
      expect(used[0]!.usedAt).toEqual(LATER);
      expect(used[0]!.codeHash).toBe(hashHumanCode(code!));
    });

    it('accepts any spelling of the code', async () => {
      const userId = await seedActiveUser(database);
      const codes = await generateRecoveryCodes(db(), userId, { now: T0 });
      const spellings = [
        codes[0]!.toLowerCase(),
        codes[1]!.replaceAll('-', ''),
        ` ${codes[2]!.replaceAll('-', ' ')} `,
      ];
      for (const spelling of spellings) {
        expect(
          await consumeRecoveryCode(db(), userId, spelling, { now: LATER }),
        ).toBe(true);
      }
    });

    it('refuses a wrong code, another user’s code, and anything not shaped like a code', async () => {
      const userId = await seedActiveUser(database);
      const other = await seedActiveUser(database);
      await generateRecoveryCodes(db(), userId, { now: T0 });
      const [theirs] = await generateRecoveryCodes(db(), other, { now: T0 });
      for (const bad of [
        'AAAA-AAAA-AAAA-AAAA',
        theirs!,
        '',
        'short',
        '__proto__',
        'x'.repeat(5000),
        null as unknown as string,
        undefined as unknown as string,
        42 as unknown as string,
      ]) {
        expect(
          await consumeRecoveryCode(db(), userId, bad, { now: LATER }),
        ).toBe(false);
      }
      // The other user's code was not spent by the attempt above.
      expect(
        await consumeRecoveryCode(db(), other, theirs!, { now: LATER }),
      ).toBe(true);
    });

    it('lets only one of two requests with the same code succeed', async () => {
      const userId = await seedActiveUser(database);
      const [code] = await generateRecoveryCodes(db(), userId, { now: T0 });
      const results = await Promise.all([
        consumeRecoveryCode(db(), userId, code!, { now: LATER }),
        consumeRecoveryCode(db(), userId, code!, { now: LATER }),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('does not use up, or accept, the code of a disabled or deleted user', async () => {
      const userId = await seedActiveUser(database);
      const [code] = await generateRecoveryCodes(db(), userId, { now: T0 });
      await setUserStatus(database, userId, 'disabled');
      expect(
        await consumeRecoveryCode(db(), userId, code!, { now: LATER }),
      ).toBe(false);
      expect(
        (await rowsOfUser(userId)).every((row) => row.usedAt === null),
      ).toBe(true);
      await setUserStatus(database, userId, 'active');
      expect(
        await consumeRecoveryCode(db(), userId, code!, { now: LATER }),
      ).toBe(true);
    });
  });

  describe('verifyRecoveryLogin', () => {
    const codeUses = async (userId: string) =>
      (await db().select().from(auditEvent)).filter(
        (event) =>
          event.category === AUTH_AUDIT.recoveryCodeUsed &&
          event.actorId === userId,
      );
    const unused = async (userId: string) =>
      (await rowsOfUser(userId)).every((row) => row.usedAt === null);

    it('lets in a right code once, returns the user and audits the use of the code', async () => {
      const userId = await seedActiveUser(database);
      const email = await emailOf(database, userId);
      const [code] = await generateRecoveryCodes(db(), userId, { now: T0 });
      const result = await verifyRecoveryLogin(db(), {
        email,
        code: code!,
        now: LATER,
      });
      expect(result).toMatchObject({ ok: true, user: { id: userId, email } });
      expect(
        await verifyRecoveryLogin(db(), { email, code: code!, now: LATER }),
      ).toEqual({ ok: false });
      expect(await codeUses(userId)).toHaveLength(1);
    });

    it('takes the address in any case and the code in any case with or without hyphens', async () => {
      const userId = await seedActiveUser(database);
      const email = await emailOf(database, userId);
      const codes = await generateRecoveryCodes(db(), userId, { now: T0 });
      const result = await verifyRecoveryLogin(db(), {
        email: '  ' + email.toUpperCase() + ' ',
        code: codes[0]!.toLowerCase().replaceAll('-', ' '),
        now: LATER,
      });
      expect(result).toMatchObject({ ok: true, user: { id: userId } });
    });

    it('gives the same answer for every failure and keeps a code that was not used', async () => {
      const wrong = await seedActiveUser(database);
      await generateRecoveryCodes(db(), wrong, { now: T0 });
      const disabled = await seedActiveUser(database);
      const [disabledCode] = await generateRecoveryCodes(db(), disabled, {
        now: T0,
      });
      await setUserStatus(database, disabled, 'disabled');
      const deleted = await seedActiveUser(database);
      const [deletedCode] = await generateRecoveryCodes(db(), deleted, {
        now: T0,
      });
      await db()
        .update(user)
        .set({ deletedAt: T0 })
        .where(eq(user.id, deleted));
      const throttled = await seedActiveUser(database);
      const [throttledCode] = await generateRecoveryCodes(db(), throttled, {
        now: T0,
      });
      for (let i = 0; i < LOGIN_THROTTLE.maxFailures; i += 1) {
        await recordLoginFailure(db(), {
          method: 'recovery',
          reason: 'wrong-secret',
          userId: throttled,
          now: new Date(LATER.getTime() + i * 1000),
        });
      }
      const another = await seedActiveUser(database);
      const [anotherCode] = await generateRecoveryCodes(db(), another, {
        now: T0,
      });
      const wrongEmail = await emailOf(database, wrong);
      const attempts = [
        { email: 'nobody@demopictures.example', code: anotherCode! },
        { email: wrongEmail, code: 'AAAA-AAAA-AAAA-AAAA' },
        { email: wrongEmail, code: 'not a code' },
        { email: wrongEmail, code: anotherCode! },
        { email: await emailOf(database, disabled), code: disabledCode! },
        { email: await emailOf(database, deleted), code: deletedCode! },
        { email: await emailOf(database, throttled), code: throttledCode! },
      ];
      const later = new Date(LATER.getTime() + 60 * 1000);
      for (const attempt of attempts) {
        expect(
          await verifyRecoveryLogin(db(), { ...attempt, now: later }),
        ).toEqual({ ok: false });
      }
      // A refusal that was not a wrong guess does not use a code up.
      for (const userId of [wrong, disabled, deleted, throttled, another]) {
        expect(await unused(userId)).toBe(true);
      }
    });

    it('audits each failure with the method and a reason class, and never what was typed', async () => {
      const userId = await seedActiveUser(database);
      const email = await emailOf(database, userId);
      await generateRecoveryCodes(db(), userId, { now: T0 });
      const disabled = await seedActiveUser(database);
      const [disabledCode] = await generateRecoveryCodes(db(), disabled, {
        now: T0,
      });
      await setUserStatus(database, disabled, 'disabled');
      const before = (await db().select().from(auditEvent)).length;
      const typedEmail = 'someone.unknown@demopictures.example';
      const typedCode = 'ZZZZ-YYYY-XXXX-WWWW';
      await verifyRecoveryLogin(db(), {
        email: typedEmail,
        code: typedCode,
        now: LATER,
      });
      await verifyRecoveryLogin(db(), { email, code: typedCode, now: LATER });
      await verifyRecoveryLogin(db(), {
        email: await emailOf(database, disabled),
        code: disabledCode!,
        now: LATER,
      });
      const events = (await db().select().from(auditEvent)).slice(before);
      expect(events.map((event) => event.category)).toEqual([
        AUTH_AUDIT.loginStepFailed,
        AUTH_AUDIT.loginStepFailed,
        AUTH_AUDIT.loginStepFailed,
      ]);
      expect(events[0]).toMatchObject({
        actorType: 'system',
        actorId: null,
        targetId: null,
        details: { method: 'recovery', reason: 'unknown-account' },
      });
      expect(events[1]).toMatchObject({
        targetId: userId,
        details: { method: 'recovery', reason: 'wrong-secret' },
      });
      expect(events[2]).toMatchObject({
        targetId: disabled,
        details: { method: 'recovery', reason: 'disabled' },
      });
      const text = JSON.stringify(events);
      for (const secret of [typedEmail, typedCode, disabledCode!]) {
        expect(text).not.toContain(secret);
      }
    });

    it('does not check the code of an account that has had five wrong guesses, even a right one, until the window has passed', async () => {
      const userId = await seedActiveUser(database);
      const email = await emailOf(database, userId);
      const [code] = await generateRecoveryCodes(db(), userId, { now: T0 });
      for (let i = 0; i < LOGIN_THROTTLE.maxFailures; i += 1) {
        expect(
          await verifyRecoveryLogin(db(), {
            email,
            code: 'AAAA-AAAA-AAAA-AAAA',
            now: new Date(LATER.getTime() + i * 1000),
          }),
        ).toEqual({ ok: false });
      }
      expect(
        await verifyRecoveryLogin(db(), {
          email,
          code: code!,
          now: new Date(LATER.getTime() + 10 * 1000),
        }),
      ).toEqual({ ok: false });
      expect(await unused(userId)).toBe(true);
      expect(
        await verifyRecoveryLogin(db(), {
          email,
          code: code!,
          now: new Date(LATER.getTime() + LOGIN_THROTTLE.windowMs),
        }),
      ).toMatchObject({ ok: true });
    });

    describe('the sessions of the user', () => {
      const sessionRows = async (userId: string) =>
        (await db().select().from(session)).filter(
          (row) => row.userId === userId,
        );
      const revocations = async (userId: string) =>
        (await db().select().from(auditEvent)).filter(
          (event) =>
            event.category === AUTH_AUDIT.sessionsRevoked &&
            event.targetId === userId,
        );

      it('ends every live session of the user, with the reason recovery-used, and no one else’s', async () => {
        const userId = await seedActiveUser(database);
        const email = await emailOf(database, userId);
        const [code] = await generateRecoveryCodes(db(), userId, { now: T0 });
        const first = await createSession(db(), {
          userId,
          method: 'password',
          now: T0,
        });
        const second = await createSession(db(), {
          userId,
          method: 'passkey',
          now: T0,
        });
        const someoneElse = await createSession(db(), {
          userId: await seedActiveUser(database),
          method: 'password',
          now: T0,
        });
        expect(
          await verifyRecoveryLogin(db(), { email, code: code!, now: LATER }),
        ).toMatchObject({ ok: true });
        const rows = await sessionRows(userId);
        expect(rows).toHaveLength(2);
        for (const row of rows) {
          expect(row.revokedAt).toEqual(LATER);
          expect(row.revokedReason).toBe('recovery-used');
        }
        expect(await validateSession(db(), first.token, LATER)).toBeNull();
        expect(await validateSession(db(), second.token, LATER)).toBeNull();
        expect(
          await validateSession(db(), someoneElse.token, LATER),
        ).not.toBeNull();
        // One event, from the user's own sign-in with the code, for all of them.
        expect(await revocations(userId)).toHaveLength(1);
        expect((await revocations(userId))[0]).toMatchObject({
          action: 'revoke-all',
          actorType: 'user',
          actorId: userId,
          details: { reason: 'recovery-used', count: 2, exceptSessionId: null },
        });
      });

      it('leaves the session made next alone: it is the only one live afterwards', async () => {
        const userId = await seedActiveUser(database);
        const email = await emailOf(database, userId);
        const [code] = await generateRecoveryCodes(db(), userId, { now: T0 });
        await createSession(db(), { userId, method: 'password', now: T0 });
        await verifyRecoveryLogin(db(), { email, code: code!, now: LATER });
        // The route makes it right after, in the same transaction.
        const recovery = await createSession(db(), {
          userId,
          method: 'recovery',
          now: LATER,
        });
        expect(
          await validateSession(db(), recovery.token, LATER),
        ).not.toBeNull();
        const live = (await sessionRows(userId)).filter(
          (row) => row.revokedAt === null,
        );
        expect(live.map((row) => row.id)).toEqual([recovery.session.id]);
      });

      it('writes no event when the user had no session to end', async () => {
        const userId = await seedActiveUser(database);
        const email = await emailOf(database, userId);
        const [code] = await generateRecoveryCodes(db(), userId, { now: T0 });
        expect(
          await verifyRecoveryLogin(db(), { email, code: code!, now: LATER }),
        ).toMatchObject({ ok: true });
        // The code was used, which has its own event; no session changed.
        expect(await revocations(userId)).toEqual([]);
      });

      it('ends nothing when the sign-in fails: a wrong code, a disabled user, a closed account', async () => {
        const wrong = await seedActiveUser(database);
        await generateRecoveryCodes(db(), wrong, { now: T0 });
        const wrongSession = await createSession(db(), {
          userId: wrong,
          method: 'password',
          now: T0,
        });
        const disabled = await seedActiveUser(database);
        const [disabledCode] = await generateRecoveryCodes(db(), disabled, {
          now: T0,
        });
        await createSession(db(), {
          userId: disabled,
          method: 'password',
          now: T0,
        });
        const throttled = await seedActiveUser(database);
        const [throttledCode] = await generateRecoveryCodes(db(), throttled, {
          now: T0,
        });
        const throttledSession = await createSession(db(), {
          userId: throttled,
          method: 'password',
          now: T0,
        });
        for (let i = 0; i < LOGIN_THROTTLE.maxFailures; i += 1) {
          await recordLoginFailure(db(), {
            method: 'recovery',
            reason: 'wrong-secret',
            userId: throttled,
            now: new Date(LATER.getTime() + i * 1000),
          });
        }
        const later = new Date(LATER.getTime() + 60 * 1000);
        await verifyRecoveryLogin(db(), {
          email: await emailOf(database, wrong),
          code: 'AAAA-AAAA-AAAA-AAAA',
          now: later,
        });
        await verifyRecoveryLogin(db(), {
          email: await emailOf(database, throttled),
          code: throttledCode!,
          now: later,
        });
        // The disabled user: the code is right, the account is not usable.
        await setUserStatus(database, disabled, 'disabled');
        await verifyRecoveryLogin(db(), {
          email: await emailOf(database, disabled),
          code: disabledCode!,
          now: later,
        });
        for (const [userId, found] of [
          [wrong, wrongSession],
          [throttled, throttledSession],
        ] as const) {
          expect(await revocations(userId)).toEqual([]);
          expect(
            await validateSession(db(), found.token, later),
          ).not.toBeNull();
        }
        // A disabled user's session is not valid either way, so look at the
        // row: the attempt did not revoke it.
        expect(
          (await sessionRows(disabled)).map((row) => row.revokedAt),
        ).toEqual([null]);
        expect(await revocations(disabled)).toEqual([]);
      });
    });
  });
});
