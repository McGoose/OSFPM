import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { auditEvent, loginChallenge } from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { AuthInputError, AuthStateError } from './errors.js';
import {
  cleanupExpiredChallenges,
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
import { generateToken, hashToken } from './tokens.js';
import { LOGIN_THROTTLE } from './throttle.js';
import { newId } from '../db/ids.js';
import { useTestServerKeys } from '../keys/test-support.js';

/** The server keys of this test file, in a key directory that is deleted afterwards. */
const serverKeys = useTestServerKeys();

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
    const secret = await seedTotp(database, userId, {
      now: T0,
      dataKeys: serverKeys().dataKeys,
    });
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

    it('makes only the second step of a password sign-in: a passkey kind is refused, writing nothing', async () => {
      const userId = await seedActiveUser(database);
      for (const kind of ['webauthn-register', 'webauthn-login']) {
        await expect(
          createLoginChallenge(db(), userId, { kind: kind as never, now: T0 }),
        ).rejects.toBeInstanceOf(AuthInputError);
      }
      const rows = await db()
        .select()
        .from(loginChallenge)
        .where(eq(loginChallenge.userId, userId));
      expect(rows).toEqual([]);
    });
  });

  describe('the expired challenges of the user', () => {
    const rowsOfUser = (userId: string) =>
      db()
        .select()
        .from(loginChallenge)
        .where(eq(loginChallenge.userId, userId));

    it('makes a new challenge delete the user’s expired ones, used or not, and keep the live ones and other users’', async () => {
      const userId = await seedActiveUser(database);
      const secret = await seedTotp(database, userId, {
        now: T0,
        dataKeys: serverKeys().dataKeys,
      });
      const other = await seedActiveUser(database);
      const unused = await createLoginChallenge(db(), userId, {
        kind: 'totp',
        now: T0,
      });
      const used = await createLoginChallenge(db(), userId, {
        kind: 'totp',
        now: T0,
      });
      await consumeLoginChallenge(db(), {
        challenge: used.challenge,
        code: totpCodeAt(secret, T0),
        now: T0,
        dataKeys: serverKeys().dataKeys,
      });
      const live = await createLoginChallenge(db(), userId, {
        kind: 'totp',
        now: at(4 * MINUTE),
      });
      // Another user's, long expired.
      const theirs = await createLoginChallenge(db(), other, {
        kind: 'totp',
        now: T0,
      });
      expect(await rowsOfUser(userId)).toHaveLength(3);

      const fresh = await createLoginChallenge(db(), userId, {
        kind: 'totp',
        now: at(6 * MINUTE),
      });
      expect(await rowOf(unused.challenge)).toBeUndefined();
      expect(await rowOf(used.challenge)).toBeUndefined();
      expect(await rowOf(live.challenge)).toBeDefined();
      expect(await rowOf(fresh.challenge)).toBeDefined();
      expect(await rowsOfUser(userId)).toHaveLength(2);
      // Only the user's own: another user's expired row is for the cleanup.
      expect(await rowOf(theirs.challenge)).toBeDefined();
    });

    it('deletes a challenge that ends at that very moment, and keeps one that ends a millisecond later', async () => {
      const userId = await seedActiveUser(database);
      const exact = await createLoginChallenge(db(), userId, {
        kind: 'totp',
        now: T0,
      });
      const justAfter = await createLoginChallenge(db(), userId, {
        kind: 'totp',
        now: at(1),
      });
      await createLoginChallenge(db(), userId, {
        kind: 'totp',
        now: at(LOGIN_CHALLENGE.ttlMs),
      });
      expect(await rowOf(exact.challenge)).toBeUndefined();
      expect(await rowOf(justAfter.challenge)).toBeDefined();
    });

    it('deletes nothing when the user is refused', async () => {
      const userId = await seedActiveUser(database);
      const old = await createLoginChallenge(db(), userId, {
        kind: 'totp',
        now: T0,
      });
      await setUserStatus(database, userId, 'disabled');
      await expect(
        createLoginChallenge(db(), userId, {
          kind: 'totp',
          now: at(10 * MINUTE),
        }),
      ).rejects.toBeInstanceOf(AuthStateError);
      expect(await rowOf(old.challenge)).toBeDefined();
    });

    it('writes no audit event for it: it is housekeeping, not a security change', async () => {
      const userId = await seedActiveUser(database);
      const before = (await db().select().from(auditEvent)).length;
      await createLoginChallenge(db(), userId, { kind: 'totp', now: T0 });
      await createLoginChallenge(db(), userId, {
        kind: 'totp',
        now: at(10 * MINUTE),
      });
      expect((await db().select().from(auditEvent)).length).toBe(before);
    });
  });

  describe('consumeLoginChallenge', () => {
    it('takes the right code, returns the user, uses the challenge up and audits the step', async () => {
      const { userId, secret, challenge } = await waiting();
      const result = await consumeLoginChallenge(db(), {
        challenge,
        code: totpCodeAt(secret, at(SECOND)),
        now: at(SECOND),
        dataKeys: serverKeys().dataKeys,
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
          dataKeys: serverKeys().dataKeys,
        }),
      ).toMatchObject({ ok: true });
      expect(
        await consumeLoginChallenge(db(), {
          challenge,
          code: totpCodeAt(secret, at(STEP)),
          now: at(STEP),
          dataKeys: serverKeys().dataKeys,
        }),
      ).toEqual({ ok: false });
      expect((await lastFailure()).details).toEqual({
        method: 'totp',
        reason: 'challenge-invalid',
      });
    });

    it('refuses the token of a passkey challenge, even with a right code, and leaves it untouched', async () => {
      // A registration challenge is tied to a user and is given to someone who is
      // already signed in. It must not do for the second step of a password
      // sign-in, which would skip the password.
      const userId = await seedActiveUser(database);
      const secret = await seedTotp(database, userId, {
        now: T0,
        dataKeys: serverKeys().dataKeys,
      });
      const token = generateToken();
      await db()
        .insert(loginChallenge)
        .values({
          originServer: newId(),
          userId,
          kind: 'webauthn-register',
          tokenHash: hashToken(token),
          expiresAt: at(LOGIN_CHALLENGE.ttlMs),
        });
      expect(
        await consumeLoginChallenge(db(), {
          challenge: token,
          code: totpCodeAt(secret, T0),
          now: T0,
          dataKeys: serverKeys().dataKeys,
        }),
      ).toEqual({ ok: false });
      expect(await rowOf(token)).toMatchObject({ attempts: 0, usedAt: null });
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
          dataKeys: serverKeys().dataKeys,
        }),
        consumeLoginChallenge(db(), {
          challenge,
          code: totpCodeAt(secret, at(STEP)),
          now: T0,
          dataKeys: serverKeys().dataKeys,
        }),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
    });

    it('refuses a wrong code, spends an attempt and audits it', async () => {
      const { userId, secret, challenge } = await waiting();
      const right = totpCodeAt(secret, T0);
      const wrong = right === '000000' ? '000001' : '000000';
      expect(
        await consumeLoginChallenge(db(), {
          challenge,
          code: wrong,
          now: T0,
          dataKeys: serverKeys().dataKeys,
        }),
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
          dataKeys: serverKeys().dataKeys,
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
          dataKeys: serverKeys().dataKeys,
        });
      }
      expect((await rowOf(challenge))!.attempts).toBe(5);
      expect(
        await consumeLoginChallenge(db(), {
          challenge,
          code: right,
          now: at(10 * SECOND),
          dataKeys: serverKeys().dataKeys,
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
        await consumeLoginChallenge(db(), {
          challenge,
          code: wrong,
          now: T0,
          dataKeys: serverKeys().dataKeys,
        });
      }
      expect(
        await consumeLoginChallenge(db(), {
          challenge,
          code: right,
          now: T0,
          dataKeys: serverKeys().dataKeys,
        }),
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
          dataKeys: serverKeys().dataKeys,
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
          dataKeys: serverKeys().dataKeys,
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
            dataKeys: serverKeys().dataKeys,
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
          dataKeys: serverKeys().dataKeys,
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
          dataKeys: serverKeys().dataKeys,
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
          dataKeys: serverKeys().dataKeys,
        });
      }
      expect(
        await consumeLoginChallenge(db(), {
          challenge,
          code: right,
          now: at(10 * SECOND),
          dataKeys: serverKeys().dataKeys,
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
          dataKeys: serverKeys().dataKeys,
        }),
      ).toMatchObject({ ok: true });
    });

    it('keeps the challenge and the code out of every event and table', async () => {
      const { secret, challenge } = await waiting();
      const code = totpCodeAt(secret, T0);
      await consumeLoginChallenge(db(), {
        challenge,
        code,
        now: T0,
        dataKeys: serverKeys().dataKeys,
      });
      await consumeLoginChallenge(db(), {
        challenge,
        code: '000000',
        now: T0,
        dataKeys: serverKeys().dataKeys,
      });
      expect(
        JSON.stringify(await db().select().from(auditEvent)),
      ).not.toContain(challenge);
      const everything = await everyRowAsText(database);
      expect(everything).not.toContain(challenge);
    });
  });
});

describe.each(testTargets)(
  'cleaning up expired login challenges on $name',
  (target) => {
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
    const rows = () => db().select().from(loginChallenge);

    it('deletes every expired challenge of every user, used or not, keeps the live ones, and says how many it deleted', async () => {
      const first = await seedActiveUser(database);
      const second = await seedActiveUser(database);
      const secret = await seedTotp(database, first, {
        now: T0,
        dataKeys: serverKeys().dataKeys,
      });
      const make = (userId: string, now: Date) =>
        createLoginChallenge(db(), userId, { kind: 'totp', now });
      // Expired, for two users, one of them used; and two that are still live,
      // one of them used.
      await make(first, T0);
      await make(second, T0);
      const usedExpired = await make(first, T0);
      await consumeLoginChallenge(db(), {
        challenge: usedExpired.challenge,
        code: totpCodeAt(secret, T0),
        now: T0,
        dataKeys: serverKeys().dataKeys,
      });
      const live = await make(second, at(4 * MINUTE));
      const usedLive = await make(first, at(4 * MINUTE));
      await consumeLoginChallenge(db(), {
        challenge: usedLive.challenge,
        code: totpCodeAt(secret, at(4 * MINUTE)),
        now: at(4 * MINUTE),
        dataKeys: serverKeys().dataKeys,
      });
      // Making a challenge for a user cleans that user's own, so the cleanup
      // starts from what is left.
      const before = await rows();
      const expired = before.filter(
        (row) => row.expiresAt.getTime() <= at(6 * MINUTE).getTime(),
      );
      expect(expired.length).toBeGreaterThan(0);

      expect(await cleanupExpiredChallenges(db(), at(6 * MINUTE))).toBe(
        expired.length,
      );
      const after = await rows();
      expect(after).toHaveLength(before.length - expired.length);
      expect(
        after.every(
          (row) => row.expiresAt.getTime() > at(6 * MINUTE).getTime(),
        ),
      ).toBe(true);
      expect(after.map((row) => row.tokenHash)).toContain(
        hashToken(live.challenge),
      );
      expect(after.map((row) => row.tokenHash)).toContain(
        hashToken(usedLive.challenge),
      );
      // Nothing is left to do.
      expect(await cleanupExpiredChallenges(db(), at(6 * MINUTE))).toBe(0);
    });

    it('deletes a challenge that ends at that very moment and no other', async () => {
      const userId = await seedActiveUser(database);
      const ends = await createLoginChallenge(db(), userId, {
        kind: 'totp',
        now: at(20 * MINUTE),
      });
      const later = await createLoginChallenge(db(), userId, {
        kind: 'totp',
        now: at(20 * MINUTE + 1),
      });
      const now = at(20 * MINUTE + LOGIN_CHALLENGE.ttlMs);
      expect(await cleanupExpiredChallenges(db(), now)).toBeGreaterThanOrEqual(
        1,
      );
      const remaining = (await rows()).map((row) => row.tokenHash);
      expect(remaining).not.toContain(hashToken(ends.challenge));
      expect(remaining).toContain(hashToken(later.challenge));
    });

    it('answers 0 when nothing has expired, and writes no audit event whatever it deletes', async () => {
      const events = (await db().select().from(auditEvent)).length;
      expect(await cleanupExpiredChallenges(db(), at(-60 * MINUTE))).toBe(0);
      await cleanupExpiredChallenges(db(), at(24 * 60 * MINUTE));
      expect((await db().select().from(auditEvent)).length).toBe(events);
      expect(await rows()).toEqual([]);
    });
  },
);
