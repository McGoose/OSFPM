import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { settingValue } from '../db/schema/index.js';
import type { Tx } from '../db/write.js';

/**
 * The organisation setting behind "share with the usual roles" (decision D-69): which
 * roles a person usually shares each group of access needs with, so that a person
 * does not have to pick the same roles on every production. It is kept as an
 * organisation-level setting: a row of `setting_value` at the `org` layer with the key
 * below and a JSON object as its value, from a field group to the ids of the roles. It
 * is empty by default, which is a row that is not there. There is no settings service
 * yet (the settings inheritance of P-04 will bring one and write it), so this module
 * only reads it.
 */

/**
 * The key of the setting. Its value is an object such as
 * `{ "schedule": ["<role id>"], "medical": ["<role id>"] }`.
 */
export const ACCESS_SUGGESTED_ROLES_SETTING = 'access.suggested-roles';

/**
 * The groups the setting can name: the groups of adjustments, and `medical`. Not
 * `notes`: free text is never shared by the shortcut, whatever the setting says, only
 * by an explicit grant.
 */
export const SUGGESTED_ROLE_GROUPS = [
  'schedule',
  'physical',
  'transport',
  'communication',
  'environment',
  'support',
  'medical',
] as const;
/** One value of `SUGGESTED_ROLE_GROUPS`. */
export type SuggestedRoleGroup = (typeof SUGGESTED_ROLE_GROUPS)[number];

/** The roles suggested for each group that has any. A group with none is not in the map. */
export type SuggestedRoles = ReadonlyMap<SuggestedRoleGroup, readonly string[]>;

const roleIds = z.array(z.uuid());

/**
 * The suggested roles a stored value says. A value that is not an object, a group the
 * setting may not name, and a group whose value is not a list of ids are left out, so
 * a value that is wrong in any way shares nothing: it fails closed. Repeated ids count
 * once. Nothing here reads the database.
 */
export function parseSuggestedRoles(value: unknown): SuggestedRoles {
  const found = new Map<SuggestedRoleGroup, readonly string[]>();
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return found;
  }
  for (const group of SUGGESTED_ROLE_GROUPS) {
    // Own keys only, so an inherited name is never read for a group.
    if (!Object.hasOwn(value, group)) continue;
    const parsed = roleIds.safeParse((value as Record<string, unknown>)[group]);
    if (parsed.success && parsed.data.length > 0) {
      found.set(group, [...new Set(parsed.data)]);
    }
  }
  return found;
}

/**
 * The suggested roles of an organisation: empty when it has no such setting, which is
 * the state of every new organisation. Reads the live row at the `org` layer with no
 * project and nothing else, without a lock, and checks no permission: the services that
 * share on a person's behalf (`shareWithSuggestedRoles`) have decided who may ask. The
 * ids are not checked against the roles here: the service that makes a grant refuses a
 * role that is not available to the project.
 */
export async function readSuggestedRoles(
  tx: Tx,
  organisationId: string,
): Promise<SuggestedRoles> {
  const [row] = await tx
    .select({ value: settingValue.value })
    .from(settingValue)
    .where(
      and(
        eq(settingValue.organisationId, organisationId),
        eq(settingValue.layer, 'org'),
        isNull(settingValue.projectId),
        eq(settingValue.key, ACCESS_SUGGESTED_ROLES_SETTING),
        isNull(settingValue.deletedAt),
      ),
    )
    .limit(1);
  return row === undefined ? new Map() : parseSuggestedRoles(row.value);
}
