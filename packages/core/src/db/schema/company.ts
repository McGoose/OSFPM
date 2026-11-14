import { sql } from 'drizzle-orm';
import { boolean, check, text, unique } from 'drizzle-orm/pg-core';
import {
  addressColumns,
  countryCheck,
  lowerCaseCheck,
} from '../address-columns.js';
import { sqlList, standardColumns, tenantTable } from '../columns.js';
import { organisation } from './organisation.js';
import { user } from './user.js';

export const COMPANY_KINDS = [
  'vendor',
  'co-producer',
  'agency',
  'funder',
  'broadcaster',
  'distributor',
  'rental-house',
  'other',
] as const;
export type CompanyKind = (typeof COMPANY_KINDS)[number];

/** A company in the organisation's library: a vendor, funder, agency and so on. */
export const company = tenantTable(
  'company',
  () => organisation.id,
  {
    ...standardColumns(() => user.id, { defaultVisibility: 'private' }),
    name: text('name').notNull(),
    legalName: text('legal_name'),
    kind: text('kind').$type<CompanyKind>().notNull(),
    country: text('country'),
    vatNumber: text('vat_number'),
    registrationNumber: text('registration_number'),
    ...addressColumns(),
    email: text('email'),
    phone: text('phone'),
    website: text('website'),
    isRelatedParty: boolean('is_related_party').notNull().default(false),
    relatedPartyNote: text('related_party_note'),
  },
  (t) => [
    // Target for composite tenant foreign keys in later tables.
    unique('company_organisation_id_id_unique').on(t.organisationId, t.id),
    check('company_kind_check', sql`${t.kind} in (${sqlList(COMPANY_KINDS)})`),
    countryCheck('company_country_check', t.country),
    countryCheck('company_address_country_check', t.addressCountry),
    lowerCaseCheck('company_email_lowercase_check', t.email),
  ],
);
