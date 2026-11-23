import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { seedOrganisation } from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import {
  accessGrant,
  auditEvent,
  projectPerson,
  role,
} from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { RecordNotFoundError } from '../db/write.js';
import {
  createAccessGrant,
  revokeAccessGrant,
  type AccessConsent,
  type AccessGrantInput,
} from './access-grants.js';
import {
  AccessGrantRefusedError,
  RoleNotAvailableError,
  SensitiveAccessDeniedError,
} from './errors.js';
import { VALID_PAYLOADS } from './payload-fixtures.js';
import { ACCESS_FIELDS, MEDICAL_FIELDS } from './schemas.js';
import {
  ctxFor,
  NOW,
  seedAccessScene,
  seedRole,
  tokenFor,
  updateProject,
  type AccessScene,
} from './test-support.js';

/**
 * Access grants (decision D-69): default deny, per field and per role. The person grants
 * for themselves when they have an account; staff record it for someone without one, with
 * how and when the person agreed. A role has one live grant, a revoked grant opens nothing
 * from that moment, and nothing in the audit trail names a field, a value or a note.
 */

/** A note that holds a distinctive sentence, to look for in places it must never be. */
const NOTE = 'Told us on the phone after the recce, in her own words';
const CONSENT: AccessConsent = {
  method: 'phone',
  at: new Date(NOW.getTime() - 60 * 60 * 1000),
  note: NOTE,
};

describe.each(testTargets)('access grants on $name', (target) => {
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

  /** A grant of the account holder's, to the production role, of two fields. */
  const forHolder = (
    over: Partial<AccessGrantInput> = {},
  ): AccessGrantInput => ({
    projectId: scene.projectId,
    personId: holder().personId,
    category: 'accessibility',
    roleId: scene.roles.production,
    fields: ['stepFreeRequired', 'maxWalkMetres'],
    ...over,
  });
  /** A grant for the person without an account, which staff record. */
  const forCrew = (over: Partial<AccessGrantInput> = {}): AccessGrantInput => ({
    ...forHolder({ personId: crew().personId, consent: CONSENT }),
    ...over,
  });

  const rows = async () => db().select().from(accessGrant);
  const liveRows = async () =>
    (await rows()).filter((row) => row.revokedAt === null);
  const events = async (category?: string) =>
    (await db().select().from(auditEvent))
      .filter((event) => category === undefined || event.category === category)
      .sort((a, b) => a.id.localeCompare(b.id));
  /** How many events of a category there are now. The audit trail is append-only and the database is shared, so a test reads the ones after this. */
  const countOf = async (category: string) => (await events(category)).length;
  const errorOf = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (caught: unknown) => caught,
    );

  describe('for a person with an account', () => {
    it('is made by the person themselves, with no consent record, and audited with ids and counts', async () => {
      const seen = await countOf('access.grant-created');
      const made = await createAccessGrant(
        db(),
        ctxFor(holder().userId),
        forHolder(),
      );
      expect(made).toMatchObject({
        projectId: scene.projectId,
        personId: holder().personId,
        category: 'accessibility',
        roleId: scene.roles.production,
        fields: ['stepFreeRequired', 'maxWalkMetres'],
        onBehalf: false,
        replaced: false,
      });
      const [row] = await liveRows();
      expect(row).toMatchObject({
        id: made.id,
        organisationId: scene.organisationId,
        grantedBy: holder().userId,
        grantedAt: NOW,
        onBehalf: false,
        consentMethod: null,
        consentAt: null,
        consentNote: null,
        revokedAt: null,
        retentionClass: 'crew-health',
      });
      const [created] = (await events('access.grant-created')).slice(seen);
      expect(created).toMatchObject({
        actorType: 'user',
        actorId: holder().userId,
        organisationId: scene.organisationId,
        projectId: scene.projectId,
        targetType: 'access_grant',
        targetId: made.id,
        details: {
          personId: holder().personId,
          category: 'accessibility',
          roleId: scene.roles.production,
          fieldCount: 2,
          onBehalf: false,
        },
      });
    });

    it('is refused to everyone else, staff who edit, an organisation owner and administrator included, and the refusal is audited', async () => {
      const others = [
        scene.users.coordinator,
        scene.users.producer,
        scene.users.owner,
        scene.users.admin,
        scene.users.stranger,
      ];
      const seen = await countOf('sensitive.denied');
      for (const other of others) {
        await expect(
          createAccessGrant(db(), ctxFor(other), forHolder()),
        ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
        // With consent, as staff would send it: it makes no difference.
        await expect(
          createAccessGrant(
            db(),
            ctxFor(other),
            forHolder({ consent: CONSENT }),
          ),
        ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
      }
      expect(await rows()).toEqual([]);
      const denied = (await events('sensitive.denied')).slice(seen);
      expect(denied.length).toBe(others.length * 2);
      expect(denied.every((event) => event.action === 'grant')).toBe(true);
      expect(denied[0]).toMatchObject({
        targetType: 'person',
        targetId: holder().personId,
        details: { category: 'accessibility' },
      });
    });

    it('is not made through the person’s own personal API token: a token never takes their own way in', async () => {
      for (const sensitivePermissions of [
        [],
        ['sensitive:edit:accessibility', 'sensitive:read:accessibility'],
      ]) {
        await expect(
          createAccessGrant(
            db(),
            ctxFor(holder().userId, {
              credential: tokenFor(scene.organisationId, sensitivePermissions, {
                access: 'write',
              }),
            }),
            forHolder(),
          ),
        ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
      }
      expect(await rows()).toEqual([]);
    });

    it('allows no consent record: the grant is the person’s own act', async () => {
      const refused = await errorOf(
        createAccessGrant(
          db(),
          ctxFor(holder().userId),
          forHolder({ consent: CONSENT }),
        ),
      );
      expect(refused).toBeInstanceOf(AccessGrantRefusedError);
      expect((refused as AccessGrantRefusedError).reason).toBe(
        'consent-not-allowed',
      );
      expect(await rows()).toEqual([]);
    });

    it('can be revoked by the person only: staff who edit get a refusal', async () => {
      await createAccessGrant(db(), ctxFor(holder().userId), forHolder());
      const seen = await countOf('access.grant-revoked');
      const key = {
        projectId: scene.projectId,
        personId: holder().personId,
        category: 'accessibility' as const,
        roleId: scene.roles.production,
      };
      // Staff who edit hold the permission, but the grant is the person's own: it is
      // the same answer as for a grant that is not there.
      await expect(
        revokeAccessGrant(db(), ctxFor(scene.users.coordinator), key),
      ).rejects.toBeInstanceOf(RecordNotFoundError);
      for (const other of [
        scene.users.producer,
        scene.users.owner,
        scene.users.admin,
        scene.users.stranger,
      ]) {
        await expect(
          revokeAccessGrant(db(), ctxFor(other), key),
        ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
      }
      expect(await liveRows()).toHaveLength(1);
      await revokeAccessGrant(db(), ctxFor(holder().userId), key);
      expect(await liveRows()).toEqual([]);
      const [revoked] = (await events('access.grant-revoked')).slice(seen);
      expect(revoked).toMatchObject({
        action: 'revoke',
        actorId: holder().userId,
        details: {
          personId: holder().personId,
          category: 'accessibility',
          roleId: scene.roles.production,
          onBehalf: false,
          reason: 'revoked',
        },
      });
    });
  });

  describe('for a person without an account, recorded by staff', () => {
    it('is recorded by a holder of the edit permission, with how and when the person agreed', async () => {
      const made = await createAccessGrant(
        db(),
        ctxFor(scene.users.coordinator),
        forCrew(),
      );
      expect(made.onBehalf).toBe(true);
      const [row] = await liveRows();
      expect(row).toMatchObject({
        id: made.id,
        personId: crew().personId,
        grantedBy: scene.users.coordinator,
        onBehalf: true,
        consentMethod: 'phone',
        consentAt: CONSENT.at,
        consentNote: NOTE,
      });
    });

    it('needs the edit permission on the project: read-only staff, an owner, an administrator and a stranger are refused', async () => {
      for (const other of [
        scene.users.producer,
        scene.users.plainReader,
        scene.users.elsewhere,
        scene.users.owner,
        scene.users.admin,
        scene.users.stranger,
      ]) {
        await expect(
          createAccessGrant(db(), ctxFor(other), forCrew()),
        ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
      }
      expect(await rows()).toEqual([]);
    });

    it('needs the consent: how and when the person agreed, and refuses a missing or unusable record, each audited with a reason code', async () => {
      const seen = await countOf('access.refused');
      const refusals: [Partial<AccessGrantInput>, string][] = [
        [{ consent: undefined }, 'consent-required'],
        [
          {
            consent: { ...CONSENT, method: 'telepathy' as 'phone' },
          },
          'consent-invalid',
        ],
        [
          {
            consent: { ...CONSENT, at: new Date(NOW.getTime() + 60_000) },
          },
          'consent-invalid',
        ],
        [
          { consent: { ...CONSENT, at: new Date('not a date') } },
          'consent-invalid',
        ],
        [{ consent: { ...CONSENT, note: 'n'.repeat(201) } }, 'consent-invalid'],
        [{ consent: { ...CONSENT, note: '' } }, 'consent-invalid'],
      ];
      for (const [over, reason] of refusals) {
        const refused = await errorOf(
          createAccessGrant(
            db(),
            ctxFor(scene.users.coordinator),
            forCrew(over),
          ),
        );
        expect(refused, reason).toBeInstanceOf(AccessGrantRefusedError);
        expect((refused as AccessGrantRefusedError).reason).toBe(reason);
      }
      expect(await rows()).toEqual([]);
      const logged = (await events('access.refused')).slice(seen);
      expect(logged.map((event) => event.action)).toEqual(
        refusals.map(([, reason]) => reason),
      );
      for (const event of logged) {
        expect(event.details).toMatchObject({ category: 'accessibility' });
        expect(Object.keys(event.details!).sort()).toEqual([
          'category',
          'reason',
        ]);
      }
    });

    it('accepts a note of up to 200 characters, or none, and every way the person may have agreed', async () => {
      for (const method of [
        'in-person',
        'phone',
        'email',
        'written',
        'other',
      ] as const) {
        await createAccessGrant(
          db(),
          ctxFor(scene.users.coordinator),
          forCrew({ consent: { method, at: CONSENT.at } }),
        );
      }
      await createAccessGrant(
        db(),
        ctxFor(scene.users.coordinator),
        forCrew({ consent: { ...CONSENT, note: 'n'.repeat(200) } }),
      );
      const [row] = await liveRows();
      expect(row?.consentNote).toHaveLength(200);
    });

    it('is made through a token of the staff member only with the edit key in its scope and the right to write', async () => {
      const coordinator = scene.users.coordinator;
      const scoped = tokenFor(
        scene.organisationId,
        ['sensitive:edit:accessibility'],
        { access: 'write' },
      );
      // A read token cannot hold a write permission, and one without the key cannot pass it.
      for (const credential of [
        tokenFor(scene.organisationId, ['sensitive:edit:accessibility']),
        tokenFor(scene.organisationId, [], { access: 'write' }),
      ]) {
        await expect(
          createAccessGrant(
            db(),
            ctxFor(coordinator, { credential }),
            forCrew(),
          ),
        ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
      }
      const seen = await countOf('access.grant-created');
      await createAccessGrant(
        db(),
        ctxFor(coordinator, { credential: scoped }),
        forCrew(),
      );
      const [created] = (await events('access.grant-created')).slice(seen);
      expect(created).toMatchObject({
        actorType: 'token',
        actorId: scoped.tokenId,
        details: { tokenId: scoped.tokenId, userId: coordinator },
      });
      // The grant is the owner's own: they recorded it, as a token for them.
      expect((await liveRows())[0]?.grantedBy).toBe(coordinator);
    });

    it('can be revoked by staff who edit, and not by anyone else', async () => {
      await createAccessGrant(db(), ctxFor(scene.users.coordinator), forCrew());
      const key = {
        projectId: scene.projectId,
        personId: crew().personId,
        category: 'accessibility' as const,
        roleId: scene.roles.production,
      };
      for (const other of [scene.users.producer, scene.users.stranger]) {
        await expect(
          revokeAccessGrant(db(), ctxFor(other), key),
        ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
      }
      await revokeAccessGrant(db(), ctxFor(scene.users.coordinator), key);
      expect(await liveRows()).toEqual([]);
      // Nothing is left to revoke.
      await expect(
        revokeAccessGrant(db(), ctxFor(scene.users.coordinator), key),
      ).rejects.toBeInstanceOf(RecordNotFoundError);
    });
  });

  describe('the role', () => {
    it('is refused with one answer, whether it is missing, deleted, another organisation’s or another project’s', async () => {
      const foreign = await seedOrganisation(database);
      const foreignRole = await seedRole(
        database,
        foreign.organisationId,
        'foreign',
        [],
      );
      const deleted = await seedRole(
        database,
        scene.organisationId,
        'retired',
        [],
      );
      await db()
        .update(role)
        .set({ deletedAt: NOW })
        .where(eq(role.id, deleted));
      const ofAnotherProject = await seedRole(
        database,
        scene.organisationId,
        'second-unit-only',
        [],
        { projectId: scene.otherProjectId },
      );
      const unavailable = [
        '0199a3c4-0000-7000-8000-00000000dead',
        'not an id',
        foreignRole,
        deleted,
        ofAnotherProject,
      ];
      const seen = await countOf('access.refused');
      const answers: string[] = [];
      for (const roleId of unavailable) {
        const refused = await errorOf(
          createAccessGrant(
            db(),
            ctxFor(holder().userId),
            forHolder({ roleId }),
          ),
        );
        expect(refused, roleId).toBeInstanceOf(RoleNotAvailableError);
        answers.push(
          `${(refused as Error).name}: ${(refused as Error).message}`,
        );
      }
      expect(new Set(answers).size).toBe(1);
      // The audit trail is as alike: the same code, and nothing that says which it was.
      const logged = (await events('access.refused')).slice(seen);
      expect(logged).toHaveLength(unavailable.length);
      expect(
        new Set(logged.map((event) => JSON.stringify(event.details))).size,
      ).toBe(1);
      expect(await rows()).toEqual([]);
    });

    it('is accepted when it is an organisation template or a role of this project', async () => {
      const ofThisProject = await seedRole(
        database,
        scene.organisationId,
        'first-unit-only',
        [],
        { projectId: scene.projectId },
      );
      for (const roleId of [scene.roles.production, ofThisProject]) {
        await createAccessGrant(
          db(),
          ctxFor(holder().userId),
          forHolder({ roleId }),
        );
      }
      expect(await liveRows()).toHaveLength(2);
    });
  });

  describe('the fields', () => {
    it('are keys of the category’s payload, each once, and at least one', async () => {
      const refusals: [unknown, string][] = [
        [[], 'empty'],
        [['stepFreeRequired', 'stepFreeRequired'], 'repeated'],
        [['stepFreeRequired', 'diagnosis'], 'not a field'],
        [['conditions'], 'a medical key on an accessibility grant'],
        [['constructor'], 'an inherited name'],
        ['stepFreeRequired', 'not a list'],
        [[5], 'not a string'],
        [undefined, 'missing'],
      ];
      for (const [fields, why] of refusals) {
        const refused = await errorOf(
          createAccessGrant(
            db(),
            ctxFor(holder().userId),
            forHolder({ fields: fields as string[] }),
          ),
        );
        expect(refused, why).toBeInstanceOf(AccessGrantRefusedError);
        expect((refused as AccessGrantRefusedError).reason, why).toBe(
          'invalid-fields',
        );
      }
      // And a medical grant takes the medical keys, not the adjustments.
      const refused = await errorOf(
        createAccessGrant(
          db(),
          ctxFor(holder().userId),
          forHolder({ category: 'medical', fields: ['stepFreeRequired'] }),
        ),
      );
      expect((refused as AccessGrantRefusedError).reason).toBe(
        'invalid-fields',
      );
      expect(await rows()).toEqual([]);
    });

    it('can be every key of either category', async () => {
      await createAccessGrant(
        db(),
        ctxFor(holder().userId),
        forHolder({ fields: ACCESS_FIELDS.map((entry) => entry.key) }),
      );
      await createAccessGrant(
        db(),
        ctxFor(holder().userId),
        forHolder({ category: 'medical', fields: [...MEDICAL_FIELDS] }),
      );
      const live = await liveRows();
      expect(
        live.map((row) => row.fields.length).sort((a, b) => a - b),
      ).toEqual(
        [MEDICAL_FIELDS.length, ACCESS_FIELDS.length].sort((a, b) => a - b),
      );
    });

    it('are granted for the two categories that have grants, and no other', async () => {
      const refused = await errorOf(
        createAccessGrant(
          db(),
          ctxFor(holder().userId),
          forHolder({ category: 'dietary' as 'medical' }),
        ),
      );
      expect(refused).toBeInstanceOf(AccessGrantRefusedError);
      expect((refused as AccessGrantRefusedError).reason).toBe(
        'category-not-grantable',
      );
      await expect(
        createAccessGrant(
          db(),
          ctxFor(holder().userId),
          forHolder({ category: 'tarot' as 'medical' }),
        ),
      ).rejects.toThrow('Unknown sensitive category');
    });
  });

  describe('the project and the person', () => {
    it('is the same refusal for a person or project that does not exist or is another organisation’s', async () => {
      const foreign = await seedOrganisation(database);
      for (const over of [
        { personId: '0199a3c4-0000-7000-8000-00000000dead' },
        { personId: 'not an id' },
        { projectId: '0199a3c4-0000-7000-8000-00000000dead' },
        { projectId: 'not an id' },
        { projectId: foreign.projectId },
      ]) {
        await expect(
          createAccessGrant(db(), ctxFor(holder().userId), forHolder(over)),
        ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);
      }
      expect(await rows()).toEqual([]);
    });

    it('is refused for a person who is not on the project: released, removed, or never engaged', async () => {
      const engagement = async (
        values: Partial<typeof projectPerson.$inferInsert>,
      ) =>
        db()
          .update(projectPerson)
          .set(values)
          .where(
            and(
              eq(projectPerson.personId, holder().personId),
              eq(projectPerson.projectId, scene.projectId),
            ),
          );
      for (const values of [
        { status: 'released' as const },
        { deletedAt: NOW },
      ]) {
        await engagement(values);
        const refused = await errorOf(
          createAccessGrant(db(), ctxFor(holder().userId), forHolder()),
        );
        expect(refused).toBeInstanceOf(AccessGrantRefusedError);
        expect((refused as AccessGrantRefusedError).reason).toBe(
          'person-not-on-project',
        );
        await engagement({ status: 'confirmed', deletedAt: null });
      }
      // Proposed still counts: the person is on the production, if not yet confirmed.
      await engagement({ status: 'proposed' });
      await createAccessGrant(db(), ctxFor(holder().userId), forHolder());
      await engagement({ status: 'confirmed' });
      // Never engaged on the other project.
      const refused = await errorOf(
        createAccessGrant(
          db(),
          ctxFor(holder().userId),
          forHolder({ projectId: scene.otherProjectId }),
        ),
      );
      expect((refused as AccessGrantRefusedError).reason).toBe(
        'person-not-on-project',
      );
    });

    it('is refused on a project that is wrapped or closed, and allowed through the wrap date itself', async () => {
      for (const values of [
        { wrapDate: '2026-11-14' },
        { status: 'delivered' as const },
        { status: 'archived' as const },
      ]) {
        await updateProject(database, scene.projectId, values);
        const refused = await errorOf(
          createAccessGrant(db(), ctxFor(holder().userId), forHolder()),
        );
        expect(refused, JSON.stringify(values)).toBeInstanceOf(
          AccessGrantRefusedError,
        );
        expect((refused as AccessGrantRefusedError).reason).toBe(
          'project-closed',
        );
        await updateProject(database, scene.projectId, {
          wrapDate: null,
          status: 'development',
        });
      }
      await updateProject(database, scene.projectId, {
        wrapDate: '2026-11-15',
      });
      await createAccessGrant(db(), ctxFor(holder().userId), forHolder());
      expect(await liveRows()).toHaveLength(1);
    });
  });

  describe('replacing and revoking', () => {
    it('keeps one live grant per role: a second grant of the same role revokes the first and takes its place', async () => {
      const seen = await countOf('access.grant-revoked');
      const first = await createAccessGrant(
        db(),
        ctxFor(holder().userId),
        forHolder(),
      );
      const second = await createAccessGrant(
        db(),
        ctxFor(holder().userId),
        forHolder({ fields: ['quietSpace'] }),
      );
      expect(second.replaced).toBe(true);
      const all = await rows();
      expect(all).toHaveLength(2);
      const live = await liveRows();
      expect(live).toHaveLength(1);
      expect(live[0]).toMatchObject({ id: second.id, fields: ['quietSpace'] });
      expect(all.find((row) => row.id === first.id)).toMatchObject({
        revokedAt: NOW,
        revokedBy: holder().userId,
      });
      const [replaced] = (await events('access.grant-revoked')).slice(seen);
      expect(replaced).toMatchObject({
        action: 'replace',
        targetId: first.id,
        details: { reason: 'replaced', onBehalf: false },
      });
    });

    it('keeps one live grant for each role, and for each category', async () => {
      const person = ctxFor(holder().userId);
      await createAccessGrant(db(), person, forHolder());
      await createAccessGrant(
        db(),
        person,
        forHolder({ roleId: scene.roles.camera }),
      );
      await createAccessGrant(
        db(),
        person,
        forHolder({ category: 'medical', fields: ['conditions'] }),
      );
      expect(await liveRows()).toHaveLength(3);
    });

    it('lets a revoked role be granted again', async () => {
      const person = ctxFor(holder().userId);
      await createAccessGrant(db(), person, forHolder());
      await revokeAccessGrant(db(), person, forHolder());
      const again = await createAccessGrant(db(), person, forHolder());
      expect(again.replaced).toBe(false);
      expect(await rows()).toHaveLength(2);
      expect(await liveRows()).toHaveLength(1);
    });

    it('says not found for a grant that is not there, to the person it is for', async () => {
      await expect(
        revokeAccessGrant(db(), ctxFor(holder().userId), forHolder()),
      ).rejects.toBeInstanceOf(RecordNotFoundError);
      await expect(
        revokeAccessGrant(
          db(),
          ctxFor(holder().userId),
          forHolder({ roleId: 'not an id' }),
        ),
      ).rejects.toBeInstanceOf(RecordNotFoundError);
    });
  });

  describe('the trail', () => {
    it('holds ids, counts and codes, and never a field name, a value or a consent note', async () => {
      const coordinator = ctxFor(scene.users.coordinator);
      const person = ctxFor(holder().userId);
      await createAccessGrant(db(), coordinator, forCrew());
      await createAccessGrant(
        db(),
        coordinator,
        forCrew({ fields: ['conditions'], category: 'medical' }),
      );
      await createAccessGrant(db(), person, forHolder());
      await createAccessGrant(
        db(),
        person,
        forHolder({ fields: ['quietSpace', 'notes'] }),
      );
      await revokeAccessGrant(db(), person, forHolder());
      await errorOf(
        createAccessGrant(db(), coordinator, forCrew({ consent: undefined })),
      );
      await errorOf(
        createAccessGrant(db(), ctxFor(scene.users.stranger), forHolder()),
      );
      const everything = (await events()).filter(
        (event) =>
          event.category.startsWith('access.') ||
          event.category === 'sensitive.denied',
      );
      expect(everything.length).toBeGreaterThanOrEqual(7);
      const text = JSON.stringify(everything);
      expect(text).not.toContain(NOTE);
      for (const entry of ACCESS_FIELDS) expect(text).not.toContain(entry.key);
      for (const name of MEDICAL_FIELDS)
        expect(text).not.toContain(`"${name}"`);
      for (const value of Object.values(VALID_PAYLOADS.accessibility)) {
        if (typeof value === 'string') expect(text).not.toContain(value);
      }
      // Counts, not names.
      const created = everything.filter(
        (event) => event.category === 'access.grant-created',
      );
      expect(created.map((event) => event.details!.fieldCount)).toEqual(
        expect.arrayContaining([1, 2]),
      );
    });

    it('makes no change event: a grant is audited, not change-logged', async () => {
      await createAccessGrant(db(), ctxFor(holder().userId), forHolder());
      await revokeAccessGrant(db(), ctxFor(holder().userId), forHolder());
      // The names of the entities that change events were made for.
      const changes = (await db().execute(
        sql`select distinct entity_type from change_event`,
      )) as { rows: { entity_type: string }[] };
      expect(changes.rows.map((row) => row.entity_type)).not.toContain(
        'access_grant',
      );
    });
  });
});
