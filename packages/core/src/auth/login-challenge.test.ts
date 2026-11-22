import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { auditEvent, loginChallenge } from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { AuthInputError, AuthStateError } from './errors.js';
import {
  consumeLoginChallenge,
  createLoginChallenge,
  LOGIN_CHALLENGE,
} from './login-challenge.js';
import { AUTH_AUDIT } from './shared.js';
import {
  everyRowAsText,
  seedActiveUser,
  seedInstallation,
  seedTotp,
  setUserStatus,
  totpCodeAt,
} from './test-support.js';
import { hashToken } from './tokens.js';
import { LOGIN_THROTTLE } from './throttle.js';
import { newId } from '../db/ids.js';

const T0 = new Date('2026-03-02T09:00:15.000Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const STEP = 30 * SECOND;
const at = (ms: number) => new Date(T0.getTime() + ms);

describe('LOGIN_CHALLENGE', () => {
  it('lasts five minutes and allows five code attempts', () => {
    expect(LOGIN_CHALLENGE.ttlMs).toBe(5 * MINUTE);
    expect(LOGIN_CHALLENGE.maxAttempts).toBe(5);
  });
});

describe.each(testTargets)('login challenges on $name', (target) => {
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

  /** A user with a confirmed authenticator and a fresh challenge made at T0. */
  async function waiting() {
    const userId = await seedActiveUser(database);
    const secret = await seedTotp(database, userId, { now: T0 });
    const { challenge } = await createLoginChallenge(db(), userId, {
      kind: 'totp',
      now: T0,
    });
    return { userId, secret, challenge };
  }

  const rowOf = async (challenge: string) => {
    const [row] = await db()
      .select()
      .from(loginChallenge)
      .where(eq(loginChallenge.tokenHash, hashToken(challenge)));
    return row;
  };

  const failures = async () =>
    (await db().select().from(auditEvent)).filter(
      (event) => event.category === AUTH_AUDIT.loginStepFailed,
    );
  const lastFailure = async () => {
    const all = await failures();
    return all[all.length - 1]!;
  };

  describe('createLoginChallenge', () => {
    it('returns a random token once, ending in five minutes, and stores only its hash', async () => {
      const userId = await seedActiveUser(database);
      const result = await createLoginChallenge(db(), userId, {
        kind: 'totp',
        now: T0,
      });
      expect(result.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(result.expiresAt).toEqual(at(LOGIN_CHALLENGE.ttlMs));
      const row = await rowOf(result.challenge);
      expect(row).toMatchObject({
        userId,
        kind: 'totp',
        attempts: 0,
        usedAt: null,
        expiresAt: at(LOGIN_CHALLENGE.ttlMs),
      });
      expect(await everyRowAsText(database)).not.toContain(result.challenge);
    });

    it('makes a different token every time', async () => {
      const userId = await seedActiveUser(database);
      const first = await createLoginChallenge(db(), userId, {
        kind: 'totp',
        now: T0,
      });
      const second = await createLoginChallenge(db(), userId, {
        kind: 'totp',
        now: T0,
      });
      expect(first.challenge).not.toBe(second.challenge);
    });

    it('refuses an unknown or a disabled user and a kind that is not on the list, writing nothing', async () => {
      await expect(
        createLoginChallenge(db(), newId(), { kind: 'totp', now: T0 }),
      ).rejects.toMatchObject({ reason: 'user-not-found' });
      const disabled = await seedActiveUser(database);
      await setUserStatus(database, disabled, 'disabled');
      await expect(
        createLoginChallenge(db(), disabled, { kind: 'totp', now: T0 }),
      ).rejects.toBeInstanceOf(AuthStateError);
      const userId = await seedActiveUser(database);
      await expect(
        createLoginChallenge(db(), userId, { kind: 'sms' as never, now: T0 }),
      ).rejects.toBeInstanceOf(AuthInputError);
      const rows = await db()
        .select()
        .from(loginChallenge)
        .where(eq(loginChallenge.userId, userId));
      expect(rows).toEqual([]);
    });
  });

  describe('consumeLoginChallenge', () => {
    it('takes the right code, returns the user, uses the challenge up and audits the step', async () => {
      const { userId, secret, challenge } = await waiting();
      const result = await consumeLoginChallenge(db(), {
        challenge,
        code: totpCodeAt(secret, at(SECOND)),
        now: at(SECOND),
      });
      expect(result).toMatchObject({ ok: true, user: { id: userId } });
      expect(await rowOf(challenge)).toMatchObject({
        attempts: 1,
        usedAt: at(SECOND),
      });
      const [passed] = (await db().select().from(auditEvent)).filter(
        (event) =>
          event.category === AUTH_AUDIT.loginStepPassed &&
          event.targetId === userId,
      );
      expect(passed).toMatchObject({
        actorId: userId,
        details: { method: 'totp', next: 'session' },
      });
    });

    it('can be used once: the same challenge with another right code is refused', async () => {
      const { secret, challenge } = await waiting();
      expect(
        await consumeLoginChallenge(db(), {
          challenge,
          code: totpCodeAt(secret, T0),
          now: T0,
        }),
      ).toMatchObject({ ok: true });
      expect(
        await consumeLoginChallenge(db(), {
          challenge,
          code: totpCodeAt(secret, at(STEP)),
          now: at(STEP),
        }),
      ).toEqual({ ok: false });
      expect((await lastFailure()).details).toEqual({
        method: 'totp',
        reason: 'challenge-invalid',
      });
    });

    it('lets only one of two requests through, even with two different right codes', async () => {
      const { secret, challenge } = await waiting();
      const results = await Promise.all([
        consumeLoginChallenge(db(), {
          challenge,
          code: totpCodeAt(secret, T0),
          now: T0,
        }),
        consumeLoginChallenge(db(), {
          challenge,
          code: totpCodeAt(secret, at(STEP)),
          now: T0,
        }),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
    });

    it('refuses a wrong code, spends an attempt and audits it', async () => {
      const { userId, secret, challenge } = await waiting();
      const right = totpCodeAt(secret, T0);
      const wrong = right === '000000' ? '000001' : '000000';
      expect(
        await consumeLoginChallenge(db(), { challenge, code: wrong, now: T0 }),
      ).toEqual({ ok: false });
      expect((await rowOf(challenge))!.attempts).toBe(1);
      expect((await rowOf(challenge))!.usedAt).toBeNull();
      expect(await lastFailure()).toMatchObject({
        targetId: userId,
        details: { method: 'totp', reason: 'wrong-secret' },
      });
      // It is still good for the right one.
      expect(
        await consumeLoginChallenge(db(), {
          challenge,
          code: right,
          now: at(SECOND),
        }),
      ).toMatchObject({ ok: true });
    });

    it('allows five attempts and no more: a sixth is refused even with the right code', async () => {
      const { secret, challenge } = await waiting();
      const right = totpCodeAt(secret, T0);
      const wrong = right === '000000' ? '000001' : '000000';
      for (let i = 0; i < LOGIN_CHALLENGE.maxAttempts; i += 1) {
        await consumeLoginChallenge(db(), {
          challenge,
          code: wrong,
          now: at(i * SECOND),
        });
      }
      expect((await rowOf(challenge))!.attempts).toBe(5);
      expect(
        await consumeLoginChallenge(db(), {
          challenge,
          code: right,
          now: at(10 * SECOND),
        }),
      ).toEqual({ ok: false });
      // The challenge ran out; it was not the throttle that refused.
      expect((await lastFailure()).details).toEqual({
        method: 'totp',
        reason: 'challenge-invalid',
      });
      expect((await rowOf(challenge))!.attempts).toBe(5);
    });

    it('takes the right code at the fifth attempt', async () => {
      const { secret, challenge } = await waiting();
      const right = totpCodeAt(secret, T0);
      const wrong = right === '000000' ? '000001' : '000000';
      for (let i = 0; i < LOGIN_CHALLENGE.maxAttempts - 1; i += 1) {
        await consumeLoginChallenge(db(), { challenge, code: wrong, now: T0 });
      }
      expect(
        await consumeLoginChallenge(db(), { challenge, code: right, now: T0 }),
      ).toMatchObject({ ok: true });
    });

    it('expires after five minutes, to the millisecond', async () => {
      const { secret, challenge } = await waiting();
      const late = at(LOGIN_CHALLENGE.ttlMs);
      expect(
        await consumeLoginChallenge(db(), {
          challenge,
          code: totpCodeAt(secret, late),
          now: late,
        }),
      ).toEqual({ ok: false });
      expect((await lastFailure()).details).toEqual({
        method: 'totp',
        reason: 'challenge-invalid',
      });
      const other = await waiting();
      const justInTime = at(LOGIN_CHALLENGE.ttlMs - 1);
      expect(
        await consumeLoginChallenge(db(), {
          challenge: other.challenge,
          code: totpCodeAt(other.secret, justInTime),
          now: justInTime,
        }),
      ).toMatchObject({ ok: true });
    });

    it('refuses a token that is no challenge, with no target and nothing typed in the event', async () => {
      const typed = 'not-a-challenge-token-at-all';
      const before = (await failures()).length;
      for (const challenge of [
        typed,
        '',
        'x'.repeat(5000),
        undefined as never,
      ]) {
        expect(
          await consumeLoginChallenge(db(), {
            challenge,
            code: '123456',
            now: T0,
          }),
        ).toEqual({ ok: false });
      }
      const events = (await failures()).slice(before);
      expect(events).toHaveLength(4);
      for (const event of events) {
        expect(event).toMatchObject({
          actorType: 'system',
          actorId: null,
          targetId: null,
          details: { method: 'totp', reason: 'challenge-invalid' },
        });
      }
      expect(JSON.stringify(events)).not.toContain(typed);
    });

    it('is tied to its user: another user’s code does not complete it', async () => {
      const first = await waiting();
      const second = await waiting();
      expect(
        await consumeLoginChallenge(db(), {
          challenge: first.challenge,
          code: totpCodeAt(second.secret, T0),
          now: T0,
        }),
      ).toEqual({ ok: false });
    });

    it('refuses a user disabled since the password step', async () => {
      const { userId, secret, challenge } = await waiting();
      await setUserStatus(database, userId, 'disabled');
      expect(
        await consumeLoginChallenge(db(), {
          challenge,
          code: totpCodeAt(secret, T0),
          now: T0,
        }),
      ).toEqual({ ok: false });
      expect(await lastFailure()).toMatchObject({
        targetId: userId,
        details: { method: 'totp', reason: 'disabled' },
      });
    });

    it('refuses an account the throttle has closed, even with a fresh challenge and the right code', async () => {
      const { userId, secret, challenge } = await waiting();
      const right = totpCodeAt(secret, T0);
      const wrong = right === '000000' ? '000001' : '000000';
      // Five wrong codes over several challenges, as a guesser who asks for a
      // new challenge each time would make.
      for (let i = 0; i < LOGIN_THROTTLE.maxFailures; i += 1) {
        const { challenge: fresh } = await createLoginChallenge(db(), userId, {
          kind: 'totp',
          now: at(i * SECOND),
        });
        await consumeLoginChallenge(db(), {
          challenge: fresh,
          code: wrong,
          now: at(i * SECOND),
        });
      }
      expect(
        await consumeLoginChallenge(db(), {
          challenge,
          code: right,
          now: at(10 * SECOND),
        }),
      ).toEqual({ ok: false });
      expect((await lastFailure()).details).toEqual({
        method: 'totp',
        reason: 'throttled',
      });
      expect((await rowOf(challenge))!.attempts).toBe(0);
      // Fifteen minutes on, a new challenge works.
      const later = at(LOGIN_THROTTLE.windowMs + 5 * SECOND);
      const { challenge: again } = await createLoginChallenge(db(), userId, {
        kind: 'totp',
        now: later,
      });
      expect(
        await consumeLoginChallenge(db(), {
          challenge: again,
          code: totpCodeAt(secret, later),
          now: later,
        }),
      ).toMatchObject({ ok: true });
    });

    it('keeps the challenge and the code out of every event and table', async () => {
      const { secret, challenge } = await waiting();
      const code = totpCodeAt(secret, T0);
      await consumeLoginChallenge(db(), { challenge, code, now: T0 });
      await consumeLoginChallenge(db(), { challenge, code: '000000', now: T0 });
      expect(
        JSON.stringify(await db().select().from(auditEvent)),
      ).not.toContain(challenge);
      const everything = await everyRowAsText(database);
      expect(everything).not.toContain(challenge);
    });
  });
});
