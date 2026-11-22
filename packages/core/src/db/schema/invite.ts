import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  primaryKey,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  baseColumns,
  securityChildTable,
  securityTable,
  sqlList,
  timestamptz,
} from '../columns.js';
import type { OrgRole } from './org-membership.js';
import { organisation } from './organisation.js';
import { role } from './role.js';
import { user } from './user.js';

/**
 * Allowed values of `invite.tier`: the membership tiers (`ORG_ROLES`) except
 * `owner`, which no invite can give (SC-10; decision D-51: a tier grants no
 * permission, so an invite's power is its roles, and the first administrator is
 * the owner). The CHECK is built from this list, so a new value needs a new
 * migration. Written out, not filtered from `ORG_ROLES`, so the API can build its
 * enum from it; `schema.test.ts` requires it to equal `ORG_ROLES` without `owner`,
 * so a new tier cannot be forgotten here.
 */
export const INVITE_TIERS = [
  'admin',
  'member',
  'supervisor',
  'guest',
] as const satisfies readonly Exclude<OrgRole, 'owner'>[];
/** One value of `INVITE_TIERS`. */
export type InviteTier = (typeof INVITE_TIERS)[number];

/**
 * A one-time invite link (SC-10, decision D-57): an administrator makes it, passes
 * it on by any channel, and whoever opens it joins the organisation with the tier
 * and roles it names. Only the SHA-256 hash of the token is stored (`token_hash`);
 * the token goes back to the administrator once, inside the link, and is never
 * stored, logged or audited. `email` is optional: when set, only that address can
 * accept it. It is stored normalised, as `user.email` is, and never audited.
 *
 * A security table: only `auth/invites.ts` writes it, directly, and every change
 * is audited instead of change-logged (CLAUDE.md, Data rules). It is the one
 * kind of security table that carries `organisation_id`, by declaration
 * (`organisationScoped`): an invite belongs to one organisation, and
 * `invite_role` points at it, and at the roles it carries, through composite keys
 * on `organisation_id`, so an invite can never attach another organisation's role.
 * It has no `owner_org_id` or `visibility`, and the write helper refuses it.
 *
 * Retention class `transient`: a working row that cleanup removes, and the audit
 * log is the record. `cleanupInvites` deletes the invites that were used or
 * revoked and those past `expires_at`, with the same cut-off as setup codes; the
 * role links go with them (`invite_role` cascades).
 */
export const invite = securityTable(
  'invite',
  {
    ...baseColumns(() => user.id, { defaultRetentionClass: 'transient' }),
    organisationId: uuid('organisation_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    email: text('email'),
    tier: text('tier').$type<InviteTier>().notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    usedAt: timestamptz('used_at'),
    usedBy: uuid('used_by'),
    revokedAt: timestamptz('revoked_at'),
    revokedBy: uuid('revoked_by'),
  },
  (t) => [
    // Named <table>_<column without _id>_fk: the table references `user` more than once.
    foreignKey({
      name: 'invite_used_by_fk',
      columns: [t.usedBy],
      foreignColumns: [user.id],
    }),
    foreignKey({
      name: 'invite_revoked_by_fk',
      columns: [t.revokedBy],
      foreignColumns: [user.id],
    }),
    unique('invite_token_hash_unique').on(t.tokenHash),
    // The target of the composite key of invite_role.
    unique('invite_organisation_id_id_unique').on(t.organisationId, t.id),
    // The same shape as user_email_normalised_check, for an address that is
    // there: lower case, no whitespace, an @ with something on each side.
    check(
      'invite_email_normalised_check',
      sql`${t.email} is null or (${t.email} = lower(${t.email}) and ${t.email} !~ '[[:space:]]' and ${t.email} like '%_@_%')`,
    ),
    check('invite_tier_check', sql`${t.tier} in (${sqlList(INVITE_TIERS)})`),
    check(
      'invite_used_pair_check',
      sql`(${t.usedAt} is null) = (${t.usedBy} is null)`,
    ),
    check(
      'invite_revoked_pair_check',
      sql`(${t.revokedAt} is null) = (${t.revokedBy} is null)`,
    ),
    check(
      'invite_not_used_and_revoked_check',
      sql`${t.usedAt} is null or ${t.revokedAt} is null`,
    ),
    check('invite_expiry_check', sql`${t.expiresAt} > ${t.createdAt}`),
  ],
  {
    organisationScoped: {
      organisationId: () => organisation.id,
      reason:
        'An invite belongs to one organisation, and invite_role ties it to roles through composite keys on organisation_id, so an invite can never attach another organisation’s role.',
    },
  },
);

/**
 * The organisation roles an invite gives, one row for each. The primary key is
 * (`invite_id`, `role_id`): a role is attached to an invite once.
 *
 * Both foreign keys are composite, on `organisation_id`: the invite and the role
 * must belong to the organisation this row names, so no invite can carry another
 * organisation's role, whatever the code does. Both cascade: the rows go with
 * their invite, and a role that is deleted drops off the invites that were still
 * waiting.
 *
 * It has no retention class of its own: its rows are deleted with their invite
 * (`ON DELETE CASCADE`), so the invite's `transient` cleanup (`cleanupInvites`)
 * covers both. Only `auth/invites.ts` writes it, directly; the write helper
 * refuses it though it has an `organisation_id`.
 */
export const inviteRole = securityChildTable(
  'invite_role',
  {
    organisationId: uuid('organisation_id').notNull(),
    inviteId: uuid('invite_id').notNull(),
    roleId: uuid('role_id').notNull(),
  },
  (t) => [
    primaryKey({ name: 'invite_role_pk', columns: [t.inviteId, t.roleId] }),
    foreignKey({
      name: 'invite_role_invite_fk',
      columns: [t.organisationId, t.inviteId],
      foreignColumns: [invite.organisationId, invite.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'invite_role_role_fk',
      columns: [t.organisationId, t.roleId],
      foreignColumns: [role.organisationId, role.id],
    }).onDelete('cascade'),
    // So that deleting a role finds its links without reading the whole table.
    index('invite_role_role_idx').on(t.organisationId, t.roleId),
  ],
  {
    organisationId: () => organisation.id,
    parent: 'invite',
    reason:
      'It has no retention class of its own: its rows are deleted with their invite (ON DELETE CASCADE), so the invite’s transient cleanup covers both. It carries organisation_id so its composite keys keep an invite and its roles in one organisation.',
  },
);
