import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedUser } from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import {
  accessReset,
  auditEvent,
  passwordCredential,
} from '../db/schema/index.js';
import { RecordStateError, type Tx } from '../db/write.js';
import {
  createMigratedDatabase,
  interleave,
  lockWaiters,
  succeeded,
  testTargets,
} from '../db/test-support.js';
import { ResetLinkBusyError } from './access-reset-errors.js';
import {
  createAccessReset,
  createSystemAccessReset,
  useAccessReset,
  type SystemAccessResetResult,
} from './access-reset.js';
import { AUTH_AUDIT, lockUser } from './shared.js';
import {
  seedMembership,
  seedPassword,
  seedResetScene,
  type ResetScene,
} from './test-support.js';

const T0 = new Date('2026-03-02T09:00:00.000Z');
const MINUTE = 60 * 1000;
const at = (ms: number) => new Date(T0.getTime() + ms);

/** The PostgreSQL target, when `DATABASE_URL` names a server. PGlite has one connection, so it cannot run this. */
const postgres = testTargets.find((target) => target.name === 'postgres');

/**
 * Reset links that the system issues, racing (P-09a2, decision D-81, E1): the
 * emergency access link must take the same locks in the same order as a link an
 * administrator makes, because it is the same code (`makeLink`). The cases of
 * `access-reset-race.test.ts` for making a link, once more with the system as the
 * maker: two links made for one person queue on the person's row, a link made while a
 * use holds the person's earlier one waits for nothing and ends as a typed busy
 * error, and a link is made once a use has finished. Each case holds one transaction
 * open after its work while the other starts, and waits until the second is blocked
 * on a lock (`interleave`). They need two real sessions, so they run on PostgreSQL and
 * are skipped on PGlite.
 */
describe.skipIf(postgres === undefined)(
  'reset links the system issues, racing, on PostgreSQL',
  () => {
    let database: Database;
    let cleanup: () => Promise<void>;
    let scene: ResetScene;
    let clock = 10;

    beforeAll(async () => {
      ({ database, cleanup } = await createMigratedDatabase(postgres!));
      scene = await seedResetScene(database, T0);
    });
    afterAll(async () => {
      await cleanup();
    });

    const db = () => database.db;

    /** An administrator with a password, which a use clears: the mark that it ran. */
    const makeAdministrator = async () => {
      const userId = await seedUser(database);
      await seedMembership(database, scene.organisationId, userId, 'admin', [
        scene.roles.administrator,
      ]);
      await seedPassword(database, userId, 'meadow-lantern-slow-river', {
        now: T0,
      });
      return userId;
    };
    const later = (minutes: number) => at((clock + minutes) * MINUTE);
    /** A link the system makes, `minutes` after the last one, in the caller's transaction. */
    const createSystem = (tx: Tx, userId: string, minutes: number) =>
      createSystemAccessReset(
        tx,
        scene.organisationId,
        userId,
        {},
        later(minutes),
      );
    /** A link the system makes, which must have been made. */
    const issued = async (userId: string) => {
      clock += 1;
      const made = await createSystemAccessReset(
        db(),
        scene.organisationId,
        userId,
        {},
        at(clock * MINUTE),
      );
      if (!made.ok) throw new Error(`refused: ${made.reason}`);
      return made;
    };
    const madeBy = (outcome: PromiseSettledResult<unknown>) =>
      (outcome as PromiseFulfilledResult<SystemAccessResetResult>).value;

    const linkRow = async (id: string) =>
      (await db().select().from(accessReset).where(eq(accessReset.id, id)))[0]!;
    const linksOf = async (userId: string) =>
      (await db().select().from(accessReset)).filter(
        (found) => found.userId === userId,
      );
    const liveLinksOf = async (userId: string) =>
      (await linksOf(userId)).filter(
        (found) => found.usedAt === null && found.revokedAt === null,
      );
    const hasPassword = async (userId: string) =>
      (await db().select().from(passwordCredential)).some(
        (found) => found.userId === userId,
      );
    const revokedEvents = async (linkId: string) =>
      (await db().select().from(auditEvent)).filter(
        (event) =>
          event.category === AUTH_AUDIT.accessResetRevoked &&
          event.targetId === linkId,
      );

    it('makes both, and leaves the later one the only live link, when a system create holds the person and another arrives', async () => {
      const person = await makeAdministrator();
      const outcomes = await interleave(
        db(),
        (tx) => createSystem(tx, person, 1),
        (tx) => createSystem(tx, person, 2),
      );
      // The second waited for the person's row and then replaced the first; without
      // the lock it would have run alongside, met the first on the unique index and failed.
      expect(outcomes[0].status).toBe('fulfilled');
      expect(outcomes[1].status).toBe('fulfilled');
      const first = madeBy(outcomes[0]);
      const second = madeBy(outcomes[1]);
      if (!first.ok || !second.ok) throw new Error('refused');
      expect((await liveLinksOf(person)).map((found) => found.id)).toEqual([
        second.reset.id,
      ]);
      expect(await linkRow(first.reset.id)).toMatchObject({
        revokedBySystem: true,
        revokedBy: null,
        usedAt: null,
      });
      expect(await revokedEvents(first.reset.id)).toHaveLength(1);
      expect(await revokedEvents(second.reset.id)).toHaveLength(0);
    });

    it('makes every link and leaves exactly one live, when many system creates for one person start together', async () => {
      const person = await makeAdministrator();
      const outcomes = await Promise.allSettled(
        Array.from({ length: 6 }, () =>
          db().transaction((tx) => createSystem(tx, person, 3)),
        ),
      );
      expect(
        outcomes.filter((outcome) => outcome.status === 'rejected'),
      ).toEqual([]);
      expect(succeeded(outcomes)).toBe(6);
      expect(await liveLinksOf(person)).toHaveLength(1);
      expect(await linksOf(person)).toHaveLength(6);
    });

    it('queues with a link an administrator makes for the same person: both are made, and the later one is the live one', async () => {
      const person = await makeAdministrator();
      const outcomes = await interleave(
        db(),
        (tx) => createSystem(tx, person, 1),
        (tx) =>
          createAccessReset(
            tx,
            { userId: scene.ownerId },
            scene.organisationId,
            person,
            {},
            later(2),
          ),
      );
      expect(outcomes[0].status).toBe('fulfilled');
      expect(outcomes[1].status).toBe('fulfilled');
      const first = madeBy(outcomes[0]);
      if (!first.ok) throw new Error('refused');
      // The system's link is revoked by the person's create, as a person's revocation.
      expect(await linkRow(first.reset.id)).toMatchObject({
        revokedBy: scene.ownerId,
        revokedBySystem: false,
      });
      expect(await liveLinksOf(person)).toHaveLength(1);
    });

    it('leaves the earlier link used and makes the new one, when a use holds the link and a system create arrives', async () => {
      const person = await makeAdministrator();
      const first = await issued(person);
      const outcomes = await interleave(
        db(),
        (tx) => useAccessReset(tx, first.token, later(1)),
        (tx) => createSystem(tx, person, 2),
      );
      expect(outcomes[0].status).toBe('fulfilled');
      expect(outcomes[1].status).toBe('fulfilled');
      const made = madeBy(outcomes[1]);
      if (!made.ok) throw new Error('refused');
      const earlier = await linkRow(first.reset.id);
      expect(earlier.usedAt).not.toBeNull();
      expect(earlier.revokedAt).toBeNull();
      expect(await hasPassword(person)).toBe(false);
      expect((await liveLinksOf(person)).map((found) => found.id)).toEqual([
        made.reset.id,
      ]);
    });

    it('revokes the earlier link as the system and refuses the use, when a system create holds the link and a use arrives', async () => {
      const person = await makeAdministrator();
      const first = await issued(person);
      const outcomes = await interleave(
        db(),
        (tx) => createSystem(tx, person, 1),
        (tx) => useAccessReset(tx, first.token, later(2)),
      );
      expect(outcomes[0].status).toBe('fulfilled');
      expect((outcomes[1] as PromiseRejectedResult).reason).toMatchObject({
        name: 'AccessResetInvalidError',
        reason: 'revoked',
      });
      expect(await linkRow(first.reset.id)).toMatchObject({
        revokedBySystem: true,
      });
      expect(await hasPassword(person)).toBe(true);
    });

    it('does not wait for a link a use holds while it holds the person: the answer is ResetLinkBusyError, nothing is written, and the use goes on', async () => {
      // The case a wait would turn into a deadlock: the use holds the link and waits
      // for the person's row, and the create, which holds that row, then meets the link.
      const person = await makeAdministrator();
      const first = await issued(person);
      let holding!: () => void;
      const holdingPromise = new Promise<void>((resolve) => {
        holding = resolve;
      });
      let useWaits!: () => void;
      const useWaitsPromise = new Promise<void>((resolve) => {
        useWaits = resolve;
      });
      const creating = db().transaction(async (tx) => {
        await lockUser(tx, person, { strength: 'update' });
        holding();
        await useWaitsPromise;
        return createSystem(tx, person, 2);
      });
      await Promise.race([holdingPromise, creating]);
      const using = db().transaction((tx) =>
        useAccessReset(tx, first.token, later(2)),
      );
      using.catch(() => undefined);
      for (let waited = 0; (await lockWaiters(db())) === 0; waited += 25) {
        if (waited >= 10_000) {
          throw new Error('The use never waited for the person’s row');
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      useWaits();
      const outcomes = await Promise.allSettled([creating, using]);
      expect(outcomes[0]).toMatchObject({ status: 'rejected' });
      const busy: unknown = (outcomes[0] as PromiseRejectedResult).reason;
      expect(busy).toBeInstanceOf(ResetLinkBusyError);
      expect(busy).toBeInstanceOf(RecordStateError);
      expect(outcomes[1].status).toBe('fulfilled');
      expect((await linkRow(first.reset.id)).usedAt).not.toBeNull();
      expect(await linksOf(person)).toHaveLength(1);
    });
  },
);
