import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasOrganisationPermission } from '../access/organisation-permission.js';
import { withManagedRoleMaintenance } from '../access/managed-role.js';
import { PERMISSION_LISTS } from '../access/permission-lists.js';
import {
  PermissionSyncError,
  syncPermissions,
  type PermissionDefinition,
} from '../access/permission-sync.js';
import { hasProjectPermission } from '../access/project-permission.js';
import {
  grantOnOrganisation,
  seedOrganisation,
  seedProject,
  seedUser,
} from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import {
  auditEvent,
  changeEvent,
  permission,
  role,
  rolePermission,
} from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import {
  narrowManagedSensitiveGrants,
  topUpAdministratorRoles,
} from './administrator-role.js';
import { completeFirstRunSetup } from './first-run-setup.js';
import { AUTH_AUDIT } from './shared.js';
import { demoSetupInput, seedFirstRun } from './test-support.js';

const T0 = new Date('2026-03-02T09:00:00.000Z');
const MINUTE = 60 * 1000;
const at = (ms: number) => new Date(T0.getTime() + ms);

/**
 * Three ordinary permissions a release has shipped. The Administrator role holds
 * each with `all-projects` reach, as the top-up gives an ordinary permission.
 */
const ORDINARY: readonly PermissionDefinition[] = [
  { key: 'later:read', module: 'later', description: 'Read what it adds' },
  { key: 'later:org', module: 'later', description: 'Another it adds' },
  { key: 'later:mixed', module: 'later', description: 'A third it adds' },
];

/** The next release flags one of them sensitive. */
const readNowSensitive: readonly PermissionDefinition[] = [
  { ...ORDINARY[0]!, grantsSensitive: true },
  ORDINARY[1]!,
  ORDINARY[2]!,
];
const orgNowSensitive: readonly PermissionDefinition[] = [
  ORDINARY[0]!,
  { ...ORDINARY[1]!, grantsSensitive: true },
  ORDINARY[2]!,
];
const mixedNowSensitive: readonly PermissionDefinition[] = [
  ORDINARY[0]!,
  ORDINARY[1]!,
  { ...ORDINARY[2]!, grantsSensitive: true },
];

const listsWith = (own: readonly PermissionDefinition[]) =>
  [...PERMISSION_LISTS, own] as const;

describe.each(testTargets)(
  'narrowing the managed grants of a permission that turns sensitive on $name',
  (target) => {
    let database: Database;
    let cleanup: () => Promise<void>;
    let organisationId: string;
    let administratorId: string;
    let userId: string;
    let projectId: string;

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
      // The release before: every permission is ordinary, so each is granted
      // all-projects.
      await syncPermissions(database.db, ORDINARY);
      await topUpAdministratorRoles(database.db, {
        now: at(MINUTE),
        lists: listsWith(ORDINARY),
      });
    });
    afterAll(async () => {
      await cleanup();
    });

    const db = () => database.db;
    const grantOf = async (key: string) => {
      const [found] = await db()
        .select()
        .from(rolePermission)
        .where(
          and(
            eq(rolePermission.roleId, administratorId),
            eq(rolePermission.permissionKey, key),
          ),
        );
      return found!;
    };
    const reductions = async () =>
      (await db().select().from(auditEvent)).filter(
        (event) => event.category === AUTH_AUDIT.grantReachReduced,
      );
    const flagged = async (key: string) => {
      const [found] = await db()
        .select({ grantsSensitive: permission.grantsSensitive })
        .from(permission)
        .where(eq(permission.key, key));
      return found!.grantsSensitive;
    };

    it('leaves every grant alone when no permission of the lists is sensitive', async () => {
      expect(
        await narrowManagedSensitiveGrants(db(), {
          now: at(2 * MINUTE),
          lists: listsWith(ORDINARY),
        }),
      ).toBe(0);
      expect((await grantOf('later:read')).reach).toBe('all-projects');
      expect(await reductions()).toEqual([]);
    });

    it('is refused by the database without it: the sync cannot flag the permission while the managed role holds it everywhere', async () => {
      await expect(
        syncPermissions(db(), readNowSensitive),
      ).rejects.toBeInstanceOf(PermissionSyncError);
      expect(await flagged('later:read')).toBe(false);
    });

    it('narrows the managed role’s all-projects grant of the permission to own-scope, and counts it', async () => {
      const before = await grantOf('later:read');
      expect(
        await narrowManagedSensitiveGrants(db(), {
          now: at(3 * MINUTE),
          lists: listsWith(readNowSensitive),
        }),
      ).toBe(1);
      const after = await grantOf('later:read');
      expect(after.reach).toBe('own-scope');
      expect(after.version).toBe(before.version + 1);
      // The other permission is not sensitive, so its grant is as it was.
      expect((await grantOf('later:org')).reach).toBe('all-projects');
    });

    it('lets the sync flag the permission afterwards, and the administrator still holds it in the organisation but not in a project', async () => {
      await syncPermissions(db(), readNowSensitive);
      expect(await flagged('later:read')).toBe(true);
      expect(
        await hasOrganisationPermission(
          db(),
          userId,
          organisationId,
          'later:read',
        ),
      ).toBe(true);
      expect(
        await hasProjectPermission(db(), userId, projectId, 'later:read'),
      ).toBe(false);
    });

    it('audits one event for the grant, from the system, with the role, the permission and both reaches', async () => {
      const events = await reductions();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: 'reduce-reach',
        actorType: 'system',
        actorId: null,
        targetType: 'role',
        targetId: administratorId,
        organisationId,
        details: {
          roleId: administratorId,
          permissionKey: 'later:read',
          from: 'all-projects',
          to: 'own-scope',
        },
      });
      expect(events[0]!.occurredAt).toEqual(at(3 * MINUTE));
    });

    it('logs the change in the organisation’s sequence, by the system, naming the reach only', async () => {
      const grant = await grantOf('later:read');
      const changes = (await db().select().from(changeEvent)).filter(
        (event) =>
          event.entityType === 'role_permission' &&
          event.entityId === grant.id &&
          event.action === 'update',
      );
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        organisationId,
        projectId: null,
        actorType: 'system',
        actorId: null,
        changedFields: ['reach'],
        before: { reach: 'all-projects' },
        after: { reach: 'own-scope' },
      });
    });

    it('does nothing the second time: no change to a grant, no event', async () => {
      const events = (await reductions()).length;
      const changes = (await db().select().from(changeEvent)).length;
      expect(
        await narrowManagedSensitiveGrants(db(), {
          now: at(4 * MINUTE),
          lists: listsWith(readNowSensitive),
        }),
      ).toBe(0);
      expect((await reductions()).length).toBe(events);
      expect((await db().select().from(changeEvent)).length).toBe(changes);
    });

    it('narrows a managed grant that was removed too, because the database counts it', async () => {
      const grant = await grantOf('later:org');
      await withManagedRoleMaintenance(db(), (tx) =>
        tx
          .update(rolePermission)
          .set({ deletedAt: at(5 * MINUTE) })
          .where(eq(rolePermission.id, grant.id)),
      );
      expect(
        await narrowManagedSensitiveGrants(db(), {
          now: at(6 * MINUTE),
          lists: listsWith(orgNowSensitive),
        }),
      ).toBe(1);
      expect((await grantOf('later:org')).reach).toBe('own-scope');
      await syncPermissions(db(), orgNowSensitive);
      expect(await flagged('later:org')).toBe(true);
    });

    it('leaves an organisation’s own role alone, so the sync still stops and names it and the fix', async () => {
      // Another organisation, whose own role holds the all-projects grant.
      const other = await seedOrganisation(database);
      const owner = await seedUser(database);
      await grantOnOrganisation(
        database,
        other.organisationId,
        owner,
        'admin',
        ['later:mixed'],
        { reach: 'all-projects' },
      );
      const narrowed = await narrowManagedSensitiveGrants(db(), {
        now: at(7 * MINUTE),
        lists: listsWith(mixedNowSensitive),
      });
      // Only the managed role’s grant was narrowed.
      expect(narrowed).toBe(1);
      expect((await grantOf('later:mixed')).reach).toBe('own-scope');

      const error = await syncPermissions(db(), mixedNowSensitive).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(PermissionSyncError);
      const { message } = error as PermissionSyncError;
      expect(message).toContain('later:mixed');
      expect(message).toContain(
        `role admin in organisation ${other.organisationId}`,
      );
      expect(message).toContain('ship a migration that narrows');
      // The managed role was narrowed, so it is not what stands in the way.
      expect(message).not.toContain('role administrator');
      expect(await flagged('later:mixed')).toBe(false);
    });

    it('does nothing on an install with no installation row, where no managed role can exist', async () => {
      const empty = await createMigratedDatabase(target);
      try {
        expect(
          await narrowManagedSensitiveGrants(empty.database.db, {
            now: T0,
            lists: listsWith(readNowSensitive),
          }),
        ).toBe(0);
      } finally {
        await empty.cleanup();
      }
    });
  },
);
