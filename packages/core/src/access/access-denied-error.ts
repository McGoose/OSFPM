import type { PermissionScope } from './scoped-permission.js';

/**
 * The caller lacks `permission`. Services throw it for a denied call; the
 * layer above maps it to a 403.
 *
 * `scope` says whether the permission was checked on a project or in the
 * organisation. Pass the scope only when the caller named it, as a create, a
 * list or a place-hold call does. When the caller named a record by id, leave
 * it out: the record's own scope is not for a caller without access to learn,
 * and an unknown id must be refused exactly like a forbidden one, or the scope
 * would tell whether the id exists.
 *
 * The error never carries ids or values: from the scope it keeps only the kind.
 */
export class AccessDeniedError extends Error {
  readonly scope: 'project' | 'organisation' | undefined;

  constructor(
    readonly permission: string,
    scope?: PermissionScope,
  ) {
    const kind =
      scope === undefined
        ? undefined
        : scope.projectId !== null
          ? 'project'
          : 'organisation';
    super(
      `Access denied: ${permission} is needed` +
        (kind === undefined ? '' : ` on the ${kind}`),
    );
    this.name = 'AccessDeniedError';
    this.scope = kind;
  }
}
