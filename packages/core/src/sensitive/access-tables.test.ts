import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  declaredRetentionClasses,
  organisationScopedSecurityTables,
  tableWriters,
} from '../db/columns.js';
import {
  ORIGIN,
  seedOrganisation,
  seedPerson,
  seedUser,
} from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import {
  ACCESS_CONSENT_NOTE_MAX_LENGTH,
  accessGrant,
  user,
  userAccessProfile,
} from '../db/schema/index.js';
import { sensitiveColumns } from '../db/sensitive.js';
import {
  createMigratedDatabase,
  failureOf,
  SQLSTATE,
  testTargets,
} from '../db/test-support.js';
import {
  insertRecord,
  SecurityTableWriteError,
  type WriteContext,
} from '../db/write.js';
import {
  NOW,
  seedAccessScene,
  seedRole,
  type AccessScene,
} from './test-support.js';

/**
 * The two tables of the access needs model, as the database holds them (decision D-69).
 * Every rule the service relies on as a backstop is checked here with direct inserts, as
 * fixtures do, so a rule the service forgot would still be refused by the database.
 */

describe.each(testTargets)(
  'the access profile and grant tables on $name',
  (target) => {
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
    });

    const db = () => database.db;

    /** A valid grant row of a person without an account, with `over` changed. */
    const grantRow = (over: Partial<typeof accessGrant.$inferInsert> = {}) => ({
      originServer: ORIGIN,
      organisationId: scene.organisationId,
      projectId: scene.projectId,
      personId: scene.people.crew.personId,
      category: 'accessibility' as const,
      roleId: scene.roles.production,
      fields: ['stepFreeRequired'],
      grantedBy: scene.users.coordinator,
      grantedAt: NOW,
      onBehalf: false,
      ...over,
    });
    const onBehalf = {
      onBehalf: true,
      consentMethod: 'phone' as const,
      consentAt: NOW,
    };
    const insert = (over?: Partial<typeof accessGrant.$inferInsert>) =>
      db().insert(accessGrant).values(grantRow(over));
    const refusedBy = async (
      over: Partial<typeof accessGrant.$inferInsert>,
      constraint: string,
      code: string = SQLSTATE.checkViolation,
    ) => {
      expect(await failureOf(() => insert(over))).toEqual({ code, constraint });
    };

    describe('access_grant', () => {
      it('takes a grant of a person’s own, and one recorded on someone’s behalf, with the standard columns and the crew-health class', async () => {
        await insert();
        await insert({
          ...onBehalf,
          roleId: scene.roles.camera,
          consentNote: 'n'.repeat(ACCESS_CONSENT_NOTE_MAX_LENGTH),
        });
        const rows = await db().select().from(accessGrant);
        expect(rows).toHaveLength(2);
        for (const row of rows) {
          expect(row).toMatchObject({
            retentionClass: 'crew-health',
            version: 1,
            revokedAt: null,
            revokedBy: null,
          });
          expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
        }
      });

      it('allows only the two categories that have grants', async () => {
        await refusedBy(
          { category: 'dietary' as 'medical' },
          'access_grant_category_check',
        );
      });

      it('needs fields, and no field twice', async () => {
        await refusedBy({ fields: [] }, 'access_grant_fields_check');
        await refusedBy(
          { fields: ['quietSpace', 'quietSpace'] },
          'access_grant_fields_check',
        );
      });

      it('ties on_behalf to how and when the person agreed: both for staff, neither for the person', async () => {
        await refusedBy({ onBehalf: true }, 'access_grant_consent_check');
        await refusedBy(
          { onBehalf: true, consentMethod: 'phone' },
          'access_grant_consent_check',
        );
        await refusedBy(
          { onBehalf: true, consentAt: NOW },
          'access_grant_consent_check',
        );
        await refusedBy(
          { consentMethod: 'phone' },
          'access_grant_consent_check',
        );
        await refusedBy({ consentAt: NOW }, 'access_grant_consent_check');
      });

      it('allows only the ways of agreeing it lists', async () => {
        await refusedBy(
          { ...onBehalf, consentMethod: 'telepathy' as 'phone' },
          'access_grant_consent_method_check',
        );
        for (const consentMethod of [
          'in-person',
          'phone',
          'email',
          'written',
          'other',
        ] as const) {
          await insert({ ...onBehalf, consentMethod });
          // The same key again for the next one: the live index allows one at a time.
          await db().delete(accessGrant);
        }
      });

      it('holds a note of 1 to 200 characters, and only on a grant recorded on someone’s behalf', async () => {
        await refusedBy(
          {
            ...onBehalf,
            consentNote: 'n'.repeat(ACCESS_CONSENT_NOTE_MAX_LENGTH + 1),
          },
          'access_grant_consent_note_check',
        );
        await refusedBy(
          { ...onBehalf, consentNote: '' },
          'access_grant_consent_note_check',
        );
        await refusedBy(
          { consentNote: 'Said so in the corridor' },
          'access_grant_consent_note_check',
        );
      });

      it('is revoked and revoked by together, or neither', async () => {
        await refusedBy({ revokedAt: NOW }, 'access_grant_revoked_pair_check');
        await refusedBy(
          { revokedBy: scene.users.coordinator },
          'access_grant_revoked_pair_check',
        );
        await insert({ revokedAt: NOW, revokedBy: scene.users.coordinator });
      });

      it('has one live grant for a person, category and role on a project, and any number that were revoked', async () => {
        await insert();
        expect(
          await failureOf(() => insert({ fields: ['quietSpace'] })),
        ).toEqual({
          code: SQLSTATE.uniqueViolation,
          constraint: 'access_grant_live_unique',
        });
        // Another role, another category, another person and another project are other grants.
        await insert({ roleId: scene.roles.camera });
        await insert({ category: 'medical', fields: ['conditions'] });
        await insert({ personId: scene.people.holder.personId });
        // A revoked one does not count, and neither do several.
        await db()
          .update(accessGrant)
          .set({ revokedAt: NOW, revokedBy: scene.users.coordinator })
          .where(eq(accessGrant.roleId, scene.roles.production));
        await insert();
        await insert({ revokedAt: NOW, revokedBy: scene.users.coordinator });
        await insert({ revokedAt: NOW, revokedBy: scene.users.coordinator });
      });

      it('keeps a grant, its person, its project and its role in one organisation, by composite keys', async () => {
        const foreign = await seedOrganisation(database);
        const foreignPerson = await seedPerson(
          database,
          foreign.organisationId,
        );
        const foreignRole = await seedRole(
          database,
          foreign.organisationId,
          'foreign',
          [],
        );
        await refusedBy(
          { projectId: foreign.projectId },
          'access_grant_project_fk',
          SQLSTATE.foreignKeyViolation,
        );
        await refusedBy(
          { personId: foreignPerson },
          'access_grant_person_fk',
          SQLSTATE.foreignKeyViolation,
        );
        await refusedBy(
          { roleId: foreignRole },
          'access_grant_role_fk',
          SQLSTATE.foreignKeyViolation,
        );
      });

      it('names a user who granted it, and one who revoked it', async () => {
        const missing = '0199a3c4-0000-7000-8000-00000000dead';
        await refusedBy(
          { grantedBy: missing },
          'access_grant_granted_by_fk',
          SQLSTATE.foreignKeyViolation,
        );
        await refusedBy(
          { revokedAt: NOW, revokedBy: missing },
          'access_grant_revoked_by_fk',
          SQLSTATE.foreignKeyViolation,
        );
      });

      it('is a security table the write helper refuses, and is declared written by the sensitive service, with a reason', async () => {
        const ctx: WriteContext = {
          actor: { type: 'user', id: scene.users.coordinator },
          originServer: ORIGIN,
          clock: () => NOW,
        };
        await expect(
          db().transaction((tx) =>
            insertRecord(
              tx,
              accessGrant,
              {
                ...grantRow(),
                ownerOrgId: scene.organisationId,
              } as never,
              ctx,
            ),
          ),
        ).rejects.toBeInstanceOf(SecurityTableWriteError);
        expect(await db().select().from(accessGrant)).toEqual([]);
        expect(tableWriters().get('access_grant')).toMatchObject({
          kind: 'security',
          service: 'sensitive',
        });
        expect(
          tableWriters().get('access_grant')?.reason?.length,
        ).toBeGreaterThan(0);
        expect(organisationScopedSecurityTables().has('access_grant')).toBe(
          true,
        );
        expect(declaredRetentionClasses().get('access_grant')).toBe(
          'crew-health',
        );
      });

      it('marks the field names and the consent note as sensitive', () => {
        const marked = sensitiveColumns(accessGrant);
        expect(marked.has('fields')).toBe(true);
        expect(marked.has('consent_note')).toBe(true);
      });
    });

    describe('user_access_profile', () => {
      const profile = (userId: string) => ({
        originServer: ORIGIN,
        userId,
        payload: { stepFreeRequired: true },
      });

      it('holds one profile per user, in the crew-health class', async () => {
        const owner = await seedUser(database);
        await db().insert(userAccessProfile).values(profile(owner));
        expect(
          await failureOf(() =>
            db().insert(userAccessProfile).values(profile(owner)),
          ),
        ).toEqual({
          code: SQLSTATE.uniqueViolation,
          constraint: 'user_access_profile_user_unique',
        });
        const [row] = await db()
          .select()
          .from(userAccessProfile)
          .where(eq(userAccessProfile.userId, owner));
        expect(row).toMatchObject({
          retentionClass: 'crew-health',
          version: 1,
        });
      });

      it('names a user that exists, and goes with the account if the account is ever deleted', async () => {
        expect(
          await failureOf(() =>
            db()
              .insert(userAccessProfile)
              .values(profile('0199a3c4-0000-7000-8000-00000000dead')),
          ),
        ).toEqual({
          code: SQLSTATE.foreignKeyViolation,
          constraint: 'user_access_profile_user_fk',
        });
        const leaving = await seedUser(database);
        await db().insert(userAccessProfile).values(profile(leaving));
        await db().delete(user).where(eq(user.id, leaving));
        expect(
          await db()
            .select()
            .from(userAccessProfile)
            .where(eq(userAccessProfile.userId, leaving)),
        ).toEqual([]);
      });

      it('is a service-written table with the sensitive service as its writer, a reason, and a payload marked sensitive', () => {
        expect(tableWriters().get('user_access_profile')).toMatchObject({
          kind: 'service-written',
          service: 'sensitive',
        });
        expect(
          tableWriters().get('user_access_profile')?.reason?.length,
        ).toBeGreaterThan(0);
        expect(sensitiveColumns(userAccessProfile).has('payload')).toBe(true);
      });
    });
  },
);
