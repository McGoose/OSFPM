import type { PermissionDefinition } from '../access/permission-sync.js';

/**
 * Permission to read charts of accounts and their accounts. It is held on a
 * project for that project's charts, and in the organisation for the
 * organisation's template charts, those with no project. Each organisation and
 * project decides which roles hold it. Copying a template into a project needs
 * it on the organisation, because the template is read.
 */
export const ACCOUNTS_READ_PERMISSION = 'accounts:read';

/**
 * Permission to create and change charts of accounts and their accounts, held
 * in the same two places as `accounts:read`. Copying a template into a project
 * needs it on that project.
 */
export const ACCOUNTS_EDIT_PERMISSION = 'accounts:edit';

/** Catalogue rows for the accounts module. Neither permission exposes sensitive data. */
export const ACCOUNT_PERMISSIONS: readonly PermissionDefinition[] = [
  {
    key: ACCOUNTS_READ_PERMISSION,
    module: 'accounts',
    description: 'Read charts of accounts and their accounts',
    grantsSensitive: false,
  },
  {
    key: ACCOUNTS_EDIT_PERMISSION,
    module: 'accounts',
    description:
      'Create, copy and change charts of accounts and their accounts',
    grantsSensitive: false,
  },
];
