import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { base } from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import {
  accessGrant,
  auditEvent,
  settingValue,
  userAccessProfile,
} from '../db/schema/index.js';
import {
  createMigratedDatabase,
  interleave,
  testTargets,
} from '../db/test-support.js';
import type { Tx } from '../db/write.js';
import { shareWithSuggestedRoles } from './access-grants.js';
import { endAccountAccessSharing } from './account-sharing.js';
import { ACCESS_SUGGESTED_ROLES_SETTING } from './suggested-roles.js';
import {
  ctxFor,
  NOW,
  seedAccessScene,
  seedProfileHolder,
  type AccessScene,
} from './test-support.js';

/** The PostgreSQL target, when `DATABASE_URL` names a server. PGlite has one connection, so it cannot run this. */
const postgres = testTargets.find((target) => target.name === 'postgres');

/** What a call answered, or why it failed. */
const resultOf = (outcome: PromiseSettledResult<unknown>): unknown =>
  outcome.status === 'fulfilled' ? outcome.value : outcome.reason;

/**
 * Ending an account's access sharing racing a share with the usual roles (decision D-69;
 * CLAUDE.md, Data rules). Ending the sharing revokes every grant of the account, so a grant
 * made from the profile that commits after the profile is gone would outlive the account's
 * sharing and open the next profile the person makes. A share reads the profile and then
 * writes grants derived from it, so it holds the profile row `FOR SHARE` while it works, and
 * ending the sharing takes the row `FOR UPDATE` before it revokes anything: it queues behind
 * a share that has read the profile, and a share that starts after it finds no profile. Each
 * case holds one transaction open after its work while the other starts, and waits until the
 * second is blocked on a lock (`interleave`), so the two really overlap and the order is the
 * one the test names. They need two real sessions, so they run on PostgreSQL and are skipped
 * on PGlite.
 */
describe.skipIf(postgres === undefined)(
  'ending an account’s access sharing racing a share with the usual roles, on PostgreSQL',
  () => {
    let database: Database;
    let cleanup: () => Promise<void>;
    let scene: AccessScene;

    beforeAll(async () => {
      ({ database, cleanup } = await createMigratedDatabase(postgres!));
      scene = await seedAccessScene(database);
      // The organisation usually shares the physical group with the production role.
      await database.db.insert(settingValue).values({
        ...base(scene.organisationId),
        layer: 'org',
        projectId: null,
        key: ACCESS_SUGGESTED_ROLES_SETTING,
        value: { physical: [scene.roles.production] },
      });
    });
    afterAll(async () => {
      await cleanup();
    });

    const db = () => database.db;
    type Holder = Awaited<ReturnType<typeof seedProfileHolder>>;
    /** The person shares their profile with the usual roles, for real. */
    const share = (tx: Tx, who: Holder) =>
      shareWithSuggestedRoles(
        tx,
        ctxFor(who.userId),
        scene.projectId,
        who.personId,
        'accessibility',
      );
    const endSharing = (tx: Tx, who: Holder) =>
      endAccountAccessSharing(tx, who.userId, 'account-deleted', { now: NOW });
    const grantsOf = async (personId: string) =>
      (await db().select().from(accessGrant)).filter(
        (row) => row.personId === personId,
      );
    const profileRowsOf = (userId: string) =>
      db()
        .select()
        .from(userAccessProfile)
        .where(eq(userAccessProfile.userId, userId));

    it('makes the end wait for a share that has read the profile, and then revokes the grants that share made', async () => {
      const ines = await seedProfileHolder(database, scene, 'Ines Kovac');
      const outcomes = await interleave(
        db(),
        (tx) => share(tx, ines),
        (tx) => endSharing(tx, ines),
      );
      expect(resultOf(outcomes[0])).toMatchObject({
        preview: false,
        granted: 1,
      });
      expect(outcomes[1].status).toBe('fulfilled');
      // It ran once the share had committed, so it saw what the share made.
      const rows = await grantsOf(ines.personId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.revokedAt).toEqual(NOW);
      expect(await profileRowsOf(ines.userId)).toEqual([]);
      const [event] = (await db().select().from(auditEvent)).filter(
        (found) =>
          found.targetId === ines.userId &&
          found.category === 'access.account-sharing-ended',
      );
      expect(event!.details).toEqual({
        reason: 'account-deleted',
        accessibilityGrants: 1,
        medicalGrants: 0,
        profileErased: true,
      });
    });

    it('makes a share wait for an end in progress, and share nothing from a profile that is gone', async () => {
      const ines = await seedProfileHolder(database, scene, 'Ines Kovac');
      const outcomes = await interleave(
        db(),
        (tx) => endSharing(tx, ines),
        (tx) => share(tx, ines),
      );
      expect(outcomes[0].status).toBe('fulfilled');
      // The share found no profile once the end had committed, so it made nothing that
      // could open the next profile.
      expect(resultOf(outcomes[1])).toMatchObject({
        preview: false,
        shares: [],
        granted: 0,
      });
      expect(await grantsOf(ines.personId)).toEqual([]);
      expect(await profileRowsOf(ines.userId)).toEqual([]);
    });
  },
);
