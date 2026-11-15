import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  jsonb,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  sqlList,
  standardColumns,
  tenantTable,
  timestamptz,
} from '../columns.js';
import { markSensitive } from '../sensitive.js';
import { declareOrganisationLevel } from '../project-resolver.js';
import { organisation } from './organisation.js';
import { person } from './person.js';
import { user } from './user.js';

/**
 * Keys of the eight sensitive data categories. Must equal
 * `SENSITIVE_CATEGORIES` in `sensitive/schemas.ts`; a test checks it.
 */
export const PERSON_SENSITIVE_CATEGORIES = [
  'dietary',
  'medical',
  'accessibility',
  'emergency',
  'identity',
  'financial',
  'representation',
  'compliance',
] as const;
/** One value of `PERSON_SENSITIVE_CATEGORIES`. */
export type PersonSensitiveCategory =
  (typeof PERSON_SENSITIVE_CATEGORIES)[number];

/**
 * Allowed values of `person_sensitive.legal_basis`. The CHECK is built from
 * this list, so a new value needs a new migration.
 */
export const PERSON_SENSITIVE_LEGAL_BASES = [
  'consent',
  'contract',
  'legal-obligation',
  'vital-interest',
] as const;
/** One value of `PERSON_SENSITIVE_LEGAL_BASES`. */
export type PersonSensitiveLegalBasis =
  (typeof PERSON_SENSITIVE_LEGAL_BASES)[number];

/**
 * Allowed values of `person_sensitive.entered_by_kind`. The CHECK is built from
 * this list, so a new value needs a new migration.
 *
 * `self` is the person; `staff` is another user.
 */
export const PERSON_SENSITIVE_ENTERED_BY_KINDS = ['self', 'staff'] as const;
/** One value of `PERSON_SENSITIVE_ENTERED_BY_KINDS`. */
export type PersonSensitiveEnteredByKind =
  (typeof PERSON_SENSITIVE_ENTERED_BY_KINDS)[number];

/**
 * Sensitive personal data of one person, one row per category. The `payload`
 * is plain JSON for now; `key_id` is reserved for later end-to-end encryption.
 * Deleting a row erases its payload in the same write; category, who and when
 * stay for the audit trail until a retention job purges the row.
 *
 * Only `sensitive/service.ts` reads or writes this table (CLAUDE.md, Data
 * rules); a test scans the source for other uses. `payload` is marked
 * sensitive, so change events never hold its value (CLAUDE.md, Privacy rule).
 */
export const personSensitive = tenantTable(
  'person_sensitive',
  () => organisation.id,
  {
    ...standardColumns(() => user.id, { defaultVisibility: 'private' }),
    personId: uuid('person_id').notNull(),
    category: text('category').$type<PersonSensitiveCategory>().notNull(),
    /** NULL only on a deleted row: deleting erases the values (see the CHECK). */
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    keyId: text('key_id'),
    legalBasis: text('legal_basis')
      .$type<PersonSensitiveLegalBasis>()
      .notNull(),
    consentRecordedAt: timestamptz('consent_recorded_at'),
    consentTextVersion: text('consent_text_version'),
    enteredByKind: text('entered_by_kind')
      .$type<PersonSensitiveEnteredByKind>()
      .notNull(),
    enteredBy: uuid('entered_by').notNull(),
    lastConfirmedAt: timestamptz('last_confirmed_at'),
  },
  (t) => [
    foreignKey({
      name: 'person_sensitive_person_fk',
      columns: [t.organisationId, t.personId],
      foreignColumns: [person.organisationId, person.id],
    }),
    foreignKey({
      name: 'person_sensitive_entered_by_fk',
      columns: [t.enteredBy],
      foreignColumns: [user.id],
    }),
    unique('person_sensitive_person_category_unique').on(
      t.personId,
      t.category,
    ),
    check(
      'person_sensitive_payload_check',
      sql`${t.payload} is not null or ${t.deletedAt} is not null`,
    ),
    check(
      'person_sensitive_category_check',
      sql`${t.category} in (${sqlList(PERSON_SENSITIVE_CATEGORIES)})`,
    ),
    check(
      'person_sensitive_legal_basis_check',
      sql`${t.legalBasis} in (${sqlList(PERSON_SENSITIVE_LEGAL_BASES)})`,
    ),
    check(
      'person_sensitive_entered_by_kind_check',
      sql`${t.enteredByKind} in (${sqlList(PERSON_SENSITIVE_ENTERED_BY_KINDS)})`,
    ),
  ],
);

markSensitive(personSensitive, ['payload']);

/** Belongs to the organisation, never to a project: no project_id, no resolver. */
declareOrganisationLevel(personSensitive);
