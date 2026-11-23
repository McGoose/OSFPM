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
  succeeded,
  testTargets,
} from '../db/test-support.js';
import { AccessResetInvalidError } from './access-reset-errors.js';
import {
  createAccessReset,
  revokeAccessReset,
  useAccessReset,
} from './access-reset.js';
import { acceptInvite, createInvite } from './invites.js';
import { AUTH_AUDIT } from './shared.js';
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
 * Reset links racing: two uses of one token, a use and a revoke of one link, and a
 * use of a link against the same person accepting an invite into a second
 * organisation. Each case holds one transaction open after its work while the
 * other starts, and the call waits until the second is blocked on a lock
 * (`interleave`), so the two really overlap and the order is the one the test
 * names. They need two real sessions, so they run on PostgreSQL and are skipped on
 * PGlite.
 *
 * What they pin: a link is used once however many uses run at once; it ends used
 * or revoked, never both; and a link is never used for a person who already
 * belongs to two organisations. The reset row lock decides a use against a revoke
 * and against another use; the user row lock, `FOR UPDATE` and taken last (CLAUDE.md,
 * Data rules), decides a use against an accept that gives the person a second
 * membership: one finishes before the other starts, or the use is refused.
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
