import type { Tx } from '../db/write.js';
import { hasOrganisationPermission } from './organisation-permission.js';
import { hasProjectPermission } from './project-permission.js';

/**
 * Where a permission is checked: on a project, or in the organisation when
 * `projectId` is null. The two never overlap: a role on a project grants
 * nothing in the organisation, and an organisation role grants nothing on a
 * project.
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
