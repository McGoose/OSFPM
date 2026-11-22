import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withManagedRoleMaintenance } from '../access/managed-role.js';
import { hasOrganisationPermission } from '../access/organisation-permission.js';
import { PERMISSION_LISTS } from '../access/permission-lists.js';
import { syncPermissions } from '../access/permission-sync.js';
import { hasProjectPermission } from '../access/project-permission.js';
import { seedProject } from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import {
  auditEvent,
  permission,
  role,
  rolePermission,
} from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import {
  MEMBER_PERMISSIONS,
  MEMBERS_INVITE_PERMISSION,
  MEMBERS_READ_PERMISSION,
} from '../members/permissions.js';
import { topUpAdministratorRoles } from './administrator-role.js';
import { completeFirstRunSetup } from './first-run-setup.js';
import { AUTH_AUDIT } from './shared.js';
import { demoSetupInput, seedFirstRun } from './test-support.js';

const T0 = new Date('2026-03-02T09:00:00.000Z');
const MINUTE = 60 * 1000;
const at = (ms: number) => new Date(T0.getTime() + ms);

const MEMBER_KEYS = [MEMBERS_READ_PERMISSION, MEMBERS_INVITE_PERMISSION];

describe.each(testTargets)(
  'the Administrator role and the members permissions on $name',
  (target) => {
    let database: Database;
    let cleanup: () => Promise<void>;
    let organisationId: string;
    let administratorId: string;
    let userId: string;
    let projectId: string;

    /** The grants of the two members permissions the role holds. */
    const memberGrants = () =>
      database.db
        .select()
        .from(rolePermission)
        .where(inArray(rolePermission.permissionKey, MEMBER_KEYS));

    beforeAll(async () => {
      ({ database, cleanup } = await createMigratedDatabase(target));
      const code = await seedFirstRun(database, T0);
      const done = await completeFirstRunSetup(
        database.db,
        demoSetupInput(code),
        T0,
      );
      if (!done.ok) throw new Error('the setup was refused');
      organisationId = done.organisation.id;
      userId = done.user.id;
      projectId = await seedProject(database, organisationId);
      const [administrator] = await database.db.select().from(role);
      administratorId = administrator!.id;
      // A database set up before this release: the Administrator role was made
      // without the two permissions, which the catalogue did not have either.
      await withManagedRoleMaintenance(database.db, (tx) =>
        tx
          .delete(rolePermission)
          .where(inArray(rolePermission.permissionKey, MEMBER_KEYS)),
      );
      await database.db
        .delete(permission)
        .where(inArray(permission.key, MEMBER_KEYS));
    });
    afterAll(async () => {
      await cleanup();
    });

    it('is the state a database set up before had: no grant, no catalogue row, no permission held', async () => {
      expect(await memberGrants()).toEqual([]);
      expect(
        await database.db
          .select()
          .from(permission)
          .where(inArray(permission.key, MEMBER_KEYS)),
      ).toEqual([]);
      for (const key of MEMBER_KEYS) {
        expect(
          await hasOrganisationPermission(
            database.db,
            userId,
            organisationId,
            key,
          ),
          key,
        ).toBe(false);
      }
    });

    it('declares both as ordinary organisation permissions of the members module, and has them in the registry', () => {
      expect(MEMBER_PERMISSIONS.map((entry) => entry.key).sort()).toEqual(
        [...MEMBER_KEYS].sort(),
      );
      for (const entry of MEMBER_PERMISSIONS) {
        expect(entry.module).toBe('members');
        expect(entry.grantsSensitive).toBe(false);
      }
      expect(PERMISSION_LISTS).toContain(MEMBER_PERMISSIONS);
    });

    it('gives the Administrator role both, all-projects, when the server starts again', async () => {
      // What start-up does: sync the catalogue, then top the role up.
      for (const list of PERMISSION_LISTS) {
        await syncPermissions(database.db, list);
      }
      const added = await topUpAdministratorRoles(database.db, {
        now: at(MINUTE),
      });
      expect(added).toBe(2);
      const grants = await memberGrants();
      expect(grants.map((grant) => grant.permissionKey).sort()).toEqual(
        [...MEMBER_KEYS].sort(),
      );
      for (const grant of grants) {
        expect(grant).toMatchObject({
          roleId: administratorId,
          organisationId,
          reach: 'all-projects',
          departmentId: null,
        });
      }
    });

    it('makes the administrator hold both in the organisation, and in a project too', async () => {
      for (const key of MEMBER_KEYS) {
        expect(
          await hasOrganisationPermission(
            database.db,
            userId,
            organisationId,
            key,
          ),
          key,
        ).toBe(true);
        expect(
          await hasProjectPermission(database.db, userId, projectId, key),
          key,
        ).toBe(true);
      }
    });

    it('audits the top-up once, with the count and no permission key', async () => {
      const events = (await database.db.select().from(auditEvent)).filter(
        (event) =>
          event.category === AUTH_AUDIT.administratorRoleToppedUp &&
          event.occurredAt.getTime() === at(MINUTE).getTime(),
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        organisationId,
        targetId: administratorId,
        details: { added: 2 },
      });
      expect(JSON.stringify(events)).not.toContain('members:');
    });

    it('does nothing at the start after', async () => {
      expect(
        await topUpAdministratorRoles(database.db, { now: at(2 * MINUTE) }),
      ).toBe(0);
      expect(await memberGrants()).toHaveLength(2);
    });
  },
);
