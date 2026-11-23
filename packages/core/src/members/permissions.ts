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

/**
 * Permission to help a member who is locked out back in: to make a one-time reset
 * link for them and to revoke it. Held in the organisation. Using the link signs
 * the person in with a recovery-scope session and clears their password,
 * authenticator and recovery codes (and their passkeys, when asked), so the
 * services refuse to make one for anyone who holds more than the person making it
 * (`createAccessReset`; SC-10, decision D-57). It does not reach crew personal data
 * and shows nothing about how a member signs in.
 */
export const MEMBERS_RESET_ACCESS_PERMISSION = 'members:reset-access';

/** Catalogue rows for the members module. None of the permissions exposes sensitive data. */
export const MEMBER_PERMISSIONS: readonly PermissionDefinition[] = [
  {
    key: MEMBERS_READ_PERMISSION,
    module: 'members',
    description: 'List the members of the organisation',
    grantsSensitive: false,
    access: 'read',
  },
  {
    key: MEMBERS_INVITE_PERMISSION,
    module: 'members',
    description: 'Create, list and revoke invite links',
    grantsSensitive: false,
    access: 'write',
  },
  {
    key: MEMBERS_RESET_ACCESS_PERMISSION,
    module: 'members',
    description: 'Create and revoke reset links for members who are locked out',
    grantsSensitive: false,
    access: 'write',
  },
];
