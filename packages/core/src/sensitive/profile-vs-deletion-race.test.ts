import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedUser } from '../access/test-fixtures.js';
import { lockUser } from '../auth/shared.js';
import type { Database } from '../db/client.js';
import {
  accessGrant,
  auditEvent,
  userAccessProfile,
} from '../db/schema/index.js';
import {
  createMigratedDatabase,
  interleave,
  testTargets,
} from '../db/test-support.js';
import { RecordNotFoundError } from '../db/write.js';
import { createAccessGrant } from './access-grants.js';
import {
  createAccessProfile,
  deleteAccessProfile,
  updateAccessProfile,
} from './access-profile.js';
import { AccountDeletedError } from './errors.js';
import { VALID_PAYLOADS } from './payload-fixtures.js';
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

const PROFILE = VALID_PAYLOADS.accessibility;
/** What a change to the profile says: one answer different from `PROFILE`. */
const CHANGED = { ...PROFILE, maxWalkMetres: 250 };

/**
 * Making, changing and deleting an access profile racing the deletion of the account it
 * belongs to (decision D-69; CLAUDE.md, Data rules). The deletion takes the user row
 * `FOR UPDATE`, then the profile row, then the grants. A profile deletion that took the
 * profile row first reached the user row later, through the key-share lock of the grants it
 * revokes (`revoked_by`), so it could wait for the deletion's user row while the deletion
 * waited for its profile row, and one of them would be ended by a deadlock; a creation that
 * came after the deletion committed left a profile of an account that is gone. The three
 * therefore take the user row `FOR KEY SHARE` first, so both go user row first and queue on
 * it, and a creation refuses an account that is deleted. Each case holds one transaction
 * open after its work while the other starts, and waits until the second is blocked on a
 * lock (`interleave`), so the two really overlap and the order is the one the test names.
 * They need two real sessions, so they run on PostgreSQL and are skipped on PGlite.
 */
describe.skipIf(postgres === undefined)(
  'writing the access profile racing the deletion of the account, on PostgreSQL',
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
    /** A person with an account and a profile, and an accessibility grant for the production role. */
    const newSharer = async () => {
      const ines = await seedProfileHolder(database, scene, 'Ines Kovac');
      await createAccessGrant(db(), ctxFor(ines.userId), {
        projectId: scene.projectId,
        personId: ines.personId,
        category: 'accessibility',
        roleId: scene.roles.production,
        fields: ['stepFreeRequired'],
      });
      return ines;
    };
    type Sharer = Awaited<ReturnType<typeof newSharer>>;
    const profileRowsOf = (userId: string) =>
      db()
        .select()
        .from(userAccessProfile)
        .where(eq(userAccessProfile.userId, userId));
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
    /** The probe: takes the person's profile row `FOR UPDATE NOWAIT` from a third connection. */
    const probeProfileRow = (userId: string) => async () => {
      await db().transaction((probe) =>
        probe.execute(
          sql`select id from user_access_profile where user_id = ${userId} for update nowait`,
        ),
      );
    };
    const deleteProfile = (
      tx: Parameters<typeof deleteAccessProfile>[0],
      who: Sharer,
    ) => deleteAccessProfile(tx, ctxFor(who.userId), who.userId);

    describe('deleting the profile', () => {
      it('makes the deletion of a profile wait for the account row while it holds nothing on the profile, so it cannot deadlock with a deletion of the account', async () => {
        const ines = await newSharer();

        const outcomes = await interleave(
          db(),
          // The deletion of the account has the user row and is on its way to the profile.
          (tx) => lockUser(tx, ines.userId, { strength: 'update' }),
          (tx) => deleteProfile(tx, ines),
          // While it waits: the profile row must be free. `nowait` fails at once when the
          // deletion of the profile already holds it, which is the order that deadlocks.
          probeProfileRow(ines.userId),
        );

        expect(outcomes[0].status).toBe('fulfilled');
        expect(outcomes[1].status).toBe('fulfilled');
        expect(await profileRowsOf(ines.userId)).toEqual([]);
        expect(await grantsOf(ines.personId)).toMatchObject([
          { revokedAt: NOW, version: 2 },
        ]);
      });

      it('answers a deletion of the profile that meets the deletion of the account as one of a profile that is already gone', async () => {
        const ines = await newSharer();

        const outcomes = await interleave(
          db(),
          (tx) => simulateAccountDeletion(tx, ines.userId),
          (tx) => deleteProfile(tx, ines),
        );

        expect(outcomes[0].status).toBe('fulfilled');
        expect(resultOf(outcomes[1])).toBeInstanceOf(RecordNotFoundError);
        expect(await profileRowsOf(ines.userId)).toEqual([]);
        expect(await liveGrantsOf(ines.personId)).toEqual([]);
      });

      it('makes the deletion of the account wait for a deletion of the profile that has started, and then find nothing left to end', async () => {
        const ines = await newSharer();

        const outcomes = await interleave(
          db(),
          (tx) => deleteProfile(tx, ines),
          (tx) => simulateAccountDeletion(tx, ines.userId),
        );

        expect(outcomes[0].status).toBe('fulfilled');
        expect(outcomes[1].status).toBe('fulfilled');
        expect((await endEvent(ines.userId))?.details).toMatchObject({
          accessibilityGrants: 0,
          profileErased: false,
        });
        expect(await liveGrantsOf(ines.personId)).toEqual([]);
      });

      it('leaves no profile and no live grant however the deletion of the profile and of the account interleave, and neither is ended by a deadlock', async () => {
        for (let round = 0; round < 8; round += 1) {
          const ines = await newSharer();

          const outcomes = await Promise.allSettled([
            db().transaction((tx) => deleteProfile(tx, ines)),
            db().transaction((tx) => simulateAccountDeletion(tx, ines.userId)),
          ]);

          // The deletion of the account always finishes. The deletion of the profile either
          // came first, or found the profile already erased: nothing else, so no deadlock.
          expect(outcomes[1].status, `round ${round}`).toBe('fulfilled');
          expect(
            outcomes[0].status === 'fulfilled' ||
              resultOf(outcomes[0]) instanceof RecordNotFoundError,
            `round ${round}`,
          ).toBe(true);
          expect(await profileRowsOf(ines.userId), `round ${round}`).toEqual(
            [],
          );
          expect(await liveGrantsOf(ines.personId), `round ${round}`).toEqual(
            [],
          );
        }
      });
    });

    describe('changing the profile', () => {
      it('makes a change wait for the account row while it holds nothing on the profile', async () => {
        const ines = await newSharer();

        const outcomes = await interleave(
          db(),
          (tx) => lockUser(tx, ines.userId, { strength: 'update' }),
          (tx) =>
            updateAccessProfile(tx, ctxFor(ines.userId), ines.userId, CHANGED),
          probeProfileRow(ines.userId),
        );

        expect(outcomes[0].status).toBe('fulfilled');
        expect(resultOf(outcomes[1])).toMatchObject({ version: 2 });
        expect(await profileRowsOf(ines.userId)).toMatchObject([
          { payload: CHANGED, version: 2 },
        ]);
      });

      it('answers a change that meets the deletion of the account as one of a profile that is gone', async () => {
        const ines = await newSharer();

        const outcomes = await interleave(
          db(),
          (tx) => simulateAccountDeletion(tx, ines.userId),
          (tx) =>
            updateAccessProfile(tx, ctxFor(ines.userId), ines.userId, CHANGED),
        );

        expect(outcomes[0].status).toBe('fulfilled');
        expect(resultOf(outcomes[1])).toBeInstanceOf(RecordNotFoundError);
        expect(await profileRowsOf(ines.userId)).toEqual([]);
      });

      it('makes the deletion of the account wait for a change that has started, and then erase the profile', async () => {
        const ines = await newSharer();

        const outcomes = await interleave(
          db(),
          (tx) =>
            updateAccessProfile(tx, ctxFor(ines.userId), ines.userId, CHANGED),
          (tx) => simulateAccountDeletion(tx, ines.userId),
        );

        expect(resultOf(outcomes[0])).toMatchObject({ version: 2 });
        expect(outcomes[1].status).toBe('fulfilled');
        expect(await profileRowsOf(ines.userId)).toEqual([]);
        expect((await endEvent(ines.userId))?.details).toMatchObject({
          profileErased: true,
        });
      });
    });

    describe('making the profile', () => {
      /** An account with no profile yet. */
      const newAccount = () => seedUser(database);

      it('makes a creation that meets the deletion of the account wait for it, refuse the account and leave no profile behind', async () => {
        const userId = await newAccount();

        const outcomes = await interleave(
          db(),
          (tx) => simulateAccountDeletion(tx, userId),
          (tx) => createAccessProfile(tx, ctxFor(userId), userId, PROFILE),
        );

        expect(outcomes[0].status).toBe('fulfilled');
        expect(resultOf(outcomes[1])).toBeInstanceOf(AccountDeletedError);
        expect(await profileRowsOf(userId)).toEqual([]);
      });

      it('makes the deletion of the account wait for a creation that has started, and then erase the profile it made', async () => {
        const userId = await newAccount();

        const outcomes = await interleave(
          db(),
          (tx) => createAccessProfile(tx, ctxFor(userId), userId, PROFILE),
          (tx) => simulateAccountDeletion(tx, userId),
        );

        expect(resultOf(outcomes[0])).toMatchObject({ userId, version: 1 });
        expect(outcomes[1].status).toBe('fulfilled');
        expect(await profileRowsOf(userId)).toEqual([]);
        expect((await endEvent(userId))?.details).toMatchObject({
          profileErased: true,
        });
      });

      it('leaves no profile behind however the creation and the deletion of the account interleave', async () => {
        for (let round = 0; round < 8; round += 1) {
          const userId = await newAccount();

          const outcomes = await Promise.allSettled([
            db().transaction((tx) =>
              createAccessProfile(tx, ctxFor(userId), userId, PROFILE),
            ),
            db().transaction((tx) => simulateAccountDeletion(tx, userId)),
          ]);

          // The creation either came first, and the deletion erased what it made, or met
          // the deletion and was refused: nothing else, and never a profile left behind.
          expect(outcomes[1].status, `round ${round}`).toBe('fulfilled');
          expect(
            outcomes[0].status === 'fulfilled' ||
              resultOf(outcomes[0]) instanceof AccountDeletedError,
            `round ${round}`,
          ).toBe(true);
          expect(await profileRowsOf(userId), `round ${round}`).toEqual([]);
        }
      });
    });
  },
);
