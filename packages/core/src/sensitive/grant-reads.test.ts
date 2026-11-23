import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { seedUser } from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import { accessGrant, auditEvent, settingValue } from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { createAccessProfile } from './access-profile.js';
import {
  createAccessGrant,
  revokeAccessGrant,
  type AccessConsent,
} from './access-grants.js';
import { SensitiveAccessDeniedError } from './errors.js';
import { leafStrings, VALID_PAYLOADS } from './payload-fixtures.js';
import { editPermissionKey, readPermissionKey } from './permissions.js';
import { ACCESS_FIELDS, type SensitiveCategory } from './schemas.js';
import { readSensitive, writeSensitive } from './service.js';
import {
  ctxFor,
  joinProject,
  NOW,
  seedAccessScene,
  seedRole,
  tokenFor,
  turnTokensOn,
  type AccessScene,
} from './test-support.js';

/**
 * How `accessibility` and `medical` are read (decision D-69): the person themselves read
 * all of it, staff who edit the record of a person without an account read all of it, and
 * everyone else who holds the read permission reads only the fields that live grants to a
 * role they hold cover, or is denied. The permission alone is never enough; the same rule
 * holds for a personal API token, through its sensitive scope. Dietary and emergency data
 * are read as they always were.
 */

const CONSENT: AccessConsent = {
  method: 'in-person',
  at: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
};
const HOLDER_PROFILE = VALID_PAYLOADS.accessibility;
const HOLDER_MEDICAL = VALID_PAYLOADS.medical;
/** The production record of the person without an account: invented, and none of it in the profile above. */
const CREW_ACCESS = {
  breakEveryMinutes: 90,
  seatingNeeded: true,
  extraThinkingTime: true,
  notes: 'Mornings are hard; please give the call time the night before',
};
const CREW_MEDICAL = {
  conditions: 'Migraine',
  medication: 'Prescribed, kept in a bag',
  notes: 'Needs a dark room for an hour at a time',
};

describe.each(testTargets)('reading access needs on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  let scene: AccessScene;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    scene = await seedAccessScene(database);
    const { holder, crew } = scene.people;
    await createAccessProfile(
      database.db,
      ctxFor(holder.userId),
      holder.userId,
      HOLDER_PROFILE,
    );
    await writeSensitive(
      database.db,
      ctxFor(holder.userId),
      holder.personId,
      'medical',
      HOLDER_MEDICAL,
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
  });

  const db = () => database.db;
  const holder = () => scene.people.holder;
  const crew = () => scene.people.crew;

  /** The person with an account grants `fields` of `category` to a role of the project. */
  const grantAsHolder = (
    roleId: string,
    fields: string[],
    category: 'accessibility' | 'medical' = 'accessibility',
  ) =>
    createAccessGrant(db(), ctxFor(holder().userId), {
      projectId: scene.projectId,
      personId: holder().personId,
      category,
      roleId,
      fields,
    });
  /** Staff record that the person without an account agreed to share `fields`. */
  const grantForCrew = (
    roleId: string,
    fields: string[],
    category: 'accessibility' | 'medical' = 'accessibility',
  ) =>
    createAccessGrant(db(), ctxFor(scene.users.coordinator), {
      projectId: scene.projectId,
      personId: crew().personId,
      category,
      roleId,
      fields,
      consent: CONSENT,
    });
  const read = (
    userId: string,
    personId: string,
    category: SensitiveCategory,
    credential?: ReturnType<typeof tokenFor>,
  ) =>
    readSensitive(
      db(),
      ctxFor(userId, credential === undefined ? {} : { credential }),
      personId,
      category,
    );
  const events = async (category: string) =>
    (await db().select().from(auditEvent))
      .filter((event) => event.category === category)
      .sort((a, b) => a.id.localeCompare(b.id));

  describe('the permission alone', () => {
    it('is not enough: a holder of the read permission with no grant is denied, for both categories and both kinds of person, and the denial is audited', async () => {
      const seen = (await events('sensitive.denied')).length;
      const readsSeen = (await events('sensitive.read')).length;
      let attempts = 0;
      for (const personId of [holder().personId, crew().personId]) {
        for (const category of ['accessibility', 'medical'] as const) {
          await expect(
            read(scene.users.producer, personId, category),
          ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
          attempts += 1;
        }
      }
      const denied = (await events('sensitive.denied')).slice(seen);
      expect(denied).toHaveLength(attempts);
      expect(denied[0]).toMatchObject({
        action: 'read',
        actorId: scene.users.producer,
        targetType: 'person',
        organisationId: scene.organisationId,
      });
      // Nothing was read: no read event came with a denial.
      expect((await events('sensitive.read')).length).toBe(readsSeen);
    });

    it('gets an organisation owner, an administrator, a stranger and a member of another project nothing, grants or not', async () => {
      await grantAsHolder(scene.roles.production, ['stepFreeRequired']);
      for (const other of [
        scene.users.owner,
        scene.users.admin,
        scene.users.stranger,
        scene.users.elsewhere,
      ]) {
        await expect(
          read(other, holder().personId, 'accessibility'),
        ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
      }
    });

    it('is the same denial for a person who does not exist', async () => {
      await expect(
        read(
          scene.users.producer,
          '0199a3c4-0000-7000-8000-00000000dead',
          'accessibility',
        ),
      ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
    });
  });

  describe('through grants', () => {
    it('gives back only the granted fields, from the profile of a person with an account, with the count in the audit event and no names', async () => {
      await grantAsHolder(scene.roles.production, [
        'stepFreeRequired',
        'quietSpace',
      ]);
      const seen = (await events('sensitive.read')).length;
      const record = await read(
        scene.users.producer,
        holder().personId,
        'accessibility',
      );
      expect(record?.payload).toEqual({
        stepFreeRequired: true,
        quietSpace: true,
      });
      // None of what was not granted came with it, notes and sign language included.
      expect(JSON.stringify(record)).not.toContain('hr-HR-SL');
      expect(JSON.stringify(record)).not.toContain('ground-floor');
      const [event] = (await events('sensitive.read')).slice(seen);
      expect(event).toMatchObject({
        actorId: scene.users.producer,
        details: { category: 'accessibility', fieldCount: 2 },
      });
      expect(Object.keys(event!.details!).sort()).toEqual([
        'category',
        'fieldCount',
      ]);
    });

    it('gives back only the granted fields of a person without an account, from the production record', async () => {
      await grantForCrew(scene.roles.production, [
        'seatingNeeded',
        'notes',
        // Granted and not filled in: nothing to give back for it.
        'quietSpace',
      ]);
      const record = await read(
        scene.users.producer,
        crew().personId,
        'accessibility',
      );
      expect(record?.payload).toEqual({
        seatingNeeded: true,
        notes: CREW_ACCESS.notes,
      });
    });

    it('gives back nothing, and no error, when none of the granted fields is filled in, and says so in the count', async () => {
      await grantAsHolder(scene.roles.production, ['previewLocation']);
      const seen = (await events('sensitive.read')).length;
      expect(
        await read(scene.users.producer, holder().personId, 'accessibility'),
      ).toBeNull();
      const [event] = (await events('sensitive.read')).slice(seen);
      expect(event?.details).toMatchObject({ fieldCount: 0 });
    });

    it('combines the fields of two roles a reader holds, and gives each role only its own', async () => {
      await grantAsHolder(scene.roles.production, ['stepFreeRequired']);
      await grantAsHolder(scene.roles.camera, ['quietSpace', 'maxWalkMetres']);
      const both = await read(
        scene.users.both,
        holder().personId,
        'accessibility',
      );
      expect(both?.payload).toEqual({
        stepFreeRequired: true,
        quietSpace: true,
        maxWalkMetres: 100,
      });
      expect(
        (await read(scene.users.producer, holder().personId, 'accessibility'))
          ?.payload,
      ).toEqual({ stepFreeRequired: true });
      expect(
        (await read(scene.users.cameraLead, holder().personId, 'accessibility'))
          ?.payload,
      ).toEqual({ quietSpace: true, maxWalkMetres: 100 });
    });

    it('is denied to a reader who holds the permission but not a role that a grant names', async () => {
      await grantAsHolder(scene.roles.production, ['stepFreeRequired']);
      for (const other of [scene.users.plainReader, scene.users.cameraLead]) {
        await expect(
          read(other, holder().personId, 'accessibility'),
        ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
      }
    });

    it('opens only on the grant’s project: a role held on another project reads nothing', async () => {
      await grantAsHolder(scene.roles.production, ['stepFreeRequired']);
      // The same role, on another project, with the same permissions there.
      await expect(
        read(scene.users.elsewhere, holder().personId, 'accessibility'),
      ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
    });

    it('needs the read permission as well as the role: a role a grant names but whose holder cannot read opens nothing', async () => {
      // `camera` holds the accessibility permission only, so a medical grant to it opens nothing.
      await grantAsHolder(scene.roles.camera, ['conditions'], 'medical');
      await expect(
        read(scene.users.cameraLead, holder().personId, 'medical'),
      ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
    });

    it('needs the role in an active membership: an invited or ended membership opens nothing', async () => {
      await grantAsHolder(scene.roles.production, ['stepFreeRequired']);
      for (const status of ['invited', 'ended'] as const) {
        const later = await seedUser(database);
        await joinProject(
          database,
          scene.organisationId,
          scene.projectId,
          later,
          [scene.roles.production],
          { status },
        );
        await expect(
          read(later, holder().personId, 'accessibility'),
        ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
      }
    });

    it('follows the same rule for medical data', async () => {
      await grantAsHolder(scene.roles.production, ['conditions'], 'medical');
      await grantForCrew(scene.roles.production, ['medication'], 'medical');
      expect(
        (await read(scene.users.producer, holder().personId, 'medical'))
          ?.payload,
      ).toEqual({ conditions: HOLDER_MEDICAL.conditions });
      expect(
        (await read(scene.users.producer, crew().personId, 'medical'))?.payload,
      ).toEqual({ medication: CREW_MEDICAL.medication });
    });

    it('opens no medical data through a grant of accessibility fields, and the other way round', async () => {
      await grantAsHolder(scene.roles.production, ['stepFreeRequired']);
      await expect(
        read(scene.users.producer, holder().personId, 'medical'),
      ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
      await db().delete(accessGrant);
      await grantAsHolder(scene.roles.production, ['conditions'], 'medical');
      await expect(
        read(scene.users.producer, holder().personId, 'accessibility'),
      ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
    });

    it('stops at once when the grant is revoked, with no waiting for anything', async () => {
      await grantAsHolder(scene.roles.production, ['stepFreeRequired']);
      expect(
        await read(scene.users.producer, holder().personId, 'accessibility'),
      ).not.toBeNull();
      await revokeAccessGrant(db(), ctxFor(holder().userId), {
        projectId: scene.projectId,
        personId: holder().personId,
        category: 'accessibility',
        roleId: scene.roles.production,
      });
      await expect(
        read(scene.users.producer, holder().personId, 'accessibility'),
      ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
    });

    it('follows a changed grant: replacing the fields changes what is read', async () => {
      await grantAsHolder(scene.roles.production, ['stepFreeRequired']);
      await grantAsHolder(scene.roles.production, ['maxWorkingHours']);
      expect(
        (await read(scene.users.producer, holder().personId, 'accessibility'))
          ?.payload,
      ).toEqual({ maxWorkingHours: 10 });
    });
  });

  describe('the person and the staff who edit', () => {
    it('reads all of their own data, whatever is granted', async () => {
      expect(
        (await read(holder().userId, holder().personId, 'accessibility'))
          ?.payload,
      ).toEqual(HOLDER_PROFILE);
      expect(
        (await read(holder().userId, holder().personId, 'medical'))?.payload,
      ).toEqual(HOLDER_MEDICAL);
    });

    it('lets staff who edit read the whole record of a person without an account, with no grant', async () => {
      const coordinator = scene.users.coordinator;
      expect(
        (await read(coordinator, crew().personId, 'accessibility'))?.payload,
      ).toEqual(CREW_ACCESS);
      expect(
        (await read(coordinator, crew().personId, 'medical'))?.payload,
      ).toEqual(CREW_MEDICAL);
    });

    it('does not let staff who edit read a person with an account without a grant, though they may write the production’s record of medical data', async () => {
      const coordinator = scene.users.coordinator;
      await expect(
        read(coordinator, holder().personId, 'accessibility'),
      ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
      await expect(
        read(coordinator, holder().personId, 'medical'),
      ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
      // With a grant to a role they hold, they read what it covers, as anyone does.
      await grantAsHolder(scene.roles.coordinator, ['medication'], 'medical');
      expect(
        (await read(coordinator, holder().personId, 'medical'))?.payload,
      ).toEqual({ medication: HOLDER_MEDICAL.medication });
    });
  });

  describe('dietary and emergency data', () => {
    it('are read as they always were: the permission is enough, and no grant is needed', async () => {
      const kitchen = await seedRole(
        database,
        scene.organisationId,
        'kitchen',
        [
          readPermissionKey('dietary'),
          readPermissionKey('emergency'),
          editPermissionKey('dietary'),
          editPermissionKey('emergency'),
        ],
      );
      const cook = await seedUser(database);
      await joinProject(database, scene.organisationId, scene.projectId, cook, [
        kitchen,
      ]);
      await writeSensitive(
        db(),
        ctxFor(cook),
        crew().personId,
        'dietary',
        VALID_PAYLOADS.dietary,
        { legalBasis: 'consent' },
      );
      await writeSensitive(
        db(),
        ctxFor(cook),
        crew().personId,
        'emergency',
        VALID_PAYLOADS.emergency,
        { legalBasis: 'consent' },
      );
      const seen = (await events('sensitive.read')).length;
      expect((await read(cook, crew().personId, 'dietary'))?.payload).toEqual(
        VALID_PAYLOADS.dietary,
      );
      expect((await read(cook, crew().personId, 'emergency'))?.payload).toEqual(
        VALID_PAYLOADS.emergency,
      );
      // The events are as they were: the category, and no count.
      const fresh = (await events('sensitive.read')).slice(seen);
      expect(fresh.map((event) => event.details)).toEqual([
        { category: 'dietary' },
        { category: 'emergency' },
      ]);
    });
  });

  describe('through a personal API token', () => {
    const scope = ['sensitive:read:accessibility', 'sensitive:read:medical'];

    it('sees what its owner sees through grants, and no more: only the granted fields', async () => {
      await grantAsHolder(scene.roles.production, ['stepFreeRequired']);
      const token = tokenFor(scene.organisationId, scope);
      const seen = (await events('sensitive.read')).length;
      const record = await read(
        scene.users.producer,
        holder().personId,
        'accessibility',
        token,
      );
      expect(record?.payload).toEqual({ stepFreeRequired: true });
      const [event] = (await events('sensitive.read')).slice(seen);
      expect(event).toMatchObject({
        actorType: 'token',
        actorId: token.tokenId,
        details: {
          category: 'accessibility',
          fieldCount: 1,
          tokenId: token.tokenId,
          userId: scene.users.producer,
        },
      });
    });

    it('is denied when nothing is granted, with the scope or without it, and when its owner holds no granted role', async () => {
      await grantAsHolder(scene.roles.production, ['stepFreeRequired']);
      // Functions, not promises: a promise that rejects before its handler is attached is an
      // unhandled rejection, which on PostgreSQL's pool, where the reads overlap, fails the run.
      const refused = [
        // No grant for this person of this category.
        () =>
          read(
            scene.users.producer,
            crew().personId,
            'accessibility',
            tokenFor(scene.organisationId, scope),
          ),
        // The scope does not list the key.
        () =>
          read(
            scene.users.producer,
            holder().personId,
            'accessibility',
            tokenFor(scene.organisationId, ['sensitive:read:medical']),
          ),
        () =>
          read(
            scene.users.producer,
            holder().personId,
            'accessibility',
            tokenFor(scene.organisationId, []),
          ),
        // The owner holds a permission, and no role a grant names.
        () =>
          read(
            scene.users.plainReader,
            holder().personId,
            'accessibility',
            tokenFor(scene.organisationId, scope),
          ),
      ];
      for (const attempt of refused) {
        await expect(attempt()).rejects.toBeInstanceOf(
          SensitiveAccessDeniedError,
        );
      }
    });

    it('does not take the whole record of a person without an account through its owner’s edit permission, because a read token does not carry it: grants still apply', async () => {
      const coordinatorToken = tokenFor(scene.organisationId, [
        'sensitive:read:accessibility',
      ]);
      // The owner reads the whole record with a session; the token needs a grant.
      await expect(
        read(
          scene.users.coordinator,
          crew().personId,
          'accessibility',
          coordinatorToken,
        ),
      ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
      await grantForCrew(scene.roles.coordinator, ['seatingNeeded']);
      expect(
        (
          await read(
            scene.users.coordinator,
            crew().personId,
            'accessibility',
            coordinatorToken,
          )
        )?.payload,
      ).toEqual({ seatingNeeded: true });
    });

    it('never takes the person’s own way in: a token reads nobody’s data as its owner’s own', async () => {
      for (const sensitivePermissions of [[], scope]) {
        await expect(
          read(
            holder().userId,
            holder().personId,
            'accessibility',
            tokenFor(scene.organisationId, sensitivePermissions),
          ),
        ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
      }
    });

    it('is refused when the organisation turns the sensitive switch off', async () => {
      await grantAsHolder(scene.roles.production, ['stepFreeRequired']);
      await db().delete(settingValue);
      await expect(
        read(
          scene.users.producer,
          holder().personId,
          'accessibility',
          tokenFor(scene.organisationId, scope),
        ),
      ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
      await turnTokensOn(database, scene.organisationId);
    });
  });

  describe('the trail of reads and refusals', () => {
    it('counts fields and never names them: nothing in a read or denial event holds a field name or a stored value', async () => {
      await grantAsHolder(scene.roles.production, ['stepFreeRequired']);
      await grantForCrew(scene.roles.production, ['notes', 'seatingNeeded']);
      await read(scene.users.producer, holder().personId, 'accessibility');
      await read(scene.users.producer, crew().personId, 'accessibility');
      await read(holder().userId, holder().personId, 'medical');
      await read(scene.users.coordinator, crew().personId, 'medical');
      await read(
        scene.users.plainReader,
        crew().personId,
        'accessibility',
      ).catch(() => undefined);
      const everything = [
        ...(await events('sensitive.read')),
        ...(await events('sensitive.denied')),
      ];
      expect(everything.length).toBeGreaterThan(4);
      const text = JSON.stringify(everything);
      for (const entry of ACCESS_FIELDS) expect(text).not.toContain(entry.key);
      for (const payload of [
        HOLDER_PROFILE,
        HOLDER_MEDICAL,
        CREW_ACCESS,
        CREW_MEDICAL,
      ]) {
        for (const value of leafStrings(payload)) {
          expect(text).not.toContain(value);
        }
      }
      for (const name of ['conditions', 'medication']) {
        expect(text).not.toContain(name);
      }
    });
  });
});
