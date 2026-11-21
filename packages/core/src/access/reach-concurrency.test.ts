import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database, SchemaDb } from '../db/client.js';
import { permission, role, rolePermission } from '../db/schema/index.js';
import {
  createMigratedDatabase,
  failureOf,
  SQLSTATE,
  testTargets,
} from '../db/test-support.js';
import type { Tx } from '../db/write.js';
import { base, seedOrganisation } from './test-fixtures.js';

/** The PostgreSQL target, when `DATABASE_URL` names a server. PGlite has one connection, so it cannot run this. */
const postgres = testTargets.find((target) => target.name === 'postgres');

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A promise that is resolved from outside. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** How many sessions of the test database are waiting for a lock right now. */
async function lockWaiters(db: SchemaDb): Promise<number> {
  const result = await db.execute<{ waiting: number }>(
    sql`select count(*)::int as waiting
        from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'`,
  );
  // Both drivers return `{ rows }`, but the shared base type leaves it `unknown`.
  const { rows } = result as { rows: { waiting: number }[] };
  return Number(rows[0]!.waiting);
}

/**
 * Runs two pieces of work in two transactions on two connections, in a fixed
 * order. `holder` runs to the end of its work and keeps its transaction open.
 * Then `waiter` starts on the second connection. The call waits until the
 * waiter is blocked on a lock, which proves the two overlap, and only then lets
 * the holder commit. Returns both outcomes. If the waiter finishes while the
 * holder is still open, the lock did not do its job and the call throws.
 */
async function interleave(
  db: SchemaDb,
  holder: (tx: Tx) => Promise<unknown>,
  waiter: (tx: Tx) => Promise<unknown>,
) {
  const holderDone = deferred();
  const commit = deferred();
  const first = db.transaction(async (tx) => {
    const result = await holder(tx);
    holderDone.resolve();
    await commit.promise;
    return result;
  });
  // A holder that fails before it is done rejects `first`, and the test with it.
  await Promise.race([holderDone.promise, first]);
  const second = db.transaction((tx) => waiter(tx));
  let secondSettled = false;
  second.then(
    () => {
      secondSettled = true;
    },
    () => {
      secondSettled = true;
    },
  );
  try {
    for (let waited = 0; ; waited += 25) {
      if (secondSettled) {
        throw new Error(
          'The second transaction finished while the first was still open: it did not wait for the lock',
        );
      }
      if ((await lockWaiters(db)) > 0) break;
      if (waited >= 10_000) {
        throw new Error('The second transaction never waited for a lock');
      }
      await sleep(25);
    }
  } finally {
    commit.resolve();
  }
  return Promise.allSettled([first, second]);
}

const succeeded = (outcomes: PromiseSettledResult<unknown>[]) =>
  outcomes.filter((outcome) => outcome.status === 'fulfilled').length;

/**
 * An `all-projects` grant of a permission and the flagging of that permission as
 * sensitive, on two real connections. `role_permission_all_projects_not_sensitive`
 * reads the permission `FOR SHARE` when a grant is written, and the flag change
 * is an UPDATE that locks the same row, so whichever comes second must wait for
 * the first and then see its result. Without the lock both could commit, and a
 * sensitive permission would reach all projects. Only a server with real
 * concurrent sessions can show that, so the test runs on PostgreSQL and is
 * skipped on PGlite.
 */
describe.skipIf(postgres === undefined)(
  'granting a permission to all projects while it is flagged sensitive, on PostgreSQL',
  () => {
    let database: Database;
    let cleanup: () => Promise<void>;
    const db = () => database.db;

    beforeAll(async () => {
      ({ database, cleanup } = await createMigratedDatabase(postgres!));
    });
    afterAll(async () => {
      await cleanup();
    });

    let counter = 0;
    /** An organisation role, a permission that is not sensitive yet, and the two competing writes. */
    async function world() {
      counter += 1;
      const { organisationId } = await seedOrganisation(database);
      const key = `race:key-${counter}`;
      await db().insert(permission).values({
        key,
        module: 'race',
        description: 'Race test',
      });
      const [wide] = await db()
        .insert(role)
        .values({
          ...base(organisationId),
          projectId: null,
          key: 'wide',
          name: 'Wide',
        })
        .returning({ id: role.id });
      return {
        key,
        addGrant: async (tx: Tx) => {
          await tx.insert(rolePermission).values({
            ...base(organisationId),
            roleId: wide!.id,
            permissionKey: key,
            reach: 'all-projects',
          });
        },
        flagSensitive: async (tx: Tx) => {
          await tx
            .update(permission)
            .set({ grantsSensitive: true })
            .where(eq(permission.key, key));
        },
      };
    }

    /** How the permission and its all-projects grants stand now. */
    async function stateOf(key: string) {
      const [flag] = await db()
        .select({ sensitive: permission.grantsSensitive })
        .from(permission)
        .where(eq(permission.key, key));
      const [grants] = await db()
        .select({ n: sql<number>`count(*)::int` })
        .from(rolePermission)
        .where(
          and(
            eq(rolePermission.permissionKey, key),
            eq(rolePermission.reach, 'all-projects'),
          ),
        );
      return { sensitive: flag!.sensitive, grants: Number(grants!.n) };
    }

    /** All-projects grants of sensitive permissions in the whole database. There must be none. */
    async function violations() {
      const result = await db().execute<{ n: number }>(
        sql`select count(*)::int as n
            from role_permission rp
            join permission p on p.key = rp.permission_key
            where rp.reach = 'all-projects' and p.grants_sensitive`,
      );
      return Number((result as { rows: { n: number }[] }).rows[0]!.n);
    }

    /** Fails the test unless `outcome` is the database refusing a sensitive all-projects grant. */
    async function expectRefused(outcome: PromiseSettledResult<unknown>) {
      expect(outcome.status).toBe('rejected');
      const reason = (outcome as PromiseRejectedResult).reason as unknown;
      const failure = await failureOf(() =>
        Promise.resolve().then(() => {
          throw reason;
        }),
      );
      expect(failure).toEqual({
        code: SQLSTATE.checkViolation,
        constraint: 'role_permission_all_projects_not_sensitive',
      });
    }

    it(
      'lets exactly one of them succeed, in either order, and leaves no all-projects grant of a sensitive permission',
      { timeout: 120_000 },
      async () => {
        // The grant is open first: the flag change has to wait for it, then
        // finds the grant and refuses.
        const grantFirst = await world();
        const [grant, flag] = await interleave(
          db(),
          grantFirst.addGrant,
          grantFirst.flagSensitive,
        );
        expect(grant.status).toBe('fulfilled');
        await expectRefused(flag);
        expect(await stateOf(grantFirst.key)).toEqual({
          sensitive: false,
          grants: 1,
        });

        // The flag change is open first: the grant has to wait for it, then
        // finds the permission sensitive and refuses.
        const flagFirst = await world();
        const [flagged, refusedGrant] = await interleave(
          db(),
          flagFirst.flagSensitive,
          flagFirst.addGrant,
        );
        expect(flagged.status).toBe('fulfilled');
        await expectRefused(refusedGrant);
        expect(await stateOf(flagFirst.key)).toEqual({
          sensitive: true,
          grants: 0,
        });

        // Both start at once, with no ordering forced, a number of times. Which
        // one wins varies; that one wins and the other is refused never does.
        let grantWins = 0;
        let flagWins = 0;
        for (let round = 0; round < 12; round += 1) {
          const w = await world();
          const outcomes = await Promise.allSettled([
            db().transaction((tx) => w.addGrant(tx)),
            db().transaction((tx) => w.flagSensitive(tx)),
          ]);
          expect(succeeded(outcomes), `round ${round}`).toBe(1);
          const refused = outcomes.find((o) => o.status === 'rejected')!;
          await expectRefused(refused);
          const state = await stateOf(w.key);
          if (outcomes[0].status === 'fulfilled') {
            grantWins += 1;
            expect(state, `round ${round}`).toEqual({
              sensitive: false,
              grants: 1,
            });
          } else {
            flagWins += 1;
            expect(state, `round ${round}`).toEqual({
              sensitive: true,
              grants: 0,
            });
          }
        }
        expect(grantWins + flagWins).toBe(12);

        // Whatever happened in any round, no sensitive permission is reached.
        expect(await violations()).toBe(0);
      },
    );
  },
);
