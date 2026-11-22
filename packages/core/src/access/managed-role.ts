import { and, eq, sql } from 'drizzle-orm';
import { role, rolePermission } from '../db/schema/index.js';
import type { Tx } from '../db/write.js';

/**
 * Managed roles (SC-10, decision D-56). A managed role (`role.managed`) is one the
 * server makes and keeps, the Administrator role: an organisation cannot edit or
 * delete it, or give, change or take away its grants. Two layers hold that.
 *
 * - The service guards in this file, `assertRoleEditable` and
 *   `assertGrantEditable`, which every service that edits a role or its grants
 *   calls before it writes, so the caller gets a clear `ManagedRoleError`.
 * - The database triggers of `0031_role_managed.sql`, which refuse the write when
 *   a caller skipped the guard, with the constraint names `role_managed_system_only`,
 *   `role_managed_no_change` and `role_permission_managed_no_change`.
 *
 * The server's own writes to a managed role (making it, topping it up) run inside
 * `withManagedRoleMaintenance`, which switches the triggers off for that work only.
 */

/**
 * The transaction-local setting the triggers read (`osfpm_managed_role_maintenance()`
 * in `0031_role_managed.sql`). Not exported: only `withManagedRoleMaintenance`
 * writes it.
 */
const MAINTENANCE_SETTING = 'osfpm.managed_role_maintenance';

/**
 * A caller tried to edit or delete a managed role, or to give, change or take
 * away one of its grants. The message is fixed text: it carries no ids and no
 * values, so a caller may show it. Thrown by `assertRoleEditable` and
 * `assertGrantEditable`; the API answers it with a 409 `role-managed`.
 */
export class ManagedRoleError extends Error {
  constructor() {
    super('A managed role and its permissions are kept by the server');
    this.name = 'ManagedRoleError';
  }
}

/**
 * Refuses when role `roleId` is managed, and answers nothing otherwise. A role
 * that is not there passes: the caller's own lookup says it is not found, and
 * this guard does not leak whether a role exists. Call it before any edit or
 * delete of a role.
 *
 * It reads without a lock. A role's flag never changes once the role exists
 * (only the server's own maintenance writes it, and nothing flips it), and a lock
 * taken here, before the write helper takes the organisation's change counter,
 * would reverse the lock order (CLAUDE.md, Data rules). The database trigger is
 * the check that no concurrent write can slip past.
 *
 * Checks no permission: the calling service does that.
 *
 * @throws ManagedRoleError when the role is managed.
 */
export async function assertRoleEditable(
  tx: Tx,
  roleId: string,
): Promise<void> {
  const [found] = await tx
    .select({ managed: role.managed })
    .from(role)
    .where(eq(role.id, roleId))
    .limit(1);
  if (found?.managed === true) throw new ManagedRoleError();
}

/**
 * Refuses when grant `grantId` belongs to a managed role, and answers nothing
 * otherwise. A grant that is not there passes, as in `assertRoleEditable`. Call it
 * before any change or removal of a grant. To give a role a new grant, call
 * `assertRoleEditable` for the role. Reads without a lock, for the reason given
 * there. Checks no permission.
 *
 * @throws ManagedRoleError when the grant's role is managed.
 */
export async function assertGrantEditable(
  tx: Tx,
  grantId: string,
): Promise<void> {
  const [found] = await tx
    .select({ managed: role.managed })
    .from(rolePermission)
    .innerJoin(
      role,
      and(
        eq(role.organisationId, rolePermission.organisationId),
        eq(role.id, rolePermission.roleId),
      ),
    )
    .where(eq(rolePermission.id, grantId))
    .limit(1);
  if (found?.managed === true) throw new ManagedRoleError();
}

/**
 * Runs `work` with the managed-role triggers switched off, in a transaction of its
 * own (a savepoint when `tx` is already one), and answers what `work` answers. For
 * the server's own writes to a managed role and nothing else: making the
 * Administrator role and topping it up. A request must never reach it, and no
 * value from a caller may be written inside it.
 *
 * The setting is local to the transaction, so it ends with it, and it is put back
 * to what it was when `work` finishes, so the rest of the caller's transaction is
 * checked again, and a call inside another call leaves the outer one switched off.
 * If `work` throws, the savepoint (or the transaction) is rolled back and takes
 * the setting with it. `work` must write through the handle it is given: another
 * connection does not see the setting.
 *
 * Checks no permission.
 *
 * @throws Whatever `work` throws, unchanged.
 */
export function withManagedRoleMaintenance<T>(
  tx: Tx,
  work: (inner: Tx) => PromiseLike<T>,
): Promise<T> {
  return tx.transaction(async (inner) => {
    // Both drivers return `{ rows }`, but the shared base type leaves it `unknown`.
    const { rows } = (await inner.execute(
      sql`select coalesce(current_setting(${MAINTENANCE_SETTING}, true), '') as setting`,
    )) as { rows: { setting: string }[] };
    const before = rows[0]!.setting;
    await inner.execute(
      sql`select set_config(${MAINTENANCE_SETTING}, 'on', true)`,
    );
    const result = await work(inner);
    await inner.execute(
      sql`select set_config(${MAINTENANCE_SETTING}, ${before}, true)`,
    );
    return result;
  });
}
