import type { PermissionDefinition } from '../access/permission-sync.js';

/**
 * Permission to read contracts, with their parties and links, but not their
 * amounts. Like the other two, it is held on a project for that project's
 * contracts, and in the organisation for organisation-level contracts, those
 * with no project. Each organisation and project decides which roles hold it.
 */
export const CONTRACTS_READ_PERMISSION = 'contracts:read';

/**
 * Permission to create and change contracts, and to add and remove their
 * parties and links.
 */
export const CONTRACTS_EDIT_PERMISSION = 'contracts:edit';

/**
 * Permission to see the amount and the currency of a contract, and to set or
 * change them. Without it those two fields are left out of every result, and
 * writing them is refused. It is the one contracts permission flagged as
 * granting sensitive data, because the amounts of crew and cast contracts are
 * what people are paid.
 *
 * It is a mixed permission: it shows the amount and it also sets it. So it is
 * classed `write` for now (see `PermissionDefinition.access`), and a read-only API
 * token cannot hold it. When contracts get routes it should be split into a read
 * permission and a write permission (maintainer decision of 23 Nov, task P-03b5).
 */
export const CONTRACTS_READ_VALUE_PERMISSION = 'contracts:read-value';

/** Catalogue rows for the contracts module. */
export const CONTRACT_PERMISSIONS: readonly PermissionDefinition[] = [
  {
    key: CONTRACTS_READ_PERMISSION,
    module: 'contracts',
    description: 'Read contracts, their parties and links, without amounts',
    grantsSensitive: false,
    access: 'read',
  },
  {
    key: CONTRACTS_EDIT_PERMISSION,
    module: 'contracts',
    description: 'Create and change contracts, their parties and links',
    grantsSensitive: false,
    access: 'write',
  },
  {
    key: CONTRACTS_READ_VALUE_PERMISSION,
    module: 'contracts',
    description: 'See and change contract amounts and currencies',
    grantsSensitive: true,
    // Mixed today: it shows the amount and also sets it, so it is `write`, which
    // means a read token cannot hold it. Split it into a read and a write
    // permission when contracts get routes; until then a read token cannot see
    // contract amounts.
    access: 'write',
    accessReason:
      'Mixed: it shows contract amounts and also sets them. Split it into a read and a write permission when contracts get routes; until then a read token cannot hold it.',
  },
];
