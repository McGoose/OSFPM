import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { accessGrant } from '../db/schema/index.js';
import {
  createMigratedDatabase,
  interleave,
  testTargets,
} from '../db/test-support.js';
import type { Tx } from '../db/write.js';
import { createAccessGrant, revokeAccessGrant } from './access-grants.js';
import { AccessGrantBusyError } from './errors.js';
import { ctxFor, seedAccessScene, type AccessScene } from './test-support.js';

/** The PostgreSQL target, when `DATABASE_URL` names a server. PGlite has one connection, so it cannot run this. */
const postgres = testTargets.find((target) => target.name === 'postgres');

/** Why a call was refused, or undefined when it went through. */
const reasonOf = (outcome: PromiseSettledResult<unknown>): unknown =>
  outcome.status === 'rejected' ? outcome.reason : undefined;

/**
 * Changes to one access grant racing each other (decision D-69; CLAUDE.md, Data rules). A
 * role has one live grant: a change locks the live grant of the role `FOR UPDATE` before it
 * revokes it, the partial unique index is the backstop, and a change that still loses to the
 * index is `AccessGrantBusyError` and writes nothing. Each ordered case holds one
 * transaction open after its work while the other starts, and waits until the second is
 * blocked on a lock (`interleave`), so the two really overlap and the order is the one the
 * test names. They need two real sessions, so they run on PostgreSQL and are skipped on PGlite.
 */
describe.skipIf(postgres === undefined)(
  'changes to one access grant racing, on PostgreSQL',
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
    afterEach(async () => {
      await database.db.delete(accessGrant);
    });

    const db = () => database.db;
    const person = () => ctxFor(scene.people.holder.userId);
    const key = () => ({
      projectId: scene.projectId,
      personId: scene.people.holder.personId,
      category: 'accessibility' as const,
      roleId: scene.roles.production,
    });
    /** The person makes, or replaces, the grant of the production role with `fields`. */
    const make = (tx: Tx, fields: string[]) =>
      createAccessGrant(tx, person(), { ...key(), fields });
    const revoke = (tx: Tx) => revokeAccessGrant(tx, person(), key());
    const live = async () =>
      (await db().select().from(accessGrant)).filter(
        (row) => row.revokedAt === null,
      );

    it('leave one live grant when two are made at the same moment, and the one that lost says it was busy', async () => {
      for (let round = 0; round < 8; round += 1) {
        const outcomes = await Promise.allSettled([
          db().transaction((tx) => make(tx, ['stepFreeRequired'])),
          db().transaction((tx) => make(tx, ['quietSpace'])),
        ]);
        expect(await live(), `round ${round}`).toHaveLength(1);
        expect(
          outcomes.some((outcome) => outcome.status === 'fulfilled'),
          `round ${round}`,
        ).toBe(true);
        // Never a deadlock or another failure of the database: only the refusal of the index.
        for (const outcome of outcomes) {
          if (outcome.status === 'rejected') {
            expect(outcome.reason, `round ${round}`).toBeInstanceOf(
              AccessGrantBusyError,
            );
          }
        }
        await db().delete(accessGrant);
      }
    });

    it('make the second wait for the first when no grant exists yet, and fail it as busy, writing nothing', async () => {
      const outcomes = await interleave(
        db(),
        (tx) => make(tx, ['stepFreeRequired']),
        (tx) => make(tx, ['quietSpace']),
      );
      expect(outcomes[0].status).toBe('fulfilled');
      expect(reasonOf(outcomes[1])).toBeInstanceOf(AccessGrantBusyError);
      const rows = await live();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.fields).toEqual(['stepFreeRequired']);
    });

    it('make the second wait for the first that replaces a live grant, and fail it as busy: one live grant, the first one’s', async () => {
      await make(db(), ['maxWalkMetres']);
      const outcomes = await interleave(
        db(),
        (tx) => make(tx, ['stepFreeRequired']),
        (tx) => make(tx, ['quietSpace']),
      );
      expect(outcomes[0].status).toBe('fulfilled');
      expect(reasonOf(outcomes[1])).toBeInstanceOf(AccessGrantBusyError);
      const rows = await live();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.fields).toEqual(['stepFreeRequired']);
      // The first grant and the one that replaced it, and nothing made by the loser.
      expect(await db().select().from(accessGrant)).toHaveLength(2);
    });

    it('end a grant that is being replaced when a revoke is waiting for it: the revoke finds the new one and ends it, and is not told it was gone', async () => {
      await make(db(), ['maxWalkMetres']);
      const outcomes = await interleave(
        db(),
        (tx) => make(tx, ['stepFreeRequired']),
        (tx) => revoke(tx),
      );
      expect(outcomes[0].status).toBe('fulfilled');
      expect(outcomes[1].status).toBe('fulfilled');
      expect(await live()).toEqual([]);
    });

    it('let a grant be made while a revoke of the earlier one is open, and make it once the revoke is done', async () => {
      await make(db(), ['maxWalkMetres']);
      const outcomes = await interleave(
        db(),
        (tx) => revoke(tx),
        (tx) => make(tx, ['quietSpace']),
      );
      expect(outcomes[0].status).toBe('fulfilled');
      expect(outcomes[1].status).toBe('fulfilled');
      const rows = await live();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.fields).toEqual(['quietSpace']);
    });
  },
);
