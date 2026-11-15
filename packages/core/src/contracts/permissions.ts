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
 * writing them is refused.
 */
export const CONTRACTS_READ_VALUE_PERMISSION = 'contracts:read-value';

/** Catalogue rows for the contracts module. */
export const CONTRACT_PERMISSIONS: readonly PermissionDefinition[] = [
  {
    key: CONTRACTS_READ_PERMISSION,
    module: 'contracts',
    description: 'Read contracts, their parties and links, without amounts',
    grantsSensitive: false,
  },
  {
    key: CONTRACTS_EDIT_PERMISSION,
    module: 'contracts',
    description: 'Create and change contracts, their parties and links',
    grantsSensitive: false,
  },
  {
    key: CONTRACTS_READ_VALUE_PERMISSION,
    module: 'contracts',
    description: 'See and change contract amounts and currencies',
    grantsSensitive: false,
  },
];
