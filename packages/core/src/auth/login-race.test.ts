import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { auditEvent } from '../db/schema/index.js';
import {
  createMigratedDatabase,
  interleave,
  testTargets,
} from '../db/test-support.js';
import {
  consumeLoginChallenge,
  createLoginChallenge,
} from './login-challenge.js';
import { verifyPasswordLogin } from './password-service.js';
import { AUTH_AUDIT } from './shared.js';
import {
  emailOf,
  seedActiveUser,
  seedInstallation,
  seedPassword,
  seedTotp,
  totpCodeAt,
} from './test-support.js';
import { LOGIN_THROTTLE, recordLoginFailure } from './throttle.js';
import { useTestServerKeys } from '../keys/test-support.js';

/** The server keys of this test file, in a key directory that is deleted afterwards. */
const serverKeys = useTestServerKeys();

/** The PostgreSQL target, when `DATABASE_URL` names a server. PGlite has one connection, so it cannot run this. */
const postgres = testTargets.find((target) => target.name === 'postgres');

// An invented password, free of any word of the fixture addresses.
const PASSWORD = 'harbour-warehouse-night-shoot';

const T0 = new Date('2026-03-02T09:00:15.000Z');
const SECOND = 1000;
const STEP = 30 * SECOND;
const at = (ms: number) => new Date(T0.getTime() + ms);

/**
 * The sign-in services against themselves, on two real connections. Each takes
 * the user's row lock (`lockUser`) before it counts failures or reads a
 * challenge, so whichever comes second waits for the first and then sees what
 * it wrote. Without the lock two guesses made at once would both read four
 * failures and both go on, and the throttle of five would let six or more
 * through; two requests with one challenge would both read it unused. Only a
 * server with real concurrent sessions can show that, so the tests run on
 * PostgreSQL and are skipped on PGlite.
 *
 * `interleave` fixes the order: the first piece of work runs to its end and
 * keeps its transaction open, the second starts and must block on a lock, and
 * only then does the first commit.
 */
describe.skipIf(postgres === undefined)(
  'sign-in steps racing each other, on PostgreSQL',
  () => {
    let database: Database;
    let cleanup: () => Promise<void>;
    const db = () => database.db;

    beforeAll(async () => {
      ({ database, cleanup } = await createMigratedDatabase(postgres!));
      await seedInstallation(database);
    });
    afterAll(async () => {
      await cleanup();
    });

    const reasonsFor = async (userId: string) =>
      (await db().select().from(auditEvent))
        .filter(
          (event) =>
            event.category === AUTH_AUDIT.loginStepFailed &&
            event.targetId === userId,
        )
        .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
        .map((event) => (event.details as { reason: string }).reason);

    it('makes a guess wait for the guess before it, and counts it: the fifth failure closes the account to the next, which has the right password', async () => {
      const userId = await seedActiveUser(database);
      await seedPassword(database, userId, PASSWORD);
      const email = await emailOf(database, userId);
      for (let i = 0; i < LOGIN_THROTTLE.maxFailures - 1; i += 1) {
        await recordLoginFailure(db(), {
          method: 'password',
          reason: 'wrong-secret',
          userId,
          now: at(i * SECOND),
        });
      }
      const outcomes = await interleave(
        db(),
        (tx) =>
          verifyPasswordLogin(tx, {
            email,
            password: 'not-the-password-x',
            now: at(10 * SECOND),
          }),
        (tx) =>
          verifyPasswordLogin(tx, {
            email,
            password: PASSWORD,
            now: at(11 * SECOND),
          }),
      );
      expect(outcomes).toEqual([
        { status: 'fulfilled', value: { ok: false } },
        { status: 'fulfilled', value: { ok: false } },
      ]);
      // The second saw the fifth failure, committed by the first, and did not
      // check its password.
      const reasons = await reasonsFor(userId);
      expect(reasons).toHaveLength(LOGIN_THROTTLE.maxFailures + 1);
      expect(reasons.at(-1)).toBe('throttled');
    });

    it('lets only one of two requests with one challenge sign in, even with two different right codes', async () => {
      const userId = await seedActiveUser(database);
      const secret = await seedTotp(database, userId, {
        now: T0,
        dataKeys: serverKeys().dataKeys,
      });
      const { challenge } = await createLoginChallenge(db(), userId, {
        kind: 'totp',
        now: T0,
      });
      const outcomes = await interleave(
        db(),
        (tx) =>
          consumeLoginChallenge(tx, {
            challenge,
            code: totpCodeAt(secret, T0),
            now: T0,
            dataKeys: serverKeys().dataKeys,
          }),
        (tx) =>
          consumeLoginChallenge(tx, {
            challenge,
            code: totpCodeAt(secret, at(STEP)),
            now: T0,
            dataKeys: serverKeys().dataKeys,
          }),
      );
      expect(outcomes).toMatchObject([
        { status: 'fulfilled', value: { ok: true } },
        { status: 'fulfilled', value: { ok: false } },
      ]);
      // The second waited, then found the challenge used.
      expect((await reasonsFor(userId)).at(-1)).toBe('challenge-invalid');
    });
  },
);
