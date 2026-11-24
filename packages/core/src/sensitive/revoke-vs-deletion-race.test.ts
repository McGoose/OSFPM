import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lockUser } from '../auth/shared.js';
import type { Database } from '../db/client.js';
import { accessGrant, auditEvent } from '../db/schema/index.js';
import {
  createMigratedDatabase,
  interleave,
  testTargets,
} from '../db/test-support.js';
import { RecordNotFoundError, type Tx } from '../db/write.js';
import { createAccessGrant, revokeAccessGrant } from './access-grants.js';
import {
  ctxFor,
  NOW,
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
 * Revoking a grant racing the deletion of the account it belongs to (decision D-69; CLAUDE.md,
 * Data rules). The deletion takes the user row `FOR UPDATE` and then ends every grant of the
 * account, locking the grant rows. A revoke that took the grant row first and reached the user
 * row later, through the key-share lock that its `revoked_by` takes, could wait for the
 * deletion's user row while the deletion waited for its grant row, and one of them would be
 * ended by a deadlock. `revokeAccessGrant` therefore takes the user row `FOR KEY SHARE`
 * first, so both go user row first and queue on it. Each case holds one transaction open after
 * its work while the other starts, and waits until the second is blocked on a lock
 * (`interleave`), so the two really overlap and the order is the one the test names. They need
 * two real sessions, so they run on PostgreSQL and are skipped on PGlite.
 */
describe.skipIf(postgres === undefined)(
  'revoking a grant racing the deletion of the account, on PostgreSQL',
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
    const key = (who: Holder, category: 'accessibility' | 'medical') => ({
      projectId: scene.projectId,
      personId: who.personId,
      category,
      roleId: scene.roles.production,
    });
    /** The person grants a field of a category to the production role. */
    const makeGrant = (who: Holder, category: 'accessibility' | 'medical') =>
      createAccessGrant(db(), ctxFor(who.userId), {
        ...key(who, category),
        fields: [FIELD[category]],
      });
    /** The person revokes it. */
    const revoke = (
      tx: Tx,
      who: Holder,
      category: 'accessibility' | 'medical',
    ) => revokeAccessGrant(tx, ctxFor(who.userId), key(who, category));
    const grantsOf = async (personId: string) =>
      (await db().select().from(accessGrant)).filter(
        (row) => row.personId === personId,
      );
    const liveGrantsOf = async (personId: string) =>
      (await grantsOf(personId)).filter((row) => row.revokedAt === null);
    const endEvent = async (userId: string) =>
      (await db().select().from(auditEvent)).find(
        (event) =>
          event.targetId === userId &&
          event.category === 'access.account-sharing-ended',
      );

    it('makes a revoke wait for the account row while it holds nothing on the grant, so it cannot deadlock with a deletion', async () => {
      const ines = await newHolder();
      await makeGrant(ines, 'accessibility');

      const outcomes = await interleave(
        db(),
        // The deletion has the user row and is on its way to the grants.
        (tx) => lockUser(tx, ines.userId, { strength: 'update' }),
        (tx) => revoke(tx, ines, 'accessibility'),
        // While the revoke waits: the grant's row must be free. `nowait` fails at once
        // when the revoke already holds it, which is the order that deadlocks.
        async () => {
          await db().transaction((probe) =>
            probe.execute(
              sql`select id from access_grant where person_id = ${ines.personId} for update nowait`,
            ),
          );
        },
      );

      expect(outcomes[0].status).toBe('fulfilled');
      // The account was not deleted, so the revoke went ahead once the row was free.
      expect(outcomes[1].status).toBe('fulfilled');
      expect(await grantsOf(ines.personId)).toMatchObject([
        { revokedAt: NOW, revokedBy: ines.userId, version: 2 },
      ]);
    });

    it.each(['accessibility', 'medical'] as const)(
      'answers a %s revoke that meets a deletion in progress as one of a grant that is already gone',
      async (category) => {
        const ines = await newHolder();
        await makeGrant(ines, category);

        const outcomes = await interleave(
          db(),
          (tx) => simulateAccountDeletion(tx, ines.userId),
          (tx) => revoke(tx, ines, category),
        );

        expect(outcomes[0].status).toBe('fulfilled');
        expect(resultOf(outcomes[1])).toBeInstanceOf(RecordNotFoundError);
        // The deletion ended it, once.
        expect(await grantsOf(ines.personId)).toMatchObject([
          { revokedAt: NOW, version: 2 },
        ]);
        expect(await liveGrantsOf(ines.personId)).toEqual([]);
      },
    );

    it.each(['accessibility', 'medical'] as const)(
      'makes a deletion wait for a %s revoke that has started, and then find nothing live to end',
      async (category) => {
        const ines = await newHolder();
        await makeGrant(ines, category);

        const outcomes = await interleave(
          db(),
          (tx) => revoke(tx, ines, category),
          (tx) => simulateAccountDeletion(tx, ines.userId),
        );

        expect(outcomes[0].status).toBe('fulfilled');
        expect(outcomes[1].status).toBe('fulfilled');
        // The revoke ended it, once; the deletion ran after it and found none live.
        expect(await grantsOf(ines.personId)).toMatchObject([
          { revokedAt: NOW, version: 2 },
        ]);
        expect((await endEvent(ines.userId))?.details).toMatchObject({
          accessibilityGrants: 0,
          medicalGrants: 0,
        });
      },
    );

    it('leaves no live grant however the revoke and the deletion interleave, and neither is ended by a deadlock', async () => {
      for (let round = 0; round < 8; round += 1) {
        const ines = await newHolder();
        await makeGrant(ines, 'accessibility');

        const outcomes = await Promise.allSettled([
          db().transaction((tx) => revoke(tx, ines, 'accessibility')),
          db().transaction((tx) => simulateAccountDeletion(tx, ines.userId)),
        ]);

        // The deletion always finishes. The revoke either came first, or found the grant
        // already ended by the deletion: nothing else, so no deadlock error.
        expect(outcomes[1].status, `round ${round}`).toBe('fulfilled');
        expect(
          outcomes[0].status === 'fulfilled' ||
            resultOf(outcomes[0]) instanceof RecordNotFoundError,
          `round ${round}`,
        ).toBe(true);
        expect(await liveGrantsOf(ines.personId), `round ${round}`).toEqual([]);
      }
    });
  },
);
