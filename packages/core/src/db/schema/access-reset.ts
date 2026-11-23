import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns, securityTable, timestamptz } from '../columns.js';
import { orgMembership } from './org-membership.js';
import { organisation } from './organisation.js';
import { user } from './user.js';

/**
 * A one-time admin reset link (SC-10, decision D-57, which closes O-14): an
 * administrator makes it for a member who is locked out (a forgotten password, a
 * lost authenticator device, a lost passkey), shows it once and passes it on by any
 * channel. Whoever opens it signs in with a recovery-scope session and must set a
 * new password or add a passkey. Only the SHA-256 hash of the token is stored
 * (`token_hash`); the token goes back to the administrator once, inside the link,
 * and is never stored, logged or audited.
 *
 * `user_id` is the person the link is for. The composite key to `org_membership`
 * on (`organisation_id`, `user_id`) makes that person a member of the issuing
 * organisation, whatever the code does; `user_id` also has a plain key to `user`,
 * named like every security table's. `created_by` is the administrator, who is
 * never the person (`access_reset_not_self_check`: people reset themselves with
 * their recovery codes). `remove_passkeys` says whether using the link also
 * revokes the person's passkeys, for the case where a device was lost or stolen.
 * The rules for who may reset whom are checked by the service, when the link is
 * made and again when it is used (`auth/access-reset.ts`), not by this table. The
 * table does keep one live link per person per organisation
 * (`access_reset_live_unique`: at most one row that is neither used nor revoked).
 *
 * A security table: only `auth/access-reset.ts` writes it, directly, and every
 * change is audited instead of change-logged (CLAUDE.md, Data rules). It is the
 * second security table that carries `organisation_id`, by declaration
 * (`organisationScoped`, as `invite` does): the composite key above needs the
 * column. It has no `owner_org_id` or `visibility`, and the write helper refuses it.
 *
 * Retention class `transient`: a working row that cleanup removes, and the audit
 * log is the record. `cleanupAccessResets` deletes the links that were used or
 * revoked and those past `expires_at`, with the same cut-off as invites.
 */
export const accessReset = securityTable(
  'access_reset',
  {
    ...baseColumns(() => user.id, { defaultRetentionClass: 'transient' }),
    organisationId: uuid('organisation_id').notNull(),
    userId: uuid('user_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    removePasskeys: boolean('remove_passkeys').notNull().default(false),
    expiresAt: timestamptz('expires_at').notNull(),
    usedAt: timestamptz('used_at'),
    revokedAt: timestamptz('revoked_at'),
    revokedBy: uuid('revoked_by'),
  },
  (t) => [
    // Named <table>_<target>_fk, as every security table's key to its user is.
    foreignKey({
      name: 'access_reset_user_fk',
      columns: [t.userId],
      foreignColumns: [user.id],
    }),
    // The person is a member of the organisation that issued the link. The
    // membership row is a tenant record and is only ever soft-deleted, so the key
    // never blocks a removal; it stops a link for someone who was never a member.
    foreignKey({
      name: 'access_reset_org_membership_fk',
      columns: [t.organisationId, t.userId],
      foreignColumns: [orgMembership.organisationId, orgMembership.userId],
    }),
    // Named <table>_<column without _id>_fk: the table references `user` more than once.
    foreignKey({
      name: 'access_reset_revoked_by_fk',
      columns: [t.revokedBy],
      foreignColumns: [user.id],
    }),
    unique('access_reset_token_hash_unique').on(t.tokenHash),
    // The target of the composite key of any table that later hangs off a link,
    // as `invite_organisation_id_id_unique` is for `invite_role`.
    unique('access_reset_organisation_id_id_unique').on(t.organisationId, t.id),
    // Finds the live link of a member without reading the whole table, and
    // covers the composite key above.
    index('access_reset_organisation_user_idx').on(t.organisationId, t.userId),
    // One link per member per organisation that is neither used nor revoked: the
    // backstop for `createAccessReset`, which locks the person's row and revokes the
    // earlier link before it makes the next. The expiry is not part of "live" here,
    // because `now()` cannot be in an index predicate: a link past its end holds the
    // place until something revokes it, and the next link does. Both key columns are
    // NOT NULL, so the NULLS NOT DISTINCT rule of CLAUDE.md (Data rules) does not apply.
    uniqueIndex('access_reset_live_unique')
      .on(t.organisationId, t.userId)
      .where(sql`${t.usedAt} is null and ${t.revokedAt} is null`),
    check(
      'access_reset_revoked_pair_check',
      sql`(${t.revokedAt} is null) = (${t.revokedBy} is null)`,
    ),
    check(
      'access_reset_not_used_and_revoked_check',
      sql`${t.usedAt} is null or ${t.revokedAt} is null`,
    ),
    check('access_reset_expiry_check', sql`${t.expiresAt} > ${t.createdAt}`),
    // People reset themselves with their recovery codes (SC-10). A NULL
    // `created_by` passes, as for every other table; the service always sets it.
    check('access_reset_not_self_check', sql`${t.userId} <> ${t.createdBy}`),
  ],
  {
    organisationScoped: {
      organisationId: () => organisation.id,
      reason:
        'A reset link belongs to one organisation, and its composite key to org_membership on organisation_id makes the person it is for a member of the organisation that issued it, so one organisation’s administrator can never be handed a link for someone who is not a member.',
    },
  },
);
