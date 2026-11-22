import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertGrantEditable,
  assertRoleEditable,
  ManagedRoleError,
} from '../access/managed-role.js';
import { hasOrganisationPermission } from '../access/organisation-permission.js';
import { PERMISSION_LISTS } from '../access/permission-lists.js';
import { hasProjectPermission } from '../access/project-permission.js';
import { seedProject, seedUser } from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import { role, rolePermission } from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import {
  RecordWriteError,
  softDeleteRecord,
  updateRecord,
  type WriteContext,
} from '../db/write.js';
import {
  ADMINISTRATOR_ROLE_KEY,
  ADMINISTRATOR_ROLE_NAME,
} from './administrator-role.js';
import { completeFirstRunSetup } from './first-run-setup.js';
import { demoSetupInput, seedFirstRun } from './test-support.js';

const T0 = new Date('2026-03-02T09:00:00.000Z');

/** Every permission the core declares, from the registry the server syncs at start-up. */
const DEFINITIONS = PERMISSION_LISTS.flatMap((list) => [...list]);
const SENSITIVE = DEFINITIONS.filter(
  (definition) => definition.grantsSensitive === true,
);
const ORDINARY = DEFINITIONS.filter(
  (definition) => definition.grantsSensitive !== true,
);

describe('the permissions the Administrator role is made from', () => {
  it('include both kinds, so the tests below check something', () => {
    expect(SENSITIVE.length).toBeGreaterThan(5);
    expect(ORDINARY.length).toBeGreaterThan(5);
    expect(new Set(DEFINITIONS.map((definition) => definition.key)).size).toBe(
      DEFINITIONS.length,
    );
  });
});

describe.each(testTargets)('the Administrator role on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  let organisationId: string;
  let userId: string;
  let projectId: string;
  let outsiderId: string;

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
    // A production made afterwards, as any new one would be, and a person who
    // belongs to nothing.
    projectId = await seedProject(database, organisationId);
    outsiderId = await seedUser(database);
  });
  afterAll(async () => {
    await cleanup();
  });

  const db = () => database.db;
  const grants = () => db().select().from(rolePermission);

  it('is the one role of the organisation, an organisation role and not a project role, made by the new user', async () => {
    const roles = await db().select().from(role);
    expect(roles).toHaveLength(1);
    expect(roles[0]).toMatchObject({
      organisationId,
      ownerOrgId: organisationId,
      projectId: null,
      key: ADMINISTRATOR_ROLE_KEY,
      name: ADMINISTRATOR_ROLE_NAME,
      isDefault: false,
      managed: true,
      createdBy: userId,
    });
    expect(ADMINISTRATOR_ROLE_KEY).toBe('administrator');
  });

  it('is a managed role: an organisation cannot edit or delete it or its grants, through the service guard or the database', async () => {
    const [administrator] = await db().select().from(role);
    const [grant] = await grants();
    await expect(
      assertRoleEditable(db(), administrator!.id),
    ).rejects.toBeInstanceOf(ManagedRoleError);
    await expect(assertGrantEditable(db(), grant!.id)).rejects.toBeInstanceOf(
      ManagedRoleError,
    );
    // A write that skips the guard, through the write helper, is refused by the trigger.
    const context: WriteContext = {
      actor: { type: 'user', id: userId },
      originServer: administrator!.originServer,
      clock: () => T0,
    };
    const attempts = [
      () =>
        updateRecord(
          db(),
          role,
          administrator!.id,
          administrator!.version,
          { name: 'Renamed' },
          context,
        ),
      () =>
        softDeleteRecord(
          db(),
          role,
          administrator!.id,
          administrator!.version,
          context,
        ),
      () =>
        updateRecord(
          db(),
          rolePermission,
          grant!.id,
          grant!.version,
          { reach: 'own-scope' },
          context,
        ),
      () =>
        softDeleteRecord(
          db(),
          rolePermission,
          grant!.id,
          grant!.version,
          context,
        ),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toBeInstanceOf(RecordWriteError);
    }
    expect(await db().select().from(role)).toHaveLength(1);
    expect(await grants()).toHaveLength(DEFINITIONS.length);
  });

  it('holds every permission the core declares, once each, and no other', async () => {
    const held = (await grants()).map((grant) => grant.permissionKey).sort();
    expect(held).toEqual(
      DEFINITIONS.map((definition) => definition.key).sort(),
    );
    for (const grant of await grants()) {
      // Never limited to a department: the Administrator is not one.
      expect(grant.departmentId).toBeNull();
      expect(grant.deletedAt).toBeNull();
    }
  });

  it('grants a sensitive permission in its own scope, and every other to all projects', async () => {
    const byKey = new Map(
      (await grants()).map((grant) => [grant.permissionKey, grant.reach]),
    );
    for (const definition of SENSITIVE) {
      expect(byKey.get(definition.key), definition.key).toBe('own-scope');
    }
    for (const definition of ORDINARY) {
      expect(byKey.get(definition.key), definition.key).toBe('all-projects');
    }
  });

  it('grants no sensitive permission to all projects', async () => {
    const sensitiveKeys = new Set(
      SENSITIVE.map((definition) => definition.key),
    );
    const wide = (await grants()).filter(
      (grant) =>
        grant.reach === 'all-projects' &&
        sensitiveKeys.has(grant.permissionKey),
    );
    expect(wide).toEqual([]);
  });

  it('lets the administrator pass hasOrganisationPermission for every permission, sensitive or not', async () => {
    for (const definition of DEFINITIONS) {
      expect(
        await hasOrganisationPermission(
          db(),
          userId,
          organisationId,
          definition.key,
        ),
        definition.key,
      ).toBe(true);
    }
  });

  it('lets the administrator pass hasProjectPermission in a new project for the ordinary permissions only', async () => {
    for (const definition of ORDINARY) {
      expect(
        await hasProjectPermission(db(), userId, projectId, definition.key),
        definition.key,
      ).toBe(true);
    }
    // Sensitive crew data, contract and cost amounts still need a membership of
    // the project (decision D-55; CLAUDE.md, Privacy rule).
    for (const definition of SENSITIVE) {
      expect(
        await hasProjectPermission(db(), userId, projectId, definition.key),
        definition.key,
      ).toBe(false);
    }
  });

  it('gives a person with no membership nothing, in the organisation or in the project', async () => {
    for (const definition of DEFINITIONS) {
      expect(
        await hasOrganisationPermission(
          db(),
          outsiderId,
          organisationId,
          definition.key,
        ),
        definition.key,
      ).toBe(false);
      expect(
        await hasProjectPermission(db(), outsiderId, projectId, definition.key),
        definition.key,
      ).toBe(false);
    }
  });

  it('is what grants it: the owner tier alone holds nothing', async () => {
    // Remove the link between the membership and the role, and the owner has
    // nothing at all: a tier grants nothing by itself.
    // Direct SQL in a test, as fixtures may write rows directly.
    await db().execute(
      sql.raw('update org_membership_role set deleted_at = now()'),
    );
    for (const definition of DEFINITIONS) {
      expect(
        await hasOrganisationPermission(
          db(),
          userId,
          organisationId,
          definition.key,
        ),
        definition.key,
      ).toBe(false);
    }
    await db().execute(
      sql.raw('update org_membership_role set deleted_at = null'),
    );
    expect(
      await hasOrganisationPermission(
        db(),
        userId,
        organisationId,
        DEFINITIONS[0]!.key,
      ),
    ).toBe(true);
  });

  it('names the role in the grants it made', async () => {
    const [administrator] = await db()
      .select()
      .from(role)
      .where(eq(role.key, ADMINISTRATOR_ROLE_KEY));
    for (const grant of await grants()) {
      expect(grant.roleId).toBe(administrator!.id);
      expect(grant.organisationId).toBe(organisationId);
    }
  });
});
