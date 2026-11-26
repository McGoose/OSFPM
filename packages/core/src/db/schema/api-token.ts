import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  baseColumns,
  securityTable,
  sqlList,
  timestamptz,
} from '../columns.js';
import { orgMembership } from './org-membership.js';
import { organisation } from './organisation.js';
import { project } from './project.js';
import { user } from './user.js';

/**
 * Allowed values of `api_token.access`: what a personal API token may do. A `read`
 * token passes only the checks of permissions classed `read` and only calls routes
 * that say `tokenAccess: 'read'`; a `write` token also passes the write ones
 * (SC-10, decision D-68). Either way it never exceeds what its owner holds. The CHECK
 * is built from this list, so a new value needs a new migration.
 */
export const API_TOKEN_ACCESS = ['read', 'write'] as const;
/** One value of `API_TOKEN_ACCESS`. */
export type ApiTokenAccess = (typeof API_TOKEN_ACCESS)[number];

/**
 * Allowed values of `api_token.revoke_reason`: why a token stopped working. A fixed
 * list, so a caller cannot put free text, and with it a secret, into the audit
 * trail. `manual` is the owner, or an administrator with `api:manage`, revoking one
 * token; `switch-off` is the organisation turning off personal tokens, or the
 * sensitive scope; `access-reset` is an admin reset link being used for the owner;
 * `membership-ended` is the owner's membership ending (the member removal of P-04b
 * writes it; until then a token whose membership is not active simply fails);
 * `admin-action` is the admin command `revoke-sessions --include-api-tokens` ending
 * the owner's tokens (P-09a2, decision D-81). The CHECK is built from this list, so
 * a new value needs a new migration.
 */
export const API_TOKEN_REVOKE_REASONS = [
  'manual',
  'switch-off',
  'access-reset',
  'membership-ended',
  'admin-action',
] as const;
/** One value of `API_TOKEN_REVOKE_REASONS`. */
export type ApiTokenRevokeReason = (typeof API_TOKEN_REVOKE_REASONS)[number];

/**
 * A personal API token (SC-10, decisions D-17 and D-68): a secret a person makes for
 * their own scripts and tools, which acts as them, narrowed by what the token says. The
 * token itself is `osfpm_pat_` and 43 characters of base64url (32 random bytes). Only
 * the SHA-256 hash of those 43 characters is stored (`token_hash`, made as a session
 * token's is, since they are a session token's kind of secret); the token
 * goes back to its owner once, in the response that makes it, and is never stored,
 * logged or audited. `prefix` is `osfpm_pat_` and the first 8 characters of the random
 * part, so owners and administrators can tell tokens apart; it is the only part of the
 * token that is kept or shown.
 *
 * `user_id` is the owner and `organisation_id` the organisation the token works in.
 * The composite key to `org_membership` on (`organisation_id`, `user_id`) makes the
 * owner a member of that organisation, whatever the code does; `user_id` also has a
 * plain key to `user`, named like every security table's. `project_id` limits the
 * token to one project of the organisation (a composite key to `project`), or is NULL
 * for the whole organisation. `sensitive_permissions` is the explicit sensitive scope:
 * the keys of the permissions flagged `grants_sensitive` that the token may pass, none
 * by default; the service refuses a key that is not one, and the database refuses a key
 * listed twice (`api_token_sensitive_permissions_distinct_check`, which calls the
 * function `osfpm_text_array_is_distinct`, written by hand in the migration because a
 * CHECK cannot hold a subquery).
 *
 * `expires_at` is NULL for a token that never expires, which the owner has to ask for
 * (maintainer decision, D-68): the service gives a token that asks for nothing 365
 * days. `last_used_at` is written at most once a minute. A token is revoked, never
 * un-revoked: `revoked_at` and `revoke_reason` are set together; `revoked_by` is the
 * person who did it, required for a `manual` revocation (`api_token_manual_revoker_check`)
 * and NULL for the reasons the server acts on its own (`access-reset`, `membership-ended`,
 * `admin-action`), so the reason and the audit trail say why and who.
 *
 * A security table: only `auth/api-tokens.ts` writes it, directly, and every change is
 * audited instead of change-logged (CLAUDE.md, Data rules). It is the third security
 * table that carries `organisation_id`, by declaration (`organisationScoped`, as
 * `invite` and `access_reset` do): the composite keys above need the column. It has no
 * `owner_org_id` or `visibility`, and the write helper refuses it.
 *
 * Retention class `transient`: a working row that cleanup removes, and the audit log
 * is the record. `cleanupApiTokens` deletes the tokens that were revoked or have
 * expired, with the same cut-off as reset links.
 */
export const apiToken = securityTable(
  'api_token',
  {
    ...baseColumns(() => user.id, { defaultRetentionClass: 'transient' }),
    organisationId: uuid('organisation_id').notNull(),
    userId: uuid('user_id').notNull(),
    projectId: uuid('project_id'),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    tokenHash: text('token_hash').notNull(),
    access: text('access').$type<ApiTokenAccess>().notNull(),
    sensitivePermissions: text('sensitive_permissions')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    expiresAt: timestamptz('expires_at'),
    lastUsedAt: timestamptz('last_used_at'),
    revokedAt: timestamptz('revoked_at'),
    revokedBy: uuid('revoked_by'),
    revokeReason: text('revoke_reason').$type<ApiTokenRevokeReason>(),
  },
  (t) => [
    // Named <table>_<target>_fk, as every security table's key to its user is.
    foreignKey({
      name: 'api_token_user_fk',
      columns: [t.userId],
      foreignColumns: [user.id],
    }),
    // The owner is a member of the organisation the token works in. The membership
    // row is a tenant record and is only ever soft-deleted, so the key never blocks a
    // removal; it stops a token for someone who was never a member. A membership that
    // stops being active makes the token fail at once (`authenticateApiToken`).
    foreignKey({
      name: 'api_token_org_membership_fk',
      columns: [t.organisationId, t.userId],
      foreignColumns: [orgMembership.organisationId, orgMembership.userId],
    }),
    // A project of the same organisation. With `project_id` NULL the key is not
    // checked (MATCH SIMPLE), which is the whole-organisation token.
    foreignKey({
      name: 'api_token_project_fk',
      columns: [t.organisationId, t.projectId],
      foreignColumns: [project.organisationId, project.id],
    }),
    // Named <table>_<column without _id>_fk: the table references `user` more than once.
    foreignKey({
      name: 'api_token_revoked_by_fk',
      columns: [t.revokedBy],
      foreignColumns: [user.id],
    }),
    // Neither key has a nullable column, so the NULLS NOT DISTINCT rule of CLAUDE.md
    // (Data rules) does not apply.
    unique('api_token_token_hash_unique').on(t.tokenHash),
    unique('api_token_prefix_unique').on(t.prefix),
    // An owner's tokens, and an organisation's (the organisation is the first column).
    index('api_token_organisation_user_idx').on(t.organisationId, t.userId),
    // The tokens of one person in any organisation, which an admin reset link ends.
    index('api_token_user_idx').on(t.userId),
    check(
      'api_token_access_check',
      sql`${t.access} in (${sqlList(API_TOKEN_ACCESS)})`,
    ),
    check(
      'api_token_name_check',
      sql`char_length(${t.name}) between 1 and 100`,
    ),
    check(
      'api_token_expiry_check',
      sql`${t.expiresAt} is null or ${t.expiresAt} > ${t.createdAt}`,
    ),
    // Revoked or not, in one piece: the reason is there exactly when the time is.
    check(
      'api_token_revoked_pair_check',
      sql`(${t.revokedAt} is null) = (${t.revokeReason} is null)`,
    ),
    check(
      'api_token_revoke_reason_check',
      sql`${t.revokeReason} is null or ${t.revokeReason} in (${sqlList(API_TOKEN_REVOKE_REASONS)})`,
    ),
    // Only a revoked token has a revoker, and a manual revocation always names one.
    // The reasons the server acts on its own may leave it empty.
    check(
      'api_token_revoker_check',
      sql`${t.revokedBy} is null or ${t.revokedAt} is not null`,
    ),
    check(
      'api_token_manual_revoker_check',
      sql`${t.revokeReason} is distinct from 'manual' or ${t.revokedBy} is not null`,
    ),
    // A CHECK cannot hold a subquery, so the test for a repeated key is a function
    // the migration writes by hand, before this table (drizzle does not track it).
    check(
      'api_token_sensitive_permissions_distinct_check',
      sql`osfpm_text_array_is_distinct(${t.sensitivePermissions})`,
    ),
  ],
  {
    organisationScoped: {
      organisationId: () => organisation.id,
      reason:
        'A personal API token belongs to one organisation, and its composite keys to org_membership and project on organisation_id make its owner a member of that organisation and its project one of that organisation’s projects, so a token can never reach another organisation’s data.',
    },
  },
);
