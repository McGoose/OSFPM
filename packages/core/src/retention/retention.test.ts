import { describe, expect, it } from 'vitest';
import { RETENTION_ANCHORS } from '../db/schema/retention-class.js';
import {
  RETENTION_CLASS_KEYS,
  SHIPPED_RETENTION_DEFAULTS,
} from './defaults.js';
import { retentionEndDate, type RetentionDates } from './end-date.js';

const NO_DATES: RetentionDates = {
  recordCreated: null,
  lastActivity: null,
  wrapDate: null,
  deliveryDate: null,
  firstExploitationDate: null,
};

describe('SHIPPED_RETENTION_DEFAULTS', () => {
  it('has one entry per class and none is verified', () => {
    expect(Object.keys(SHIPPED_RETENTION_DEFAULTS).sort()).toEqual(
      [...RETENTION_CLASS_KEYS].sort(),
    );
    for (const entry of Object.values(SHIPPED_RETENTION_DEFAULTS)) {
      expect(entry.verified).toBe(false);
    }
  });

  it('keeps financial records and contracts for ten years and purges nothing else automatically', () => {
    expect(SHIPPED_RETENTION_DEFAULTS['financial-record'].periodYears).toBe(10);
    expect(SHIPPED_RETENTION_DEFAULTS.contract.periodYears).toBe(10);
    for (const key of RETENTION_CLASS_KEYS) {
      if (key === 'financial-record' || key === 'contract') continue;
      expect(SHIPPED_RETENTION_DEFAULTS[key].periodYears, key).toBeNull();
    }
  });

  it('gives the transient class no period: cleanup removes its rows, retention never does', () => {
    expect(SHIPPED_RETENTION_DEFAULTS.transient).toEqual({
      periodYears: null,
      verified: false,
    });
    // The anchor date is known and there is still no end date.
    expect(
      retentionEndDate({
        anchor: 'record-created',
        periodsYears: [SHIPPED_RETENTION_DEFAULTS.transient.periodYears],
        dates: { ...NO_DATES, recordCreated: '2026-03-05' },
      }),
    ).toBeNull();
  });

  it('gives the account-lifetime class no period: no date ends it, only the person or the account', () => {
    expect(SHIPPED_RETENTION_DEFAULTS['account-lifetime']).toEqual({
      periodYears: null,
      verified: false,
    });
    // Every date known and long past, under every anchor: still no end date. A
    // project's wrap, delivery or first exploitation cannot end a row that
    // belongs to an account and not to a project.
    const everyDate: RetentionDates = {
      recordCreated: '2000-01-01',
      lastActivity: '2000-01-01',
      wrapDate: '2000-01-01',
      deliveryDate: '2000-01-01',
      firstExploitationDate: '2000-01-01',
    };
    for (const anchor of RETENTION_ANCHORS) {
      expect(
        retentionEndDate({
          anchor,
          periodsYears: [
            SHIPPED_RETENTION_DEFAULTS['account-lifetime'].periodYears,
          ],
          dates: everyDate,
        }),
        anchor,
      ).toBeNull();
    }
  });
});

describe('retentionEndDate', () => {
  const dates: RetentionDates = {
    recordCreated: new Date(Date.UTC(2026, 2, 5, 9, 30)),
    lastActivity: new Date(Date.UTC(2027, 3, 6, 18)),
    wrapDate: '2026-05-07',
    deliveryDate: '2026-08-09',
    firstExploitationDate: '2026-11-12',
  };

  it.each([
    ['record-created', '2036-03-05'],
    ['last-activity', '2037-04-06'],
    ['project-wrap', '2036-05-07'],
    ['project-delivery', '2036-08-09'],
    ['first-exploitation', '2036-11-12'],
  ] as const)('counts %s from its own date', (anchor, expected) => {
    expect(retentionEndDate({ anchor, periodsYears: [10], dates })).toBe(
      expected,
    );
  });

  it('returns null when the anchor date is missing, even if other dates are set', () => {
    expect(
      retentionEndDate({
        anchor: 'project-wrap',
        periodsYears: [10],
        dates: { ...dates, wrapDate: null },
      }),
    ).toBeNull();
    expect(
      retentionEndDate({
        anchor: 'first-exploitation',
        periodsYears: [10],
        dates: NO_DATES,
      }),
    ).toBeNull();
  });

  describe('an anchor that is not a known anchor', () => {
    // Names every object inherits must be refused like any other unknown name.
    it.each(['nonsense', '', 'constructor', '__proto__', 'toString'])(
      'throws RangeError for %j',
      (anchor) => {
        const call = () =>
          retentionEndDate({
            anchor: anchor as never,
            periodsYears: [10],
            dates,
          });
        expect(call).toThrow(RangeError);
        expect(call).toThrow('Unknown retention anchor');
      },
    );

    it('throws whatever the periods and dates are, so a corrupt anchor is never read as "keep"', () => {
      for (const periodsYears of [[], [null], [10, null], [10]]) {
        for (const given of [dates, NO_DATES]) {
          expect(() =>
            retentionEndDate({
              anchor: 'nonsense' as never,
              periodsYears,
              dates: given,
            }),
          ).toThrow(RangeError);
        }
      }
    });

    it('is told apart from a known anchor with no date, which still gives null', () => {
      expect(() =>
        retentionEndDate({
          anchor: 'nonsense' as never,
          periodsYears: [10],
          dates: NO_DATES,
        }),
      ).toThrow(RangeError);
      expect(
        retentionEndDate({
          anchor: 'project-wrap',
          periodsYears: [10],
          dates: NO_DATES,
        }),
      ).toBeNull();
    });
  });

  it('returns null when any period is null, however long the others are', () => {
    for (const periodsYears of [[null], [10, null], [null, 10, 30]]) {
      expect(
        retentionEndDate({ anchor: 'project-wrap', periodsYears, dates }),
      ).toBeNull();
    }
  });

  it('returns null when no period applies', () => {
    expect(
      retentionEndDate({ anchor: 'project-wrap', periodsYears: [], dates }),
    ).toBeNull();
  });

  it('uses the largest period', () => {
    expect(
      retentionEndDate({
        anchor: 'project-wrap',
        periodsYears: [3, 10, 7],
        dates,
      }),
    ).toBe('2036-05-07');
  });

  it('accepts a zero period, which ends on the anchor date', () => {
    expect(
      retentionEndDate({ anchor: 'project-wrap', periodsYears: [0], dates }),
    ).toBe('2026-05-07');
  });

  describe('29 February', () => {
    const leapDay = (anchor: string): RetentionDates => ({
      ...NO_DATES,
      wrapDate: anchor,
    });

    it('lands on 28 February when the end year has no 29 February', () => {
      for (const [years, expected] of [
        [1, '2025-02-28'],
        [3, '2027-02-28'],
        [10, '2034-02-28'],
      ] as const) {
        expect(
          retentionEndDate({
            anchor: 'project-wrap',
            periodsYears: [years],
            dates: leapDay('2024-02-29'),
          }),
        ).toBe(expected);
      }
    });

    it('stays on 29 February when the end year has one', () => {
      expect(
        retentionEndDate({
          anchor: 'project-wrap',
          periodsYears: [4],
          dates: leapDay('2024-02-29'),
        }),
      ).toBe('2028-02-29');
    });

    it('goes to 28 February in a century year that is not a leap year', () => {
      expect(
        retentionEndDate({
          anchor: 'project-wrap',
          periodsYears: [76],
          dates: leapDay('2024-02-29'),
        }),
      ).toBe('2100-02-28');
    });

    it('does not move other dates', () => {
      expect(
        retentionEndDate({
          anchor: 'project-wrap',
          periodsYears: [1],
          dates: leapDay('2024-02-28'),
        }),
      ).toBe('2025-02-28');
    });
  });

  describe('calendar dates in UTC', () => {
    it('reads a point in time as its UTC date', () => {
      // 23:30 on 31 December in New York is already 1 January in UTC.
      const lateNewYear = new Date('2026-12-31T23:30:00-05:00');
      expect(
        retentionEndDate({
          anchor: 'record-created',
          periodsYears: [1],
          dates: { ...NO_DATES, recordCreated: lateNewYear },
        }),
      ).toBe('2028-01-01');
    });

    it('reads an ISO timestamp string as its UTC date', () => {
      expect(
        retentionEndDate({
          anchor: 'last-activity',
          periodsYears: [2],
          dates: { ...NO_DATES, lastActivity: '2026-06-30T23:59:59Z' },
        }),
      ).toBe('2028-06-30');
    });
  });

  describe('bad input', () => {
    it.each([-1, 1.5, Number.NaN, Infinity])(
      'refuses the period %s',
      (period) => {
        expect(() =>
          retentionEndDate({
            anchor: 'project-wrap',
            periodsYears: [period],
            dates,
          }),
        ).toThrow(RangeError);
      },
    );

    it('refuses a date that does not exist', () => {
      expect(() =>
        retentionEndDate({
          anchor: 'project-wrap',
          periodsYears: [1],
          dates: { ...NO_DATES, wrapDate: '2025-02-29' },
        }),
      ).toThrow(RangeError);
    });
  });
});
