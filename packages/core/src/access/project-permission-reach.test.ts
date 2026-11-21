import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import {
  orgMembershipRole,
  project,
  role,
  rolePermission,
} from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { hasOrganisationPermission } from './organisation-permission.js';
import { syncPermissions } from './permission-sync.js';
import { hasProjectPermission } from './project-permission.js';
import { hasScopedPermission } from './scoped-permission.js';
import {
  base,
  ensurePermissions,
  grantOnOrganisation,
  grantOnProject,
  seedOrganisation,
  seedProject,
  seedUser,
} from './test-fixtures.js';

const KEY = 'legal-hold:manage';
const OTHER_KEY = 'budget:read';
const SENSITIVE_KEY = 'costs:read';

describe.each(testTargets)(
  'organisation roles in projects on $name',
  (target) => {
    let database: Database;
    let cleanup: () => Promise<void>;

    beforeAll(async () => {
      ({ database, cleanup } = await createMigratedDatabase(target));
      await ensurePermissions(database, [KEY, OTHER_KEY]);
      // The real flag: costs:read exposes amounts and payees, so it is sensitive.
      await syncPermissions(database.db, [
        {
          key: SENSITIVE_KEY,
          module: 'costs',
          description: 'Read cost lines',
          grantsSensitive: true,
        },
      ]);
    });
    afterAll(async () => {
      await cleanup();
    });

    const check = (userId: string, projectId: string, key = KEY) =>
      hasProjectPermission(database.db, userId, projectId, key);

    it('grants an organisation-only user in every live project of the organisation', async () => {
      const first = await seedOrganisation(database);
      const secondProject = await seedProject(database, first.organisationId);
      const userId = await seedUser(database);
      await grantOnOrganisation(
        database,
        first.organisationId,
        userId,
        'admin',
        [KEY],
        { reach: 'all-projects' },
      );
      expect(await check(userId, first.projectId)).toBe(true);
      expect(await check(userId, secondProject)).toBe(true);
    });

    it('grants only the key the role holds', async () => {
      const { organisationId, projectId } = await seedOrganisation(database);
      const userId = await seedUser(database);
      await grantOnOrganisation(
        database,
        organisationId,
        userId,
        'admin',
        [KEY],
        { reach: 'all-projects' },
      );
      expect(await check(userId, projectId, OTHER_KEY)).toBe(false);
    });

    it('does not reach a project of another organisation', async () => {
      const first = await seedOrganisation(database);
      const second = await seedOrganisation(database);
      const userId = await seedUser(database);
      await grantOnOrganisation(
        database,
        first.organisationId,
        userId,
        'admin',
        [KEY],
        { reach: 'all-projects' },
      );
      expect(await check(userId, first.projectId)).toBe(true);
      expect(await check(userId, second.projectId)).toBe(false);
    });

    it('does not reach a soft-deleted project, and reaches it again when it is restored', async () => {
      const { organisationId, projectId } = await seedOrganisation(database);
      const userId = await seedUser(database);
      await grantOnOrganisation(
        database,
        organisationId,
        userId,
        'admin',
        [KEY],
        { reach: 'all-projects' },
      );
      const setDeleted = (deletedAt: Date | null) =>
        database.db
          .update(project)
          .set({ deletedAt })
          .where(eq(project.id, projectId));
      await setDeleted(new Date());
      expect(await check(userId, projectId)).toBe(false);
      await setDeleted(null);
      expect(await check(userId, projectId)).toBe(true);
    });

    it('refuses a project that does not exist', async () => {
      const { organisationId } = await seedOrganisation(database);
      const userId = await seedUser(database);
      await grantOnOrganisation(
        database,
        organisationId,
        userId,
        'admin',
        [KEY],
        { reach: 'all-projects' },
      );
      expect(await check(userId, '019f0000-0000-7000-8000-000000000000')).toBe(
        false,
      );
    });

    it('does not let an own-scope organisation grant reach a project', async () => {
      const { organisationId, projectId } = await seedOrganisation(database);
      const userId = await seedUser(database);
      await grantOnOrganisation(database, organisationId, userId, 'admin', [
        KEY,
      ]);
      expect(
        await hasOrganisationPermission(
          database.db,
          userId,
          organisationId,
          KEY,
        ),
      ).toBe(true);
      expect(await check(userId, projectId)).toBe(false);
    });

    it('refuses a user with no membership and a member of another organisation', async () => {
      const first = await seedOrganisation(database);
      const second = await seedOrganisation(database);
      const member = await seedUser(database);
      await grantOnOrganisation(
        database,
        first.organisationId,
        member,
        'admin',
        [KEY],
        { reach: 'all-projects' },
      );
      const stranger = await seedUser(database);
      const outsider = await seedUser(database);
      await grantOnOrganisation(
        database,
        second.organisationId,
        outsider,
        'admin',
        [KEY],
        { reach: 'all-projects' },
      );
      expect(await check(stranger, first.projectId)).toBe(false);
      expect(await check(outsider, first.projectId)).toBe(false);
    });

    it('refuses invited and removed members', async () => {
      const { organisationId, projectId } = await seedOrganisation(database);
      const invited = await seedUser(database);
      const removed = await seedUser(database);
      await grantOnOrganisation(
        database,
        organisationId,
        invited,
        'member',
        [KEY],
        { reach: 'all-projects', status: 'invited' },
      );
      await grantOnOrganisation(
        database,
        organisationId,
        removed,
        'guest',
        [KEY],
        { reach: 'all-projects', status: 'removed' },
      );
      expect(await check(invited, projectId)).toBe(false);
      expect(await check(removed, projectId)).toBe(false);
    });

    it('refuses a soft-deleted membership', async () => {
      const { organisationId, projectId } = await seedOrganisation(database);
      const userId = await seedUser(database);
      await grantOnOrganisation(
        database,
        organisationId,
        userId,
        'admin',
        [KEY],
        { reach: 'all-projects', deleted: true },
      );
      expect(await check(userId, projectId)).toBe(false);
    });

    it('refuses a membership with no link, even when its tier names a role that holds the grant', async () => {
      const { organisationId, projectId } = await seedOrganisation(database);
      const userId = await seedUser(database);
      await grantOnOrganisation(
        database,
        organisationId,
        userId,
        'admin',
        [KEY],
        { reach: 'all-projects', linked: false },
      );
      expect(await check(userId, projectId)).toBe(false);
    });

    it('refuses when the link is soft-deleted, and grants again when it is restored', async () => {
      const { organisationId, projectId } = await seedOrganisation(database);
      const userId = await seedUser(database);
      const { linkId } = await grantOnOrganisation(
        database,
        organisationId,
        userId,
        'admin',
        [KEY],
        { reach: 'all-projects' },
      );
      const setDeleted = (deletedAt: Date | null) =>
        database.db
          .update(orgMembershipRole)
          .set({ deletedAt })
          .where(eq(orgMembershipRole.id, linkId!));
      expect(await check(userId, projectId)).toBe(true);
      await setDeleted(new Date());
      expect(await check(userId, projectId)).toBe(false);
      await setDeleted(null);
      expect(await check(userId, projectId)).toBe(true);
    });

    it('refuses when the role is soft-deleted, and grants again when it is restored', async () => {
      const { organisationId, projectId } = await seedOrganisation(database);
      const userId = await seedUser(database);
      const { roleId } = await grantOnOrganisation(
        database,
        organisationId,
        userId,
        'admin',
        [KEY],
        { reach: 'all-projects' },
      );
      const setDeleted = (deletedAt: Date | null) =>
        database.db.update(role).set({ deletedAt }).where(eq(role.id, roleId));
      expect(await check(userId, projectId)).toBe(true);
      await setDeleted(new Date());
      expect(await check(userId, projectId)).toBe(false);
      await setDeleted(null);
      expect(await check(userId, projectId)).toBe(true);
    });

    it('refuses when the role permission is soft-deleted', async () => {
      const { organisationId, projectId } = await seedOrganisation(database);
      const userId = await seedUser(database);
      const { roleId } = await grantOnOrganisation(
        database,
        organisationId,
        userId,
        'admin',
        [KEY],
        { reach: 'all-projects' },
      );
      await database.db
        .update(rolePermission)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(rolePermission.roleId, roleId),
            eq(rolePermission.permissionKey, KEY),
          ),
        );
      expect(await check(userId, projectId)).toBe(false);
    });

    it('reaches projects only with the all-projects grant when a role holds both reaches of different keys', async () => {
      const { organisationId, projectId } = await seedOrganisation(database);
      const userId = await seedUser(database);
      const { roleId } = await grantOnOrganisation(
        database,
        organisationId,
        userId,
        'admin',
        [OTHER_KEY],
      );
      await database.db.insert(rolePermission).values({
        ...base(organisationId),
        roleId,
        permissionKey: KEY,
        reach: 'all-projects',
      });
      expect(await check(userId, projectId, KEY)).toBe(true);
      expect(await check(userId, projectId, OTHER_KEY)).toBe(false);
    });

    it('still grants through project membership, with or without an organisation grant', async () => {
      const { organisationId, projectId } = await seedOrganisation(database);
      const userId = await seedUser(database);
      await grantOnProject(database, organisationId, projectId, userId, [KEY]);
      expect(await check(userId, projectId)).toBe(true);
      await grantOnOrganisation(
        database,
        organisationId,
        userId,
        'member',
        [OTHER_KEY],
        { reach: 'all-projects' },
      );
      expect(await check(userId, projectId)).toBe(true);
      expect(await check(userId, projectId, OTHER_KEY)).toBe(true);
    });

    it('counts both reaches at organisation level', async () => {
      const { organisationId } = await seedOrganisation(database);
      const wide = await seedUser(database);
      const narrow = await seedUser(database);
      await grantOnOrganisation(
        database,
        organisationId,
        wide,
        'admin',
        [KEY],
        { reach: 'all-projects' },
      );
      await grantOnOrganisation(database, organisationId, narrow, 'member', [
        KEY,
      ]);
      const inOrganisation = (userId: string) =>
        hasOrganisationPermission(database.db, userId, organisationId, KEY);
      expect(await inOrganisation(wide)).toBe(true);
      expect(await inOrganisation(narrow)).toBe(true);
    });

    it('answers a project scope through the all-projects grant and an organisation scope as before', async () => {
      const { organisationId, projectId } = await seedOrganisation(database);
      const userId = await seedUser(database);
      await grantOnOrganisation(
        database,
        organisationId,
        userId,
        'admin',
        [KEY],
        { reach: 'all-projects' },
      );
      expect(
        await hasScopedPermission(
          database.db,
          userId,
          { organisationId, projectId },
          KEY,
        ),
      ).toBe(true);
      expect(
        await hasScopedPermission(
          database.db,
          userId,
          { organisationId, projectId: null },
          KEY,
        ),
      ).toBe(true);
    });

    describe('sensitive permissions', () => {
      it('are refused through an own-scope organisation grant', async () => {
        const { organisationId, projectId } = await seedOrganisation(database);
        const userId = await seedUser(database);
        await grantOnOrganisation(database, organisationId, userId, 'admin', [
          SENSITIVE_KEY,
        ]);
        expect(await check(userId, projectId, SENSITIVE_KEY)).toBe(false);
      });

      it('cannot be granted to all projects, so no all-projects grant exists to use', async () => {
        const { organisationId } = await seedOrganisation(database);
        const userId = await seedUser(database);
        await expect(
          grantOnOrganisation(
            database,
            organisationId,
            userId,
            'admin',
            [SENSITIVE_KEY],
            { reach: 'all-projects' },
          ),
        ).rejects.toThrow();
      });

      it('are refused even when an all-projects grant got past the database triggers', async () => {
        const { organisationId, projectId } = await seedOrganisation(database);
        const userId = await seedUser(database);
        // The triggers make this row impossible to write, so switch one off for
        // the insert, as a bulk restore that skips triggers could. The check
        // must still refuse: sensitive permissions never reach all projects.
        const trigger = 'role_permission_all_projects_not_sensitive';
        await database.db.execute(
          sql.raw(`alter table role_permission disable trigger ${trigger}`),
        );
        try {
          await grantOnOrganisation(
            database,
            organisationId,
            userId,
            'admin',
            [SENSITIVE_KEY],
            { reach: 'all-projects' },
          );
        } finally {
          await database.db.execute(
            sql.raw(`alter table role_permission enable trigger ${trigger}`),
          );
        }
        expect(await check(userId, projectId, SENSITIVE_KEY)).toBe(false);
        // The same grant still counts in the organisation, as before.
        expect(
          await hasOrganisationPermission(
            database.db,
            userId,
            organisationId,
            SENSITIVE_KEY,
          ),
        ).toBe(true);
      });

      it('are still granted through project membership', async () => {
        const { organisationId, projectId } = await seedOrganisation(database);
        const userId = await seedUser(database);
        await grantOnProject(database, organisationId, projectId, userId, [
          SENSITIVE_KEY,
        ]);
        expect(await check(userId, projectId, SENSITIVE_KEY)).toBe(true);
      });
    });
  },
);
