import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedUser } from '../access/test-fixtures.js';
import { AuthStateError } from '../auth/errors.js';
import { lockUser } from '../auth/shared.js';
import type { Database } from '../db/client.js';
import { auditEvent, user, userPreferences } from '../db/schema/index.js';
import {
  createMigratedDatabase,
  interleave,
  testTargets,
} from '../db/test-support.js';
import type { Tx } from '../db/write.js';
import { endAccountAccessSharing } from '../sensitive/account-sharing.js';
import { saveOwnPreferences } from './service.js';
import { ctxFor, NOW } from './test-support.js';

/** The PostgreSQL target, when `DATABASE_URL` names a server. PGlite has one connection, so it cannot run this. */
const postgres = testTargets.find((target) => target.name === 'postgres');

/** What a call answered, or why it failed. */
const resultOf = (outcome: PromiseSettledResult<unknown>): unknown =>
  outcome.status === 'fulfilled' ? outcome.value : outcome.reason;

/**
 * Saving an account's preferences racing the account's deletion, and two first saves at once
 * (decision D-69; CLAUDE.md, Data rules). A save writes a row derived from the account it has
 * just read, so it holds the user row `FOR KEY SHARE` until it commits: the deletion, which
 * holds that row `FOR UPDATE`, queues behind a save that has started, and a save that starts
 * after finds the account deleted and writes nothing. Without it a save could slip in after
 * the erase and leave a row for an account that is gone. Each case holds one transaction
 * open after its work while the other starts, and waits until the second is blocked on a lock
 * (`interleave`), so the two really overlap and the order is the one the test names. They
 * need two real sessions, so they run on PostgreSQL and are skipped on PGlite.
 */
describe.skipIf(postgres === undefined)(
  'saving delivery preferences racing an account deletion, on PostgreSQL',
  () => {
    let database: Database;
    let cleanup: () => Promise<void>;

    beforeAll(async () => {
      ({ database, cleanup } = await createMigratedDatabase(postgres!));
    });
    afterAll(async () => {
      await cleanup();
    });

    const db = () => database.db;
    const rowsOf = async (userId: string) =>
      (await db().select().from(userPreferences)).filter(
        (row) => row.userId === userId,
      );
    const eventsAbout = async (userId: string, category: string) =>
      (await db().select().from(auditEvent)).filter(
        (event) => event.targetId === userId && event.category === category,
      );

    /**
     * What the account-deletion service that does not exist yet will do, in its order: the
     * user row `FOR UPDATE`, the account marked deleted, the account's sharing and
     * preferences ended.
     */
    const deleteAccount = async (tx: Tx, userId: string) => {
      await lockUser(tx, userId, { strength: 'update' });
      await tx.update(user).set({ deletedAt: NOW }).where(eq(user.id, userId));
      await endAccountAccessSharing(tx, userId, 'account-deleted', {
        now: NOW,
      });
    };

    it('makes a save that comes after a deletion in progress wait, find the account deleted, and leave no row behind', async () => {
      const userId = await seedUser(database);
      await saveOwnPreferences(db(), ctxFor(userId), { textSize: 'large' });

      const outcomes = await interleave(
        db(),
        (tx) => deleteAccount(tx, userId),
        (tx) =>
          saveOwnPreferences(tx, ctxFor(userId), { textSize: 'extra-large' }),
      );

      expect(outcomes[0].status).toBe('fulfilled');
      expect(resultOf(outcomes[1])).toBeInstanceOf(AuthStateError);
      expect(await rowsOf(userId)).toEqual([]);
      expect(await eventsAbout(userId, 'preferences.erased')).toHaveLength(1);
    });

    it('makes a deletion wait for a save that has started, and then erase what that save wrote', async () => {
      const userId = await seedUser(database);

      const outcomes = await interleave(
        db(),
        (tx) => saveOwnPreferences(tx, ctxFor(userId), { textSize: 'large' }),
        (tx) => deleteAccount(tx, userId),
      );

      expect(resultOf(outcomes[0])).toMatchObject({
        stored: { textSize: 'large' },
      });
      expect(outcomes[1].status).toBe('fulfilled');
      // The deletion ran once the save had committed, so it saw the row and erased it.
      expect(await rowsOf(userId)).toEqual([]);
      expect(await eventsAbout(userId, 'preferences.erased')).toHaveLength(1);
    });

    it('makes one row of two first saves at the same moment, and the later one the update of the first', async () => {
      const userId = await seedUser(database);

      const outcomes = await interleave(
        db(),
        (tx) => saveOwnPreferences(tx, ctxFor(userId), { textSize: 'large' }),
        (tx) =>
          saveOwnPreferences(tx, ctxFor(userId), { textSize: 'extra-large' }),
      );

      expect(outcomes[0].status).toBe('fulfilled');
      expect(resultOf(outcomes[1])).toMatchObject({
        stored: { textSize: 'extra-large' },
      });
      const rows = await rowsOf(userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        payload: { textSize: 'extra-large' },
        version: 2,
      });
      const saved = await eventsAbout(userId, 'preferences.saved');
      expect(saved.map((event) => event.action).sort()).toEqual([
        'create',
        'update',
      ]);
    });
  },
);
