import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lockUser } from '../auth/shared.js';
import type { Database } from '../db/client.js';
import { accessGrant } from '../db/schema/index.js';
import {
  createMigratedDatabase,
  interleave,
  testTargets,
} from '../db/test-support.js';
import type { Tx } from '../db/write.js';
import { createAccessGrant } from './access-grants.js';
import { AccountDeletedError } from './errors.js';
import {
  ctxFor,
  seedAccessScene,
  seedProfileHolder,
  simulateAccountDeletion,
  type AccessScene,
} from './test-support.js';

/** The PostgreSQL target, when `DATABASE_URL` names a server. PGlite has one connection, so it cannot run this. */
const postgres = testTargets.find((target) => target.name === 'postgres');

/** What a call answered, or why it failed. */
const resultOf = (outcome: PromiseSettledResult<unknown>): unknown =>
  outcome.status === 'fulfilled' ? outcome.value : outcome.reason;

/** One field of each category a grant can name. */
const FIELD = { accessibility: 'stepFreeRequired', medical: 'conditions' };

/**
 * Making a grant racing the deletion of the account it is for (decision D-69; CLAUDE.md,
 * Data rules). The deletion takes the user row `FOR UPDATE` and then ends every grant of the
 * account, locking the grant rows. A grant that replaced an earlier one took the earlier
 * grant's row first and reached the user row later, through the key-share lock its
 * `granted_by` takes, so it could wait for the deletion's user row while the deletion waited
 * for its grant row, and one of them would be ended by a deadlock; and a grant made after the
 * deletion committed was a live grant of a deleted account. `createAccessGrant` therefore
 * takes the user row `FOR KEY SHARE` first and refuses an account that is deleted, so the
 * two queue on that row. Each case holds one transaction open after its work while the other
 * starts, and waits until the second is blocked on a lock (`interleave`), so the two really
 * overlap and the order is the one the test names. They need two real sessions, so they run
 * on PostgreSQL and are skipped on PGlite.
 */
describe.skipIf(postgres === undefined)(
  'making a grant racing the deletion of the account, on PostgreSQL',
  () => {
    let database: Database;
    let cleanup: () => Promise<void>;
    let scene: AccessScene;

    beforeAll(async () => {
      ({ database, cleanup } = await createMigratedDatabase(postgres!));
      scene = await seedAccessScene(database);
    });
    afterAll(async () => {
      await cleanup();
    });

    const db = () => database.db;
    const newHolder = () => seedProfileHolder(database, scene, 'Ines Kovac');
    type Holder = Awaited<ReturnType<typeof newHolder>>;
    /** The person grants `fields` of a category to the production role. */
    const grant = (
      tx: Tx,
      who: Holder,
      category: 'accessibility' | 'medical',
      fields: string[] = [FIELD[category]],
    ) =>
      createAccessGrant(tx, ctxFor(who.userId), {
        projectId: scene.projectId,
        personId: who.personId,
        category,
        roleId: scene.roles.production,
        fields,
      });
    const grantsOf = async (personId: string) =>
      (await db().select().from(accessGrant)).filter(
        (row) => row.personId === personId,
      );
    const liveGrantsOf = async (personId: string) =>
      (await grantsOf(personId)).filter((row) => row.revokedAt === null);

    it('makes a grant that replaces another wait for the account row while it holds nothing on the earlier grant, so it cannot deadlock with a deletion', async () => {
      const ines = await newHolder();
      // The earlier grant, committed, which the next one replaces.
      await grant(db(), ines, 'accessibility');

      const outcomes = await interleave(
        db(),
        // The deletion has the user row and is on its way to the grants.
        (tx) => lockUser(tx, ines.userId, { strength: 'update' }),
        (tx) => grant(tx, ines, 'accessibility', ['quietSpace']),
        // While the grant waits: the earlier grant's row must be free. `nowait` fails at
        // once when the grant already holds it, which is the order that deadlocks.
        async () => {
          await db().transaction((probe) =>
            probe.execute(
              sql`select id from access_grant where person_id = ${ines.personId} for update nowait`,
            ),
          );
        },
      );

      expect(outcomes[0].status).toBe('fulfilled');
      // The account was not deleted, so the grant went ahead once the row was free.
      expect(resultOf(outcomes[1])).toMatchObject({ replaced: true });
    });

    it.each(['accessibility', 'medical'] as const)(
      'makes a %s grant that meets a deletion in progress wait for it, refuse the account and leave no grant behind',
      async (category) => {
        const ines = await newHolder();

        const outcomes = await interleave(
          db(),
          (tx) => simulateAccountDeletion(tx, ines.userId),
          (tx) => grant(tx, ines, category),
        );

        expect(outcomes[0].status).toBe('fulfilled');
        expect(resultOf(outcomes[1])).toBeInstanceOf(AccountDeletedError);
        expect(await grantsOf(ines.personId)).toEqual([]);
      },
    );

    it.each(['accessibility', 'medical'] as const)(
      'makes a deletion wait for a %s grant that has started, and then end it',
      async (category) => {
        const ines = await newHolder();

        const outcomes = await interleave(
          db(),
          (tx) => grant(tx, ines, category),
          (tx) => simulateAccountDeletion(tx, ines.userId),
        );

        expect(resultOf(outcomes[0])).toMatchObject({ category });
        expect(outcomes[1].status).toBe('fulfilled');
        // The deletion ran once the grant had committed, so it saw what the grant made.
        expect(await grantsOf(ines.personId)).toHaveLength(1);
        expect(await liveGrantsOf(ines.personId)).toEqual([]);
      },
    );

    it('leaves no live grant however the grant and the deletion interleave, and neither is ended by a deadlock', async () => {
      for (let round = 0; round < 8; round += 1) {
        const ines = await newHolder();
        // An earlier grant for the new one to replace: the order that deadlocked.
        await grant(db(), ines, 'accessibility');

        const outcomes = await Promise.allSettled([
          db().transaction((tx) =>
            grant(tx, ines, 'accessibility', ['quietSpace']),
          ),
          db().transaction((tx) => simulateAccountDeletion(tx, ines.userId)),
        ]);

        // The deletion always finishes. The grant either came first, and the deletion ended
        // it, or met the deletion and was refused: nothing else, so no deadlock error.
        expect(outcomes[1].status, `round ${round}`).toBe('fulfilled');
        expect(
          outcomes[0].status === 'fulfilled' ||
            resultOf(outcomes[0]) instanceof AccountDeletedError,
          `round ${round}`,
        ).toBe(true);
        expect(await liveGrantsOf(ines.personId), `round ${round}`).toEqual([]);
      }
    });
  },
);
