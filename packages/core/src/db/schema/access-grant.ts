import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  baseColumns,
  securityTable,
  sqlList,
  timestamptz,
} from '../columns.js';
import { markSensitive } from '../sensitive.js';
import { organisation } from './organisation.js';
import { person } from './person.js';
import { project } from './project.js';
import { role } from './role.js';
import { user } from './user.js';

/**
 * The categories of `person_sensitive` data a person can grant access to, per field
 * and per role (decision D-69): the adjustments they ask for and their medical data.
 * The CHECK is built from this list, so a new value needs a new migration.
 */
export const ACCESS_GRANT_CATEGORIES = ['accessibility', 'medical'] as const;
/** One value of `ACCESS_GRANT_CATEGORIES`. */
export type AccessGrantCategory = (typeof ACCESS_GRANT_CATEGORIES)[number];

/**
 * Allowed values of `access_grant.consent_method`: how a person without an account
 * told staff they agree to share. The CHECK is built from this list, so a new value
 * needs a new migration.
 */
export const ACCESS_CONSENT_METHODS = [
  'in-person',
  'phone',
  'email',
  'written',
  'other',
] as const;
/** One value of `ACCESS_CONSENT_METHODS`. */
export type AccessConsentMethod = (typeof ACCESS_CONSENT_METHODS)[number];

/** The most characters a consent note may have. The CHECK below says 200 too; a test pins both. */
export const ACCESS_CONSENT_NOTE_MAX_LENGTH = 200;

/** The name of the partial unique index that allows one live grant per role: the service tells its violation from others. */
export const ACCESS_GRANT_LIVE_INDEX = 'access_grant_live_unique';

/**
 * A person's grant of access to some of their access needs or medical data, to one
 * role of one production (decision D-69): default deny, per field, per role, ending
 * when the production wraps while the person keeps their data. `fields` are the keys
 * of the payload the role may see (`ACCESS_FIELDS` or the medical keys; the service
 * checks them, the database only that the list is not empty and holds no key twice).
 * Whether a grant is live is worked out when it is read, not stored: it is not
 * revoked, the project is not wrapped or closed, and the person still has a
 * `project_person` row on the project that is proposed or confirmed. Nothing needs a
 * job to end a grant.
 *
 * Who makes one: the person themselves, when they have an account (`on_behalf` false);
 * or, for a person without one, a user holding `sensitive:edit:<category>` on the
 * project, recording how and when the person agreed (`on_behalf` true, `consent_method`
 * and `consent_at` both set, and an optional `consent_note` of at most 200 characters
 * that holds no health details). The CHECK ties `on_behalf` to the two consent columns
 * and lets only an on-behalf grant carry a note. The note is never returned to a
 * reader, only to the person, whoever recorded it and the editors, and it is never
 * put into an audit event, a change event, a log or an error (CLAUDE.md, Privacy rule).
 * `granted_by` is the user who made it, also when a token did so for its owner.
 * A grant is revoked, never deleted: `revoked_at` and `revoked_by` are set together.
 * Changing the fields of a role's grant revokes it and makes a new one, so at most one
 * live grant exists per role (`access_grant_live_unique`).
 *
 * A security table, and the fourth that carries `organisation_id` by declaration
 * (`organisationScoped`, as `invite`, `access_reset` and `api_token` do): a grant
 * reveals that someone has shared access needs, which is itself sensitive, so the
 * composite keys to the project, the person and the role keep a grant, the person it is
 * for and the role it opens inside one organisation. It is audited and not
 * change-logged, and the write helper refuses it. Unlike the others, the sensitive
 * service writes it and not the auth service (`writtenBy`, recorded in
 * `tableWriters`), and it is the only code that imports it. Retention class
 * `crew-health`, the same as the data it opens.
 */
export const accessGrant = securityTable(
  'access_grant',
  {
    ...baseColumns(() => user.id, { defaultRetentionClass: 'crew-health' }),
    organisationId: uuid('organisation_id').notNull(),
    projectId: uuid('project_id').notNull(),
    personId: uuid('person_id').notNull(),
    category: text('category').$type<AccessGrantCategory>().notNull(),
    roleId: uuid('role_id').notNull(),
    fields: text('fields').array().notNull(),
    grantedBy: uuid('granted_by').notNull(),
    grantedAt: timestamptz('granted_at').notNull(),
    onBehalf: boolean('on_behalf').notNull(),
    consentMethod: text('consent_method').$type<AccessConsentMethod>(),
    consentAt: timestamptz('consent_at'),
    consentNote: text('consent_note'),
    revokedAt: timestamptz('revoked_at'),
    revokedBy: uuid('revoked_by'),
  },
  (t) => [
    // Composite on organisation_id, so a grant can never tie a project, a person or a
    // role of another organisation to this one's.
    foreignKey({
      name: 'access_grant_project_fk',
      columns: [t.organisationId, t.projectId],
      foreignColumns: [project.organisationId, project.id],
    }),
    foreignKey({
      name: 'access_grant_person_fk',
      columns: [t.organisationId, t.personId],
      foreignColumns: [person.organisationId, person.id],
    }),
    foreignKey({
      name: 'access_grant_role_fk',
      columns: [t.organisationId, t.roleId],
      foreignColumns: [role.organisationId, role.id],
    }),
    // Named <table>_<column without _id>_fk: the table references `user` more than once.
    foreignKey({
      name: 'access_grant_granted_by_fk',
      columns: [t.grantedBy],
      foreignColumns: [user.id],
    }),
    foreignKey({
      name: 'access_grant_revoked_by_fk',
      columns: [t.revokedBy],
      foreignColumns: [user.id],
    }),
    // One live grant per role, person and category on a project. This index is what
    // guarantees it, whatever the service does: the service revokes the earlier grant of
    // a role before it makes the next, and locks that grant `FOR UPDATE` so that two
    // changes of one role queue, but the lock only orders the work and the index is the
    // rule. All four key columns are NOT NULL, so the NULLS NOT DISTINCT rule of CLAUDE.md
    // (Data rules) does not apply. It also finds a project's live grants without reading
    // the whole table.
    uniqueIndex(ACCESS_GRANT_LIVE_INDEX)
      .on(t.projectId, t.personId, t.category, t.roleId)
      .where(sql`${t.revokedAt} is null`),
    // A person's grants, which a read looks up before it looks at the project.
    index('access_grant_person_idx').on(t.organisationId, t.personId),
    check(
      'access_grant_category_check',
      sql`${t.category} in (${sqlList(ACCESS_GRANT_CATEGORIES)})`,
    ),
    check(
      'access_grant_consent_method_check',
      sql`${t.consentMethod} is null or ${t.consentMethod} in (${sqlList(ACCESS_CONSENT_METHODS)})`,
    ),
    // A CHECK cannot hold a subquery, so the test for a repeated key is the function
    // migration 0034 writes by hand, which this reuses.
    check(
      'access_grant_fields_check',
      sql`cardinality(${t.fields}) > 0 and osfpm_text_array_is_distinct(${t.fields})`,
    ),
    // On behalf of someone with no account: how and when they agreed, both set. Their
    // own grant: neither.
    check(
      'access_grant_consent_check',
      sql`(${t.onBehalf} and ${t.consentMethod} is not null and ${t.consentAt} is not null) or (not ${t.onBehalf} and ${t.consentMethod} is null and ${t.consentAt} is null)`,
    ),
    check(
      'access_grant_consent_note_check',
      sql`${t.consentNote} is null or (${t.onBehalf} and char_length(${t.consentNote}) between 1 and 200)`,
    ),
    check(
      'access_grant_revoked_pair_check',
      sql`(${t.revokedAt} is null) = (${t.revokedBy} is null)`,
    ),
  ],
  {
    organisationScoped: {
      organisationId: () => organisation.id,
      reason:
        'A grant belongs to one organisation, and its composite keys to project, person and role on organisation_id keep a grant, the person it is for and the role it opens to inside one organisation, so a grant can never open one organisation’s data to another’s role.',
    },
    writtenBy: {
      service: 'sensitive',
      reason:
        'A grant records that a person shared access needs, which is itself sensitive, so the sensitive service that guards the data is the only one that writes it (decision D-69).',
    },
  },
);

// The field names of a grant hint at a condition, and the note is the person's own words
// about how they agreed, so neither may reach a log, an event or an error. The table is
// audited and not change-logged, so no change event could hold them; the tag says so for
// anything that reads this table's columns later (CLAUDE.md, Data rules).
markSensitive(accessGrant, ['fields', 'consentNote']);
