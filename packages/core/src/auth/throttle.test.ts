import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import { auditEvent } from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { AuthInputError } from './errors.js';
import { AUTH_AUDIT } from './shared.js';
import { seedActiveUser, rowsOf } from './test-support.js';
import { sql } from 'drizzle-orm';
import {
  isThrottled,
  LOGIN_FAILURE_REASONS,
  LOGIN_THROTTLE,
  recordLoginFailure,
} from './throttle.js';

const T0 = new Date('2026-03-02T09:00:00.000Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const at = (ms: number) => new Date(T0.getTime() + ms);

describe('LOGIN_THROTTLE', () => {
  it('is five failures in fifteen minutes', () => {
    expect(LOGIN_THROTTLE.maxFailures).toBe(5);
    expect(LOGIN_THROTTLE.windowMs).toBe(15 * MINUTE);
  });
});

describe.each(testTargets)('the login throttle on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
  });
  afterAll(async () => {
    await cleanup();
  });

  const db = () => database.db;

  /** `count` wrong-secret failures for `userId`, one second apart from `start`. */
  async function fail(
    userId: string,
    count: number,
    start: Date,
    method: 'password' | 'totp' | 'recovery' = 'password',
  ) {
    for (let i = 0; i < count; i += 1) {
      await recordLoginFailure(db(), {
        method,
        reason: 'wrong-secret',
        userId,
        now: new Date(start.getTime() + i * SECOND),
      });
    }
  }

  describe('recordLoginFailure', () => {
    it('writes one event with the method and the reason, from no one, about the user', async () => {
      const userId = await seedActiveUser(database);
      await recordLoginFailure(db(), {
        method: 'totp',
        reason: 'wrong-secret',
        userId,
        now: T0,
      });
      const events = (await db().select().from(auditEvent)).filter(
        (event) =>
          event.category === AUTH_AUDIT.loginStepFailed &&
          event.targetId === userId,
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: 'fail',
        actorType: 'system',
        actorId: null,
        targetType: 'user',
        details: { method: 'totp', reason: 'wrong-secret' },
        occurredAt: T0,
      });
    });

    it('writes an event for an unknown account with no actor, no target and nothing typed', async () => {
      const before = (await db().select().from(auditEvent)).length;
      await recordLoginFailure(db(), {
        method: 'password',
        reason: 'unknown-account',
        userId: null,
        now: T0,
      });
      const events = (await db().select().from(auditEvent)).slice(before);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        category: AUTH_AUDIT.loginStepFailed,
        actorType: 'system',
        actorId: null,
        targetType: null,
        targetId: null,
        details: { method: 'password', reason: 'unknown-account' },
      });
    });

    it('notes a failed check of the current password as a re-check, not a sign-in', async () => {
      const userId = await seedActiveUser(database);
      await recordLoginFailure(db(), {
        method: 'password',
        reason: 'wrong-secret',
        userId,
        purpose: 'reauthenticate',
        now: T0,
      });
      const [event] = (await db().select().from(auditEvent)).filter(
        (found) => found.targetId === userId,
      );
      expect(event!.details).toEqual({
        method: 'password',
        reason: 'wrong-secret',
        purpose: 'reauthenticate',
      });
    });

    it('refuses a method or a reason that is not on the list, and writes nothing', async () => {
      const before = (await db().select().from(auditEvent)).length;
      for (const [method, reason] of [
        ['sms', 'wrong-secret'],
        ['password', 'because'],
        ['__proto__', 'toString'],
      ] as const) {
        await expect(
          recordLoginFailure(db(), {
            method: method as never,
            reason: reason as never,
            userId: null,
            now: T0,
          }),
        ).rejects.toBeInstanceOf(AuthInputError);
      }
      expect((await db().select().from(auditEvent)).length).toBe(before);
    });

    it('has the nine reasons the audit trail names: five for a secret, four more for a passkey', () => {
      expect([...LOGIN_FAILURE_REASONS].sort()).toEqual([
        'challenge-invalid',
        'counter-regressed',
        'disabled',
        'revoked',
        'throttled',
        'unknown-account',
        'unknown-credential',
        'verification-failed',
        'wrong-secret',
      ]);
    });
  });

  describe('isThrottled', () => {
    it('is false for four failures and true from the fifth', async () => {
      const userId = await seedActiveUser(database);
      await fail(userId, 4, T0);
      expect(await isThrottled(db(), userId, at(10 * SECOND))).toBe(false);
      await fail(userId, 1, at(4 * SECOND));
      expect(await isThrottled(db(), userId, at(10 * SECOND))).toBe(true);
    });

    it('counts a wrong password, a wrong authenticator code and a wrong recovery code together', async () => {
      const userId = await seedActiveUser(database);
      await fail(userId, 2, T0, 'password');
      await fail(userId, 2, at(2 * SECOND), 'totp');
      expect(await isThrottled(db(), userId, at(10 * SECOND))).toBe(false);
      await fail(userId, 1, at(4 * SECOND), 'recovery');
      expect(await isThrottled(db(), userId, at(10 * SECOND))).toBe(true);
    });

    it('counts only the failures of this account', async () => {
      const userId = await seedActiveUser(database);
      const other = await seedActiveUser(database);
      await fail(other, 5, T0);
      expect(await isThrottled(db(), other, at(10 * SECOND))).toBe(true);
      expect(await isThrottled(db(), userId, at(10 * SECOND))).toBe(false);
    });

    it('counts only wrong secrets: a refusal, a disabled account or a dead challenge is not a guess', async () => {
      const userId = await seedActiveUser(database);
      for (const reason of [
        'throttled',
        'disabled',
        'challenge-invalid',
      ] as const) {
        for (let i = 0; i < 6; i += 1) {
          await recordLoginFailure(db(), {
            method: 'password',
            reason,
            userId,
            now: at(i * SECOND),
          });
        }
      }
      expect(await isThrottled(db(), userId, at(10 * SECOND))).toBe(false);
    });

    it('ends when the oldest failure is fifteen minutes old, and not before', async () => {
      const userId = await seedActiveUser(database);
      await fail(userId, 5, T0);
      const window = LOGIN_THROTTLE.windowMs;
      expect(await isThrottled(db(), userId, at(window - 1))).toBe(true);
      // The first failure is exactly fifteen minutes old and no longer counts.
      expect(await isThrottled(db(), userId, at(window))).toBe(false);
    });

    it('is not kept alive by the attempts it refuses', async () => {
      const userId = await seedActiveUser(database);
      await fail(userId, 5, T0);
      // A guesser keeps trying while the account is throttled.
      for (let minute = 1; minute < 15; minute += 1) {
        expect(await isThrottled(db(), userId, at(minute * MINUTE))).toBe(true);
        await recordLoginFailure(db(), {
          method: 'password',
          reason: 'throttled',
          userId,
          now: at(minute * MINUTE),
        });
      }
      expect(
        await isThrottled(db(), userId, at(15 * MINUTE + 5 * SECOND)),
      ).toBe(false);
    });

    it('is false for an account with no failures, and for an id nobody has', async () => {
      const userId = await seedActiveUser(database);
      expect(await isThrottled(db(), userId, T0)).toBe(false);
      expect(await isThrottled(db(), newId(), T0)).toBe(false);
    });

    it('finds the failures by an index on the target and the time, not by a scan of the whole log', async () => {
      const found = await rowsOf(
        database,
        sql`select indexdef from pg_indexes
            where tablename = 'audit_event'
              and indexname = 'audit_event_target_occurred_idx'`,
      );
      expect(found).toHaveLength(1);
      expect(String(found[0]!.indexdef)).toMatch(/\(target_id, occurred_at\)/);
    });
  });
});
