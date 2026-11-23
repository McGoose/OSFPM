import type { PermissionDefinition } from '../access/permission-sync.js';

/**
 * Permission to read cost lines, with their scheme tags, and to see their
 * amounts. It is held on a project and covers that project's cost lines. Without
 * it a caller never sees an amount: the results of the edit and tagging calls
 * leave the amounts out. It is flagged as granting sensitive data because the
 * amounts of lines paid to a person or company are what people are paid.
 */
export const COSTS_READ_PERMISSION = 'costs:read';

/**
 * Permission to create, change and remove cost lines on a project. It does not
 * show amounts: that needs `costs:read`.
 */
export const COSTS_EDIT_PERMISSION = 'costs:edit';

/**
 * Permission to set and remove the scheme tags of a project's cost lines, which
 * say whether a line qualifies for an incentive or funding scheme. Setting a
 * qualifying amount needs `costs:read` as well, because the amount is checked
 * against the line's own.
 */
export const COSTS_TAG_SCHEMES_PERMISSION = 'costs:tag-schemes';

/** Catalogue rows for the costs module. */
export const COST_PERMISSIONS: readonly PermissionDefinition[] = [
  {
    key: COSTS_READ_PERMISSION,
    module: 'costs',
    description:
      'Read cost lines and their scheme tags, including amounts and payees',
    grantsSensitive: true,
    access: 'read',
  },
  {
    key: COSTS_EDIT_PERMISSION,
    module: 'costs',
    description: 'Create, change and remove cost lines',
    grantsSensitive: false,
    access: 'write',
  },
  {
    key: COSTS_TAG_SCHEMES_PERMISSION,
    module: 'costs',
    description: 'Tag cost lines as qualifying or not for incentive schemes',
    grantsSensitive: false,
    access: 'write',
  },
];
