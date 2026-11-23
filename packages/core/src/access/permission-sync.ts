import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/write.js';
import { permission, role, rolePermission } from '../db/schema/index.js';

/**
 * What a permission lets its holder do: `read` only looks at data, `write` also
 * creates, changes, deletes or hands out access. A personal API token that can only
 * read passes `read` permissions and no other (maintainer decision of 23 Nov, task
 * P-03b5; SC-10, D-68), so a permission that both shows and changes something is
 * `write`. The class lives in code only: it is not a column of the `permission`
 * catalogue, `syncPermissions` does not store it, and no response serves it.
 */
export const PERMISSION_ACCESS = ['read', 'write'] as const;
/** One value of `PERMISSION_ACCESS`. */
export type PermissionAccess = (typeof PERMISSION_ACCESS)[number];

/**
 * One permission a module declares, as a row of the `permission` catalogue.
 * Set `grantsSensitive` for any permission that exposes sensitive data
 * (CLAUDE.md, Privacy rule). `access` is required, so a permission cannot be added
 * without being classed (see `PERMISSION_ACCESS`).
 */
export type PermissionDefinition = {
  /** `module:action`, for example `sensitive:read:dietary`. */
  readonly key: string;
  readonly module: string;
  readonly description: string;
  /** Defaults to false. */
  readonly grantsSensitive?: boolean;
  /**
   * Whether the permission only reads or can also change things. Not stored: see
   * `PERMISSION_ACCESS`. A permission that does both is `write`, so a read-only API
   * token cannot hold it (fail closed).
   */
  readonly access: PermissionAccess;
  /**
   * Why `access` is what it is, when the key says otherwise: a mixed permission is
   * `write` although its name says read. Required for a key that ends in `:read`
   * and is `write` (`permission-lists.test.ts` fails without it), so a new read
   * permission is not misclassed by accident. A comment in code, never stored or
   * served.
   */
  readonly accessReason?: string;
};

/**
 * One organisation role that holds an `all-projects` grant of a permission the
 * catalogue is now asked to flag sensitive (see `PermissionSyncError`).
 */
export type AllProjectsHolder = {
  readonly organisationId: string;
  /** The role's key, for example `finance`. */
  readonly roleKey: string;
  /**
   * True when the grant is soft-deleted. It still blocks the change, so it has
   * to be turned into an `own-scope` grant or deleted from the table.
   */
  readonly removed: boolean;
};

/** A permission `syncPermissions` could not flag sensitive, and the roles that stand in the way. */
export type PermissionSyncConflict = {
  readonly permissionKey: string;
  readonly roles: readonly AllProjectsHolder[];
};

/**
 * `syncPermissions` was asked to flag a permission `grantsSensitive` while
 * organisation roles still hold `all-projects` grants of it. A sensitive
 * permission never reaches all projects (CLAUDE.md, Privacy rule; database rule
 * `role_permission_all_projects_not_sensitive`), so the database refuses the
 * change. Nothing from the list was written.
 *
 * The server narrows the grants of managed roles by itself before the sync
 * (`narrowManagedSensitiveGrants`), so only roles an organisation made can be
 * named here. The message and `conflicts` name each permission key and those
 * roles, by organisation id and role key, and say how to fix it: the release that
 * flags the permission must ship a migration that narrows the grants to
 * own-scope, and until it does an operator narrows or removes them and restarts.
 * They carry no names, descriptions or other values.
 */
export class PermissionSyncError extends Error {
  constructor(readonly conflicts: readonly PermissionSyncConflict[]) {
    super(
      'Cannot flag a permission as sensitive while organisation roles hold ' +
        'all-projects grants of it, because a sensitive permission never ' +
        'reaches all projects. ' +
        conflicts
          .map(
            (c) =>
              `${c.permissionKey}: ${c.roles
                .map(
                  (r) =>
                    `role ${r.roleKey} in organisation ${r.organisationId}` +
                    (r.removed ? ' (grant removed)' : ''),
                )
                .join(', ')}.`,
          )
          .join(' ') +
        ' The release that flags this permission must ship a migration that ' +
        'narrows these grants to own-scope. Until it does, narrow or remove ' +
        'them, then restart. A removed grant still counts: change its reach ' +
        'to own-scope or delete the row.',
    );
    this.name = 'PermissionSyncError';
  }
}

/** The constraint name the database trigger raises (see `0023_role_permission_reach.sql`). */
const ALL_PROJECTS_NOT_SENSITIVE = 'role_permission_all_projects_not_sensitive';

/** True when `error`, or a cause of it, is the database refusing a sensitive all-projects grant. */
function isAllProjectsNotSensitive(error: unknown): boolean {
  let current: unknown = error;
  while (current && typeof current === 'object') {
    const candidate = current as { code?: unknown; constraint?: unknown };
    if (typeof candidate.code === 'string') {
      return (
        candidate.code === '23514' &&
        candidate.constraint === ALL_PROJECTS_NOT_SENSITIVE
      );
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The organisation roles that hold an `all-projects` grant of any of `keys`,
 * deleted grants included because the trigger counts them too.
 */
async function allProjectsHolders(
  tx: Tx,
  keys: readonly string[],
): Promise<PermissionSyncConflict[]> {
  if (keys.length === 0) return [];
  const found = await tx
    .select({
      permissionKey: rolePermission.permissionKey,
      organisationId: role.organisationId,
      roleKey: role.key,
      removed: sql<boolean>`${rolePermission.deletedAt} is not null`,
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
        inArray(rolePermission.permissionKey, keys),
        eq(rolePermission.reach, 'all-projects'),
      ),
    )
    .orderBy(
      asc(rolePermission.permissionKey),
      asc(role.organisationId),
      asc(role.key),
    );
  // A Map, because the keys come from a caller (CLAUDE.md, Data rules).
  const byKey = new Map<string, AllProjectsHolder[]>();
  for (const row of found) {
    const holders = byKey.get(row.permissionKey) ?? [];
    holders.push({
      organisationId: row.organisationId,
      roleKey: row.roleKey,
      removed: row.removed,
    });
    byKey.set(row.permissionKey, holders);
  }
  return [...byKey].map(([permissionKey, roles]) => ({ permissionKey, roles }));
}

/**
 * Upserts catalogue rows: new keys are inserted, known keys get the current
 * module, description and `grants_sensitive`. Running it again changes
 * nothing, and existing role grants stay. The API server calls it for every
 * list in `PERMISSION_LISTS` when it starts (`runStartup` in
 * `packages/api/src/startup.ts`);
 * tests that need keys without a server use `ensurePermissions`.
 * Checks no permission: only trusted start-up code calls it.
 *
 * The list is applied together or not at all, in a savepoint, so a refusal
 * leaves the caller's transaction usable.
 *
 * @throws PermissionSyncError when a key is flagged `grantsSensitive` while
 * organisation roles hold `all-projects` grants of it (the managed roles' own
 * grants are narrowed first, by `narrowManagedSensitiveGrants`). It names the key
 * and the roles; nothing is written.
 * @throws The database's own error when a key breaks the key-format CHECK.
 */
export async function syncPermissions(
  tx: Tx,
  list: readonly PermissionDefinition[],
): Promise<void> {
  if (list.length === 0) return;
  try {
    // A failed statement aborts a PostgreSQL transaction, so the upsert runs in
    // a savepoint (a transaction of its own when `tx` is the database). Then the
    // lookup below still works, and the caller can carry on after the error.
    await tx.transaction(async (inner) => {
      await inner
        .insert(permission)
        .values(
          list.map((p) => ({
            key: p.key,
            module: p.module,
            description: p.description,
            grantsSensitive: p.grantsSensitive ?? false,
          })),
        )
        .onConflictDoUpdate({
          target: permission.key,
          set: {
            module: sql`excluded.module`,
            description: sql`excluded.description`,
            grantsSensitive: sql`excluded.grants_sensitive`,
          },
        });
    });
  } catch (error) {
    if (!isAllProjectsNotSensitive(error)) throw error;
    const conflicts = await allProjectsHolders(
      tx,
      list.filter((p) => p.grantsSensitive === true).map((p) => p.key),
    );
    // The grants went away while we looked: report the database's error as is.
    if (conflicts.length === 0) throw error;
    throw new PermissionSyncError(conflicts);
  }
}
