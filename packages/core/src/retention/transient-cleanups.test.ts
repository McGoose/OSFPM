import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLoginChallenge } from '../auth/login-challenge.js';
import { createSession } from '../auth/sessions.js';
import { consumeSetupCode, issueSetupCode } from '../auth/setup-code.js';
import {
  rowsOf,
  seedActiveUser,
  seedInstallation,
} from '../auth/test-support.js';
import type { Database } from '../db/client.js';
import { declaredRetentionClasses } from '../db/columns.js';
import { loginChallenge, session, setupCode } from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { TRANSIENT_CLEANUPS } from './transient-cleanups.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * The tables whose default class is transient and that have no cleanup, and the
 * cleanups registered for tables that are not transient. Both lists are empty
 * when the registry is right.
 */
function cleanupMismatches(
  declared: ReadonlyMap<string, string>,
  cleanups: ReadonlyMap<string, unknown>,
) {
  const transient = [...declared]
    .filter(([, retentionClass]) => retentionClass === 'transient')
    .map(([table]) => table);
  return {
    withoutCleanup: transient.filter((table) => !cleanups.has(table)).sort(),
    notTransient: [...cleanups.keys()]
      .filter((table) => declared.get(table) !== 'transient')
      .sort(),
  };
}

describe('TRANSIENT_CLEANUPS', () => {
  it('has a cleanup for every table whose default class is transient, and for no other table', () => {
    // The tables come from the schema: each one declares its default class
    // where it is defined, so a new transient table is found without a list
    // kept here.
    expect(
      cleanupMismatches(declaredRetentionClasses(), TRANSIENT_CLEANUPS),
    ).toEqual({ withoutCleanup: [], notTransient: [] });
  });

  it('is found by the check, which flags a transient table with no cleanup and a cleanup for a table that is not transient', () => {
    const declared = new Map([
      ['working', 'transient'],
      ['forgotten', 'transient'],
      ['ordinary', 'standard'],
    ]);
    const cleanups = new Map([
      ['working', 1],
      ['ordinary', 2],
      ['gone', 3],
    ]);
    expect(cleanupMismatches(declared, cleanups)).toEqual({
      withoutCleanup: ['forgotten'],
      notTransient: ['gone', 'ordinary'],
    });
  });
});

describe.each(testTargets)(
  'running every cleanup in TRANSIENT_CLEANUPS on $name',
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

    /** The number of rows in a table, whichever table the registry names. */
    const countOf = async (table: string) =>
      Number(
        (
          await rowsOf(
            database,
            sql`select count(*) as n from ${sql.identifier(table)}`,
          )
        )[0]!.n,
      );

    it('removes what is of no use in every transient table and keeps what is live', async () => {
      const db = database.db;
      const now = new Date('2026-06-01T09:00:00.000Z');
      const ago = (ms: number) => new Date(now.getTime() - ms);
      const userId = await seedActiveUser(database);
      const otherId = await seedActiveUser(database);

      // Each table gets one row that is of no use and one that is live. Making
      // a login challenge deletes that user's expired ones, so the two
      // challenges are for two users.
      await createSession(db, {
        userId,
        method: 'password',
        now: ago(60 * DAY),
      });
      const live = await createSession(db, {
        userId,
        method: 'password',
        now: ago(HOUR),
      });
      await createLoginChallenge(db, userId, {
        kind: 'totp',
        now: ago(60 * DAY),
      });
      const liveChallenge = await createLoginChallenge(db, otherId, {
        kind: 'totp',
        now: ago(MINUTE),
      });
      const used = await issueSetupCode(db, ago(60 * DAY));
      expect(await consumeSetupCode(db, used, ago(60 * DAY - HOUR))).toBe(true);
      await issueSetupCode(db, ago(HOUR));
      expect(await db.select().from(session)).toHaveLength(2);
      expect(await db.select().from(loginChallenge)).toHaveLength(2);
      expect(await db.select().from(setupCode)).toHaveLength(2);

      // What the worker does: every cleanup, with the same time. The name an
      // entry is listed under must be the table its cleanup empties, so each
      // run removes the one row of no use from that table and touches no other.
      const counts = async () =>
        new Map(
          await Promise.all(
            [...TRANSIENT_CLEANUPS.keys()].map(
              async (table) => [table, await countOf(table)] as const,
            ),
          ),
        );
      for (const [table, run] of TRANSIENT_CLEANUPS) {
        const before = await counts();
        expect(await run(db, now), table).toBe(1);
        expect(await counts(), table).toEqual(
          new Map([...before, [table, before.get(table)! - 1] as const]),
        );
      }

      // What is left is what was live.
      expect(
        (await db.select({ id: session.id }).from(session)).map((r) => r.id),
      ).toEqual([live.session.id]);
      expect(
        (
          await db
            .select({ expiresAt: loginChallenge.expiresAt })
            .from(loginChallenge)
        ).map((r) => r.expiresAt),
      ).toEqual([liveChallenge.expiresAt]);
      const codes = await db.select().from(setupCode);
      expect(codes).toHaveLength(1);
      expect(codes[0]!.usedAt).toBeNull();
      expect(codes[0]!.revokedAt).toBeNull();
      expect(codes[0]!.expiresAt.getTime()).toBeGreaterThan(now.getTime());
    });
  },
);
