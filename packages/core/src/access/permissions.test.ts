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
import { syncPermissions } from './permission-sync.js';
import {
  ensurePermissions,
  grantOnProject,
  seedDepartment,
  seedOrganisation,
  seedProject,
  seedUser,
  type SeedOrganisation,
} from './test-fixtures.js';

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

    it('rejects a malformed key', async () => {
      await expect(
        syncPermissions(database.db, [
          { key: 'Bad Key', module: 'demo', description: 'x' },
        ]),
      ).rejects.toThrow();
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
