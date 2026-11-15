import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  numeric,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { addressColumns, countryCheck } from '../address-columns.js';
import { sqlList, standardColumns, tenantTable } from '../columns.js';
import { declareOrganisationLevel } from '../project-resolver.js';
import { company } from './company.js';
import { organisation } from './organisation.js';
import { person } from './person.js';
import { user } from './user.js';

export const LOCATION_KINDS = [
  'location',
  'studio',
  'stage',
  'unit-base',
  'parking',
  'hospital',
  'office',
  'other',
] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];

export const LOCATION_STATUSES = ['active', 'archived'] as const;
export type LocationStatus = (typeof LOCATION_STATUSES)[number];

/** A place in the organisation's library: a set, studio, car park, hospital. */
export const location = tenantTable(
  'location',
  () => organisation.id,
  {
    ...standardColumns(() => user.id, { defaultVisibility: 'private' }),
    name: text('name').notNull(),
    kind: text('kind').$type<LocationKind>().notNull(),
    ...addressColumns(),
    latitude: numeric('latitude', { precision: 9, scale: 6 }),
    longitude: numeric('longitude', { precision: 9, scale: 6 }),
    timezone: text('timezone'),
    ownerCompanyId: uuid('owner_company_id'),
    contactPersonId: uuid('contact_person_id'),
    accessNotes: text('access_notes'),
    parkingNotes: text('parking_notes'),
    nearestHospitalId: uuid('nearest_hospital_id'),
    status: text('status').$type<LocationStatus>().notNull().default('active'),
  },
  (t) => [
    foreignKey({
      name: 'location_company_fk',
      columns: [t.organisationId, t.ownerCompanyId],
      foreignColumns: [company.organisationId, company.id],
    }),
    foreignKey({
      name: 'location_person_fk',
      columns: [t.organisationId, t.contactPersonId],
      foreignColumns: [person.organisationId, person.id],
    }),
    // The nearest hospital is another location of the same organisation.
    foreignKey({
      name: 'location_nearest_hospital_fk',
      columns: [t.organisationId, t.nearestHospitalId],
      foreignColumns: [t.organisationId, t.id],
    }),
    // Target for composite tenant foreign keys, including the one above.
    unique('location_organisation_id_id_unique').on(t.organisationId, t.id),
    check(
      'location_kind_check',
      sql`${t.kind} in (${sqlList(LOCATION_KINDS)})`,
    ),
    check(
      'location_status_check',
      sql`${t.status} in (${sqlList(LOCATION_STATUSES)})`,
    ),
    countryCheck('location_address_country_check', t.addressCountry),
    check('location_latitude_check', sql`${t.latitude} between -90 and 90`),
    check('location_longitude_check', sql`${t.longitude} between -180 and 180`),
    check(
      'location_coordinates_pair_check',
      sql`(${t.latitude} is null) = (${t.longitude} is null)`,
    ),
    check(
      'location_nearest_hospital_self_check',
      sql`${t.nearestHospitalId} <> ${t.id}`,
    ),
  ],
);

/** Belongs to the organisation, never to a project: no project_id, no resolver. */
declareOrganisationLevel(location);
