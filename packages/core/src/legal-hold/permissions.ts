import type { PermissionDefinition } from '../access/permission-sync.js';

/**
 * Permission to place and release legal holds. Held on a project for project
 * and project-record holds, and in the organisation for whole-organisation
 * holds and for record holds without a project.
 */
export const LEGAL_HOLD_MANAGE_PERMISSION = 'legal-hold:manage';

/** Catalogue rows for the legal hold module. */
export const LEGAL_HOLD_PERMISSIONS: readonly PermissionDefinition[] = [
  {
    key: LEGAL_HOLD_MANAGE_PERMISSION,
    module: 'legal-hold',
    description: 'Place and release legal holds',
    grantsSensitive: false,
    access: 'write',
  },
];
