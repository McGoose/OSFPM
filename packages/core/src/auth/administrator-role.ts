import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { withManagedRoleMaintenance } from '../access/managed-role.js';
import { PERMISSION_LISTS } from '../access/permission-lists.js';
import type { PermissionDefinition } from '../access/permission-sync.js';
import {
  role,
  rolePermission,
  type RolePermissionReach,
} from '../db/schema/index.js';
import {
  insertRecord,
  updateRecord,
  type Tx,
  type WriteContext,
} from '../db/write.js';
import { AuthStateError } from './errors.js';
import { lockInstallation } from './setup-code.js';
import { AUTH_AUDIT, guardedAuth, recordAuthAudit } from './shared.js';

/**
 * The Administrator role of an organisation, made by first-run setup and kept up
 * to date by the server (SC-10, decision D-56, Q1). A role belongs to the
 * organisation and holds permissions; the owner tier of a membership grants
 * nothing by itself, so this role is what makes the first administrator able to
 * do anything.
 *
 * It is a managed role (`role.managed`): the server makes it and keeps it, and an
 * organisation cannot edit or delete it or its grants (`access/managed-role.ts`).
 * Every write here runs with the managed-role triggers switched off for that work
 * only (`withManagedRoleMaintenance`).
 */

/** The key of the Administrator role in its organisation. */
export const ADMINISTRATOR_ROLE_KEY = 'administrator';

/** The name the Administrator role is shown with. */
export const ADMINISTRATOR_ROLE_NAME = 'Administrator';

/** What the Administrator role is for, in the words a role list shows. */
const ADMINISTRATOR_ROLE_DESCRIPTION =
  'Holds every permission in the organisation, and the ordinary data of every production. Sensitive crew data, contract amounts and cost amounts still need membership of the production.';

/**
 * The reach the Administrator role is given `permission` with, which is the most a
 * role can hold of it without a department:
 *
 * - A permission that is not flagged `grants_sensitive` is granted `all-projects`,
 *   which counts in the organisation and in every project of it, so the
 *   administrator sees and edits every production's ordinary data without being a
 *   member of each (maintainer decision of 22 Nov, task P-03b4a).
 * - A sensitive permission is granted `own-scope`, which counts in the
 *   organisation and nowhere else. A sensitive permission can never reach all
 *   projects, whoever holds it: the database refuses such a grant, and
 *   `hasProjectPermission` ignores one (CLAUDE.md, Privacy rule; decision D-55;
 *   maintainer decision of 21 Nov, task P-02k). Sensitive crew data, contract and
 *   cost amounts still need membership of the project.
 */
function reachFor(permission: PermissionDefinition): RolePermissionReach {
  return permission.grantsSensitive === true ? 'own-scope' : 'all-projects';
}

/** The values of the grant of `permission` to the Administrator role `roleId`. */
function administratorGrant(
  organisationId: string,
  roleId: string,
  permission: PermissionDefinition,
) {
  return {
    organisationId,
    ownerOrgId: organisationId,
    roleId,
    permissionKey: permission.key,
    departmentId: null,
    reach: reachFor(permission),
  };
}

/**
 * Creates the Administrator organisation role (key `administrator`, no project,
 * managed) and grants it every permission in `PERMISSION_LISTS`, and answers its
 * id and how many permissions it was given. Every grant is one row, with the reach
 * `reachFor` gives it: `all-projects` for an ordinary permission, `own-scope` for a
 * sensitive one (see there for the rule and its source).
 *
 * Every row goes through the write helper, with `ctx` as the writer, so each is a
 * change event in the organisation's sequence. The role and its grants are written
 * with the managed-role triggers switched off (`withManagedRoleMaintenance`),
 * which is the only way a managed role is made. The organisation must exist and
 * the permission catalogue must hold every key of the lists (the server syncs it
 * when it starts); a missing key is refused by the database and nothing is left
 * behind when the caller's transaction ends. Checks no permission: only first-run
 * setup calls it, for an organisation that was made a moment ago.
 *
 * @throws RecordWriteError when the database refuses a row; it carries the
 * SQLSTATE and constraint name only.
 * @throws MissingActingUserError for a `token` or `email` context without
 * `onBehalfOfUserId`.
 */
export function createAdministratorRole(
  tx: Tx,
  ctx: WriteContext,
  organisationId: string,
): Promise<{ id: string; permissions: number }> {
  return withManagedRoleMaintenance(tx, async (inner) => {
    const created = await insertRecord(
      inner,
      role,
      {
        organisationId,
        ownerOrgId: organisationId,
        projectId: null,
        key: ADMINISTRATOR_ROLE_KEY,
        name: ADMINISTRATOR_ROLE_NAME,
        description: ADMINISTRATOR_ROLE_DESCRIPTION,
        isDefault: false,
        managed: true,
      },
      ctx,
    );
    let permissions = 0;
    for (const list of PERMISSION_LISTS) {
      for (const permission of list) {
        await insertRecord(
          inner,
          rolePermission,
          administratorGrant(organisationId, created.id, permission),
          ctx,
        );
        permissions += 1;
      }
    }
    return { id: created.id, permissions };
  });
}

/** What `topUpAdministratorRoles` is given. */
export type TopUpAdministratorOptions = {
  /** When it happens: the time of its events and of its change log. */
  readonly now: Date;
  /** The permission lists to give. `PERMISSION_LISTS`, the core's own, when left out. */
  readonly lists?: readonly (readonly PermissionDefinition[])[];
};

/**
 * Gives every managed Administrator role the permissions it does not hold yet, and
 * answers how many grants it made in all, for the server to run each time it
 * starts, after it has synced the permission catalogue: a release that adds a
 * permission makes it reach the administrators without anyone granting it. A
 * grant is made the way `createAdministratorRole` makes it (`reach` `all-projects`
 * for an ordinary permission, `own-scope` for a sensitive one), through the write
 * helper with the system as the writer, so each is a change event in its
 * organisation's sequence.
 *
 * It only adds: it grants what the role is meant to hold (maintainer decision of
 * 22 Nov, task P-03b4a) and changes nothing else. A permission the role already
 * holds is left as it is, whatever its reach, and one that left the lists is not
 * taken away. A permission that a release newly flags as sensitive is handled
 * before the sync, by `narrowManagedSensitiveGrants`, which start-up runs first.
 *
 * Audited as `auth.administrator-role-topped-up` once for each organisation that
 * got any, from the system, naming the organisation and the role, with the count
 * and no permission key. An organisation that got none has no event, and a call
 * that adds nothing writes nothing, takes no change counter and makes no event.
 *
 * It takes the `installation` row lock before anything else, the same first lock
 * as first-run setup, so two servers that start together take turns: the second
 * finds nothing missing and neither fails on the unique key of a grant. After that
 * the lock order is the write helper's own: an organisation's change counter, then
 * the rows. Only the server's start-up calls it, before any request is served, so
 * it checks no permission. Only a role that is managed, has the key
 * `administrator` and belongs to no project is topped up, and a role of an
 * organisation's own with the same key is left alone.
 *
 * @throws AuthStateError `installation-missing` before the installation row
 * exists.
 * @throws RecordWriteError when the database refuses a write, for example a
 * permission missing from the catalogue; it carries the SQLSTATE and constraint
 * name only. Nothing is left behind.
 */
export function topUpAdministratorRoles(
  tx: Tx,
  options: TopUpAdministratorOptions,
): Promise<number> {
  const permissions = (options.lists ?? PERMISSION_LISTS).flatMap((list) => [
    ...list,
  ]);
  return guardedAuth('role_permission', 'insert', () =>
    // A savepoint: a failure leaves no grant and no event.
    tx.transaction(async (inner) => {
      const server = await lockInstallation(inner);
      if (!server) throw new AuthStateError('installation-missing');
      const roles = await inner
        .select({ id: role.id, organisationId: role.organisationId })
        .from(role)
        .where(
          and(
            eq(role.key, ADMINISTRATOR_ROLE_KEY),
            eq(role.managed, true),
            isNull(role.projectId),
            isNull(role.deletedAt),
          ),
        )
        .orderBy(asc(role.organisationId));
      const ctx: WriteContext = {
        originServer: server.id,
        clock: () => options.now,
        actor: { type: 'system', id: null },
      };
      let added = 0;
      for (const found of roles) {
        // Any row counts, a deleted one too: the unique key does not tell them
        // apart, and nothing a caller can do deletes a managed role's grant.
        const held = new Set(
          (
            await inner
              .select({ key: rolePermission.permissionKey })
              .from(rolePermission)
              .where(
                and(
                  eq(rolePermission.roleId, found.id),
                  isNull(rolePermission.departmentId),
                ),
              )
          ).map((row) => row.key),
        );
        const missing = permissions.filter(
          (permission) => !held.has(permission.key),
        );
        if (missing.length === 0) continue;
        await withManagedRoleMaintenance(inner, async (writer) => {
          for (const permission of missing) {
            await insertRecord(
              writer,
              rolePermission,
              administratorGrant(found.organisationId, found.id, permission),
              ctx,
            );
          }
        });
        await recordAuthAudit(inner, {
          category: AUTH_AUDIT.administratorRoleToppedUp,
          action: 'top-up',
          actor: { type: 'system', id: null },
          targetType: 'role',
          targetId: found.id,
          organisationId: found.organisationId,
          details: { added: missing.length },
          occurredAt: options.now,
        });
        added += missing.length;
      }
      return added;
    }),
  );
}

/** What `narrowManagedSensitiveGrants` is given. */
export type NarrowManagedGrantsOptions = {
  /** When it happens: the time of its events and of its change log. */
  readonly now: Date;
  /** The permission lists to read the sensitive flags from. `PERMISSION_LISTS`, the core's own, when left out. */
  readonly lists?: readonly (readonly PermissionDefinition[])[];
};

/**
 * Narrows every `all-projects` grant of a permission the lists flag sensitive, on
 * a managed role, to `own-scope`, and answers how many it narrowed. The server runs
 * it at start-up, in the transaction of the permission sync and before it, so that
 * a release which flags an existing permission sensitive does not stop start-up on
 * the Administrator role's own grant: a sensitive permission never reaches all
 * projects, the database refuses the flag while such a grant exists
 * (`role_permission_all_projects_not_sensitive`), and the managed-role trigger
 * refuses an operator who narrows the grant by hand (CLAUDE.md, Privacy rule;
 * decision D-55; maintainer decision of 22 Nov, task P-03b4b).
 *
 * Only managed roles: an organisation's own role is the organisation's to change,
 * so its grant stays, the sync still stops with `PermissionSyncError` and that
 * error says the release must ship a migration that narrows it. A grant that was
 * removed counts too, as it does for the database. It is done the way the top-up
 * writes, through the write helper with the system as the writer and the
 * managed-role triggers off (`withManagedRoleMaintenance`), so each narrowing is a
 * change event in its organisation's sequence, and it is audited as
 * `role.grant-reach-reduced` from the system, once for each grant, naming the
 * role, the permission and both reaches. A call that narrows nothing writes
 * nothing: no event, no counter, so the second start-up does nothing.
 *
 * When any list flags a permission sensitive it takes the `installation` row
 * lock first, the first lock of start-up, so two servers that start together take
 * turns and the second finds nothing left to narrow; after that the lock order is
 * the write helper's own (the organisation's change counter, then the rows).
 * Before the `installation` row exists no managed role can, so it answers 0 and
 * takes nothing. Only the server's start-up calls
 * it, before any request is served, so it checks no permission.
 *
 * @throws RecordWriteError when the database refuses a write; it carries the
 * SQLSTATE and constraint name only. Nothing is left behind.
 */
export function narrowManagedSensitiveGrants(
  tx: Tx,
  options: NarrowManagedGrantsOptions,
): Promise<number> {
  const sensitiveKeys = (options.lists ?? PERMISSION_LISTS)
    .flatMap((list) => [...list])
    .filter((permission) => permission.grantsSensitive === true)
    .map((permission) => permission.key);
  if (sensitiveKeys.length === 0) return Promise.resolve(0);
  return guardedAuth('role_permission', 'update', () =>
    // A savepoint: a failure leaves every grant as it was, and no event.
    tx.transaction(async (inner) => {
      const server = await lockInstallation(inner);
      if (!server) return 0;
      const wide = await inner
        .select({
          id: rolePermission.id,
          version: rolePermission.version,
          organisationId: rolePermission.organisationId,
          roleId: rolePermission.roleId,
          permissionKey: rolePermission.permissionKey,
        })
        .from(rolePermission)
        .innerJoin(
          role,
          and(
            eq(role.organisationId, rolePermission.organisationId),
            eq(role.id, rolePermission.roleId),
          ),
        )
        .where(
          and(
            inArray(rolePermission.permissionKey, sensitiveKeys),
            eq(rolePermission.reach, 'all-projects'),
            eq(role.managed, true),
          ),
        )
        .orderBy(
          asc(rolePermission.organisationId),
          asc(rolePermission.roleId),
          asc(rolePermission.permissionKey),
        );
      const ctx: WriteContext = {
        originServer: server.id,
        clock: () => options.now,
        actor: { type: 'system', id: null },
      };
      for (const grant of wide) {
        await withManagedRoleMaintenance(inner, (writer) =>
          updateRecord(
            writer,
            rolePermission,
            grant.id,
            grant.version,
            { reach: 'own-scope' },
            ctx,
          ),
        );
        await recordAuthAudit(inner, {
          category: AUTH_AUDIT.grantReachReduced,
          action: 'reduce-reach',
          actor: { type: 'system', id: null },
          targetType: 'role',
          targetId: grant.roleId,
          organisationId: grant.organisationId,
          details: {
            roleId: grant.roleId,
            permissionKey: grant.permissionKey,
            from: 'all-projects',
            to: 'own-scope',
          },
          occurredAt: options.now,
        });
      }
      return wide.length;
    }),
  );
}
