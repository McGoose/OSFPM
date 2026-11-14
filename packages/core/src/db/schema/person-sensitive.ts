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
import { organisation } from './organisation.js';
import { person } from './person.js';
import { user } from './user.js';

/** Keys of the eight sensitive data categories. */
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
export type PersonSensitiveCategory =
  (typeof PERSON_SENSITIVE_CATEGORIES)[number];

export const PERSON_SENSITIVE_LEGAL_BASES = [
  'consent',
  'contract',
  'legal-obligation',
  'vital-interest',
] as const;
export type PersonSensitiveLegalBasis =
  (typeof PERSON_SENSITIVE_LEGAL_BASES)[number];

export const PERSON_SENSITIVE_ENTERED_BY_KINDS = ['self', 'staff'] as const;
export type PersonSensitiveEnteredByKind =
  (typeof PERSON_SENSITIVE_ENTERED_BY_KINDS)[number];

/**
 * Sensitive personal data of one person, one row per category. The `payload`
 * is plain JSON for now; `key_id` is reserved for later end-to-end encryption.
 * Only the sensitive data service reads or writes this table.
 */
export const personSensitive = tenantTable(
  'person_sensitive',
  () => organisation.id,
  {
    ...standardColumns(() => user.id, { defaultVisibility: 'private' }),
    personId: uuid('person_id').notNull(),
    category: text('category').$type<PersonSensitiveCategory>().notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
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
