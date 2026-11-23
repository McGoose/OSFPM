import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { base } from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import {
  accessGrant,
  person,
  projectPerson,
  type ProjectPersonStatus,
} from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { createAccessProfile } from './access-profile.js';
import { createAccessGrant } from './access-grants.js';
import { SensitiveAccessDeniedError } from './errors.js';
import { VALID_PAYLOADS } from './payload-fixtures.js';
import { readSensitive } from './service.js';
import {
  ctxFor,
  seedAccessScene,
  updateProject,
  type AccessScene,
} from './test-support.js';

/**
 * A grant is live only while it is not revoked, its project is open and its person is
 * still on the project (decision D-69). That is worked out when it is read, from the rows
 * as they are, so nothing needs a job: a project that wraps, a person who is released or
 * removed, or a project that is closed stops opening anything at once, and the grant row is
 * never touched. Every test below reads through the same grant, and puts the world back.
 */

const SEES = { stepFreeRequired: true };

describe.each(testTargets)('when a grant is live, on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  let scene: AccessScene;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    scene = await seedAccessScene(database);
    const { userId, personId } = scene.people.holder;
    await createAccessProfile(
      database.db,
      ctxFor(userId),
      userId,
      VALID_PAYLOADS.accessibility,
    );
    await createAccessGrant(database.db, ctxFor(userId), {
      projectId: scene.projectId,
      personId,
      category: 'accessibility',
      roleId: scene.roles.production,
      fields: ['stepFreeRequired'],
    });
  });
  afterAll(async () => {
    await cleanup();
  });
  afterEach(async () => {
    await updateProject(database, scene.projectId, {
      wrapDate: null,
      status: 'development',
      deletedAt: null,
      timezone: 'Europe/London',
    });
    await database.db
      .update(projectPerson)
      .set({ status: 'confirmed', deletedAt: null })
      .where(eq(projectPerson.personId, scene.people.holder.personId));
    await database.db
      .delete(projectPerson)
      .where(
        and(
          eq(projectPerson.personId, scene.people.holder.personId),
          eq(projectPerson.engagement, 'cast'),
        ),
      );
    await database.db
      .update(person)
      .set({ deletedAt: null })
      .where(eq(person.id, scene.people.holder.personId));
  });

  const db = () => database.db;

  /** What the producer reads of the person's accessibility at `at`: the payload, `null` for nothing, or `'denied'`. */
  const sees = async (at?: Date) => {
    try {
      const record = await readSensitive(
        db(),
        ctxFor(scene.users.producer, at === undefined ? {} : { at }),
        scene.people.holder.personId,
        'accessibility',
      );
      return record?.payload ?? null;
    } catch (error) {
      if (error instanceof SensitiveAccessDeniedError) return 'denied';
      throw error;
    }
  };
  const holderEngagement = (values: {
    status?: ProjectPersonStatus;
    deletedAt?: Date | null;
  }) =>
    db()
      .update(projectPerson)
      .set(values)
      .where(
        and(
          eq(projectPerson.personId, scene.people.holder.personId),
          eq(projectPerson.engagement, 'crew'),
        ),
      );
  /** The grant as stored: it must be the same whatever happened to the project and the person. */
  const storedGrant = async () => (await db().select().from(accessGrant))[0]!;

  it('opens the granted field while the project is open and the person is on it', async () => {
    expect(await sees()).toEqual(SEES);
  });

  describe('the project', () => {
    it('ends with the wrap date: live through the wrap date itself, and not the day after', async () => {
      await updateProject(database, scene.projectId, {
        wrapDate: '2026-11-16',
      });
      expect(await sees()).toEqual(SEES);
      // Today, in London, is the 15th: the last day of the shoot still runs.
      await updateProject(database, scene.projectId, {
        wrapDate: '2026-11-15',
      });
      expect(await sees()).toEqual(SEES);
      await updateProject(database, scene.projectId, {
        wrapDate: '2026-11-14',
      });
      expect(await sees()).toBe('denied');
    });

    it('counts the wrap date in the project’s own time zone, not in UTC', async () => {
      await updateProject(database, scene.projectId, {
        wrapDate: '2026-11-15',
        timezone: 'Pacific/Auckland',
      });
      // 23:00 on the 15th in Auckland, which is 10:00 UTC: still the wrap date.
      expect(await sees(new Date('2026-11-15T10:00:00.000Z'))).toEqual(SEES);
      // 00:30 on the 16th in Auckland, while it is still the 15th in UTC: wrapped.
      expect(await sees(new Date('2026-11-15T11:30:00.000Z'))).toBe('denied');
    });

    it('reads a time zone the runtime does not know as UTC, and does not fail', async () => {
      await updateProject(database, scene.projectId, {
        wrapDate: '2026-11-15',
        timezone: 'Not/AZone',
      });
      expect(await sees(new Date('2026-11-15T23:59:00.000Z'))).toEqual(SEES);
      expect(await sees(new Date('2026-11-16T00:01:00.000Z'))).toBe('denied');
    });

    it('is closed when it is delivered or archived, and open in every status before', async () => {
      for (const status of [
        'development',
        'pre-production',
        'production',
        'post-production',
      ] as const) {
        await updateProject(database, scene.projectId, { status });
        expect(await sees(), status).toEqual(SEES);
      }
      for (const status of ['delivered', 'archived'] as const) {
        await updateProject(database, scene.projectId, { status });
        expect(await sees(), status).toBe('denied');
      }
    });

    it('ends when the project is deleted', async () => {
      await updateProject(database, scene.projectId, { deletedAt: new Date() });
      expect(await sees()).toBe('denied');
    });
  });

  describe('the person', () => {
    it('is on the project while proposed or confirmed, and not once released or removed', async () => {
      await holderEngagement({ status: 'proposed' });
      expect(await sees()).toEqual(SEES);
      await holderEngagement({ status: 'released' });
      expect(await sees()).toBe('denied');
      await holderEngagement({ status: 'confirmed', deletedAt: new Date() });
      expect(await sees()).toBe('denied');
    });

    it('is on the project while any of their engagements is, and not when none is', async () => {
      await db()
        .insert(projectPerson)
        .values({
          ...base(scene.organisationId),
          projectId: scene.projectId,
          personId: scene.people.holder.personId,
          engagement: 'cast',
          characterName: 'The Cashier',
          status: 'confirmed',
        });
      await holderEngagement({ status: 'released' });
      expect(await sees()).toEqual(SEES);
      await db()
        .update(projectPerson)
        .set({ status: 'released' })
        .where(
          and(
            eq(projectPerson.personId, scene.people.holder.personId),
            eq(projectPerson.engagement, 'cast'),
          ),
        );
      expect(await sees()).toBe('denied');
    });

    it('ends when the person is deleted', async () => {
      await db()
        .update(person)
        .set({ deletedAt: new Date() })
        .where(eq(person.id, scene.people.holder.personId));
      expect(await sees()).toBe('denied');
    });
  });

  describe('with no job', () => {
    it('never touches the grant: it is the same row after the project wrapped and the person left, and it opens again when they are back', async () => {
      const before = await storedGrant();
      await updateProject(database, scene.projectId, {
        wrapDate: '2026-11-01',
      });
      expect(await sees()).toBe('denied');
      await updateProject(database, scene.projectId, { wrapDate: null });
      await holderEngagement({ status: 'released' });
      expect(await sees()).toBe('denied');
      await holderEngagement({ status: 'confirmed' });
      // Nothing revoked it and nothing has to restore it: it was only ever worked out.
      expect(await sees()).toEqual(SEES);
      const after = await storedGrant();
      expect(after).toEqual(before);
      expect(after.revokedAt).toBeNull();
      expect(after.version).toBe(before.version);
    });

    it('keeps the profile when the production ends: the person reads all of it, and another production is a separate question', async () => {
      await updateProject(database, scene.projectId, { status: 'archived' });
      expect(await sees()).toBe('denied');
      const { userId, personId } = scene.people.holder;
      const own = await readSensitive(
        db(),
        ctxFor(userId),
        personId,
        'accessibility',
      );
      expect(own?.payload).toEqual(VALID_PAYLOADS.accessibility);
    });
  });
});
