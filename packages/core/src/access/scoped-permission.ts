import type { Tx } from '../db/write.js';
import { hasOrganisationPermission } from './organisation-permission.js';
import { hasProjectPermission } from './project-permission.js';

/**
 * Where a permission is checked: on a project, or in the organisation when
 * `projectId` is null. A role on a project grants nothing in the organisation.
 * An organisation role grants on a project only through a grant with reach
 * `all-projects`, never for a sensitive permission.
 */
export type PermissionScope = {
  readonly organisationId: string;
  readonly projectId: string | null;
};

/**
 * True when `userId` holds `key` in `scope`: `hasProjectPermission` when the
 * scope has a project, `hasOrganisationPermission` when it has none. For
 * modules whose records may belong to a project or to the organisation alone,
 * such as legal holds and contracts. Server-side only, like both of them.
 */
export function hasScopedPermission(
  tx: Tx,
  userId: string,
  scope: PermissionScope,
  key: string,
): Promise<boolean> {
  return scope.projectId !== null
    ? hasProjectPermission(tx, userId, scope.projectId, key)
    : hasOrganisationPermission(tx, userId, scope.organisationId, key);
}
