import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lockInstallation } from '@osfpm/core/src/auth/setup-code.js';
import {
  demoSetupInput,
  seedFirstRun,
} from '@osfpm/core/src/auth/test-support.js';
import { migrate } from '@osfpm/core/src/db/migrate.js';
import {
  organisation,
  orgMembership,
  session,
  user,
} from '@osfpm/core/src/db/schema/index.js';
import { testTargets } from '@osfpm/core/src/db/test-support.js';
import { API_PREFIX } from '../api-version.js';
import { createTestApp, TEST_PUBLIC_ORIGIN } from '../test-support.js';

/** The PostgreSQL target, when `DATABASE_URL` names a server. PGlite has one connection, so it cannot run this. */
const postgres = testTargets.find((target) => target.name === 'postgres');

/** A promise that is settled from outside. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * Two setup requests at once with the same live code, on two real connections
 * (SC-10, decision D-56, Q1): exactly one succeeds, and the other gets the same
 * 401 `setup-code-invalid` as any code that does not work; never two
 * organisations, two users or two owners.
 *
 * The test makes the overlap certain and does not hope for it. It holds the
 * `installation` row in another transaction, starts both requests, which pass
 * the gate and then block on that row (setup takes it first, before it spends
 * the code or writes anything), waits until the database shows both waiting, and
 * only then lets go. So both are in flight on the lock when the first commits,
 * and the second finds the code spent. Without the lock a request would not
 * wait, and the test fails at the wait: that is what it is there to show. Only a
 * server with real concurrent sessions can run it, so it is skipped on PGlite.
 */
describe.skipIf(postgres === undefined)(
  'two setup requests at once, on PostgreSQL',
  () => {
    let ctx: Awaited<ReturnType<typeof createTestApp>>;
    let code: string;

    // Setup completes in the test, so it has an app and a database of its own.
    beforeEach(async () => {
      ctx = await createTestApp(postgres!, { setupComplete: false });
      await migrate(ctx.database);
      code = await seedFirstRun(ctx.database);
    });
    afterEach(async () => {
      await ctx.close();
    });

    /** How many sessions of the test database are waiting for a lock right now. */
    async function lockWaiters(): Promise<number> {
      const result = (await ctx.database.db.execute(
        `select count(*)::int as waiting from pg_stat_activity
         where datname = current_database() and wait_event_type = 'Lock'`,
      )) as { rows: { waiting: number }[] };
      return Number(result.rows[0]!.waiting);
    }

    const setup = (email: string, remoteAddress: string) =>
      ctx.app.inject({
        method: 'POST',
        url: `${API_PREFIX}/setup`,
        headers: { origin: TEST_PUBLIC_ORIGIN },
        remoteAddress,
        payload: demoSetupInput(code, { email }) as unknown as Record<
          string,
          unknown
        >,
      });

    it('lets one succeed and refuses the other as an invalid code, with one organisation, one user and one owner', async () => {
      const held = deferred();
      const release = deferred();
      const holder = ctx.database.db.transaction(async (tx) => {
        await lockInstallation(tx);
        held.resolve();
        await release.promise;
      });
      let responses: Awaited<ReturnType<typeof setup>>[];
      try {
        await Promise.race([held.promise, holder]);
        const first = setup('first.person@demopictures.example', '10.7.0.1');
        const second = setup('second.person@demopictures.example', '10.7.0.2');
        // Both are in flight, and both are waiting for the installation row.
        await vi.waitFor(async () => {
          expect(await lockWaiters()).toBeGreaterThanOrEqual(2);
        }, 10_000);
        release.resolve();
        await holder;
        responses = await Promise.all([first, second]);
      } finally {
        release.resolve();
      }

      expect(responses.map((response) => response.statusCode).sort()).toEqual([
        201, 401,
      ]);
      const loser = responses.find((response) => response.statusCode === 401)!;
      expect(loser.json()).toMatchObject({
        code: 'setup-code-invalid',
        status: 401,
      });
      expect(loser.headers['set-cookie']).toBeUndefined();

      const { db } = ctx.database;
      expect(await db.select().from(organisation)).toHaveLength(1);
      expect(await db.select().from(user)).toHaveLength(1);
      expect(await db.select().from(session)).toHaveLength(1);
      const owners = (await db.select().from(orgMembership)).filter(
        (member) => member.orgRole === 'owner',
      );
      expect(owners).toHaveLength(1);
      // The server was told, so the gate is open and the routes are closed.
      expect(await ctx.app.setup.isComplete()).toBe(true);
    });
  },
);
