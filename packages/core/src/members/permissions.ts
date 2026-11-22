import type { PermissionDefinition } from '../access/permission-sync.js';

/**
 * Permission to list the people who belong to the organisation: who they are by
 * name and address, their tier, whether the membership is active, and the keys of
 * the roles they hold. Held in the organisation. It does not reach crew personal
 * data, which belongs to `person` and `sensitive:read:*`, and it shows nothing
 * about how a member signs in.
 */
export const MEMBERS_READ_PERMISSION = 'members:read';

/**
 * Permission to invite people into the organisation: to make an invite link, list
 * the invites still waiting and revoke one. Held in the organisation. An invite
 * can give only roles whose every permission the person making it holds, at the
 * same reach or wider, so holding this permission never lets someone hand out
 * more than they have (`createInvite`; SC-10, decision D-57).
 */
export const MEMBERS_INVITE_PERMISSION = 'members:invite';

/** Catalogue rows for the members module. Neither permission exposes sensitive data. */
export const MEMBER_PERMISSIONS: readonly PermissionDefinition[] = [
  {
    key: MEMBERS_READ_PERMISSION,
    module: 'members',
    description: 'List the members of the organisation',
    grantsSensitive: false,
  },
  {
    key: MEMBERS_INVITE_PERMISSION,
    module: 'members',
    description: 'Create, list and revoke invite links',
    grantsSensitive: false,
  },
];
