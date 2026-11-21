import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import {
  permission,
  projectMembership,
  projectMembershipRole,
  rolePermission,
} from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import {
  COMPLIANCE_REPORT_PERMISSION,
  SENSITIVE_PERMISSIONS,
  editPermissionKey,
  readPermissionKey,
} from '../sensitive/permissions.js';
import { SENSITIVE_CATEGORIES } from '../sensitive/schemas.js';
import { hasProjectPermission } from './project-permission.js';
import {
  PermissionSyncError,
  syncPermissions,
  type PermissionDefinition,
} from './permission-sync.js';
import {
  ensurePermissions,
  grantOnOrganisation,
  grantOnProject,
  seedDepartment,
  seedOrganisation,
  seedProject,
  seedUser,
  type SeedOrganisation,
} from './test-fixtures.js';

/** The error a call fails with. Fails the test when the call succeeds. */
const errorOf = (call: Promise<unknown>) =>
  call.then(
    () => {
      throw new Error('Expected the call to fail, but it succeeded');
    },
    (error: unknown) => error,
  );

describe('sensitive permission catalogue', () => {
  it('has a read and an edit permission per category, plus compliance:report', () => {
    const keys = SENSITIVE_PERMISSIONS.map((p) => p.key).sort();
    const expected = [
      COMPLIANCE_REPORT_PERMISSION,
      ...SENSITIVE_CATEGORIES.flatMap((c) => [
        `sensitive:read:${c}`,
        `sensitive:edit:${c}`,
      ]),
    ].sort();
    expect(keys).toEqual(expected);
    expect(keys).toHaveLength(17);
    expect(readPermissionKey('dietary')).toBe('sensitive:read:dietary');
    expect(editPermissionKey('medical')).toBe('sensitive:edit:medical');
  });

  it('marks every per-category permission as granting sensitive data', () => {
    for (const p of SENSITIVE_PERMISSIONS) {
      if (p.key.startsWith('sensitive:')) {
        expect(p.grantsSensitive, p.key).toBe(true);
      }
    }
  });
});

describe.each(testTargets)('permissions on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
  });
  afterAll(async () => {
    await cleanup();
  });

  describe('syncPermissions', () => {
    it('inserts the catalogue rows', async () => {
      await syncPermissions(database.db, SENSITIVE_PERMISSIONS);
      const found = await database.db
        .select()
        .from(permission)
        .where(eq(permission.module, 'sensitive'));
      expect(found).toHaveLength(16);
      expect(found.every((p) => p.grantsSensitive)).toBe(true);
      const [report] = await database.db
        .select()
        .from(permission)
        .where(eq(permission.key, COMPLIANCE_REPORT_PERMISSION));
      expect(report).toMatchObject({
        module: 'compliance',
        grantsSensitive: false,
      });
    });

    it('is idempotent', async () => {
      await syncPermissions(database.db, SENSITIVE_PERMISSIONS);
      await syncPermissions(database.db, SENSITIVE_PERMISSIONS);
      const [count] = (
        (await database.db.execute(
          sql`select count(*)::int as n from permission`,
        )) as { rows: { n: number }[] }
      ).rows;
      expect(count!.n).toBe(SENSITIVE_PERMISSIONS.length);
    });

    it('updates description and flag of an existing key, and keeps role grants', async () => {
      const s = await seedOrganisation(database);
      const u = await seedUser(database);
      await syncPermissions(database.db, [
        {
          key: 'demo:thing',
          module: 'demo',
          description: 'Old text',
          grantsSensitive: false,
        },
      ]);
      await grantOnProject(database, s.organisationId, s.projectId, u, [
        'demo:thing',
      ]);
      await syncPermissions(database.db, [
        {
          key: 'demo:thing',
          module: 'demo',
          description: 'New text',
          grantsSensitive: true,
        },
      ]);
      const [row] = await database.db
        .select()
        .from(permission)
        .where(eq(permission.key, 'demo:thing'));
      expect(row).toEqual({
        key: 'demo:thing',
        module: 'demo',
        description: 'New text',
        grantsSensitive: true,
      });
      const grants = await database.db
        .select()
        .from(rolePermission)
        .where(eq(rolePermission.permissionKey, 'demo:thing'));
      expect(grants).toHaveLength(1);
    });

    it('does nothing for an empty list', async () => {
      await syncPermissions(database.db, []);
    });

    it('rejects a malformed key with the database’s own error, not a PermissionSyncError', async () => {
      const error = await errorOf(
        syncPermissions(database.db, [
          { key: 'Bad Key', module: 'demo', description: 'x' },
        ]),
      );
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(PermissionSyncError);
    });

    describe('flagging a permission sensitive while organisation roles reach all projects with it', () => {
      /** A catalogue row, not sensitive yet, and an organisation role holding an all-projects grant of it. */
      async function wideGrant(
        key: string,
        options: { deleted?: boolean } = {},
      ) {
        const { organisationId } = await seedOrganisation(database);
        await ensurePermissions(database, [key]);
        const { roleId } = await grantOnOrganisation(
          database,
          organisationId,
          await seedUser(database),
          'admin',
          [key],
          { reach: 'all-projects' },
        );
        if (options.deleted) {
          await database.db
            .update(rolePermission)
            .set({ deletedAt: new Date() })
            .where(eq(rolePermission.roleId, roleId));
        }
        return { organisationId, roleId };
      }

      const sensitive = (key: string): PermissionDefinition => ({
        key,
        module: 'demo',
        description: 'Now sensitive',
        grantsSensitive: true,
      });

      const stored = async (key: string) => {
        const [row] = await database.db
          .select()
          .from(permission)
          .where(eq(permission.key, key));
        return row;
      };

      it('throws a PermissionSyncError that names the key, the roles and the fix', async () => {
        const { organisationId } = await wideGrant('demo:wide-one');
        const error = await errorOf(
          syncPermissions(database.db, [sensitive('demo:wide-one')]),
        );
        expect(error).toBeInstanceOf(PermissionSyncError);
        const found = error as PermissionSyncError;
        expect(found.conflicts).toEqual([
          {
            permissionKey: 'demo:wide-one',
            roles: [{ organisationId, roleKey: 'admin', removed: false }],
          },
        ]);
        expect(found.message).toContain('demo:wide-one');
        expect(found.message).toContain('admin');
        expect(found.message).toContain(organisationId);
        expect(found.message).toContain('Remove those grants, then restart.');
        // Nothing was written.
        expect(await stored('demo:wide-one')).toMatchObject({
          grantsSensitive: false,
        });
      });

      it('names the roles of every organisation, and says which grants are already removed', async () => {
        const first = await wideGrant('demo:wide-two');
        const second = await wideGrant('demo:wide-two', { deleted: true });
        const error = await errorOf(
          syncPermissions(database.db, [sensitive('demo:wide-two')]),
        );
        expect(error).toBeInstanceOf(PermissionSyncError);
        const [conflict, ...others] = (error as PermissionSyncError).conflicts;
        expect(others).toEqual([]);
        expect(conflict!.permissionKey).toBe('demo:wide-two');
        expect(conflict!.roles).toHaveLength(2);
        expect(conflict!.roles).toEqual(
          expect.arrayContaining([
            {
              organisationId: first.organisationId,
              roleKey: 'admin',
              removed: false,
            },
            {
              organisationId: second.organisationId,
              roleKey: 'admin',
              removed: true,
            },
          ]),
        );
        // A removed grant still counts, so the message says so.
        expect((error as PermissionSyncError).message).toContain('removed');
      });

      it('names every refused key and writes nothing from the list', async () => {
        await wideGrant('demo:wide-three');
        await wideGrant('demo:wide-four');
        const error = await errorOf(
          syncPermissions(database.db, [
            sensitive('demo:fresh-key'),
            sensitive('demo:wide-three'),
            sensitive('demo:wide-four'),
          ]),
        );
        expect(error).toBeInstanceOf(PermissionSyncError);
        expect(
          (error as PermissionSyncError).conflicts.map((c) => c.permissionKey),
        ).toEqual(['demo:wide-four', 'demo:wide-three']);
        // The list is applied together or not at all.
        expect(await stored('demo:fresh-key')).toBeUndefined();
        expect(await stored('demo:wide-three')).toMatchObject({
          grantsSensitive: false,
        });
      });

      it('leaves the caller’s transaction usable, so the caller can handle the error and carry on', async () => {
        await wideGrant('demo:wide-five');
        await database.db.transaction(async (tx) => {
          const error = await errorOf(
            syncPermissions(tx, [sensitive('demo:wide-five')]),
          );
          expect(error).toBeInstanceOf(PermissionSyncError);
          // On PostgreSQL a failed statement aborts the whole transaction unless
          // it ran in a savepoint, and this read would then fail.
          const [row] = await tx
            .select()
            .from(permission)
            .where(eq(permission.key, 'demo:wide-five'));
          expect(row).toMatchObject({ grantsSensitive: false });
          await syncPermissions(tx, [
            { key: 'demo:after-refusal', module: 'demo', description: 'x' },
          ]);
        });
        expect(await stored('demo:after-refusal')).toBeDefined();
      });

      it('succeeds once the all-projects grants are gone', async () => {
        const { roleId } = await wideGrant('demo:wide-six');
        await database.db
          .update(rolePermission)
          .set({ reach: 'own-scope' })
          .where(eq(rolePermission.roleId, roleId));
        await syncPermissions(database.db, [sensitive('demo:wide-six')]);
        expect(await stored('demo:wide-six')).toMatchObject({
          grantsSensitive: true,
        });
      });
    });
  });

  describe('hasProjectPermission', () => {
    const KEY = 'sensitive:read:dietary';
    let s: SeedOrganisation;
    let otherProjectId: string;

    beforeAll(async () => {
      s = await seedOrganisation(database);
      otherProjectId = await seedProject(database, s.organisationId);
      await ensurePermissions(database, [KEY, 'sensitive:edit:dietary']);
    });

    const check = (userId: string, projectId: string, key = KEY) =>
      hasProjectPermission(database.db, userId, projectId, key);

    it('is true for an active member whose role has the key', async () => {
      const u = await seedUser(database);
      await grantOnProject(database, s.organisationId, s.projectId, u, [KEY]);
      expect(await check(u, s.projectId)).toBe(true);
    });

    it('is false for a different key', async () => {
      const u = await seedUser(database);
      await grantOnProject(database, s.organisationId, s.projectId, u, [KEY]);
      expect(await check(u, s.projectId, 'sensitive:edit:dietary')).toBe(false);
    });

    it('is false for a different project', async () => {
      const u = await seedUser(database);
      await grantOnProject(database, s.organisationId, s.projectId, u, [KEY]);
      expect(await check(u, otherProjectId)).toBe(false);
    });

    it('is false without any membership', async () => {
      expect(await check(await seedUser(database), s.projectId)).toBe(false);
    });

    it('is false for an invited or ended membership', async () => {
      for (const status of ['invited', 'ended'] as const) {
        const u = await seedUser(database);
        await grantOnProject(
          database,
          s.organisationId,
          s.projectId,
          u,
          [KEY],
          {
            status,
          },
        );
        expect(await check(u, s.projectId), status).toBe(false);
      }
    });

    it('counts a department-scoped grant as held on the project', async () => {
      const u = await seedUser(database);
      const camera = await seedDepartment(database, s.organisationId, 'sound');
      await grantOnProject(database, s.organisationId, s.projectId, u, [KEY], {
        departmentId: camera,
      });
      expect(await check(u, s.projectId)).toBe(true);
    });

    it('accepts a role that belongs to the project', async () => {
      const u = await seedUser(database);
      await grantOnProject(database, s.organisationId, s.projectId, u, [KEY], {
        roleProjectId: s.projectId,
      });
      expect(await check(u, s.projectId)).toBe(true);
    });

    it('refuses a role that belongs to another project', async () => {
      const u = await seedUser(database);
      await grantOnProject(database, s.organisationId, s.projectId, u, [KEY], {
        roleProjectId: otherProjectId,
      });
      expect(await check(u, s.projectId)).toBe(false);
    });

    it('ignores soft-deleted membership, membership role and grant rows', async () => {
      const u = await seedUser(database);
      const { membershipId, roleId } = await grantOnProject(
        database,
        s.organisationId,
        s.projectId,
        u,
        [KEY],
      );
      expect(await check(u, s.projectId)).toBe(true);
      const now = new Date();

      await database.db
        .update(rolePermission)
        .set({ deletedAt: now })
        .where(eq(rolePermission.roleId, roleId));
      expect(await check(u, s.projectId), 'grant').toBe(false);
      await database.db
        .update(rolePermission)
        .set({ deletedAt: null })
        .where(eq(rolePermission.roleId, roleId));

      await database.db
        .update(projectMembershipRole)
        .set({ deletedAt: now })
        .where(eq(projectMembershipRole.membershipId, membershipId));
      expect(await check(u, s.projectId), 'membership role').toBe(false);
      await database.db
        .update(projectMembershipRole)
        .set({ deletedAt: null })
        .where(eq(projectMembershipRole.membershipId, membershipId));

      await database.db
        .update(projectMembership)
        .set({ deletedAt: now })
        .where(eq(projectMembership.id, membershipId));
      expect(await check(u, s.projectId), 'membership').toBe(false);
    });

    it('is false for an unknown user or project', async () => {
      expect(await check(newId(), s.projectId)).toBe(false);
      const u = await seedUser(database);
      await grantOnProject(database, s.organisationId, s.projectId, u, [KEY]);
      expect(await check(u, newId())).toBe(false);
    });
  });
});
