import { describe, expect, it } from 'vitest';
import {
  locationAccessChangesSchema,
  locationAccessSummary,
  type LocationAccessColumns,
} from './location-access.js';

/**
 * What a location's access summary says (decision D-69, P-02l2). The stored answers are
 * yes, no or unknown, and checking them is a separate act with a date: an answer nobody has
 * verified is never presented as known, so an unverified "yes" reads "unknown". A later
 * call-sheet or schedule check matches the effective answers against people's adjustments.
 */

const VERIFIED_AT = new Date('2026-11-10T09:00:00.000Z');
const VERIFIER = '0199a3c4-0000-7000-8000-0000000000cc';

/** The access columns of a location nobody has described. */
const NOTHING_KNOWN: LocationAccessColumns = {
  stepFreeRoute: 'unknown',
  accessibleToilet: 'unknown',
  accessibleToiletDistanceM: null,
  accessibleParking: 'unknown',
  accessibleParkingSurface: null,
  parkingHeightClearanceCm: null,
  quietRoom: 'unknown',
  seating: 'unknown',
  accessVerifiedAt: null,
  accessVerifiedBy: null,
};

/** The five answers that are yes, no or unknown. */
const ANSWERS = [
  'stepFreeRoute',
  'accessibleToilet',
  'accessibleParking',
  'quietRoom',
  'seating',
] as const;

/** A fully described location: every answer yes, with its details. */
const DESCRIBED: LocationAccessColumns = {
  stepFreeRoute: 'yes',
  accessibleToilet: 'yes',
  accessibleToiletDistanceM: 40,
  accessibleParking: 'yes',
  accessibleParkingSurface: 'paved',
  parkingHeightClearanceCm: 210,
  quietRoom: 'yes',
  seating: 'yes',
  accessVerifiedAt: null,
  accessVerifiedBy: null,
};

const verified = (columns: LocationAccessColumns): LocationAccessColumns => ({
  ...columns,
  accessVerifiedAt: VERIFIED_AT,
  accessVerifiedBy: VERIFIER,
});

describe('locationAccessSummary', () => {
  it('says unknown and unverified for a location nobody has described', () => {
    const summary = locationAccessSummary(NOTHING_KNOWN);
    expect(summary.verifiedAt).toBeNull();
    expect(summary.verifiedBy).toBeNull();
    for (const name of ANSWERS) {
      expect(summary.fields[name], name).toEqual({
        stored: 'unknown',
        effective: 'unknown',
        verified: false,
      });
    }
    expect(summary.fields.accessibleToiletDistanceM).toEqual({
      stored: null,
      effective: null,
      verified: false,
    });
  });

  it('never presents an unverified answer as known: a stored yes or no reads unknown', () => {
    for (const name of ANSWERS) {
      for (const stored of ['yes', 'no', 'unknown'] as const) {
        const summary = locationAccessSummary({
          ...NOTHING_KNOWN,
          [name]: stored,
        });
        expect(summary.fields[name], `${name} ${stored}`).toEqual({
          stored,
          effective: 'unknown',
          verified: false,
        });
      }
    }
  });

  it('presents every answer as stored once the location is verified', () => {
    for (const name of ANSWERS) {
      for (const stored of ['yes', 'no', 'unknown'] as const) {
        const summary = locationAccessSummary(
          verified({ ...NOTHING_KNOWN, [name]: stored }),
        );
        expect(summary.fields[name], `${name} ${stored}`).toEqual({
          stored,
          effective: stored,
          verified: true,
        });
      }
    }
  });

  it('holds the details of an answer back until it is verified, as null and not as a number', () => {
    const unverified = locationAccessSummary(DESCRIBED);
    expect(unverified.fields.accessibleToiletDistanceM).toEqual({
      stored: 40,
      effective: null,
      verified: false,
    });
    expect(unverified.fields.accessibleParkingSurface).toEqual({
      stored: 'paved',
      effective: null,
      verified: false,
    });
    expect(unverified.fields.parkingHeightClearanceCm).toEqual({
      stored: 210,
      effective: null,
      verified: false,
    });
    const checked = locationAccessSummary(verified(DESCRIBED));
    expect(checked.fields.accessibleToiletDistanceM).toEqual({
      stored: 40,
      effective: 40,
      verified: true,
    });
    expect(checked.fields.accessibleParkingSurface).toEqual({
      stored: 'paved',
      effective: 'paved',
      verified: true,
    });
    expect(checked.fields.parkingHeightClearanceCm).toEqual({
      stored: 210,
      effective: 210,
      verified: true,
    });
  });

  it('says when and by whom it was verified, and nothing of it when it was not', () => {
    const summary = locationAccessSummary(verified(DESCRIBED));
    expect(summary.verifiedAt).toEqual(VERIFIED_AT);
    expect(summary.verifiedBy).toBe(VERIFIER);
    expect(locationAccessSummary(DESCRIBED).verifiedAt).toBeNull();
  });

  it('names the eight fields and nothing else, whatever else the location row holds', () => {
    const row = {
      ...verified(DESCRIBED),
      name: 'Harbour Warehouse',
      addressLine1: '1 Demo Street',
      accessNotes: 'Use the side door',
    };
    const summary = locationAccessSummary(row);
    expect(Object.keys(summary).sort()).toEqual([
      'fields',
      'verifiedAt',
      'verifiedBy',
    ]);
    expect(Object.keys(summary.fields).sort()).toEqual([
      'accessibleParking',
      'accessibleParkingSurface',
      'accessibleToilet',
      'accessibleToiletDistanceM',
      'parkingHeightClearanceCm',
      'quietRoom',
      'seating',
      'stepFreeRoute',
    ]);
    expect(JSON.stringify(summary)).not.toContain('Harbour');
    expect(JSON.stringify(summary)).not.toContain('side door');
  });

  it('does not change what it is given, and answers a new object each time', () => {
    const input = verified(DESCRIBED);
    const before = JSON.stringify(input);
    const first = locationAccessSummary(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(locationAccessSummary(input)).not.toBe(first);
  });
});

describe('the changes an update of a location’s access may name', () => {
  it('accepts each answer, the details with null to clear them, and nothing at all', () => {
    expect(locationAccessChangesSchema.safeParse({}).success).toBe(true);
    expect(
      locationAccessChangesSchema.safeParse({
        stepFreeRoute: 'yes',
        accessibleToilet: 'no',
        accessibleParking: 'unknown',
        quietRoom: 'yes',
        seating: 'no',
      }).success,
    ).toBe(true);
    expect(
      locationAccessChangesSchema.safeParse({
        accessibleToiletDistanceM: null,
        accessibleParkingSurface: null,
        parkingHeightClearanceCm: null,
      }).success,
    ).toBe(true);
    expect(
      locationAccessChangesSchema.safeParse({
        accessibleToiletDistanceM: 0,
        parkingHeightClearanceCm: 100,
      }).success,
    ).toBe(true);
    expect(
      locationAccessChangesSchema.safeParse({
        accessibleToiletDistanceM: 5000,
        parkingHeightClearanceCm: 500,
        accessibleParkingSurface: 'other',
      }).success,
    ).toBe(true);
  });

  it.each([
    ['an answer that is none of the three', { stepFreeRoute: 'maybe' }],
    ['a null answer', { seating: null }],
    ['a distance of -1', { accessibleToiletDistanceM: -1 }],
    ['a distance of 5001', { accessibleToiletDistanceM: 5001 }],
    ['a distance that is not whole', { accessibleToiletDistanceM: 12.5 }],
    ['a clearance of 99', { parkingHeightClearanceCm: 99 }],
    ['a clearance of 501', { parkingHeightClearanceCm: 501 }],
    ['a surface that is not on the list', { accessibleParkingSurface: 'sand' }],
    ['a field it does not know', { name: 'Harbour Warehouse' }],
    ['the verification itself', { accessVerifiedAt: new Date() }],
  ])('refuses %s', (_label, changes) => {
    expect(locationAccessChangesSchema.safeParse(changes).success).toBe(false);
  });
});
