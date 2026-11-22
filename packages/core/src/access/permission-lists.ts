import { ACCOUNT_PERMISSIONS } from '../accounts/permissions.js';
import { CONTRACT_PERMISSIONS } from '../contracts/permissions.js';
import { COST_PERMISSIONS } from '../costs/permissions.js';
import { LEGAL_HOLD_PERMISSIONS } from '../legal-hold/permissions.js';
import { MEMBER_PERMISSIONS } from '../members/permissions.js';
import { SENSITIVE_PERMISSIONS } from '../sensitive/permissions.js';
import type { PermissionDefinition } from './permission-sync.js';

/**
 * Every permission list a module of the core declares, in the order they are
 * synced: the one registry. The server fills the `permission` catalogue from
 * these when it starts (`syncPermissions`), so a module's keys exist before any
 * role is granted them. Read-only; nothing here checks a permission.
 *
 * A module that adds a `*_PERMISSIONS` list adds it here too.
 * `permission-lists.test.ts` scans the core for declared lists and fails when
 * one is missing, so a list cannot be left out and never synced.
 */
export const PERMISSION_LISTS: readonly (readonly PermissionDefinition[])[] = [
  ACCOUNT_PERMISSIONS,
  CONTRACT_PERMISSIONS,
  COST_PERMISSIONS,
  LEGAL_HOLD_PERMISSIONS,
  MEMBER_PERMISSIONS,
  SENSITIVE_PERMISSIONS,
];
