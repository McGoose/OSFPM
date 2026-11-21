import { and, eq, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncPermissions } from '../access/permission-sync.js';
import {
  base,
  grantOnProject,
  ORIGIN,
  seedOrganisation,
  seedUser,
} from '../access/test-fixtures.js';
import { ACCOUNT_PERMISSIONS } from '../accounts/permissions.js';
import {
  AccountInUseError,
  removeAccount,
  type AccountContext,
} from '../accounts/service.js';
import type { Database, SchemaDb } from '../db/client.js';
import {
  account,
  accountChart,
  costLine,
  project,
} from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import {
  insertRecord,
  RecordWriteError,
  updateRecord,
  type Tx,
  type WriteContext,
} from '../db/write.js';
import { COST_PERMISSIONS } from './permissions.js';
import {
  CostLineInputError,
  createCostLine,
  type CostContext,
} from './service.js';
import { seedAccount, seedChart } from './test-fixtures.js';

const NOW = new Date(Date.UTC(2026, 1, 1, 12));

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

/**
 * A removal of an account and a booking of a cost line to it, on two real
 * connections. The accounts guard locks the account `FOR UPDATE` before it looks
 * for cost lines and the cost line service reads it `FOR SHARE`, so whichever
 * comes second must wait for the first and then see its result. Only a server
 * with real concurrent sessions can show that, so the test runs on PostgreSQL
 * and is skipped on PGlite.
 */
describe.skipIf(postgres === undefined)(
  'a removal and a booking at the same moment on PostgreSQL',
  () => {
    let database: Database;
    let cleanup: () => Promise<void>;
    const db = () => database.db;

    beforeAll(async () => {
      ({ database, cleanup } = await createMigratedDatabase(postgres!));
      await syncPermissions(db(), [
        ...ACCOUNT_PERMISSIONS,
        ...COST_PERMISSIONS,
      ]);
    });
    afterAll(async () => {
      await cleanup();
    });

    /** An organisation with a postable account, and a user for each side. */
    async function world() {
      const org = await seedOrganisation(database);
      const accountId = await seedAccount(
        database,
        org.organisationId,
        await seedChart(database, org.organisationId, {
          projectId: org.projectId,
        }),
      );
      const user = async (keys: string[]) => {
        const userId = await seedUser(database);
        await grantOnProject(
          database,
          org.organisationId,
          org.projectId,
          userId,
          keys,
        );
        return userId;
      };
      const bookerId = await user(['costs:edit']);
      const removerId = await user(['accounts:edit']);
      const costs: CostContext = {
        userId: bookerId,
        originServer: ORIGIN,
        clock: () => NOW,
      };
      const accounts: AccountContext = {
        userId: removerId,
        originServer: ORIGIN,
        clock: () => NOW,
      };
      return {
        ...org,
        accountId,
        book: (tx: Tx) =>
          createCostLine(tx, costs, {
            organisationId: org.organisationId,
            projectId: org.projectId,
            stage: 'budget',
            sourceType: 'other',
            accountId,
            description: 'Camera hire',
            territory: 'GB',
            productionPhase: 'principal-photography',
            amount: '1000.00',
            currency: 'GBP',
          }),
        remove: (tx: Tx) => removeAccount(tx, accounts, accountId, 1),
      };
    }

    /** How many live cost lines of the organisation point at a removed account. */
    const danglingLines = async (organisationId: string) => {
      const [row] = await db()
        .select({ n: sql<number>`count(*)::int` })
        .from(costLine)
        .innerJoin(
          account,
          and(
            eq(account.organisationId, costLine.organisationId),
            eq(account.id, costLine.accountId),
          ),
        )
        .where(
          and(
            eq(costLine.organisationId, organisationId),
            isNull(costLine.deletedAt),
            isNotNull(account.deletedAt),
          ),
        );
      return Number(row!.n);
    };

    const succeeded = (outcomes: PromiseSettledResult<unknown>[]) =>
      outcomes.filter((outcome) => outcome.status === 'fulfilled').length;

    it(
      'lets exactly one of them succeed, in either order, and leaves no live cost line on a removed account',
      { timeout: 120_000 },
      async () => {
        // The booking is open first: the removal has to wait for it, then finds
        // the line and refuses.
        const bookingFirst = await world();
        const [booking, removal] = await interleave(
          db(),
          bookingFirst.book,
          bookingFirst.remove,
        );
        expect(booking.status).toBe('fulfilled');
        expect(removal.status).toBe('rejected');
        expect((removal as PromiseRejectedResult).reason).toBeInstanceOf(
          AccountInUseError,
        );
        expect(succeeded([booking, removal])).toBe(1);
        expect(await danglingLines(bookingFirst.organisationId)).toBe(0);

        // The removal is open first: the booking has to wait for it, then finds
        // the account gone and refuses.
        const removalFirst = await world();
        const [removed, booked] = await interleave(
          db(),
          removalFirst.remove,
          removalFirst.book,
        );
        expect(removed.status).toBe('fulfilled');
        expect(booked.status).toBe('rejected');
        expect((booked as PromiseRejectedResult).reason).toBeInstanceOf(
          CostLineInputError,
        );
        expect(succeeded([removed, booked])).toBe(1);
        expect(await danglingLines(removalFirst.organisationId)).toBe(0);

        // Both start at once, with no ordering forced, a number of times. Which
        // one wins varies; that one wins and the other loses never does.
        let bookingWins = 0;
        let removalWins = 0;
        for (let round = 0; round < 12; round += 1) {
          const w = await world();
          const outcomes = await Promise.allSettled([
            db().transaction((tx) => w.book(tx)),
            db().transaction((tx) => w.remove(tx)),
          ]);
          expect(succeeded(outcomes), `round ${round}`).toBe(1);
          if (outcomes[0].status === 'fulfilled') bookingWins += 1;
          else removalWins += 1;
          expect(await danglingLines(w.organisationId), `round ${round}`).toBe(
            0,
          );
        }
        expect(bookingWins + removalWins).toBe(12);
      },
    );
  },
);

/**
 * A change of a project's currency and a booking of a cost line, on two real
 * connections. The database refuses the change while the project has live cost
 * lines (`0022_project_currency_locked.sql`), and the cost line service prices a
 * line against the project's currency under a share lock on the project, so
 * whichever comes second must wait for the first and then see its result: either
 * the line exists and the currency stays, or the currency has changed and the
 * line, written in the old one, is refused. The currency changes through the
 * write helper, as a project update does, so the test also shows that the two
 * take their locks in an order that cannot deadlock. A loser must fail with its
 * own clean refusal, never with a deadlock error. PostgreSQL only, as above.
 */
describe.skipIf(postgres === undefined)(
  'a currency change and a booking at the same moment on PostgreSQL',
  () => {
    let database: Database;
    let cleanup: () => Promise<void>;
    const db = () => database.db;
    const write: WriteContext = {
      actor: { type: 'system', id: null },
      originServer: ORIGIN,
      clock: () => NOW,
    };

    beforeAll(async () => {
      ({ database, cleanup } = await createMigratedDatabase(postgres!));
      await syncPermissions(db(), COST_PERMISSIONS);
    });
    afterAll(async () => {
      await cleanup();
    });

    /** A project in pounds with a postable account and a user who may book. */
    async function world() {
      const org = await seedOrganisation(database);
      // Written through the helper, as a real project's records are. That gives
      // the project its change counter, which every writer in it queues on.
      const chart = await insertRecord(
        db(),
        accountChart,
        {
          ...base(org.organisationId),
          projectId: org.projectId,
          key: 'house',
          name: 'House chart',
        },
        write,
      );
      const bookable = await insertRecord(
        db(),
        account,
        {
          ...base(org.organisationId),
          chartId: chart.id,
          code: '5100',
          name: 'Camera',
        },
        write,
      );
      const userId = await seedUser(database);
      await grantOnProject(
        database,
        org.organisationId,
        org.projectId,
        userId,
        ['costs:edit'],
      );
      const costs: CostContext = {
        userId,
        originServer: ORIGIN,
        clock: () => NOW,
      };
      return {
        ...org,
        // A line in pounds, which needs no rate while the project is in pounds
        // and is refused once the project is in dollars.
        book: (tx: Tx) =>
          createCostLine(tx, costs, {
            organisationId: org.organisationId,
            projectId: org.projectId,
            stage: 'budget',
            sourceType: 'other',
            accountId: bookable.id,
            description: 'Camera hire',
            territory: 'GB',
            productionPhase: 'principal-photography',
            amount: '1000.00',
            currency: 'GBP',
          }),
        changeCurrency: (tx: Tx) =>
          updateRecord(
            tx,
            project,
            org.projectId,
            1,
            { currency: 'USD' },
            write,
          ),
      };
    }

    const currencyOf = async (projectId: string) =>
      (
        await db()
          .select({ currency: project.currency })
          .from(project)
          .where(eq(project.id, projectId))
      )[0]!.currency;

    /**
     * How many live cost lines of the organisation are priced in a currency
     * other than their project's: a line with no rate must be in the project's
     * currency, and a line with a rate must not be.
     */
    const mispricedLines = async (organisationId: string) => {
      const [row] = await db()
        .select({ n: sql<number>`count(*)::int` })
        .from(costLine)
        .innerJoin(
          project,
          and(
            eq(project.organisationId, costLine.organisationId),
            eq(project.id, costLine.projectId),
          ),
        )
        .where(
          and(
            eq(costLine.organisationId, organisationId),
            isNull(costLine.deletedAt),
            or(
              and(
                isNull(costLine.fxRate),
                ne(costLine.currency, project.currency),
              ),
              and(
                isNotNull(costLine.fxRate),
                eq(costLine.currency, project.currency),
              ),
            ),
          ),
        );
      return Number(row!.n);
    };

    const succeeded = (outcomes: PromiseSettledResult<unknown>[]) =>
      outcomes.filter((outcome) => outcome.status === 'fulfilled').length;

    /** A change that lost must have been refused by the currency lock, not by a deadlock or anything else. */
    const expectRefusedByTheLock = (outcome: PromiseSettledResult<unknown>) => {
      expect(outcome.status).toBe('rejected');
      const reason = (outcome as PromiseRejectedResult).reason as unknown;
      expect(reason).toBeInstanceOf(RecordWriteError);
      expect(reason).toMatchObject({
        code: '23514',
        constraint: 'project_currency_locked',
      });
    };

    /** A booking that lost must have been refused by the service for its currency, not by a deadlock or anything else. */
    const expectRefusedForItsCurrency = (
      outcome: PromiseSettledResult<unknown>,
    ) => {
      expect(outcome.status).toBe('rejected');
      expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(
        CostLineInputError,
      );
    };

    it(
      'lets exactly one of them succeed, in either order, and leaves no live cost line priced in another currency than its project’s',
      { timeout: 120_000 },
      async () => {
        // The booking is open first: the change has to wait for it, then finds
        // the line and refuses.
        const bookingFirst = await world();
        const [booking, change] = await interleave(
          db(),
          bookingFirst.book,
          bookingFirst.changeCurrency,
        );
        expect(booking.status).toBe('fulfilled');
        expectRefusedByTheLock(change);
        expect(succeeded([booking, change])).toBe(1);
        expect(await currencyOf(bookingFirst.projectId)).toBe('GBP');
        expect(await mispricedLines(bookingFirst.organisationId)).toBe(0);

        // The change is open first: the booking has to wait for it, then prices
        // its pounds against a project in dollars and refuses.
        const changeFirst = await world();
        const [changed, booked] = await interleave(
          db(),
          changeFirst.changeCurrency,
          changeFirst.book,
        );
        expect(changed.status).toBe('fulfilled');
        expectRefusedForItsCurrency(booked);
        expect(succeeded([changed, booked])).toBe(1);
        expect(await currencyOf(changeFirst.projectId)).toBe('USD');
        expect(await mispricedLines(changeFirst.organisationId)).toBe(0);

        // Both start at once, with no ordering forced, a number of times. Which
        // one wins varies; that one wins and the other loses never does.
        for (let round = 0; round < 12; round += 1) {
          const w = await world();
          const [bookingOutcome, changeOutcome] = await Promise.allSettled([
            db().transaction((tx) => w.book(tx)),
            db().transaction((tx) => w.changeCurrency(tx)),
          ]);
          const label = `round ${round}`;
          expect(succeeded([bookingOutcome, changeOutcome]), label).toBe(1);
          if (bookingOutcome.status === 'fulfilled') {
            expectRefusedByTheLock(changeOutcome);
            expect(await currencyOf(w.projectId), label).toBe('GBP');
          } else {
            expectRefusedForItsCurrency(bookingOutcome);
            expect(await currencyOf(w.projectId), label).toBe('USD');
          }
          expect(await mispricedLines(w.organisationId), label).toBe(0);
        }
      },
    );
  },
);
