import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  numeric,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { addressColumns, countryCheck } from '../address-columns.js';
import {
  sqlList,
  standardColumns,
  tenantTable,
  timestamptz,
} from '../columns.js';
import { declareOrganisationLevel } from '../project-resolver.js';
import { company } from './company.js';
import { organisation } from './organisation.js';
import { person } from './person.js';
import { user } from './user.js';

/**
 * Allowed values of `location.kind`. The CHECK is built from this list, so a
 * new value needs a new migration.
 */
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
/** One value of `LOCATION_KINDS`. */
export type LocationKind = (typeof LOCATION_KINDS)[number];

/**
 * Allowed values of `location.status`. The CHECK is built from this list, so a
 * new value needs a new migration.
 */
export const LOCATION_STATUSES = ['active', 'archived'] as const;
/** One value of `LOCATION_STATUSES`. */
export type LocationStatus = (typeof LOCATION_STATUSES)[number];

/**
 * The answers to a question about a location's access (decision D-69, P-02l2). `unknown`
 * is the answer of a location nobody has described, and is not `no`. The CHECKs of the five
 * answers are built from this list, so a new value needs a new migration.
 */
export const LOCATION_ACCESS_ANSWERS = ['yes', 'no', 'unknown'] as const;
/** One value of `LOCATION_ACCESS_ANSWERS`. */
export type LocationAccessAnswer = (typeof LOCATION_ACCESS_ANSWERS)[number];

/**
 * Allowed values of `location.accessible_parking_surface`. The CHECK is built from this
 * list, so a new value needs a new migration.
 */
export const PARKING_SURFACES = ['paved', 'gravel', 'grass', 'other'] as const;
/** One value of `PARKING_SURFACES`. */
export type ParkingSurface = (typeof PARKING_SURFACES)[number];

/** The most metres from the set to an accessible toilet. The CHECK says 5000 too; a test pins both. */
export const ACCESSIBLE_TOILET_DISTANCE_MAX_M = 5000;
/** The least height clearance of an accessible parking space, in centimetres. The CHECK says 100 too; a test pins both. */
export const PARKING_CLEARANCE_MIN_CM = 100;
/** The most height clearance of an accessible parking space, in centimetres. The CHECK says 500 too; a test pins both. */
export const PARKING_CLEARANCE_MAX_CM = 500;

/**
 * A place in the organisation's library: a set, studio, car park, hospital.
 *
 * Its access is structured so that a later call-sheet or schedule check can match it with
 * people's granted adjustments (decision D-69, P-02l2): five answers (a step-free route, an
 * accessible toilet, accessible parking, a quiet room, seating) that are `yes`, `no` or
 * `unknown`, and the details that only make sense under a `yes`: the distance to the toilet,
 * and the surface and height clearance of the parking. `access_notes` stays as free text
 * beside them. Whether anyone has checked the answers is its own fact: `access_verified_at`
 * and `access_verified_by`, set together by the verify call. Any change to an answer or a
 * detail clears the verification in the same write, because it covered the answers as they
 * were, and an answer that is not verified is never presented as known (`locationAccessSummary`
 * in `library/`). Written through the write helper by someone who holds `locations:edit`.
 */
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
    stepFreeRoute: text('step_free_route')
      .$type<LocationAccessAnswer>()
      .notNull()
      .default('unknown'),
    accessibleToilet: text('accessible_toilet')
      .$type<LocationAccessAnswer>()
      .notNull()
      .default('unknown'),
    accessibleToiletDistanceM: integer('accessible_toilet_distance_m'),
    accessibleParking: text('accessible_parking')
      .$type<LocationAccessAnswer>()
      .notNull()
      .default('unknown'),
    accessibleParkingSurface: text(
      'accessible_parking_surface',
    ).$type<ParkingSurface>(),
    parkingHeightClearanceCm: integer('parking_height_clearance_cm'),
    quietRoom: text('quiet_room')
      .$type<LocationAccessAnswer>()
      .notNull()
      .default('unknown'),
    seating: text('seating')
      .$type<LocationAccessAnswer>()
      .notNull()
      .default('unknown'),
    accessVerifiedAt: timestamptz('access_verified_at'),
    accessVerifiedBy: uuid('access_verified_by'),
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
    // Who verified the access answers is a user, who is install-level, so the key is plain.
    // Named by its column because the table points at `user` more than once (CLAUDE.md,
    // Data rules).
    foreignKey({
      name: 'location_access_verified_by_fk',
      columns: [t.accessVerifiedBy],
      foreignColumns: [user.id],
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
    // The five answers are yes, no or unknown, and never empty (the columns are NOT NULL).
    check(
      'location_step_free_route_check',
      sql`${t.stepFreeRoute} in (${sqlList(LOCATION_ACCESS_ANSWERS)})`,
    ),
    check(
      'location_accessible_toilet_check',
      sql`${t.accessibleToilet} in (${sqlList(LOCATION_ACCESS_ANSWERS)})`,
    ),
    check(
      'location_accessible_parking_check',
      sql`${t.accessibleParking} in (${sqlList(LOCATION_ACCESS_ANSWERS)})`,
    ),
    check(
      'location_quiet_room_check',
      sql`${t.quietRoom} in (${sqlList(LOCATION_ACCESS_ANSWERS)})`,
    ),
    check(
      'location_seating_check',
      sql`${t.seating} in (${sqlList(LOCATION_ACCESS_ANSWERS)})`,
    ),
    // A detail only describes a yes, so it exists only under one, and has a range. The
    // numbers are the constants above; the CHECK cannot read them, so a test pins both.
    check(
      'location_toilet_distance_check',
      sql`${t.accessibleToiletDistanceM} is null or (${t.accessibleToilet} = 'yes' and ${t.accessibleToiletDistanceM} between 0 and 5000)`,
    ),
    check(
      'location_parking_surface_check',
      sql`${t.accessibleParkingSurface} is null or (${t.accessibleParking} = 'yes' and ${t.accessibleParkingSurface} in (${sqlList(PARKING_SURFACES)}))`,
    ),
    check(
      'location_parking_clearance_check',
      sql`${t.parkingHeightClearanceCm} is null or (${t.accessibleParking} = 'yes' and ${t.parkingHeightClearanceCm} between 100 and 500)`,
    ),
    // Who verified the answers and when are one fact: both set, or neither.
    check(
      'location_access_verified_check',
      sql`(${t.accessVerifiedAt} is null) = (${t.accessVerifiedBy} is null)`,
    ),
  ],
);

/** Belongs to the organisation, never to a project: no project_id, no resolver. */
declareOrganisationLevel(location);
