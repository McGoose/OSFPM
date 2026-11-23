import type { PermissionDefinition } from '../access/permission-sync.js';

/**
 * Permission to run the organisation's personal API tokens (SC-10, decision D-68):
 * to read and change the two switches that allow them (`api.personal-tokens` and
 * `api.personal-tokens.sensitive`), and to list and revoke any token of the
 * organisation. Held in the organisation. It shows token metadata only, never a
 * token or its hash, and it lets nobody make a token for someone else: a token is
 * only ever made by its owner (`api:tokens`).
 */
export const API_MANAGE_PERMISSION = 'api:manage';

/**
 * Permission to make personal API tokens for yourself, and to list and revoke your
 * own (SC-10, decision D-68). Held in the organisation. A token never exceeds its
 * owner's access, and one that carries a sensitive scope needs the organisation's
 * sensitive-token switch on and the owner to hold each permission it names.
 */
export const API_TOKENS_PERMISSION = 'api:tokens';

/**
 * Catalogue rows for the personal API tokens. Neither exposes sensitive data, and
 * both are `write`: they create, change and revoke things, and no token ever
 * reaches the routes that use them (a token cannot manage tokens).
 */
export const API_PERMISSIONS: readonly PermissionDefinition[] = [
  {
    key: API_MANAGE_PERMISSION,
    module: 'api',
    description:
      'Read and change the API token settings, and list and revoke any personal API token of the organisation',
    grantsSensitive: false,
    access: 'write',
  },
  {
    key: API_TOKENS_PERMISSION,
    module: 'api',
    description: 'Create, list and revoke your own personal API tokens',
    grantsSensitive: false,
    access: 'write',
  },
];
