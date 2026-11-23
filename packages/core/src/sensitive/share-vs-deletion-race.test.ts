import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { base } from '../access/test-fixtures.js';
import { lockUser } from '../auth/shared.js';
import type { Database } from '../db/client.js';
import { accessGrant, settingValue } from '../db/schema/index.js';
import {
  createMigratedDatabase,
  interleave,
  testTargets,
} from '../db/test-support.js';
import type { Tx } from '../db/write.js';
import { shareWithSuggestedRoles } from './access-grants.js';
import { VALID_PAYLOADS } from './payload-fixtures.js';
import { writeSensitive } from './service.js';
import { ACCESS_SUGGESTED_ROLES_SETTING } from './suggested-roles.js';
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

/**
 * A share with the usual roles racing the deletion of the account it is for (decision D-69;
 * CLAUDE.md, Data rules). The deletion takes the user row `FOR UPDATE`, then the person's
 * access profile row; the grants a share inserts take the user row's key-share lock through
 * `granted_by`. So a share that took the profile first and the user row later could wait for
 * the deletion's user row while the deletion waited for its profile row, and one of them
 * would be ended by a deadlock. The share therefore takes the user row `FOR KEY SHARE`
 * first, so both go user row first and queue on it. Each case holds one transaction open
 * after its work while the other starts, and waits until the second is blocked on a lock
 * (`interleave`), so the two really overlap and the order is the one the test names. They
 * need two real sessions, so they run on PostgreSQL and are skipped on PGlite.
 */
describe.skipIf(postgres === undefined)(
  'sharing with the usual roles racing the deletion of the account, on PostgreSQL',
  () => {
    let database: Database;
    let cleanup: () => Promise<void>;
    let scene: AccessScene;

    beforeAll(async () => {
      ({ database, cleanup } = await createMigratedDatabase(postgres!));
      scene = await seedAccessScene(database);
      // The organisation usually shares both categories with the production role.
      await database.db.insert(settingValue).values({
        ...base(scene.organisationId),
        layer: 'org',
        projectId: null,
        key: ACCESS_SUGGESTED_ROLES_SETTING,
        value: {
          physical: [scene.roles.production],
          medical: [scene.roles.production],
        },
      });
    });
    afterAll(async () => {
      await cleanup();
    });

    const db = () => database.db;
    const newHolder = async () => {
      const holder = await seedProfileHolder(database, scene, 'Ines Kovac');
      await writeSensitive(
        db(),
        ctxFor(holder.userId),
        holder.personId,
        'medical',
        VALID_PAYLOADS.medical,
        { legalBasis: 'consent' },
      );
      return holder;
    };
    type Holder = Awaited<ReturnType<typeof newHolder>>;
    const share = (
      tx: Tx,
      who: Holder,
      category: 'accessibility' | 'medical' = 'accessibility',
    ) =>
      shareWithSuggestedRoles(
        tx,
        ctxFor(who.userId),
        scene.projectId,
        who.personId,
        category,
      );
    const grantsOf = async (personId: string) =>
      (await db().select().from(accessGrant)).filter(
        (row) => row.personId === personId,
      );

    it('makes a share wait for the account row while it holds nothing on the profile, so it cannot deadlock with a deletion', async () => {
      const ines = await newHolder();
      // The deletion has the user row and is on its way to the profile row.
      const outcomes = await interleave(
        db(),
        (tx) => lockUser(tx, ines.userId, { strength: 'update' }),
        (tx) => share(tx, ines),
        // While the share waits: the profile row must be free. `nowait` fails at once when
        // the share already holds it, which is the order that deadlocks.
        async () => {
          await db().transaction((probe) =>
            probe.execute(
              sql`select id from user_access_profile where user_id = ${ines.userId} for update nowait`,
            ),
          );
        },
      );

      expect(outcomes[0].status).toBe('fulfilled');
      // The account was not deleted, so the share went ahead once the row was free.
      expect(resultOf(outcomes[1])).toMatchObject({
        preview: false,
        granted: 1,
      });
    });

    it.each(['accessibility', 'medical'] as const)(
      'makes a %s share that meets a deletion in progress wait for it, share nothing and leave no grant behind',
      async (category) => {
        const ines = await newHolder();

        const outcomes = await interleave(
          db(),
          (tx) => simulateAccountDeletion(tx, ines.userId),
          (tx) => share(tx, ines, category),
        );

        expect(outcomes[0].status).toBe('fulfilled');
        expect(resultOf(outcomes[1])).toEqual({
          preview: false,
          shares: [],
          granted: 0,
        });
        expect(await grantsOf(ines.personId)).toEqual([]);
      },
    );

    it.each(['accessibility', 'medical'] as const)(
      'makes a deletion wait for a %s share that has started, and then end the grants that share made',
      async (category) => {
        const ines = await newHolder();

        const outcomes = await interleave(
          db(),
          (tx) => share(tx, ines, category),
          (tx) => simulateAccountDeletion(tx, ines.userId),
        );

        expect(resultOf(outcomes[0])).toMatchObject({
          preview: false,
          granted: 1,
        });
        expect(outcomes[1].status).toBe('fulfilled');
        // The deletion ran once the share had committed, so it saw what the share made.
        const rows = await grantsOf(ines.personId);
        expect(rows).toHaveLength(1);
        expect(rows.filter((row) => row.revokedAt === null)).toEqual([]);
      },
    );
  },
);
