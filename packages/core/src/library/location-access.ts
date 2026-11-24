import { z } from 'zod';
import {
  ACCESSIBLE_TOILET_DISTANCE_MAX_M,
  LOCATION_ACCESS_ANSWERS,
  PARKING_CLEARANCE_MAX_CM,
  PARKING_CLEARANCE_MIN_CM,
  PARKING_SURFACES,
  type LocationAccessAnswer,
  type location,
  type ParkingSurface,
} from '../db/schema/location.js';

/**
 * The access of a location in a form a later check can use (decision D-69, P-02l2): call
 * sheets and schedule checks match it with the adjustments people have granted (a step-free
 * route against `stepFreeRequired`, the distance to a toilet against `maxWalkMetres`). The
 * answers are yes, no or unknown, and someone checking them is a separate act with a date
 * (`verifyLocationAccess`). So the summary says, for each field, what is stored, what to
 * rely on, and whether it was verified, and what to rely on is the stored answer only once
 * it is verified: an unverified "yes" is never presented as "yes".
 */

/** The columns of a location row that hold its access: the five answers, the three details and the verification. */
export type LocationAccessColumns = Pick<
  typeof location.$inferSelect,
  | 'stepFreeRoute'
  | 'accessibleToilet'
  | 'accessibleToiletDistanceM'
  | 'accessibleParking'
  | 'accessibleParkingSurface'
  | 'parkingHeightClearanceCm'
  | 'quietRoom'
  | 'seating'
  | 'accessVerifiedAt'
  | 'accessVerifiedBy'
>;

/** One field of the summary: what is stored, what to rely on, and whether the location was verified. */
export type AccessFieldSummary<T> = {
  /** What a person entered, whether or not anyone has checked it. */
  readonly stored: T;
  /** What to rely on: `stored` once the location is verified, `unknown` (or nothing, for a detail) before. */
  readonly effective: T;
  /** Whether the answers were verified and not changed since. The same for every field of a location. */
  readonly verified: boolean;
};

/** The access of a location as a reader sees it. See `locationAccessSummary`. */
export type LocationAccessSummary = {
  /** When the answers were verified, or `null` when they were not, or were changed since. */
  readonly verifiedAt: Date | null;
  /** The user who verified them, or `null`. */
  readonly verifiedBy: string | null;
  readonly fields: {
    readonly stepFreeRoute: AccessFieldSummary<LocationAccessAnswer>;
    readonly accessibleToilet: AccessFieldSummary<LocationAccessAnswer>;
    /** Metres to the toilet; only under a toilet answered yes. `null` when unverified or not given. */
    readonly accessibleToiletDistanceM: AccessFieldSummary<number | null>;
    readonly accessibleParking: AccessFieldSummary<LocationAccessAnswer>;
    /** Only under parking answered yes. `null` when unverified or not given. */
    readonly accessibleParkingSurface: AccessFieldSummary<ParkingSurface | null>;
    /** Centimetres; only under parking answered yes. `null` when unverified or not given. */
    readonly parkingHeightClearanceCm: AccessFieldSummary<number | null>;
    readonly quietRoom: AccessFieldSummary<LocationAccessAnswer>;
    readonly seating: AccessFieldSummary<LocationAccessAnswer>;
  };
};

/**
 * The access of a location, for each field `{ stored, effective, verified }`. `effective` is
 * `stored` when the location is verified, and `unknown` otherwise, so an unverified "yes" (or
 * "no") is never presented as known; for a detail, which is a number or a surface, it is
 * `null` until verified. The location is verified when `accessVerifiedAt` is set: the
 * verification covers the answers as they were, and any change to them clears it
 * (`updateLocationAccess`), so a set date always vouches for what is stored. Pure: it reads
 * only the ten access columns of the row it is given, so it shows nothing else of the
 * location, checks no permission and changes nothing. `getLocation` adds it to its answer.
 */
export function locationAccessSummary(
  location: LocationAccessColumns,
): LocationAccessSummary {
  const verified = location.accessVerifiedAt !== null;
  const answer = (
    stored: LocationAccessAnswer,
  ): AccessFieldSummary<LocationAccessAnswer> => ({
    stored,
    effective: verified ? stored : 'unknown',
    verified,
  });
  const detail = <T>(stored: T | null): AccessFieldSummary<T | null> => ({
    stored,
    effective: verified ? stored : null,
    verified,
  });
  return {
    verifiedAt:
      location.accessVerifiedAt === null
        ? null
        : new Date(location.accessVerifiedAt),
    verifiedBy: location.accessVerifiedBy,
    fields: {
      stepFreeRoute: answer(location.stepFreeRoute),
      accessibleToilet: answer(location.accessibleToilet),
      accessibleToiletDistanceM: detail(location.accessibleToiletDistanceM),
      accessibleParking: answer(location.accessibleParking),
      accessibleParkingSurface: detail(location.accessibleParkingSurface),
      parkingHeightClearanceCm: detail(location.parkingHeightClearanceCm),
      quietRoom: answer(location.quietRoom),
      seating: answer(location.seating),
    },
  };
}

/**
 * What a call to `updateLocationAccess` may name: the five answers, and the three details,
 * where `null` clears a detail. Every field is optional and a field left out is left as it
 * is. The schema is strict: a field it does not know is refused, and so is the verification
 * itself, which only `verifyLocationAccess` sets. Whether a detail fits the answer it
 * describes is the service's rule, because it depends on what is stored.
 */
export const locationAccessChangesSchema = z.strictObject({
  stepFreeRoute: z.enum(LOCATION_ACCESS_ANSWERS).optional(),
  accessibleToilet: z.enum(LOCATION_ACCESS_ANSWERS).optional(),
  accessibleToiletDistanceM: z
    .number()
    .int()
    .min(0)
    .max(ACCESSIBLE_TOILET_DISTANCE_MAX_M)
    .nullable()
    .optional(),
  accessibleParking: z.enum(LOCATION_ACCESS_ANSWERS).optional(),
  accessibleParkingSurface: z.enum(PARKING_SURFACES).nullable().optional(),
  parkingHeightClearanceCm: z
    .number()
    .int()
    .min(PARKING_CLEARANCE_MIN_CM)
    .max(PARKING_CLEARANCE_MAX_CM)
    .nullable()
    .optional(),
  quietRoom: z.enum(LOCATION_ACCESS_ANSWERS).optional(),
  seating: z.enum(LOCATION_ACCESS_ANSWERS).optional(),
});
/** What a call to `updateLocationAccess` may name: `locationAccessChangesSchema` as a type. */
export type LocationAccessChanges = z.infer<typeof locationAccessChangesSchema>;
