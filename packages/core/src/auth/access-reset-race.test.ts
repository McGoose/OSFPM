import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORIGIN, seedUser } from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import {
  accessReset,
  auditEvent,
  orgMembership,
  passwordCredential,
  user,
} from '../db/schema/index.js';
import { RecordNotFoundError, type Tx } from '../db/write.js';
import {
  createMigratedDatabase,
  interleave,
  lockWaiters,
  succeeded,
  testTargets,
} from '../db/test-support.js';
import {
  AccessResetInvalidError,
  UserInOtherOrganisationsError,
  UserNotActiveError,
} from './access-reset-errors.js';
import {
  createAccessReset,
  revokeAccessReset,
  useAccessReset,
} from './access-reset.js';
import { acceptInvite, createInvite } from './invites.js';
import { AUTH_AUDIT, lockUser } from './shared.js';
import {
  seedMembership,
  seedOrganisationRole,
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
 * Reset links racing: two uses of one token, a use and a revoke of one link, a use
 * of a link against the same person accepting an invite into a second
 * organisation, and the making of a link against each of those and against another
 * making of a link for the same person. Each case holds one transaction open after its work while the
 * other starts, and the call waits until the second is blocked on a lock
 * (`interleave`), so the two really overlap and the order is the one the test
 * names. They need two real sessions, so they run on PostgreSQL and are skipped on
 * PGlite.
 *
 * What they pin: a link is used once however many uses run at once; it ends used
 * or revoked, never both; and a link is never used for a person who already
 * belongs to two organisations, and a person never has two links that are neither
 * used nor revoked. The reset row lock decides a use against a revoke and against
 * another use; the user row lock, `FOR UPDATE` and taken last (CLAUDE.md, Data
 * rules), decides a use against an accept that gives the person a second
 * membership: one finishes before the other starts, or the use is refused. The same
 * lock makes two links made for one person queue, and keeps a link from being made
 * for a person who has just changed; a create never waits for a link row while it
 * holds the person's row, which a use would turn into a deadlock.
 */
describe.skipIf(postgres === undefined)(
  'admin reset links racing, on PostgreSQL',
  () => {
    let database: Database;
    let cleanup: () => Promise<void>;
    let scene: ResetScene;
    /** Holds `members:invite` in the other organisation. */
    let inviterId: string;
    let clock = 10;

    beforeAll(async () => {
      ({ database, cleanup } = await createMigratedDatabase(postgres!));
      scene = await seedResetScene(database, T0);
      inviterId = await seedUser(database);
      await seedMembership(
        database,
        scene.otherOrganisationId,
        inviterId,
        'member',
        [
          await seedOrganisationRole(
            database,
            scene.otherOrganisationId,
            'inviter',
            [['members:invite', 'own-scope']],
          ),
        ],
      );
    });
    afterAll(async () => {
      await cleanup();
    });

    const db = () => database.db;

    /** A member with a password, which a use clears: the mark that it ran. */
    const makePerson = async () => {
      const userId = await seedUser(database);
      await seedMembership(database, scene.organisationId, userId, 'member', [
        scene.roles.crew,
      ]);
      await seedPassword(database, userId, 'meadow-lantern-slow-river', {
        now: T0,
      });
      return userId;
    };
    const makeLink = async (userId: string) =>
      createAccessReset(
        db(),
        { userId: scene.ownerId },
        scene.organisationId,
        userId,
        {},
        at((clock += 1) * MINUTE),
      );
    /** An invite into the other organisation, which gives nothing but a membership. */
    const makeInvite = async () =>
      createInvite(
        db(),
        { userId: inviterId },
        scene.otherOrganisationId,
        { tier: 'member', roleIds: [] },
        at((clock += 1) * MINUTE),
      );

    const linkRow = async (id: string) =>
      (await db().select().from(accessReset).where(eq(accessReset.id, id)))[0]!;
    const hasPassword = async (userId: string) =>
      (await db().select().from(passwordCredential)).some(
        (found) => found.userId === userId,
      );
    const membershipsOf = async (userId: string) =>
      (await db().select().from(orgMembership)).filter(
        (found) => found.userId === userId,
      );
    const linksOf = async (userId: string) =>
      (await db().select().from(accessReset)).filter(
        (found) => found.userId === userId,
      );
    const liveLinksOf = async (userId: string) =>
      (await linksOf(userId)).filter(
        (found) => found.usedAt === null && found.revokedAt === null,
      );
    const revokedEvents = async (linkId: string) =>
      (await db().select().from(auditEvent)).filter(
        (event) =>
          event.category === AUTH_AUDIT.accessResetRevoked &&
          event.targetId === linkId,
      );
    /** What `createAccessReset` returns. */
    type Made = Awaited<ReturnType<typeof createAccessReset>>;
    const madeBy = (outcome: PromiseSettledResult<unknown>) =>
      (outcome as PromiseFulfilledResult<Made>).value;
    /** A link made by the owner, `minutes` after the last one, in the caller's transaction. */
    const create = (tx: Tx, userId: string, minutes: number) =>
      createAccessReset(
        tx,
        { userId: scene.ownerId },
        scene.organisationId,
        userId,
        {},
        later(minutes),
      );
    const usedEvents = async (linkId: string) =>
      (await db().select().from(auditEvent)).filter(
        (event) =>
          event.category === AUTH_AUDIT.accessResetUsed &&
          event.targetId === linkId,
      );

    /** The time of a use: after the link was made. */
    const later = (minutes: number) => at((clock + minutes) * MINUTE);

    describe('two uses of one token', () => {
      it('is used once when two uses overlap, and the second gets the invalid answer', async () => {
        const person = await makePerson();
        const made = await makeLink(person);
        const outcomes = await interleave(
          db(),
          (tx) => useAccessReset(tx, made.token, later(1)),
          (tx) => useAccessReset(tx, made.token, later(1)),
        );
        expect(succeeded(outcomes)).toBe(1);
        expect(outcomes[0].status).toBe('fulfilled');
        expect(outcomes[1]).toMatchObject({ status: 'rejected' });
        expect((outcomes[1] as PromiseRejectedResult).reason).toBeInstanceOf(
          AccessResetInvalidError,
        );
        expect((outcomes[1] as PromiseRejectedResult).reason).toMatchObject({
          reason: 'used',
        });
        const row = await linkRow(made.reset.id);
        expect(row.usedAt).not.toBeNull();
        expect(row.revokedAt).toBeNull();
        expect(await hasPassword(person)).toBe(false);
        expect(await usedEvents(made.reset.id)).toHaveLength(1);
      });

      it('is used once when many uses of one token start together', async () => {
        const person = await makePerson();
        const made = await makeLink(person);
        const outcomes = await Promise.allSettled(
          Array.from({ length: 6 }, () =>
            db().transaction((tx) => useAccessReset(tx, made.token, later(2))),
          ),
        );
        expect(succeeded(outcomes)).toBe(1);
        for (const outcome of outcomes) {
          if (outcome.status === 'rejected') {
            expect(outcome.reason).toBeInstanceOf(AccessResetInvalidError);
          }
        }
        expect((await linkRow(made.reset.id)).usedAt).not.toBeNull();
        expect(await usedEvents(made.reset.id)).toHaveLength(1);
        expect(await hasPassword(person)).toBe(false);
      });
    });

    describe('a use and a revoke', () => {
      it('ends revoked, with the person untouched, when a revoke holds the link and a use arrives', async () => {
        const person = await makePerson();
        const made = await makeLink(person);
        const outcomes = await interleave(
          db(),
          (tx) =>
            revokeAccessReset(
              tx,
              { userId: scene.adminId },
              scene.organisationId,
              person,
              later(1),
            ),
          (tx) => useAccessReset(tx, made.token, later(1)),
        );
        expect(outcomes[0].status).toBe('fulfilled');
        expect(outcomes[1]).toMatchObject({ status: 'rejected' });
        // A refusal, not a failure of the database: the row lock made the use
        // wait, and it found the link revoked.
        expect((outcomes[1] as PromiseRejectedResult).reason).toMatchObject({
          name: 'AccessResetInvalidError',
          reason: 'revoked',
        });
        const row = await linkRow(made.reset.id);
        expect(row.revokedAt).not.toBeNull();
        expect(row.usedAt).toBeNull();
        expect(await hasPassword(person)).toBe(true);
      });

      it('ends used, with the person cleared, when a use holds the link and a revoke arrives', async () => {
        const person = await makePerson();
        const made = await makeLink(person);
        const outcomes = await interleave(
          db(),
          (tx) => useAccessReset(tx, made.token, later(1)),
          (tx) =>
            revokeAccessReset(
              tx,
              { userId: scene.adminId },
              scene.organisationId,
              person,
              later(1),
            ),
        );
        expect(outcomes[0].status).toBe('fulfilled');
        expect(outcomes[1]).toMatchObject({ status: 'rejected' });
        expect((outcomes[1] as PromiseRejectedResult).reason).toBeInstanceOf(
          RecordNotFoundError,
        );
        const row = await linkRow(made.reset.id);
        expect(row.usedAt).not.toBeNull();
        expect(row.revokedAt).toBeNull();
        expect(await hasPassword(person)).toBe(false);
      });

      it('never leaves a link both used and revoked, and never a cleared person for a revoked link, however a use and a revoke are ordered', async () => {
        for (let round = 0; round < 6; round += 1) {
          const person = await makePerson();
          const made = await makeLink(person);
          const outcomes = await Promise.allSettled([
            db().transaction((tx) => useAccessReset(tx, made.token, later(3))),
            db().transaction((tx) =>
              revokeAccessReset(
                tx,
                { userId: scene.adminId },
                scene.organisationId,
                person,
                later(3),
              ),
            ),
          ]);
          const row = await linkRow(made.reset.id);
          // Exactly one of the two won.
          expect(row.usedAt === null, `round ${round}`).not.toBe(
            row.revokedAt === null,
          );
          expect(succeeded(outcomes), `round ${round}`).toBe(1);
          expect(await hasPassword(person), `round ${round}`).toBe(
            row.usedAt === null,
          );
        }
      });
    });

    describe('a use and an accept of an invite for the same person', () => {
      it('finishes the use first, and then gives the person the second membership, when a use holds the person and an accept arrives', async () => {
        const person = await makePerson();
        const made = await makeLink(person);
        const invited = await makeInvite();
        const outcomes = await interleave(
          db(),
          (tx) => useAccessReset(tx, made.token, later(1)),
          (tx) =>
            acceptInvite(
              tx,
              invited.token,
              { kind: 'signed-in', userId: person },
              later(2),
            ),
        );
        // The accept waited on the person's row, then went ahead: the link was
        // used while the person had one membership, and they joined after.
        expect(outcomes[0].status).toBe('fulfilled');
        expect(outcomes[1].status).toBe('fulfilled');
        expect((await linkRow(made.reset.id)).usedAt).not.toBeNull();
        expect(await hasPassword(person)).toBe(false);
        const memberships = await membershipsOf(person);
        expect(memberships.map((m) => m.organisationId).sort()).toEqual(
          [scene.organisationId, scene.otherOrganisationId].sort(),
        );
      });

      it('refuses the use, which sees the second membership, when an accept holds the person and a use arrives', async () => {
        const person = await makePerson();
        const made = await makeLink(person);
        const invited = await makeInvite();
        const outcomes = await interleave(
          db(),
          (tx) =>
            acceptInvite(
              tx,
              invited.token,
              { kind: 'signed-in', userId: person },
              later(1),
            ),
          (tx) => useAccessReset(tx, made.token, later(2)),
        );
        expect(outcomes[0].status).toBe('fulfilled');
        expect(outcomes[1]).toMatchObject({ status: 'rejected' });
        expect((outcomes[1] as PromiseRejectedResult).reason).toMatchObject({
          name: 'AccessResetInvalidError',
          reason: 'target-in-other-organisations',
        });
        // Not used, and nothing of the person's cleared.
        const row = await linkRow(made.reset.id);
        expect(row.usedAt).toBeNull();
        expect(row.revokedAt).toBeNull();
        expect(await hasPassword(person)).toBe(true);
        expect(await membershipsOf(person)).toHaveLength(2);
      });

      it('never uses a link for a person who already belonged to two organisations, however a use and an accept are ordered', async () => {
        for (let round = 0; round < 6; round += 1) {
          const person = await makePerson();
          const made = await makeLink(person);
          const invited = await makeInvite();
          const outcomes = await Promise.allSettled([
            db().transaction((tx) => useAccessReset(tx, made.token, later(4))),
            db().transaction((tx) =>
              acceptInvite(
                tx,
                invited.token,
                { kind: 'signed-in', userId: person },
                later(5),
              ),
            ),
          ]);
          // The accept always goes through: either it waited for the use, or it
          // went first and the use was refused.
          expect(outcomes[1].status, `round ${round}`).toBe('fulfilled');
          expect(await membershipsOf(person), `round ${round}`).toHaveLength(2);
          const row = await linkRow(made.reset.id);
          if (outcomes[0].status === 'fulfilled') {
            // Used: the person was cleared, and the link is spent.
            expect(row.usedAt, `round ${round}`).not.toBeNull();
            expect(await hasPassword(person), `round ${round}`).toBe(false);
          } else {
            // Refused: for the second membership, with the person untouched.
            expect(outcomes[0].reason, `round ${round}`).toMatchObject({
              name: 'AccessResetInvalidError',
              reason: 'target-in-other-organisations',
            });
            expect(row.usedAt, `round ${round}`).toBeNull();
            expect(await hasPassword(person), `round ${round}`).toBe(true);
          }
        }
      });
    });

    describe('two links made for one person', () => {
      it('makes both, and leaves the later one the only live link, when a create holds the person and another arrives', async () => {
        const person = await makePerson();
        const outcomes = await interleave(
          db(),
          (tx) => create(tx, person, 1),
          (tx) => create(tx, person, 2),
        );
        // The second waited for the person's row and then replaced the first. Without
        // the lock it would have run alongside, met the first on the unique index and failed.
        expect(outcomes[0].status).toBe('fulfilled');
        expect(outcomes[1], 'the second create').toMatchObject({
          status: 'fulfilled',
        });
        const first = madeBy(outcomes[0]);
        const second = madeBy(outcomes[1]);
        expect((await liveLinksOf(person)).map((found) => found.id)).toEqual([
          second.reset.id,
        ]);
        const earlier = await linkRow(first.reset.id);
        expect(earlier.revokedAt).not.toBeNull();
        expect(earlier.usedAt).toBeNull();
        expect(await revokedEvents(first.reset.id)).toHaveLength(1);
        expect(await revokedEvents(second.reset.id)).toHaveLength(0);
      });

      it('makes every link and leaves exactly one live, when many creates for one person start together', async () => {
        const person = await makePerson();
        const outcomes = await Promise.allSettled(
          Array.from({ length: 6 }, () =>
            db().transaction((tx) => create(tx, person, 3)),
          ),
        );
        // None of them collided on the unique index or deadlocked: they queued.
        expect(
          outcomes.filter((outcome) => outcome.status === 'rejected'),
        ).toEqual([]);
        expect(succeeded(outcomes)).toBe(6);
        expect(await liveLinksOf(person)).toHaveLength(1);
        const links = await linksOf(person);
        expect(links).toHaveLength(6);
        // Each link but the last was revoked once, by the one made after it.
        let revoked = 0;
        for (const found of links) {
          revoked += (await revokedEvents(found.id)).length;
        }
        expect(revoked).toBe(5);
      });
    });

    describe('a create and a use of the person’s earlier link', () => {
      it('leaves the earlier link used and makes the new one, when a use holds the link and a create arrives', async () => {
        const person = await makePerson();
        const first = await makeLink(person);
        const outcomes = await interleave(
          db(),
          (tx) => useAccessReset(tx, first.token, later(1)),
          (tx) => create(tx, person, 2),
        );
        expect(outcomes[0].status).toBe('fulfilled');
        expect(outcomes[1], 'the create').toMatchObject({
          status: 'fulfilled',
        });
        const earlier = await linkRow(first.reset.id);
        expect(earlier.usedAt).not.toBeNull();
        expect(earlier.revokedAt).toBeNull();
        expect(await hasPassword(person)).toBe(false);
        expect((await liveLinksOf(person)).map((found) => found.id)).toEqual([
          madeBy(outcomes[1]).reset.id,
        ]);
      });

      it('revokes the earlier link and refuses the use, when a create holds the link and a use arrives', async () => {
        const person = await makePerson();
        const first = await makeLink(person);
        const outcomes = await interleave(
          db(),
          (tx) => create(tx, person, 1),
          (tx) => useAccessReset(tx, first.token, later(2)),
        );
        expect(outcomes[0].status).toBe('fulfilled');
        expect(outcomes[1]).toMatchObject({ status: 'rejected' });
        expect((outcomes[1] as PromiseRejectedResult).reason).toMatchObject({
          name: 'AccessResetInvalidError',
          reason: 'revoked',
        });
        expect((await linkRow(first.reset.id)).revokedAt).not.toBeNull();
        expect(await hasPassword(person)).toBe(true);
        expect((await liveLinksOf(person)).map((found) => found.id)).toEqual([
          madeBy(outcomes[0]).reset.id,
        ]);
      });

      it('does not wait for a link a use holds while it holds the person: the index refuses the new link, nothing is written, and the use goes on', async () => {
        // The case a wait would turn into a deadlock: the use holds the link and
        // waits for the person's row, and the create, which holds that row, then
        // meets the link. The create takes the person's row first, as `createAccessReset`
        // does, and the test lets it go on only once the use is waiting for it.
        const person = await makePerson();
        const first = await makeLink(person);
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
          return create(tx, person, 2);
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
        // A wait for the link would have been a deadlock, which the database ends by
        // failing one of the two with 40P01 after a second.
        expect(outcomes[0]).toMatchObject({
          status: 'rejected',
          reason: {
            name: 'RecordWriteError',
            code: '23505',
            constraint: 'access_reset_live_unique',
          },
        });
        expect(outcomes[1].status).toBe('fulfilled');
        expect((await linkRow(first.reset.id)).usedAt).not.toBeNull();
        expect(await hasPassword(person)).toBe(false);
        expect(await linksOf(person)).toHaveLength(1);
      });
    });

    describe('a create and a revoke of the person’s earlier link', () => {
      it('makes the new link once the revoke has ended, when a revoke holds the link and a create arrives', async () => {
        const person = await makePerson();
        const first = await makeLink(person);
        const outcomes = await interleave(
          db(),
          (tx) =>
            revokeAccessReset(
              tx,
              { userId: scene.adminId },
              scene.organisationId,
              person,
              later(1),
            ),
          (tx) => create(tx, person, 2),
        );
        expect(outcomes[0].status).toBe('fulfilled');
        expect(outcomes[1], 'the create').toMatchObject({
          status: 'fulfilled',
        });
        // The create left the link to the revoke, and the index let the new link in
        // when the revoke was done: the earlier link ended as revoked, not superseded.
        const earlier = await linkRow(first.reset.id);
        expect(earlier.revokedBy).toBe(scene.adminId);
        const events = await revokedEvents(first.reset.id);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          details: { userId: person, reason: 'manual' },
        });
        expect((await liveLinksOf(person)).map((found) => found.id)).toEqual([
          madeBy(outcomes[1]).reset.id,
        ]);
      });
    });

    describe('a create and a change to the person', () => {
      const changes = {
        disabled: (tx: Tx, userId: string) =>
          tx
            .update(user)
            .set({ status: 'disabled' })
            .where(eq(user.id, userId)),
        deleted: (tx: Tx, userId: string) =>
          tx
            .update(user)
            .set({ deletedAt: later(1), deletedBy: scene.ownerId })
            .where(eq(user.id, userId)),
      } as const;

      it.each(['disabled', 'deleted'] as const)(
        'judges the rules again under the person’s row, and makes no link, when a writer holds the person who was %s and a create arrives',
        async (kind) => {
          const person = await makePerson();
          const outcomes = await interleave(
            db(),
            (tx) => changes[kind](tx, person),
            (tx) => create(tx, person, 2),
          );
          expect(outcomes[0].status).toBe('fulfilled');
          expect(outcomes[1]).toMatchObject({ status: 'rejected' });
          expect((outcomes[1] as PromiseRejectedResult).reason).toBeInstanceOf(
            UserNotActiveError,
          );
          expect(await linksOf(person)).toHaveLength(0);
        },
      );

      it('refuses the link, having seen the second membership under the person’s row, when an accept holds the person and a create arrives', async () => {
        const person = await makePerson();
        const invited = await makeInvite();
        const outcomes = await interleave(
          db(),
          (tx) =>
            acceptInvite(
              tx,
              invited.token,
              { kind: 'signed-in', userId: person },
              later(1),
            ),
          (tx) => create(tx, person, 2),
        );
        expect(outcomes[0].status).toBe('fulfilled');
        expect(outcomes[1]).toMatchObject({ status: 'rejected' });
        expect((outcomes[1] as PromiseRejectedResult).reason).toBeInstanceOf(
          UserInOtherOrganisationsError,
        );
        expect(await linksOf(person)).toHaveLength(0);
        expect(await membershipsOf(person)).toHaveLength(2);
      });

      it('makes the link, which a use then refuses, when a create holds the person and an accept arrives', async () => {
        const person = await makePerson();
        const invited = await makeInvite();
        const outcomes = await interleave(
          db(),
          (tx) => create(tx, person, 1),
          (tx) =>
            acceptInvite(
              tx,
              invited.token,
              { kind: 'signed-in', userId: person },
              later(2),
            ),
        );
        expect(outcomes[0].status).toBe('fulfilled');
        expect(outcomes[1].status).toBe('fulfilled');
        expect(await membershipsOf(person)).toHaveLength(2);
        // Made while the person belonged to one organisation: refused when used,
        // since they belong to two now, and nothing of theirs is cleared.
        await expect(
          useAccessReset(db(), madeBy(outcomes[0]).token, later(3)),
        ).rejects.toMatchObject({
          name: 'AccessResetInvalidError',
          reason: 'target-in-other-organisations',
        });
        expect(await hasPassword(person)).toBe(true);
      });
    });

    describe('the strength of the lock on the person’s row', () => {
      // A transaction that holds a key-share lock on the user row is what the
      // foreign key check of any insert that points at the user takes. A lock that
      // is only `FOR NO KEY UPDATE` does not wait for it; `FOR UPDATE` does.
      const holdKeyShare = (userId: string) => (tx: Tx) =>
        tx.select().from(user).where(eq(user.id, userId)).for('key share');

      it('makes a use wait for a writer that points at the person, so it is FOR UPDATE and not FOR NO KEY UPDATE', async () => {
        const person = await makePerson();
        const made = await makeLink(person);
        const outcomes = await interleave(db(), holdKeyShare(person), (tx) =>
          useAccessReset(tx, made.token, later(1)),
        );
        expect(outcomes[0].status).toBe('fulfilled');
        expect(outcomes[1].status).toBe('fulfilled');
        expect((await linkRow(made.reset.id)).usedAt).not.toBeNull();
      });

      it('makes the making of a link wait for such a writer too, so that it is FOR UPDATE as well', async () => {
        const person = await makePerson();
        const outcomes = await interleave(db(), holdKeyShare(person), (tx) =>
          create(tx, person, 1),
        );
        expect(outcomes[0].status).toBe('fulfilled');
        expect(outcomes[1], 'the create').toMatchObject({
          status: 'fulfilled',
        });
        expect(await liveLinksOf(person)).toHaveLength(1);
      });

      it('makes the accept of an invite wait for such a writer too', async () => {
        const person = await makePerson();
        const invited = await makeInvite();
        const outcomes = await interleave(db(), holdKeyShare(person), (tx) =>
          acceptInvite(
            tx,
            invited.token,
            { kind: 'signed-in', userId: person },
            later(1),
          ),
        );
        expect(outcomes[0].status).toBe('fulfilled');
        expect(outcomes[1].status).toBe('fulfilled');
        expect(await membershipsOf(person)).toHaveLength(2);
      });

      it('holds off a membership made by a writer that takes no user lock of its own, while a use holds the person', async () => {
        const person = await makePerson();
        const made = await makeLink(person);
        const outcomes = await interleave(
          db(),
          (tx) => useAccessReset(tx, made.token, later(1)),
          (tx) => seedMembershipIn(tx, scene.otherOrganisationId, person),
        );
        expect(outcomes[0].status).toBe('fulfilled');
        expect(outcomes[1].status).toBe('fulfilled');
        expect((await linkRow(made.reset.id)).usedAt).not.toBeNull();
        expect(await membershipsOf(person)).toHaveLength(2);
      });
    });
  },
);

/**
 * A bare membership insert in `organisationId`, as a writer that never locks the
 * user would make one: it reaches the user only through the foreign key.
 */
function seedMembershipIn(tx: Tx, organisationId: string, userId: string) {
  return tx.insert(orgMembership).values({
    organisationId,
    ownerOrgId: organisationId,
    originServer: ORIGIN,
    userId,
    orgRole: 'member',
    status: 'active',
  });
}
