import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedUser } from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import { auditEvent, user } from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { RecordNotFoundError } from '../db/write.js';
import {
  createAccessProfile,
  deleteAccessProfile,
  loadProfile,
  readAccessProfile,
  updateAccessProfile,
} from './access-profile.js';
import {
  AccessProfileExistsError,
  SensitiveAccessDeniedError,
  SensitivePayloadInvalidError,
} from './errors.js';
import { leafStrings, VALID_PAYLOADS } from './payload-fixtures.js';
import { readSensitive } from './service.js';
import {
  ctxFor,
  seedAccessScene,
  tokenFor,
  updateProject,
  type AccessScene,
} from './test-support.js';

/**
 * A person's access profile (decision D-69): owned by the person, written and read only by
 * them, and kept when a project wraps. Nobody else reaches it, whatever they hold, and what
 * the audit trail says of it is the user and a count, never a field or a value.
 */

const PROFILE = VALID_PAYLOADS.accessibility;

describe.each(testTargets)('the access profile on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  let scene: AccessScene;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    scene = await seedAccessScene(database);
  });
  afterAll(async () => {
    await cleanup();
  });

  const db = () => database.db;

  /** The audit events about one user, by category. */
  const eventsAbout = async (userId: string, category?: string) =>
    (await db().select().from(auditEvent))
      .filter(
        (event) =>
          event.targetId === userId &&
          (category === undefined || event.category === category),
      )
      .sort((a, b) => a.id.localeCompare(b.id));

  const countOf = async (query: ReturnType<typeof sql>) => {
    const result = (await db().execute(query)) as { rows: { n: number }[] };
    return Number(result.rows[0]!.n);
  };

  describe('its owner', () => {
    it('makes, reads, changes and deletes their own profile, one version at a time', async () => {
      const owner = await seedUser(database);
      const made = await createAccessProfile(
        db(),
        ctxFor(owner),
        owner,
        PROFILE,
      );
      expect(made).toMatchObject({
        userId: owner,
        version: 1,
        payload: PROFILE,
      });

      const read = await readAccessProfile(db(), ctxFor(owner), owner);
      expect(read?.payload).toEqual(PROFILE);

      const changed = { ...PROFILE, maxWorkingHours: 8, quietSpace: false };
      const updated = await updateAccessProfile(
        db(),
        ctxFor(owner),
        owner,
        changed,
      );
      expect(updated.version).toBe(2);
      expect(updated.payload).toEqual(changed);
      expect(
        (await readAccessProfile(db(), ctxFor(owner), owner))?.payload,
      ).toEqual(changed);

      await deleteAccessProfile(db(), ctxFor(owner), owner);
      expect(await readAccessProfile(db(), ctxFor(owner), owner)).toBeNull();
      expect(await loadProfile(db(), owner)).toBeUndefined();
    });

    it('is the one who reads it as the person of a record: all of it, from the profile', async () => {
      const { userId, personId } = scene.people.holder;
      await createAccessProfile(db(), ctxFor(userId), userId, PROFILE);
      const read = await readSensitive(
        db(),
        ctxFor(userId),
        personId,
        'accessibility',
      );
      expect(read?.payload).toEqual(PROFILE);
      expect(read).toMatchObject({ enteredByKind: 'self', personId });
    });
  });

  describe('everyone else', () => {
    it('is refused, whatever they hold: staff, an organisation owner, an administrator and a stranger', async () => {
      const { userId } = scene.people.holder;
      const stored = await loadProfile(db(), userId);
      expect(stored).toBeDefined();
      const others = [
        scene.users.producer,
        scene.users.coordinator,
        scene.users.owner,
        scene.users.admin,
        scene.users.stranger,
      ];
      const before = (await eventsAbout(userId, 'sensitive.denied')).length;
      for (const other of others) {
        const ctx = ctxFor(other);
        for (const attempt of [
          () => readAccessProfile(db(), ctx, userId),
          () => createAccessProfile(db(), ctx, userId, PROFILE),
          () => updateAccessProfile(db(), ctx, userId, PROFILE),
          () => deleteAccessProfile(db(), ctx, userId),
        ]) {
          await expect(attempt()).rejects.toBeInstanceOf(
            SensitiveAccessDeniedError,
          );
        }
      }
      // Each refusal was audited before it was thrown, and nothing was touched.
      expect(
        (await eventsAbout(userId, 'sensitive.denied')).length - before,
      ).toBe(others.length * 4);
      const after = await loadProfile(db(), userId);
      expect(after?.payload).toEqual(PROFILE);
      expect(after?.version).toBe(stored!.version);
    });

    it('is refused the same for a user who does not exist, so ids cannot be probed', async () => {
      const missing = '0199a3c4-0000-7000-8000-00000000dead';
      await expect(
        readAccessProfile(db(), ctxFor(scene.users.producer), missing),
      ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
      await expect(
        readAccessProfile(db(), ctxFor(scene.users.producer), 'not an id'),
      ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
    });

    it('is refused a personal API token of the owner, with the scope or without, and the refusal is audited with the token', async () => {
      const { userId } = scene.people.holder;
      const token = tokenFor(scene.organisationId, [
        'sensitive:read:accessibility',
      ]);
      const before = (await eventsAbout(userId, 'sensitive.denied')).length;
      await expect(
        readAccessProfile(db(), ctxFor(userId, { credential: token }), userId),
      ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
      await expect(
        updateAccessProfile(
          db(),
          ctxFor(userId, { credential: tokenFor(scene.organisationId, []) }),
          userId,
          PROFILE,
        ),
      ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
      const events = (await eventsAbout(userId, 'sensitive.denied')).slice(
        before,
      );
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        actorType: 'token',
        actorId: token.tokenId,
        details: { category: 'accessibility', tokenId: token.tokenId, userId },
      });
    });
  });

  describe('what it holds', () => {
    it('is checked against the accessibility schema before it is written, and a refusal says where and never what', async () => {
      const owner = await seedUser(database);
      const secret = 'a diagnosis nobody should see in an error';
      const refused = await createAccessProfile(db(), ctxFor(owner), owner, {
        diagnosis: secret,
      }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(refused).toBeInstanceOf(SensitivePayloadInvalidError);
      expect(JSON.stringify(refused)).not.toContain(secret);
      expect((refused as Error).message).not.toContain(secret);
      expect(await loadProfile(db(), owner)).toBeUndefined();
      expect(await eventsAbout(owner, 'access.profile-created')).toEqual([]);
      await expect(
        createAccessProfile(db(), ctxFor(owner), owner, {}),
      ).rejects.toBeInstanceOf(SensitivePayloadInvalidError);
    });

    it('is made once: a second make, an update with none and a delete with none are refused', async () => {
      const owner = await seedUser(database);
      await expect(
        updateAccessProfile(db(), ctxFor(owner), owner, PROFILE),
      ).rejects.toBeInstanceOf(RecordNotFoundError);
      await expect(
        deleteAccessProfile(db(), ctxFor(owner), owner),
      ).rejects.toBeInstanceOf(RecordNotFoundError);
      await createAccessProfile(db(), ctxFor(owner), owner, PROFILE);
      await expect(
        createAccessProfile(db(), ctxFor(owner), owner, PROFILE),
      ).rejects.toBeInstanceOf(AccessProfileExistsError);
      expect(
        await countOf(
          sql`select count(*)::int as n from user_access_profile where user_id = ${owner}`,
        ),
      ).toBe(1);
    });

    it('is not rewritten by an update that says what is stored: the version stays and nothing is announced', async () => {
      const owner = await seedUser(database);
      await createAccessProfile(db(), ctxFor(owner), owner, PROFILE);
      // The same keys in another order are the same payload.
      const reordered = Object.fromEntries(Object.entries(PROFILE).reverse());
      const same = await updateAccessProfile(
        db(),
        ctxFor(owner),
        owner,
        reordered,
      );
      expect(same.version).toBe(1);
      expect(await eventsAbout(owner, 'access.profile-updated')).toEqual([]);
    });

    it('goes with the account: the profile of a deleted user reads as none', async () => {
      const owner = await seedUser(database);
      await createAccessProfile(db(), ctxFor(owner), owner, PROFILE);
      await db()
        .update(user)
        .set({ deletedAt: NOW_PLUS })
        .where(eq(user.id, owner));
      expect(await loadProfile(db(), owner)).toBeUndefined();
    });

    it('stays when a project wraps, and when it is delivered or archived: it is the person’s, not the production’s', async () => {
      const { userId, personId } = scene.people.holder;
      expect(await loadProfile(db(), userId)).toBeDefined();
      for (const values of [
        { wrapDate: '2026-11-01' },
        { status: 'delivered' as const },
        { status: 'archived' as const },
      ]) {
        await updateProject(database, scene.projectId, values);
        const read = await readAccessProfile(db(), ctxFor(userId), userId);
        expect(read?.payload).toEqual(PROFILE);
        const record = await readSensitive(
          db(),
          ctxFor(userId),
          personId,
          'accessibility',
        );
        expect(record?.payload).toEqual(PROFILE);
      }
      await updateProject(database, scene.projectId, {
        wrapDate: null,
        status: 'development',
      });
    });
  });

  describe('the trail it leaves', () => {
    it('is the user and a count: the changes name the user, a read counts its fields, and nothing holds a field name or a value', async () => {
      const owner = await seedUser(database);
      await createAccessProfile(db(), ctxFor(owner), owner, PROFILE);
      await updateAccessProfile(db(), ctxFor(owner), owner, {
        ...PROFILE,
        maxWorkingHours: 9,
      });
      await readAccessProfile(db(), ctxFor(owner), owner);
      await deleteAccessProfile(db(), ctxFor(owner), owner);

      const events = await eventsAbout(owner);
      expect(events.map((event) => event.category).sort()).toEqual([
        'access.profile-created',
        'access.profile-deleted',
        'access.profile-updated',
        'sensitive.read',
      ]);
      for (const event of events) {
        expect(event).toMatchObject({
          actorType: 'user',
          actorId: owner,
          targetType: 'user',
          organisationId: null,
        });
      }
      const read = events.find((event) => event.category === 'sensitive.read');
      expect(read?.details).toEqual({
        category: 'accessibility',
        fieldCount: Object.keys(PROFILE).length,
      });
      const text = JSON.stringify(events);
      for (const value of leafStrings(PROFILE))
        expect(text).not.toContain(value);
      for (const name of Object.keys(PROFILE)) expect(text).not.toContain(name);
    });

    it('makes no change event, because it has no organisation to number one in', async () => {
      const owner = await seedUser(database);
      const before = await countOf(
        sql`select count(*)::int as n from change_event`,
      );
      await createAccessProfile(db(), ctxFor(owner), owner, PROFILE);
      await updateAccessProfile(db(), ctxFor(owner), owner, {
        ...PROFILE,
        maxWorkingHours: 7,
      });
      await deleteAccessProfile(db(), ctxFor(owner), owner);
      expect(
        await countOf(sql`select count(*)::int as n from change_event`),
      ).toBe(before);
    });

    it('is kept apart from the production’s record: nothing is written to person_sensitive', async () => {
      const owner = await seedUser(database);
      const before = await countOf(
        sql`select count(*)::int as n from person_sensitive`,
      );
      await createAccessProfile(db(), ctxFor(owner), owner, PROFILE);
      expect(
        await countOf(sql`select count(*)::int as n from person_sensitive`),
      ).toBe(before);
    });
  });
});

/** A moment after the scene's clock, for a user that is deleted. */
const NOW_PLUS = new Date('2026-11-16T10:00:00.000Z');
