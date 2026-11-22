import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../db/ids.js';
import type { Database } from '../db/client.js';
import { role, rolePermission } from '../db/schema/index.js';
import {
  createMigratedDatabase,
  failureOf,
  SQLSTATE,
  testTargets,
} from '../db/test-support.js';
import {
  RecordWriteError,
  softDeleteRecord,
  updateRecord,
  type WriteContext,
} from '../db/write.js';
import {
  assertGrantEditable,
  assertRoleEditable,
  ManagedRoleError,
  withManagedRoleMaintenance,
} from './managed-role.js';
import { base, ensurePermissions, seedOrganisation } from './test-fixtures.js';

/**
 * A managed role is one the server makes and keeps, the Administrator role: an
 * organisation cannot edit or delete it, or its grants (SC-10, decision D-56).
 * The service guard gives a caller a clear error, and a database trigger
 * (`0031_role_managed.sql`) refuses the write when a caller skipped the guard.
 * The server's own writes switch the trigger off for their transaction.
 */

const context = (): WriteContext => ({
  actor: { type: 'system', id: null },
  originServer: newId(),
  clock: () => new Date('2026-03-02T09:00:00.000Z'),
});

describe.each(testTargets)('managed roles on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  let organisationId: string;
  let counter = 0;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    ({ organisationId } = await seedOrganisation(database));
    await ensurePermissions(database, ['demo:read', 'demo:write']);
  });
  afterAll(async () => {
    await cleanup();
  });

  const db = () => database.db;

  /** A new organisation role. A managed one can only be made with the check off, as the server makes it. */
  async function newRole(managed: boolean) {
    counter += 1;
    const values = {
      ...base(organisationId),
      projectId: null,
      key: `role-${counter}`,
      name: `Role ${counter}`,
      managed,
    };
    const [made] = managed
      ? await withManagedRoleMaintenance(db(), (tx) =>
          tx.insert(role).values(values).returning(),
        )
      : await db().insert(role).values(values).returning();
    return made!;
  }

  /** A grant of `permissionKey` to `roleId`, made with the check off, so a managed role can hold one. */
  async function newGrant(roleId: string, permissionKey = 'demo:read') {
    const [made] = await withManagedRoleMaintenance(db(), (tx) =>
      tx
        .insert(rolePermission)
        .values({
          ...base(organisationId),
          roleId,
          permissionKey,
          departmentId: null,
        })
        .returning(),
    );
    return made!;
  }

  const roleRow = async (id: string) =>
    (await db().select().from(role).where(eq(role.id, id)))[0];
  const grantRow = async (id: string) =>
    (
      await db().select().from(rolePermission).where(eq(rolePermission.id, id))
    )[0];

  /** The refusal the trigger gives, with the constraint name its tests look for. */
  const refused = (constraint: string) => ({
    code: SQLSTATE.checkViolation,
    constraint,
  });

  describe('the role itself', () => {
    it('is not managed unless it says so, and a new role can be made as usual', async () => {
      const made = await newRole(false);
      expect(made.managed).toBe(false);
    });

    it('refuses to make a managed role, unless it is the server', async () => {
      counter += 1;
      const failure = await failureOf(() =>
        db()
          .insert(role)
          .values({
            ...base(organisationId),
            projectId: null,
            key: `role-${counter}`,
            name: 'Sneaked in',
            managed: true,
          }),
      );
      expect(failure).toEqual(refused('role_managed_system_only'));
    });

    it('refuses every change to a managed role: a rename, a soft delete and making it ordinary', async () => {
      const managed = await newRole(true);
      for (const change of [
        { name: 'Renamed' },
        { description: 'Edited' },
        { isDefault: true },
        { deletedAt: new Date() },
        { managed: false },
      ]) {
        const failure = await failureOf(() =>
          db().update(role).set(change).where(eq(role.id, managed.id)),
        );
        expect(failure, JSON.stringify(Object.keys(change))).toEqual(
          refused('role_managed_no_change'),
        );
      }
      expect(await roleRow(managed.id)).toMatchObject({
        name: managed.name,
        managed: true,
        deletedAt: null,
      });
    });

    it('refuses to make an ordinary role managed', async () => {
      const ordinary = await newRole(false);
      const failure = await failureOf(() =>
        db()
          .update(role)
          .set({ managed: true })
          .where(eq(role.id, ordinary.id)),
      );
      expect(failure).toEqual(refused('role_managed_no_change'));
      expect((await roleRow(ordinary.id))!.managed).toBe(false);
    });

    it('refuses to delete a managed role', async () => {
      const managed = await newRole(true);
      const failure = await failureOf(() =>
        db().delete(role).where(eq(role.id, managed.id)),
      );
      expect(failure).toEqual(refused('role_managed_no_change'));
      expect(await roleRow(managed.id)).toBeDefined();
    });

    it('leaves an ordinary role alone: it can be renamed, soft-deleted and deleted', async () => {
      const ordinary = await newRole(false);
      await db()
        .update(role)
        .set({ name: 'Renamed' })
        .where(eq(role.id, ordinary.id));
      expect((await roleRow(ordinary.id))!.name).toBe('Renamed');
      await db()
        .update(role)
        .set({ deletedAt: new Date() })
        .where(eq(role.id, ordinary.id));
      await db().delete(role).where(eq(role.id, ordinary.id));
      expect(await roleRow(ordinary.id)).toBeUndefined();
    });

    it('says no more than the rule: the database’s message holds no role, no organisation and no value', async () => {
      const managed = await newRole(true);
      const error = await db()
        .update(role)
        .set({ name: 'Secret new name' })
        .where(eq(role.id, managed.id))
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );
      // The driver error is what the database said; the wrapper Drizzle puts
      // round it carries the query and its parameters, which the write helper
      // strips (see `RecordWriteError`).
      let said = error as { code?: unknown; message?: string; cause?: unknown };
      while (typeof said.code !== 'string') said = said.cause as typeof said;
      expect(said.message).toMatch(/^role_managed_no_change: /);
      for (const value of [managed.id, organisationId, 'Secret new name']) {
        expect(said.message).not.toContain(value);
      }
    });
  });

  describe('the grants of a managed role', () => {
    it('cannot be added, changed or removed', async () => {
      const managed = await newRole(true);
      const failureToAdd = await failureOf(() =>
        db()
          .insert(rolePermission)
          .values({
            ...base(organisationId),
            roleId: managed.id,
            permissionKey: 'demo:read',
            departmentId: null,
          }),
      );
      expect(failureToAdd).toEqual(
        refused('role_permission_managed_no_change'),
      );

      const grant = await newGrant(managed.id);
      const ordinary = await newRole(false);
      for (const change of [
        { reach: 'all-projects' as const },
        { deletedAt: new Date() },
        { permissionKey: 'demo:write' },
        // Moved off the managed role, which takes it away as much as deleting it.
        { roleId: ordinary.id },
      ]) {
        const failure = await failureOf(() =>
          db()
            .update(rolePermission)
            .set(change)
            .where(eq(rolePermission.id, grant.id)),
        );
        expect(failure, JSON.stringify(Object.keys(change))).toEqual(
          refused('role_permission_managed_no_change'),
        );
      }
      const failureToDelete = await failureOf(() =>
        db().delete(rolePermission).where(eq(rolePermission.id, grant.id)),
      );
      expect(failureToDelete).toEqual(
        refused('role_permission_managed_no_change'),
      );
      expect(await grantRow(grant.id)).toMatchObject({
        reach: 'own-scope',
        permissionKey: 'demo:read',
        roleId: managed.id,
        deletedAt: null,
      });
    });

    it('cannot be given by moving a grant of an ordinary role onto it', async () => {
      const managed = await newRole(true);
      const ordinary = await newRole(false);
      const grant = await db()
        .insert(rolePermission)
        .values({
          ...base(organisationId),
          roleId: ordinary.id,
          permissionKey: 'demo:write',
          departmentId: null,
        })
        .returning();
      const failure = await failureOf(() =>
        db()
          .update(rolePermission)
          .set({ roleId: managed.id })
          .where(eq(rolePermission.id, grant[0]!.id)),
      );
      expect(failure).toEqual(refused('role_permission_managed_no_change'));
      expect((await grantRow(grant[0]!.id))!.roleId).toBe(ordinary.id);
    });

    it('leave the grants of an ordinary role alone', async () => {
      const ordinary = await newRole(false);
      const [grant] = await db()
        .insert(rolePermission)
        .values({
          ...base(organisationId),
          roleId: ordinary.id,
          permissionKey: 'demo:read',
          departmentId: null,
        })
        .returning();
      await db()
        .update(rolePermission)
        .set({ reach: 'all-projects' })
        .where(eq(rolePermission.id, grant!.id));
      await db()
        .update(rolePermission)
        .set({ deletedAt: new Date() })
        .where(eq(rolePermission.id, grant!.id));
      await db().delete(rolePermission).where(eq(rolePermission.id, grant!.id));
      expect(await grantRow(grant!.id)).toBeUndefined();
    });
  });

  describe('the server’s own writes', () => {
    it('are let through while the check is off, for every kind of change', async () => {
      const managed = await newRole(true);
      const grant = await newGrant(managed.id);
      await withManagedRoleMaintenance(db(), async (tx) => {
        await tx
          .update(rolePermission)
          .set({ reach: 'all-projects' })
          .where(eq(rolePermission.id, grant.id));
        await tx
          .update(role)
          .set({ description: 'Kept up to date by the server' })
          .where(eq(role.id, managed.id));
        await tx.delete(rolePermission).where(eq(rolePermission.id, grant.id));
      });
      expect(await grantRow(grant.id)).toBeUndefined();
      expect((await roleRow(managed.id))!.description).toBe(
        'Kept up to date by the server',
      );
    });

    it('end with the call: the check is on again right after', async () => {
      const managed = await newRole(true);
      await withManagedRoleMaintenance(db(), (tx) =>
        tx
          .update(role)
          .set({ description: 'Once' })
          .where(eq(role.id, managed.id)),
      );
      const failure = await failureOf(() =>
        db()
          .update(role)
          .set({ description: 'Twice' })
          .where(eq(role.id, managed.id)),
      );
      expect(failure).toEqual(refused('role_managed_no_change'));
    });

    it('end when the work fails: nothing is left switched off, and the error is the work’s own', async () => {
      const managed = await newRole(true);
      await expect(
        db().transaction(async (tx) => {
          await withManagedRoleMaintenance(tx, () =>
            Promise.reject(new Error('the work failed')),
          );
        }),
      ).rejects.toThrow('the work failed');
      const failure = await failureOf(() =>
        db()
          .update(role)
          .set({ description: 'After a failure' })
          .where(eq(role.id, managed.id)),
      );
      expect(failure).toEqual(refused('role_managed_no_change'));
    });

    it('stay off the rest of the transaction: after the call, inside the same transaction, the check is on', async () => {
      const managed = await newRole(true);
      const outcome = await db().transaction(async (tx) => {
        await withManagedRoleMaintenance(tx, (inner) =>
          inner
            .update(role)
            .set({ description: 'Inside' })
            .where(eq(role.id, managed.id)),
        );
        // In a savepoint of its own, so the refusal does not abort the transaction.
        return failureOf(() =>
          tx.transaction((attempt) =>
            attempt
              .update(role)
              .set({ description: 'Outside' })
              .where(eq(role.id, managed.id)),
          ),
        );
      });
      expect(outcome).toEqual(refused('role_managed_no_change'));
    });
  });

  describe('through the write helper', () => {
    it('refuses to update or delete a managed role, with the constraint name and nothing else', async () => {
      const managed = await newRole(true);
      const update = await db()
        .transaction((tx) =>
          updateRecord(
            tx,
            role,
            managed.id,
            managed.version,
            { name: 'Nope' },
            context(),
          ),
        )
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );
      expect(update).toBeInstanceOf(RecordWriteError);
      expect(update).toMatchObject({
        code: SQLSTATE.checkViolation,
        constraint: 'role_managed_no_change',
      });
      const removal = await db()
        .transaction((tx) =>
          softDeleteRecord(tx, role, managed.id, managed.version, context()),
        )
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );
      expect(removal).toMatchObject({
        code: SQLSTATE.checkViolation,
        constraint: 'role_managed_no_change',
      });
      expect(await roleRow(managed.id)).toMatchObject({
        version: 1,
        deletedAt: null,
      });
    });
  });

  describe('the service guards', () => {
    it('refuse a managed role with a ManagedRoleError that names nothing', async () => {
      const managed = await newRole(true);
      const error = await assertRoleEditable(db(), managed.id).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(ManagedRoleError);
      expect((error as Error).message).not.toContain(managed.id);
      expect((error as Error).message).not.toContain(organisationId);
    });

    it('let an ordinary role, and a role that is not there, through', async () => {
      const ordinary = await newRole(false);
      await expect(
        assertRoleEditable(db(), ordinary.id),
      ).resolves.toBeUndefined();
      await expect(assertRoleEditable(db(), newId())).resolves.toBeUndefined();
    });

    it('refuse a grant of a managed role, and let a grant of an ordinary role through', async () => {
      const managed = await newRole(true);
      const managedGrant = await newGrant(managed.id);
      await expect(
        assertGrantEditable(db(), managedGrant.id),
      ).rejects.toBeInstanceOf(ManagedRoleError);
      const ordinary = await newRole(false);
      const [grant] = await db()
        .insert(rolePermission)
        .values({
          ...base(organisationId),
          roleId: ordinary.id,
          permissionKey: 'demo:write',
          departmentId: null,
        })
        .returning();
      await expect(
        assertGrantEditable(db(), grant!.id),
      ).resolves.toBeUndefined();
      await expect(assertGrantEditable(db(), newId())).resolves.toBeUndefined();
    });

    it('agree with the managed flag of every role of the test database', async () => {
      const all = await db().select().from(role);
      // Both kinds are there, so the loop checks something.
      expect(all.some((found) => found.managed)).toBe(true);
      expect(all.some((found) => !found.managed)).toBe(true);
      for (const found of all) {
        const editable = await assertRoleEditable(db(), found.id).then(
          () => true,
          () => false,
        );
        expect(editable, found.key).toBe(!found.managed);
      }
    });
  });
});
