import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import {
  auditEvent,
  passwordCredential,
  session,
  user,
} from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { AuthStateError } from './errors.js';
import {
  hashPassword,
  PASSWORD_HASH_PARAMS,
  verifyPassword,
} from './password.js';
import {
  checkCurrentPassword,
  setPassword,
  verifyPasswordLogin,
} from './password-service.js';
import { createSession, validateSession } from './sessions.js';
import { AUTH_AUDIT } from './shared.js';
import {
  E_ACUTE_COMPOSED,
  E_ACUTE_DECOMPOSED,
  emailOf,
  everyRowAsText,
  fullWidth,
  passwordHashWith,
  seedActiveUser,
  seedInstallation,
  seedPassword,
  seedTotp,
  setUserStatus,
} from './test-support.js';
import { LOGIN_THROTTLE, recordLoginFailure } from './throttle.js';

// Counts every Argon2 derivation the services make, and still does the work:
// the test asserts what ran, not a stand-in. `hashPassword` and
// `verifyPassword` are the only two places the services derive a key.
vi.mock('./password.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./password.js')>();
  return {
    ...original,
    hashPassword: vi.fn(original.hashPassword),
    verifyPassword: vi.fn(original.verifyPassword),
  };
});

// Invented passwords; none is a real credential, and none holds a word of the
// fixture addresses (`fixture`, `user`, `example`, `test`) or of the policy list.
const PASSWORD = 'harbour-warehouse-night-shoot';
const NEW_PASSWORD = 'lantern-crane-quiet-morning';

const T0 = new Date('2026-03-02T09:00:00.000Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const at = (ms: number) => new Date(T0.getTime() + ms);

/** Argon2 derivations made since `resetCosts`. */
const derivations = () =>
  vi.mocked(hashPassword).mock.calls.length +
  vi.mocked(verifyPassword).mock.calls.length;
const resetCosts = () => {
  vi.mocked(hashPassword).mockClear();
  vi.mocked(verifyPassword).mockClear();
};

describe.each(testTargets)('password services on $name', (target) => {
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

  /** An active user with a password. */
  async function userWithPassword(password = PASSWORD) {
    const userId = await seedActiveUser(database);
    await seedPassword(database, userId, password, { now: T0 });
    return { userId, email: await emailOf(database, userId) };
  }

  const eventsAbout = async (userId: string, category: string) =>
    (await db().select().from(auditEvent)).filter(
      (event) => event.targetId === userId && event.category === category,
    );

  const credentialOf = async (userId: string) => {
    const [row] = await db()
      .select()
      .from(passwordCredential)
      .where(eq(passwordCredential.userId, userId));
    return row;
  };

  describe('verifyPasswordLogin', () => {
    it('lets in the right password, returns the user and says no second step is needed', async () => {
      const { userId, email } = await userWithPassword();
      const result = await verifyPasswordLogin(db(), {
        email,
        password: PASSWORD,
        now: T0,
      });
      expect(result).toMatchObject({
        ok: true,
        totpRequired: false,
        user: { id: userId, email, status: 'active' },
      });
      const [passed] = await eventsAbout(userId, AUTH_AUDIT.loginStepPassed);
      expect(passed).toMatchObject({
        action: 'pass',
        actorType: 'user',
        actorId: userId,
        details: { method: 'password', next: 'session' },
      });
    });

    it('asks for the second step when an authenticator is confirmed, and not while one is only being set up', async () => {
      const confirmed = await userWithPassword();
      await seedTotp(database, confirmed.userId);
      expect(
        await verifyPasswordLogin(db(), {
          email: confirmed.email,
          password: PASSWORD,
          now: T0,
        }),
      ).toMatchObject({ ok: true, totpRequired: true });
      const [passed] = await eventsAbout(
        confirmed.userId,
        AUTH_AUDIT.loginStepPassed,
      );
      expect(passed!.details).toEqual({ method: 'password', next: 'totp' });

      const pending = await userWithPassword();
      await seedTotp(database, pending.userId, { confirmed: false });
      expect(
        await verifyPasswordLogin(db(), {
          email: pending.email,
          password: PASSWORD,
          now: T0,
        }),
      ).toMatchObject({ ok: true, totpRequired: false });
    });

    it('takes the address in any case with spaces round it, and the password in any Unicode form of the same text', async () => {
      const userId = await seedActiveUser(database);
      // Stored with a decomposed accent, typed with a composed one: NFC makes them one.
      await seedPassword(
        database,
        userId,
        `caf${E_ACUTE_DECOMPOSED}-harbour-night-shoot`,
      );
      const email = await emailOf(database, userId);
      const typed = (password: string) =>
        verifyPasswordLogin(db(), {
          email: `  ${email.toUpperCase()} `,
          password,
          now: T0,
        });
      expect(
        await typed(`caf${E_ACUTE_COMPOSED}-harbour-night-shoot`),
      ).toMatchObject({ ok: true, user: { id: userId } });
      expect(
        await typed(`caf${E_ACUTE_DECOMPOSED}-harbour-night-shoot`),
      ).toMatchObject({ ok: true });
      // A full-width spelling of the same text is another password.
      const wide =
        fullWidth('caf') + E_ACUTE_COMPOSED + fullWidth('-harbour-night-shoot');
      expect(await typed(wide)).toEqual({ ok: false });
    });

    it('gives the same answer for every failure', async () => {
      const wrong = await userWithPassword();
      const noPassword = await seedActiveUser(database);
      const disabled = await userWithPassword();
      await setUserStatus(database, disabled.userId, 'disabled');
      const deleted = await userWithPassword();
      await db()
        .update(user)
        .set({ deletedAt: T0 })
        .where(eq(user.id, deleted.userId));
      const throttled = await userWithPassword();
      for (let i = 0; i < LOGIN_THROTTLE.maxFailures; i += 1) {
        await recordLoginFailure(db(), {
          method: 'password',
          reason: 'wrong-secret',
          userId: throttled.userId,
          now: at(i * SECOND),
        });
      }
      const attempts = [
        { email: 'nobody@demopictures.example', password: PASSWORD },
        { email: wrong.email, password: `${PASSWORD}-not` },
        { email: await emailOf(database, noPassword), password: PASSWORD },
        { email: disabled.email, password: PASSWORD },
        { email: deleted.email, password: PASSWORD },
        { email: throttled.email, password: PASSWORD },
      ];
      const results = [];
      for (const attempt of attempts) {
        results.push(
          await verifyPasswordLogin(db(), { ...attempt, now: at(MINUTE) }),
        );
      }
      expect(results).toEqual(attempts.map(() => ({ ok: false })));
    });

    it('audits each failure with its method and a reason class, and never what was typed', async () => {
      const wrong = await userWithPassword();
      const disabled = await userWithPassword();
      await setUserStatus(database, disabled.userId, 'disabled');
      const before = (await db().select().from(auditEvent)).length;
      const typedEmail = 'someone.unknown@demopictures.example';
      const typedPassword = 'a-password-nobody-set-before';
      await verifyPasswordLogin(db(), {
        email: typedEmail,
        password: typedPassword,
        now: T0,
      });
      await verifyPasswordLogin(db(), {
        email: wrong.email,
        password: typedPassword,
        now: T0,
      });
      await verifyPasswordLogin(db(), {
        email: disabled.email,
        password: PASSWORD,
        now: T0,
      });
      const events = (await db().select().from(auditEvent)).slice(before);
      expect(events.map((event) => event.category)).toEqual([
        AUTH_AUDIT.loginStepFailed,
        AUTH_AUDIT.loginStepFailed,
        AUTH_AUDIT.loginStepFailed,
      ]);
      // An unknown address: no actor and no target, and not the address.
      expect(events[0]).toMatchObject({
        actorType: 'system',
        actorId: null,
        targetType: null,
        targetId: null,
        details: { method: 'password', reason: 'unknown-account' },
      });
      expect(events[1]).toMatchObject({
        targetId: wrong.userId,
        details: { method: 'password', reason: 'wrong-secret' },
      });
      expect(events[2]).toMatchObject({
        targetId: disabled.userId,
        details: { method: 'password', reason: 'disabled' },
      });
      const text = JSON.stringify(events);
      for (const secret of [typedEmail, typedPassword, PASSWORD]) {
        expect(text).not.toContain(secret);
      }
    });

    it('spends one Argon2 derivation on every attempt, so an unknown address costs what a wrong password does', async () => {
      const wrong = await userWithPassword();
      const noPassword = await seedActiveUser(database);
      const disabled = await userWithPassword();
      await setUserStatus(database, disabled.userId, 'disabled');
      const throttled = await userWithPassword();
      for (let i = 0; i < LOGIN_THROTTLE.maxFailures; i += 1) {
        await recordLoginFailure(db(), {
          method: 'password',
          reason: 'wrong-secret',
          userId: throttled.userId,
          now: at(i * SECOND),
        });
      }
      const right = await userWithPassword();
      const cases = [
        { name: 'unknown address', email: 'nobody@demopictures.example' },
        { name: 'wrong password', email: wrong.email },
        { name: 'no password set', email: await emailOf(database, noPassword) },
        { name: 'disabled account', email: disabled.email },
        { name: 'throttled account', email: throttled.email },
        { name: 'right password', email: right.email },
      ];
      for (const { name, email } of cases) {
        resetCosts();
        await verifyPasswordLogin(db(), {
          email,
          password: name === 'right password' ? PASSWORD : 'not-the-password-x',
          now: at(MINUTE),
        });
        expect(derivations(), name).toBe(1);
      }
    });

    it('does not check the password of an account that has had five wrong guesses, even a right one, until the window has passed', async () => {
      const { userId, email } = await userWithPassword();
      for (let i = 0; i < LOGIN_THROTTLE.maxFailures; i += 1) {
        expect(
          await verifyPasswordLogin(db(), {
            email,
            password: 'not-the-password-x',
            now: at(i * SECOND),
          }),
        ).toEqual({ ok: false });
      }
      // The sixth, with the right password.
      resetCosts();
      expect(
        await verifyPasswordLogin(db(), {
          email,
          password: PASSWORD,
          now: at(10 * SECOND),
        }),
      ).toEqual({ ok: false });
      expect(vi.mocked(verifyPassword)).not.toHaveBeenCalled();
      const reasons = (await eventsAbout(userId, AUTH_AUDIT.loginStepFailed))
        .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
        .map((event) => (event.details as { reason: string }).reason);
      expect(reasons).toEqual([
        'wrong-secret',
        'wrong-secret',
        'wrong-secret',
        'wrong-secret',
        'wrong-secret',
        'throttled',
      ]);
      // Open again once the first failure is fifteen minutes old.
      expect(
        await verifyPasswordLogin(db(), {
          email,
          password: PASSWORD,
          now: at(LOGIN_THROTTLE.windowMs),
        }),
      ).toMatchObject({ ok: true });
    });

    it('stores nothing about a successful guess beyond its event: no password in any table', async () => {
      const { email } = await userWithPassword('ironwork-seagull-tidal-ember');
      await verifyPasswordLogin(db(), {
        email,
        password: 'ironwork-seagull-tidal-ember',
        now: T0,
      });
      expect(await everyRowAsText(database)).not.toContain(
        'ironwork-seagull-tidal-ember',
      );
    });
  });

  describe('rehashing a right password', () => {
    // An older server, with other parameters, stored the hash.
    const OLDER = { memoryKiB: 8192, passes: 1, parallelism: 1 } as const;

    /** The memory, passes and parallelism a PHC string says it was made with. */
    const parametersOf = (hash: string) => {
      const found = /^\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(hash);
      return {
        memoryKiB: Number(found![1]),
        passes: Number(found![2]),
        parallelism: Number(found![3]),
      };
    };
    const CURRENT = {
      memoryKiB: PASSWORD_HASH_PARAMS.memoryKiB,
      passes: PASSWORD_HASH_PARAMS.passes,
      parallelism: PASSWORD_HASH_PARAMS.parallelism,
    };

    /** An active user whose password was stored with `settings`. */
    async function withOlderHash(
      settings: Parameters<typeof passwordHashWith>[1] = OLDER,
    ) {
      const userId = await seedActiveUser(database);
      const older = passwordHashWith(PASSWORD, settings);
      await seedPassword(database, userId, PASSWORD, { hash: older, now: T0 });
      return { userId, older, email: await emailOf(database, userId) };
    }

    const rehashes = async (userId: string) =>
      eventsAbout(userId, AUTH_AUDIT.passwordRehashed);

    it('stores the password again with the current parameters, and changes nothing else about it', async () => {
      const { userId, older, email } = await withOlderHash();
      expect(parametersOf(older)).toEqual(OLDER);
      const before = await credentialOf(userId);
      const result = await verifyPasswordLogin(db(), {
        email,
        password: PASSWORD,
        now: at(MINUTE),
      });
      expect(result).toMatchObject({ ok: true, user: { id: userId } });
      const after = await credentialOf(userId);
      expect(after!.hash).not.toBe(older);
      expect(parametersOf(after!.hash)).toEqual(CURRENT);
      // It is the same password, and now nothing asks for another rehash.
      expect(await verifyPassword(PASSWORD, after!.hash)).toEqual({
        ok: true,
        needsRehash: false,
      });
      // Not a change of password: when it was set, and the flag, stay.
      expect(after!.changedAt).toEqual(before!.changedAt);
      expect(after!.mustChange).toBe(before!.mustChange);
      expect(after!.version).toBe(before!.version + 1);
      expect(after!.updatedAt).toEqual(at(MINUTE));
    });

    it.each([
      ['less memory', { ...CURRENT, memoryKiB: 8192 }],
      ['more passes', { ...CURRENT, passes: CURRENT.passes + 1 }],
      ['more parallelism', { ...CURRENT, parallelism: 2 }],
      ['a shorter salt', { ...CURRENT, saltBytes: 8 }],
      ['a longer hash', { ...CURRENT, hashBytes: 48 }],
    ])('does it for a hash made with %s', async (_name, settings) => {
      const { userId, older, email } = await withOlderHash(settings);
      await verifyPasswordLogin(db(), {
        email,
        password: PASSWORD,
        now: at(MINUTE),
      });
      const after = await credentialOf(userId);
      expect(after!.hash).not.toBe(older);
      expect(parametersOf(after!.hash)).toEqual(CURRENT);
      expect(await rehashes(userId)).toHaveLength(1);
    });

    it('audits it as the system, about the user, and never with a hash', async () => {
      const { userId, older, email } = await withOlderHash();
      await verifyPasswordLogin(db(), {
        email,
        password: PASSWORD,
        now: at(MINUTE),
      });
      const after = await credentialOf(userId);
      const [event] = await rehashes(userId);
      expect(event).toMatchObject({
        action: 'rehash',
        actorType: 'system',
        actorId: null,
        targetType: 'user',
        details: { trigger: 'login' },
        occurredAt: at(MINUTE),
      });
      const text = JSON.stringify(await db().select().from(auditEvent));
      expect(text).not.toContain(older);
      expect(text).not.toContain(after!.hash);
      expect(text).not.toContain(PASSWORD);
    });

    it('costs the person who gave the right password a second derivation, once', async () => {
      const { email } = await withOlderHash();
      resetCosts();
      await verifyPasswordLogin(db(), {
        email,
        password: PASSWORD,
        now: at(MINUTE),
      });
      // One to check the old hash, one to make the new.
      expect(derivations()).toBe(2);
      resetCosts();
      await verifyPasswordLogin(db(), {
        email,
        password: PASSWORD,
        now: at(2 * MINUTE),
      });
      expect(derivations()).toBe(1);
    });

    it('does it once: a second sign-in finds the current parameters and writes nothing', async () => {
      const { userId, email } = await withOlderHash();
      await verifyPasswordLogin(db(), {
        email,
        password: PASSWORD,
        now: at(MINUTE),
      });
      const rehashed = await credentialOf(userId);
      await verifyPasswordLogin(db(), {
        email,
        password: PASSWORD,
        now: at(2 * MINUTE),
      });
      expect(await credentialOf(userId)).toEqual(rehashed);
      expect(await rehashes(userId)).toHaveLength(1);
    });

    it('does it once when two sign-ins arrive together', async () => {
      const { userId, email } = await withOlderHash();
      const before = await credentialOf(userId);
      const results = await Promise.all([
        verifyPasswordLogin(db(), {
          email,
          password: PASSWORD,
          now: at(MINUTE),
        }),
        verifyPasswordLogin(db(), {
          email,
          password: PASSWORD,
          now: at(MINUTE),
        }),
      ]);
      expect(results.every((result) => result.ok)).toBe(true);
      expect(await rehashes(userId)).toHaveLength(1);
      expect((await credentialOf(userId))!.version).toBe(before!.version + 1);
    });

    it('leaves the old hash alone for a wrong password, a disabled account and a closed one', async () => {
      const wrong = await withOlderHash();
      await verifyPasswordLogin(db(), {
        email: wrong.email,
        password: 'not-the-password-x',
        now: at(MINUTE),
      });
      const disabled = await withOlderHash();
      await setUserStatus(database, disabled.userId, 'disabled');
      await verifyPasswordLogin(db(), {
        email: disabled.email,
        password: PASSWORD,
        now: at(MINUTE),
      });
      const closed = await withOlderHash();
      for (let i = 0; i < LOGIN_THROTTLE.maxFailures; i += 1) {
        await recordLoginFailure(db(), {
          method: 'password',
          reason: 'wrong-secret',
          userId: closed.userId,
          now: at(i * SECOND),
        });
      }
      await verifyPasswordLogin(db(), {
        email: closed.email,
        password: PASSWORD,
        now: at(10 * SECOND),
      });
      for (const { userId, older } of [wrong, disabled, closed]) {
        expect((await credentialOf(userId))!.hash).toBe(older);
        expect(await rehashes(userId)).toEqual([]);
      }
    });

    it('does not change the sign-in: the same answer, with or without the second step', async () => {
      const { userId, email } = await withOlderHash();
      await seedTotp(database, userId);
      expect(
        await verifyPasswordLogin(db(), {
          email,
          password: PASSWORD,
          now: at(MINUTE),
        }),
      ).toMatchObject({ ok: true, totpRequired: true });
      expect(parametersOf((await credentialOf(userId))!.hash)).toEqual(CURRENT);
    });
  });

  describe('setPassword', () => {
    it('sets a first password with no current one needed, hashed with Argon2id from the normalised text', async () => {
      const userId = await seedActiveUser(database);
      const typed = `lantern-crane-quiet-caf${E_ACUTE_DECOMPOSED}`;
      const normalised = `lantern-crane-quiet-caf${E_ACUTE_COMPOSED}`;
      const result = await setPassword(db(), {
        userId,
        newPassword: typed,
        now: T0,
      });
      expect(result).toEqual({ ok: true });
      const row = await credentialOf(userId);
      expect(row).toMatchObject({ mustChange: false, changedAt: T0 });
      expect(row!.hash).toMatch(/^\$argon2id\$/);
      // The hash is of the normalised text, not of what was typed.
      expect((await verifyPassword(normalised, row!.hash)).ok).toBe(true);
      expect((await verifyPassword(typed, row!.hash)).ok).toBe(false);
      const [event] = await eventsAbout(userId, AUTH_AUDIT.passwordSet);
      expect(event).toMatchObject({
        action: 'set',
        actorType: 'user',
        actorId: userId,
        details: { first: true, mustChangeCleared: false },
      });
    });

    it('refuses a password the policy refuses, with the reason, and changes nothing', async () => {
      const { userId, email } = await userWithPassword();
      const before = await credentialOf(userId);
      const local = email.slice(0, email.indexOf('@'));
      const cases: [string, string][] = [
        ['too short', 'too-short'],
        [`my-${local}-secret-door`, 'contains-email'],
        ['correct horse battery staple', 'too-common'],
        ['abcdefghijklmnop', 'too-predictable'],
        ['x'.repeat(300), 'too-long'],
      ];
      for (const [newPassword, reason] of cases) {
        expect(
          await setPassword(db(), {
            userId,
            newPassword,
            currentPassword: PASSWORD,
            now: at(MINUTE),
          }),
          reason,
        ).toEqual({ ok: false, reason });
      }
      expect(await credentialOf(userId)).toEqual(before);
      expect(await eventsAbout(userId, AUTH_AUDIT.passwordSet)).toEqual([]);
    });

    it('needs the current password to change one, and says which part is wrong', async () => {
      const { userId } = await userWithPassword();
      expect(
        await setPassword(db(), { userId, newPassword: NEW_PASSWORD, now: T0 }),
      ).toEqual({ ok: false, reason: 'current-password-required' });
      expect(
        await setPassword(db(), {
          userId,
          newPassword: NEW_PASSWORD,
          currentPassword: 'not-the-password-x',
          now: T0,
        }),
      ).toEqual({ ok: false, reason: 'current-password-incorrect' });
      const [failure] = await eventsAbout(userId, AUTH_AUDIT.loginStepFailed);
      expect(failure!.details).toEqual({
        method: 'password',
        reason: 'wrong-secret',
        purpose: 'reauthenticate',
      });
      expect(
        await setPassword(db(), {
          userId,
          newPassword: NEW_PASSWORD,
          currentPassword: PASSWORD,
          now: at(SECOND),
        }),
      ).toEqual({ ok: true });
      const row = await credentialOf(userId);
      expect((await verifyPassword(NEW_PASSWORD, row!.hash)).ok).toBe(true);
      expect(row!.version).toBe(2);
      const [event] = await eventsAbout(userId, AUTH_AUDIT.passwordSet);
      expect(event!.details).toEqual({
        first: false,
        mustChangeCleared: false,
      });
    });

    it('counts wrong current passwords toward the throttle, so a stolen session cannot guess one', async () => {
      const { userId, email } = await userWithPassword();
      for (let i = 0; i < LOGIN_THROTTLE.maxFailures; i += 1) {
        await setPassword(db(), {
          userId,
          newPassword: NEW_PASSWORD,
          currentPassword: 'not-the-password-x',
          now: at(i * SECOND),
        });
      }
      resetCosts();
      expect(
        await setPassword(db(), {
          userId,
          newPassword: NEW_PASSWORD,
          currentPassword: PASSWORD,
          now: at(10 * SECOND),
        }),
      ).toEqual({ ok: false, reason: 'current-password-incorrect' });
      expect(vi.mocked(verifyPassword)).not.toHaveBeenCalled();
      // The same five failures close the sign-in too.
      expect(
        await verifyPasswordLogin(db(), {
          email,
          password: PASSWORD,
          now: at(11 * SECOND),
        }),
      ).toEqual({ ok: false });
    });

    it('needs no current password when the user must change it, and clears the flag', async () => {
      const userId = await seedActiveUser(database);
      await seedPassword(database, userId, PASSWORD, { mustChange: true });
      expect(
        await setPassword(db(), { userId, newPassword: NEW_PASSWORD, now: T0 }),
      ).toEqual({ ok: true });
      expect((await credentialOf(userId))!.mustChange).toBe(false);
      const [event] = await eventsAbout(userId, AUTH_AUDIT.passwordSet);
      expect(event!.details).toEqual({ first: false, mustChangeCleared: true });
    });

    it('revokes every other session of the user and keeps the one that made the change', async () => {
      const { userId } = await userWithPassword();
      const other = await createSession(db(), {
        userId,
        method: 'password',
        now: T0,
      });
      const mine = await createSession(db(), {
        userId,
        method: 'password',
        now: T0,
      });
      const someoneElse = await createSession(db(), {
        userId: await seedActiveUser(database),
        method: 'password',
        now: T0,
      });
      await setPassword(db(), {
        userId,
        newPassword: NEW_PASSWORD,
        currentPassword: PASSWORD,
        session: { id: mine.session.id, scope: 'full' },
        now: at(MINUTE),
      });
      expect(
        await validateSession(db(), other.token, at(2 * MINUTE)),
      ).toBeNull();
      expect(
        await validateSession(db(), mine.token, at(2 * MINUTE)),
      ).not.toBeNull();
      expect(
        await validateSession(db(), someoneElse.token, at(2 * MINUTE)),
      ).not.toBeNull();
      const [revoked] = await db()
        .select()
        .from(session)
        .where(eq(session.id, other.session.id));
      expect(revoked!.revokedReason).toBe('password-changed');
    });

    it('lets a recovery session set one with no current password, and makes that session full', async () => {
      const { userId } = await userWithPassword();
      const recovery = await createSession(db(), {
        userId,
        method: 'recovery',
        now: T0,
      });
      expect(
        await setPassword(db(), {
          userId,
          newPassword: NEW_PASSWORD,
          session: { id: recovery.session.id, scope: 'recovery' },
          now: at(MINUTE),
        }),
      ).toEqual({ ok: true });
      const found = await validateSession(db(), recovery.token, at(2 * MINUTE));
      expect(found!.session.scope).toBe('full');
    });

    it('does not make a recovery session full when the new password is refused', async () => {
      const userId = await seedActiveUser(database);
      const recovery = await createSession(db(), {
        userId,
        method: 'recovery',
        now: T0,
      });
      expect(
        await setPassword(db(), {
          userId,
          newPassword: 'short',
          session: { id: recovery.session.id, scope: 'recovery' },
          now: at(MINUTE),
        }),
      ).toEqual({ ok: false, reason: 'too-short' });
      const found = await validateSession(db(), recovery.token, at(2 * MINUTE));
      expect(found!.session.scope).toBe('recovery');
    });

    it('refuses an unknown or a disabled user with a typed error and writes nothing', async () => {
      await expect(
        setPassword(db(), {
          userId: newId(),
          newPassword: NEW_PASSWORD,
          now: T0,
        }),
      ).rejects.toMatchObject({ reason: 'user-not-found' });
      const disabled = await seedActiveUser(database);
      await setUserStatus(database, disabled, 'disabled');
      const error = await setPassword(db(), {
        userId: disabled,
        newPassword: NEW_PASSWORD,
        now: T0,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AuthStateError);
      expect(error).toMatchObject({ reason: 'user-disabled' });
      expect(await credentialOf(disabled)).toBeUndefined();
    });

    it('keeps the new password out of every table and every event', async () => {
      const userId = await seedActiveUser(database);
      const secret = 'cobblestone-heron-velvet-tide';
      await setPassword(db(), { userId, newPassword: secret, now: T0 });
      expect(await everyRowAsText(database)).not.toContain(secret);
    });
  });

  describe('checkCurrentPassword', () => {
    it('says ok, incorrect, or not-set, and is throttled with the sign-in', async () => {
      const { userId } = await userWithPassword();
      expect(
        await checkCurrentPassword(db(), {
          userId,
          password: PASSWORD,
          now: T0,
        }),
      ).toBe('ok');
      expect(
        await checkCurrentPassword(db(), {
          userId,
          password: 'not-the-password-x',
          now: T0,
        }),
      ).toBe('incorrect');
      const none = await seedActiveUser(database);
      expect(
        await checkCurrentPassword(db(), {
          userId: none,
          password: PASSWORD,
          now: T0,
        }),
      ).toBe('not-set');
    });
  });
});
