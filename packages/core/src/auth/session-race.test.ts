import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { session, user } from '../db/schema/index.js';
import {
  createMigratedDatabase,
  interleave,
  testTargets,
} from '../db/test-support.js';
import { createSession, disableUser, validateSession } from './sessions.js';
import { seedActiveUser, seedInstallation } from './test-support.js';

/** The PostgreSQL target, when `DATABASE_URL` names a server. PGlite has one connection, so it cannot run this. */
const postgres = testTargets.find((target) => target.name === 'postgres');

const T0 = new Date('2026-03-02T09:00:00.000Z');
const LATER = new Date('2026-03-02T09:01:00.000Z');

/**
 * `createSession` against a concurrent `disableUser`, on two real connections.
 * Both take the user's row lock before they look at the status
 * (`lockUser`), so whichever comes second waits for the first and then sees its
 * result. The rule they keep: a disabled user never has a live session, meaning
 * one that is not revoked. Without the lock a login that read the status just
 * before the disable committed could insert its session after the disable had
 * revoked the others, and the user would be disabled with a live session.
 * `validateSession` would still refuse it, because it checks the status, but
 * the row must not exist either. Only a server with real concurrent sessions
 * can show that, so the test runs on PostgreSQL and is skipped on PGlite.
 *
 * `interleave` fixes the order: the first piece of work runs to its end and
 * keeps its transaction open, the second starts and must block on a lock, and
 * only then does the first commit. The two orders are the two tests.
 */
describe.skipIf(postgres === undefined)(
  'a login racing the disabling of its user, on PostgreSQL',
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

    const sessionsOf = (userId: string) =>
      db().select().from(session).where(eq(session.userId, userId));

    /** Sessions of the user that are not revoked. There must be none once the user is disabled. */
    const liveSessionsOf = (userId: string) =>
      db()
        .select()
        .from(session)
        .where(and(eq(session.userId, userId), isNull(session.revokedAt)));

    const statusOf = async (userId: string) =>
      (await db().select().from(user).where(eq(user.id, userId)))[0]!.status;

    it('revokes the session when the login commits first and the disable waits for it', async () => {
      const userId = await seedActiveUser(database);
      const outcomes = await interleave(
        db(),
        (tx) => createSession(tx, { userId, method: 'password', now: T0 }),
        (tx) => disableUser(tx, userId, { now: LATER }),
      );
      expect(outcomes.map((outcome) => outcome.status)).toEqual([
        'fulfilled',
        'fulfilled',
      ]);
      const login = (
        outcomes[0] as PromiseFulfilledResult<
          Awaited<ReturnType<typeof createSession>>
        >
      ).value;
      expect((outcomes[1] as PromiseFulfilledResult<boolean>).value).toBe(true);
      expect(await statusOf(userId)).toBe('disabled');
      // The disable waited, so it saw the new session and revoked it with the rest.
      const rows = await sessionsOf(userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.revokedReason).toBe('user-disabled');
      expect(await liveSessionsOf(userId)).toEqual([]);
      expect(await validateSession(db(), login.token, LATER)).toBeNull();
    });

    it('refuses the login when the disable commits first and the login waits for it', async () => {
      const userId = await seedActiveUser(database);
      const outcomes = await interleave(
        db(),
        (tx) => disableUser(tx, userId, { now: T0 }),
        (tx) => createSession(tx, { userId, method: 'password', now: LATER }),
      );
      expect(outcomes[0]).toMatchObject({ status: 'fulfilled', value: true });
      // The login waited, then read the committed status: refused, not a database error.
      expect(outcomes[1]).toMatchObject({
        status: 'rejected',
        reason: { name: 'AuthStateError', reason: 'user-disabled' },
      });
      expect(await statusOf(userId)).toBe('disabled');
      expect(await sessionsOf(userId)).toEqual([]);
    });

    it('never leaves a disabled user with a live session, however many times the two run at once', async () => {
      for (let round = 0; round < 12; round += 1) {
        const userId = await seedActiveUser(database);
        const [login, disable] = await Promise.allSettled([
          createSession(db(), { userId, method: 'password', now: T0 }),
          disableUser(db(), userId, { now: LATER }),
        ]);
        expect(disable.status, `round ${round}`).toBe('fulfilled');
        // The login either won and was revoked, or lost and was refused cleanly.
        if (login.status === 'rejected') {
          expect(login.reason, `round ${round}`).toMatchObject({
            name: 'AuthStateError',
            reason: 'user-disabled',
          });
        }
        expect(await statusOf(userId), `round ${round}`).toBe('disabled');
        expect(await liveSessionsOf(userId), `round ${round}`).toEqual([]);
      }
    });
  },
);
