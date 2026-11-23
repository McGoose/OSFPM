import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  base,
  engagePerson,
  seedOrganisation,
  seedPerson,
} from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import {
  accessGrant,
  auditEvent,
  role,
  settingValue,
} from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import {
  createAccessGrant,
  shareWithSuggestedRoles,
  type AccessConsent,
  type ShareItem,
  type ShareOptions,
} from './access-grants.js';
import { createAccessProfile } from './access-profile.js';
import {
  AccessGrantRefusedError,
  SensitiveAccessDeniedError,
} from './errors.js';
import { VALID_PAYLOADS } from './payload-fixtures.js';
import { writeSensitive } from './service.js';
import {
  ctxFor,
  NOW,
  seedAccessScene,
  seedRole,
  updateProject,
  type AccessScene,
} from './test-support.js';
import { ACCESS_SUGGESTED_ROLES_SETTING } from './suggested-roles.js';

/**
 * "Share with the usual roles" (decision D-69): one grant for each role the organisation
 * usually shares each group with, covering what the person has filled in, and never the
 * free-text notes. A preview says who will see what, writes nothing, and is what a
 * confirmed call then makes.
 */

const CONSENT: AccessConsent = {
  method: 'email',
  at: new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000),
};
/** The person without an account: schedule, physical and communication fields, and notes, no environment. */
const CREW_ACCESS = {
  breakEveryMinutes: 90,
  seatingNeeded: true,
  extraThinkingTime: true,
  notes: 'Mornings are hard',
};
const CREW_MEDICAL = {
  conditions: 'Migraine',
  medication: 'Prescribed, kept in a bag',
  notes: 'Needs a dark room',
};

describe.each(testTargets)(
  'sharing with the usual roles on $name',
  (target) => {
    let database: Database;
    let cleanup: () => Promise<void>;
    let scene: AccessScene;
    /** The two roles the suggested-roles setting names, read from the scene. */
    let production: string;
    let camera: string;

    beforeAll(async () => {
      ({ database, cleanup } = await createMigratedDatabase(target));
      scene = await seedAccessScene(database);
      production = scene.roles.production;
      camera = scene.roles.camera;
      const { holder, crew } = scene.people;
      await createAccessProfile(
        database.db,
        ctxFor(holder.userId),
        holder.userId,
        VALID_PAYLOADS.accessibility,
      );
      await writeSensitive(
        database.db,
        ctxFor(holder.userId),
        holder.personId,
        'medical',
        VALID_PAYLOADS.medical,
        { legalBasis: 'consent' },
      );
      for (const [category, payload] of [
        ['accessibility', CREW_ACCESS],
        ['medical', CREW_MEDICAL],
      ] as const) {
        await writeSensitive(
          database.db,
          ctxFor(scene.users.coordinator),
          crew.personId,
          category,
          payload,
          { legalBasis: 'consent' },
        );
      }
    });
    afterAll(async () => {
      await cleanup();
    });
    afterEach(async () => {
      await database.db.delete(accessGrant);
      await updateProject(database, scene.projectId, {
        wrapDate: null,
        status: 'development',
      });
    });

    const db = () => database.db;
    const holder = () => scene.people.holder;
    const crew = () => scene.people.crew;

    /** Sets the organisation's suggested roles, or none. */
    const suggest = async (value: unknown) => {
      await db()
        .delete(settingValue)
        .where(eq(settingValue.key, ACCESS_SUGGESTED_ROLES_SETTING));
      if (value === undefined) return;
      await db()
        .insert(settingValue)
        .values({
          ...base(scene.organisationId),
          layer: 'org',
          projectId: null,
          key: ACCESS_SUGGESTED_ROLES_SETTING,
          value,
        });
    };
    const USUAL = () => ({
      schedule: [production],
      physical: [production, camera],
      environment: [camera],
      medical: [production],
    });

    const share = (
      userId: string,
      personId: string,
      category: 'accessibility' | 'medical',
      options?: ShareOptions,
    ) =>
      shareWithSuggestedRoles(
        db(),
        ctxFor(userId),
        scene.projectId,
        personId,
        category,
        options,
      );
    /** The result as role to fields, whatever the order of the roles. */
    const byRole = (shares: readonly ShareItem[]) =>
      Object.fromEntries(shares.map((item) => [item.roleId, [...item.fields]]));
    const liveRows = async () =>
      (await db().select().from(accessGrant)).filter(
        (row) => row.revokedAt === null,
      );
    const events = async (category: string) =>
      (await db().select().from(auditEvent))
        .filter((event) => event.category === category)
        .sort((a, b) => a.id.localeCompare(b.id));
    const errorOf = (promise: Promise<unknown>) =>
      promise.then(
        () => undefined,
        (caught: unknown) => caught,
      );

    /** What the holder's profile gives each role: the usual groups, in the order of the fields. */
    const HOLDER_PLAN = () => ({
      [production]: [
        'noEarlierThan',
        'maxWorkingHours',
        'stepFreeRequired',
        'maxWalkMetres',
      ],
      [camera]: ['stepFreeRequired', 'maxWalkMetres', 'quietSpace'],
    });

    describe('the preview', () => {
      it('says who will see what, role by role, with no notes and no group the person left unsuggested, and writes no grant', async () => {
        await suggest(USUAL());
        const seen = (await events('sensitive.read')).length;
        const result = await share(
          holder().userId,
          holder().personId,
          'accessibility',
          {
            preview: true,
          },
        );
        expect(result.preview).toBe(true);
        expect(result.granted).toBe(0);
        expect(byRole(result.shares)).toEqual(HOLDER_PLAN());
        for (const item of result.shares) {
          expect(item.fields).not.toContain('notes');
          // The sign language interpreter is a communication field, and no role is
          // suggested for that group.
          expect(item.fields).not.toContain('signLanguageInterpreter');
        }
        expect(await db().select().from(accessGrant)).toEqual([]);
        expect(await events('access.shortcut-used')).toEqual([]);
        // Reading the profile to see what is filled in is a read, and is audited as one.
        const [read] = (await events('sensitive.read')).slice(seen);
        expect(read?.details).toMatchObject({
          category: 'accessibility',
          fieldCount: Object.keys(VALID_PAYLOADS.accessibility).length,
        });
      });

      it('is the order of the role ids, and the fields in the order they are listed in', async () => {
        await suggest(USUAL());
        const { shares } = await share(
          holder().userId,
          holder().personId,
          'accessibility',
          { preview: true },
        );
        expect(shares.map((item) => item.roleId)).toEqual(
          [production, camera].sort(),
        );
      });
    });

    describe('a confirmed call', () => {
      it('makes exactly the grants the preview said, one for each role, and audits them and the whole', async () => {
        await suggest(USUAL());
        const preview = await share(
          holder().userId,
          holder().personId,
          'accessibility',
          {
            preview: true,
          },
        );
        const seen = (await events('access.grant-created')).length;
        const done = await share(
          holder().userId,
          holder().personId,
          'accessibility',
        );
        expect(done.preview).toBe(false);
        expect(done.granted).toBe(2);
        expect(done.shares).toEqual(preview.shares);
        const live = await liveRows();
        expect(live).toHaveLength(2);
        expect(
          Object.fromEntries(live.map((row) => [row.roleId, row.fields])),
        ).toEqual(HOLDER_PLAN());
        for (const row of live) {
          expect(row).toMatchObject({
            personId: holder().personId,
            projectId: scene.projectId,
            category: 'accessibility',
            grantedBy: holder().userId,
            onBehalf: false,
            consentMethod: null,
          });
          expect(row.fields).not.toContain('notes');
        }
        expect((await events('access.grant-created')).length - seen).toBe(2);
        const [used] = await events('access.shortcut-used');
        expect(used).toMatchObject({
          action: 'share',
          actorId: holder().userId,
          targetId: holder().personId,
          details: { category: 'accessibility', count: 2, onBehalf: false },
        });
      });

      it('never includes notes, whatever groups are asked for, and refuses a group it does not have', async () => {
        await suggest({ ...USUAL(), notes: [production] });
        const result = await share(
          holder().userId,
          holder().personId,
          'accessibility',
        );
        for (const row of await liveRows())
          expect(row.fields).not.toContain('notes');
        expect(result.shares.flatMap((item) => item.fields)).not.toContain(
          'notes',
        );
        for (const groups of [
          ['notes'],
          [],
          ['schedule', 'notes'],
          ['medical'],
          'schedule',
        ]) {
          const refused = await errorOf(
            share(holder().userId, holder().personId, 'accessibility', {
              groups: groups as string[],
            }),
          );
          expect(refused, JSON.stringify(groups)).toBeInstanceOf(
            AccessGrantRefusedError,
          );
          expect((refused as AccessGrantRefusedError).reason).toBe(
            'invalid-groups',
          );
        }
      });

      it('shares only the groups asked for', async () => {
        await suggest(USUAL());
        const result = await share(
          holder().userId,
          holder().personId,
          'accessibility',
          {
            groups: ['schedule'],
          },
        );
        expect(byRole(result.shares)).toEqual({
          [production]: ['noEarlierThan', 'maxWorkingHours'],
        });
        expect(await liveRows()).toHaveLength(1);
      });

      it('skips a group the person left empty, and shares nothing, with no error, for a person who filled in nothing', async () => {
        await suggest(USUAL());
        // No environment fields: the camera role gets the physical ones only.
        const result = await share(
          scene.users.coordinator,
          crew().personId,
          'accessibility',
          { consent: CONSENT },
        );
        expect(byRole(result.shares)).toEqual({
          [production]: ['breakEveryMinutes', 'seatingNeeded'],
          [camera]: ['seatingNeeded'],
        });
        await db().delete(accessGrant);
        // A person with no data at all.
        const nobody = await seedPerson(database, scene.organisationId, {
          displayName: 'Ines Kovac',
        });
        await engagePerson(
          database,
          scene.organisationId,
          scene.projectId,
          nobody,
        );
        const empty = await share(
          scene.users.coordinator,
          nobody,
          'accessibility',
          {
            consent: CONSENT,
          },
        );
        expect(empty).toEqual({ preview: false, shares: [], granted: 0 });
        expect(await liveRows()).toEqual([]);
      });

      it('skips a suggested role the project cannot give, and a setting that is wrong in any way shares nothing', async () => {
        const foreign = await seedOrganisation(database);
        const foreignRole = await seedRole(
          database,
          foreign.organisationId,
          'foreign',
          [],
        );
        const gone = await seedRole(database, scene.organisationId, 'gone', []);
        await db()
          .update(role)
          .set({ deletedAt: NOW })
          .where(eq(role.id, gone));
        await suggest({
          schedule: [production, foreignRole, gone],
          physical: 'everyone',
          environment: ['not an id'],
          medical: { production },
          notes: [production],
          diagnosis: [production],
        });
        const result = await share(
          holder().userId,
          holder().personId,
          'accessibility',
        );
        expect(byRole(result.shares)).toEqual({
          [production]: ['noEarlierThan', 'maxWorkingHours'],
        });
        await suggest('not an object');
        expect(
          (await share(holder().userId, holder().personId, 'accessibility'))
            .shares,
        ).toEqual([]);
        await suggest(undefined);
        expect(
          (await share(holder().userId, holder().personId, 'accessibility'))
            .shares,
        ).toEqual([]);
      });

      it('replaces the live grant of a role it covers, and leaves a role it does not cover alone', async () => {
        await suggest({ schedule: [production] });
        const person = ctxFor(holder().userId);
        await createAccessGrant(db(), person, {
          projectId: scene.projectId,
          personId: holder().personId,
          category: 'accessibility',
          roleId: production,
          fields: ['notes', 'quietSpace'],
        });
        await createAccessGrant(db(), person, {
          projectId: scene.projectId,
          personId: holder().personId,
          category: 'accessibility',
          roleId: camera,
          fields: ['notes'],
        });
        const result = await share(
          holder().userId,
          holder().personId,
          'accessibility',
        );
        expect(result.granted).toBe(1);
        const live = Object.fromEntries(
          (await liveRows()).map((row) => [row.roleId, row.fields]),
        );
        expect(live).toEqual({
          [production]: ['noEarlierThan', 'maxWorkingHours'],
          [camera]: ['notes'],
        });
      });

      it('audits a call that shared nothing as a use with a count of none', async () => {
        await suggest(undefined);
        const seen = (await events('access.shortcut-used')).length;
        await share(holder().userId, holder().personId, 'accessibility');
        const [used] = (await events('access.shortcut-used')).slice(seen);
        expect(used?.details).toMatchObject({ count: 0 });
      });
    });

    describe('medical data', () => {
      it('shares the fields filled in, without notes, with the roles suggested for medical', async () => {
        await suggest(USUAL());
        const result = await share(
          holder().userId,
          holder().personId,
          'medical',
        );
        expect(byRole(result.shares)).toEqual({
          [production]: ['conditions', 'medication'],
        });
        const [row] = await liveRows();
        expect(row).toMatchObject({ category: 'medical', roleId: production });
        expect(row!.fields).not.toContain('notes');
      });

      it('takes no group of adjustments', async () => {
        await suggest(USUAL());
        const refused = await errorOf(
          share(holder().userId, holder().personId, 'medical', {
            groups: ['schedule'],
          }),
        );
        expect((refused as AccessGrantRefusedError).reason).toBe(
          'invalid-groups',
        );
      });
    });

    describe('who may', () => {
      it('is the person, or staff who edit for a person without an account, with the consent for a call that writes', async () => {
        await suggest(USUAL());
        // Staff may preview without it, and may not confirm without it.
        const preview = await share(
          scene.users.coordinator,
          crew().personId,
          'accessibility',
          {
            preview: true,
          },
        );
        expect(preview.shares.length).toBeGreaterThan(0);
        const refused = await errorOf(
          share(scene.users.coordinator, crew().personId, 'accessibility'),
        );
        expect((refused as AccessGrantRefusedError).reason).toBe(
          'consent-required',
        );
        expect(await liveRows()).toEqual([]);
        const done = await share(
          scene.users.coordinator,
          crew().personId,
          'accessibility',
          {
            consent: CONSENT,
          },
        );
        expect(done.granted).toBe(2);
        for (const row of await liveRows()) {
          expect(row).toMatchObject({
            onBehalf: true,
            consentMethod: 'email',
            consentAt: CONSENT.at,
            grantedBy: scene.users.coordinator,
          });
        }
        // The person themselves give none.
        const own = await errorOf(
          share(holder().userId, holder().personId, 'accessibility', {
            consent: CONSENT,
          }),
        );
        expect((own as AccessGrantRefusedError).reason).toBe(
          'consent-not-allowed',
        );
      });

      it('is denied to everyone else, preview or not: read-only staff, an owner, an administrator, a stranger, and staff for a person with an account', async () => {
        await suggest(USUAL());
        const attempts: [string, string][] = [
          [scene.users.producer, crew().personId],
          [scene.users.owner, crew().personId],
          [scene.users.admin, holder().personId],
          [scene.users.stranger, holder().personId],
          [scene.users.coordinator, holder().personId],
        ];
        for (const [userId, personId] of attempts) {
          for (const preview of [true, false]) {
            await expect(
              share(userId, personId, 'accessibility', {
                preview,
                consent: CONSENT,
              }),
            ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
          }
        }
        expect(await liveRows()).toEqual([]);
      });

      it('is refused on a project that is wrapped or closed, and for a person who is not on it', async () => {
        await suggest(USUAL());
        await updateProject(database, scene.projectId, { status: 'delivered' });
        const closed = await errorOf(
          share(holder().userId, holder().personId, 'accessibility', {
            preview: true,
          }),
        );
        expect((closed as AccessGrantRefusedError).reason).toBe(
          'project-closed',
        );
        await updateProject(database, scene.projectId, {
          status: 'development',
        });
        const away = await seedPerson(database, scene.organisationId, {
          displayName: 'Petra Lind',
        });
        const notOn = await errorOf(
          share(scene.users.coordinator, away, 'accessibility', {
            preview: true,
          }),
        );
        expect((notOn as AccessGrantRefusedError).reason).toBe(
          'person-not-on-project',
        );
      });
    });
  },
);
