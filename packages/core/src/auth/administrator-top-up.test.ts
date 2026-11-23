import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasOrganisationPermission } from '../access/organisation-permission.js';
import { withManagedRoleMaintenance } from '../access/managed-role.js';
import { PERMISSION_LISTS } from '../access/permission-lists.js';
import {
  syncPermissions,
  type PermissionDefinition,
} from '../access/permission-sync.js';
import { hasProjectPermission } from '../access/project-permission.js';
import {
  base,
  seedOrganisation,
  seedProject,
} from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import {
  auditEvent,
  changeEvent,
  role,
  rolePermission,
} from '../db/schema/index.js';
import {
  createMigratedDatabase,
  interleave,
  succeeded,
  testTargets,
} from '../db/test-support.js';
import {
  ADMINISTRATOR_ROLE_KEY,
  topUpAdministratorRoles,
} from './administrator-role.js';
import { completeFirstRunSetup } from './first-run-setup.js';
import { lockInstallation } from './setup-code.js';
import { AUTH_AUDIT } from './shared.js';
import { demoSetupInput, rowsOf, seedFirstRun } from './test-support.js';

const T0 = new Date('2026-03-02T09:00:00.000Z');
const MINUTE = 60 * 1000;
const at = (ms: number) => new Date(T0.getTime() + ms);

/** What a later release adds: an ordinary permission and a sensitive one. */
const LATER: readonly PermissionDefinition[] = [
  {
    key: 'later:read',
    module: 'later',
    description: 'Read what a later release adds',
    access: 'read',
  },
  {
    key: 'later:read:secret',
    module: 'later',
    description: 'Read the sensitive data a later release adds',
    grantsSensitive: true,
    access: 'read',
  },
];

/** The lists a later release declares: every list of the core, and its own. */
const LISTS = [...PERMISSION_LISTS, LATER] as const;

/** Every permission key the core declares today. */
const TODAY = PERMISSION_LISTS.flatMap((list) =>
  list.map((entry) => entry.key),
);

describe.each(testTargets)(
  'topping up the Administrator role on $name',
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
    });
    afterAll(async () => {
      await cleanup();
    });

    const db = () => database.db;
    const grantsOf = (roleId: string) =>
      db()
        .select()
        .from(rolePermission)
        .where(eq(rolePermission.roleId, roleId));
    const toppedUp = async () =>
      (await db().select().from(auditEvent)).filter(
        (event) => event.category === AUTH_AUDIT.administratorRoleToppedUp,
      );
    const changeCount = async () =>
      (await db().select().from(changeEvent)).length;

    it('adds nothing when the role already has every permission, and writes no event, no change and no counter', async () => {
      const events = (await db().select().from(auditEvent)).length;
      const changes = await changeCount();
      expect(await topUpAdministratorRoles(db(), { now: at(MINUTE) })).toBe(0);
      expect((await db().select().from(auditEvent)).length).toBe(events);
      expect(await changeCount()).toBe(changes);
    });

    it('gives the role a permission added since: all-projects for an ordinary one, own-scope for a sensitive one', async () => {
      await syncPermissions(db(), LATER);
      const added = await topUpAdministratorRoles(db(), {
        now: at(2 * MINUTE),
        lists: LISTS,
      });
      expect(added).toBe(2);
      const byKey = new Map(
        (await grantsOf(administratorId)).map((grant) => [
          grant.permissionKey,
          grant,
        ]),
      );
      expect(byKey.get('later:read')).toMatchObject({
        reach: 'all-projects',
        departmentId: null,
        organisationId,
      });
      expect(byKey.get('later:read:secret')).toMatchObject({
        reach: 'own-scope',
        departmentId: null,
      });
      expect(byKey.size).toBe(TODAY.length + 2);
    });

    it('makes the administrator hold them where they should: both in the organisation, only the ordinary one in a project', async () => {
      for (const key of ['later:read', 'later:read:secret']) {
        expect(
          await hasOrganisationPermission(db(), userId, organisationId, key),
          key,
        ).toBe(true);
      }
      expect(
        await hasProjectPermission(db(), userId, projectId, 'later:read'),
      ).toBe(true);
      expect(
        await hasProjectPermission(
          db(),
          userId,
          projectId,
          'later:read:secret',
        ),
      ).toBe(false);
    });

    it('audits it once, from the system, naming the organisation and the role, with the count and no permission', async () => {
      const events = await toppedUp();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: 'top-up',
        actorType: 'system',
        actorId: null,
        targetType: 'role',
        targetId: administratorId,
        organisationId,
        details: { added: 2 },
      });
      expect(events[0]!.occurredAt).toEqual(at(2 * MINUTE));
      expect(JSON.stringify(events)).not.toContain('later:');
    });

    it('logs each new grant as a change in the organisation’s sequence, by the system', async () => {
      const grants = (await db().select().from(changeEvent)).filter(
        (event) =>
          event.entityType === 'role_permission' &&
          event.actorType === 'system',
      );
      expect(grants).toHaveLength(2);
      for (const event of grants) {
        expect(event).toMatchObject({
          organisationId,
          projectId: null,
          action: 'create',
          actorId: null,
        });
      }
      // Numbered after what setup wrote, with no gap.
      const all = (await db().select().from(changeEvent)).map(
        (event) => event.seq,
      );
      expect(Math.max(...all)).toBe(all.length);
    });

    it('does nothing the second time: no grant, no event', async () => {
      const events = await toppedUp();
      const grants = (await grantsOf(administratorId)).length;
      expect(
        await topUpAdministratorRoles(db(), {
          now: at(3 * MINUTE),
          lists: LISTS,
        }),
      ).toBe(0);
      expect(await toppedUp()).toHaveLength(events.length);
      expect((await grantsOf(administratorId)).length).toBe(grants);
    });

    it('leaves a grant that exists as it is, whatever its reach: it adds, it does not reconcile', async () => {
      const [grant] = (await grantsOf(administratorId)).filter(
        (found) => found.permissionKey === 'later:read',
      );
      await withManagedRoleMaintenance(db(), (tx) =>
        tx
          .update(rolePermission)
          .set({ reach: 'own-scope' })
          .where(eq(rolePermission.id, grant!.id)),
      );
      expect(
        await topUpAdministratorRoles(db(), {
          now: at(4 * MINUTE),
          lists: LISTS,
        }),
      ).toBe(0);
      const [after] = await db()
        .select()
        .from(rolePermission)
        .where(eq(rolePermission.id, grant!.id));
      expect(after!.reach).toBe('own-scope');
    });

    it('tops up the Administrator role of every organisation, and leaves a role that is not managed alone, even one called administrator', async () => {
      const other = await seedOrganisation(database);
      const third = await seedOrganisation(database);
      // A second organisation with a managed Administrator role of its own: the
      // server made it, so it is made with the check off.
      const [managedRole] = await withManagedRoleMaintenance(db(), (tx) =>
        tx
          .insert(role)
          .values({
            ...base(other.organisationId),
            projectId: null,
            key: ADMINISTRATOR_ROLE_KEY,
            name: 'Administrator',
            managed: true,
          })
          .returning(),
      );
      // A third whose role has the same key but is an organisation's own.
      const [ordinaryRole] = await db()
        .insert(role)
        .values({
          ...base(third.organisationId),
          projectId: null,
          key: ADMINISTRATOR_ROLE_KEY,
          name: 'Administrator',
        })
        .returning();
      await syncPermissions(db(), LATER);
      const everything = TODAY.length + LATER.length;
      expect(
        await topUpAdministratorRoles(db(), {
          now: at(5 * MINUTE),
          lists: LISTS,
        }),
      ).toBe(everything);
      expect((await grantsOf(managedRole!.id)).length).toBe(everything);
      expect(await grantsOf(ordinaryRole!.id)).toEqual([]);
      // One event for the organisation that was topped up, naming it.
      const events = (await toppedUp()).filter(
        (event) => event.organisationId === other.organisationId,
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ details: { added: everything } });
    });

    it('refuses before the installation row exists, and writes nothing', async () => {
      const empty = await createMigratedDatabase(target);
      try {
        await expect(
          topUpAdministratorRoles(empty.database.db, { now: T0 }),
        ).rejects.toMatchObject({
          name: 'AuthStateError',
          reason: 'installation-missing',
        });
      } finally {
        await empty.cleanup();
      }
    });

    it('does nothing on an install with no organisation yet, and takes only the installation lock', async () => {
      const fresh = await createMigratedDatabase(target);
      try {
        await seedFirstRun(fresh.database, T0);
        expect(
          await topUpAdministratorRoles(fresh.database.db, { now: at(MINUTE) }),
        ).toBe(0);
        const [counts] = await rowsOf(
          fresh.database,
          sql`select (select count(*)::int from change_seq) as counters,
                     (select count(*)::int from change_event) as changes`,
        );
        expect(counts).toEqual({ counters: 0, changes: 0 });
      } finally {
        await fresh.cleanup();
      }
    });
  },
);

/** The PostgreSQL target, when `DATABASE_URL` names a server. PGlite has one connection, so it cannot run this. */
const postgres = testTargets.find((target) => target.name === 'postgres');

/**
 * Two servers that start at the same moment both top the role up. The top-up
 * takes the installation row lock first, so the second waits, then finds nothing
 * missing: each grant is made once, and neither start-up fails on the unique key
 * a second insert of the same grant would hit.
 */
describe.skipIf(postgres === undefined)(
  'two top-ups at once, on PostgreSQL',
  () => {
    /** A database where setup is done and a later release has declared `LATER`, so there is something to top up. */
    async function installedWithLaterPermissions() {
      const made = await createMigratedDatabase(postgres!);
      const code = await seedFirstRun(made.database, T0);
      const done = await completeFirstRunSetup(
        made.database.db,
        demoSetupInput(code),
        T0,
      );
      if (!done.ok) throw new Error('the setup was refused');
      await syncPermissions(made.database.db, LATER);
      return made;
    }

    const grantsOfTheRole = async (database: Database) => {
      const [administrator] = await database.db.select().from(role);
      return database.db
        .select()
        .from(rolePermission)
        .where(eq(rolePermission.roleId, administrator!.id));
    };

    it('waits for the installation row lock, which is what makes servers that start together take turns', async () => {
      const { database, cleanup } = await installedWithLaterPermissions();
      try {
        // One transaction holds the lock, as a server does while it completes
        // setup or tops the role up. The top-up must queue behind it: `interleave`
        // fails when the second transaction finishes while the first is open.
        const outcomes = await interleave(
          database.db,
          (tx) => lockInstallation(tx),
          (tx) =>
            topUpAdministratorRoles(tx, { now: at(MINUTE), lists: LISTS }),
        );
        expect(succeeded(outcomes)).toBe(2);
        // Once the holder let go, the top-up made the two grants.
        expect(await grantsOfTheRole(database)).toHaveLength(TODAY.length + 2);
      } finally {
        await cleanup();
      }
    });

    it('add each missing grant once and every one succeeds', async () => {
      const { database, cleanup } = await installedWithLaterPermissions();
      try {
        const results = await Promise.all(
          [1, 2, 3].map(() =>
            database.db.transaction((tx) =>
              topUpAdministratorRoles(tx, { now: at(MINUTE), lists: LISTS }),
            ),
          ),
        );
        expect(results.reduce((total, added) => total + added, 0)).toBe(2);
        expect(await grantsOfTheRole(database)).toHaveLength(TODAY.length + 2);
        const events = (await database.db.select().from(auditEvent)).filter(
          (event) => event.category === AUTH_AUDIT.administratorRoleToppedUp,
        );
        expect(events).toHaveLength(1);
      } finally {
        await cleanup();
      }
    });
  },
);
