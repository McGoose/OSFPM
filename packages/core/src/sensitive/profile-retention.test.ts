import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { retentionClass, userAccessProfile } from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import {
  SHIPPED_RETENTION_DEFAULTS,
  type RetentionDefault,
} from '../retention/defaults.js';
import {
  retentionEndDate,
  type RetentionDates,
} from '../retention/end-date.js';
import { TRANSIENT_CLEANUPS } from '../retention/transient-cleanups.js';
import { createAccessProfile, readAccessProfile } from './access-profile.js';
import { VALID_PAYLOADS } from './payload-fixtures.js';
import {
  ctxFor,
  seedAccessScene,
  updateProject,
  type AccessScene,
} from './test-support.js';

/**
 * An access profile belongs to an account, not to a production (decision D-69), so its
 * retention class is `account-lifetime`: kept while the account exists, and ended only when
 * the person deletes it or the account goes. No project date and no purge may reach it.
 * There is no purge job yet, so these tests stand on the two things that would decide one:
 * the class's period and anchor, which `retentionEndDate` reads, and the cleanups, which are
 * the only code that deletes by age today.
 */

/** Every date a period can count from, all long past. */
const EVERY_DATE: RetentionDates = {
  recordCreated: '2000-01-01',
  lastActivity: '2000-01-01',
  wrapDate: '2000-01-01',
  deliveryDate: '2000-01-01',
  firstExploitationDate: '2000-01-01',
};

/** The anchors that name a project: a profile has none, so none may apply to it. */
const PROJECT_ANCHORS = [
  'project-wrap',
  'project-delivery',
  'first-exploitation',
];

describe.each(testTargets)(
  'the retention of an access profile, on $name',
  (target) => {
    let database: Database;
    let cleanup: () => Promise<void>;
    let scene: AccessScene;

    beforeAll(async () => {
      ({ database, cleanup } = await createMigratedDatabase(target));
      scene = await seedAccessScene(database);
      const { userId } = scene.people.holder;
      await createAccessProfile(
        database.db,
        ctxFor(userId),
        userId,
        VALID_PAYLOADS.accessibility,
      );
    });
    afterAll(async () => {
      await cleanup();
    });

    /** The profile row as stored, every column. */
    const storedProfile = async () =>
      (
        await database.db
          .select()
          .from(userAccessProfile)
          .where(eq(userAccessProfile.userId, scene.people.holder.userId))
      )[0]!;

    it('is in the account-lifetime class, which has no period and counts from no project date', async () => {
      const profile = await storedProfile();
      expect(profile.retentionClass).toBe('account-lifetime');
      const [definition] = await database.db
        .select()
        .from(retentionClass)
        .where(eq(retentionClass.key, profile.retentionClass));
      expect(PROJECT_ANCHORS).not.toContain(definition!.anchor);
      const shipped = new Map<string, RetentionDefault>(
        Object.entries(SHIPPED_RETENTION_DEFAULTS),
      ).get(profile.retentionClass);
      expect(shipped).toEqual({ periodYears: null, verified: false });
      expect(
        retentionEndDate({
          anchor: definition!.anchor,
          periodsYears: [shipped!.periodYears],
          dates: EVERY_DATE,
        }),
      ).toBeNull();
    });

    it('is the same row after its person’s project wraps and is archived and every cleanup has run a century later', async () => {
      const before = await storedProfile();
      await updateProject(database, scene.projectId, {
        wrapDate: '2026-11-01',
        status: 'archived',
      });
      const aCenturyLater = new Date('2126-11-15T10:00:00.000Z');
      for (const run of TRANSIENT_CLEANUPS.values()) {
        await run(database.db, aCenturyLater);
      }
      expect(await storedProfile()).toEqual(before);
      // The person still reads all of it: nothing about the production reached it.
      const { userId } = scene.people.holder;
      const own = await readAccessProfile(database.db, ctxFor(userId), userId);
      expect(own?.payload).toEqual(VALID_PAYLOADS.accessibility);
    });
  },
);
