import { describe, expect, it } from 'vitest';
import {
  CLOSED_PROJECT_STATUSES,
  dateInZone,
  LIVE_ENGAGEMENT_STATUSES,
  projectIsOpen,
  type ProjectTiming,
} from './liveness.js';

/**
 * When a project is open for access grants (decision D-69): not deleted, not delivered or
 * archived, and not past its wrap date, by the date in its own time zone. The database
 * tests of `grant-liveness.test.ts` show it end to end; these are the rules alone.
 */

const open = (over: Partial<ProjectTiming> = {}): ProjectTiming => ({
  deletedAt: null,
  status: 'production',
  wrapDate: null,
  timezone: 'Europe/London',
  ...over,
});
const at = (iso: string) => new Date(iso);

describe('the date in a time zone', () => {
  it('is the calendar date there, as YYYY-MM-DD', () => {
    expect(dateInZone('Europe/London', at('2026-11-15T10:00:00.000Z'))).toBe(
      '2026-11-15',
    );
    // Auckland is 13 hours ahead in November, so it is already the 16th there.
    expect(dateInZone('Pacific/Auckland', at('2026-11-15T11:30:00.000Z'))).toBe(
      '2026-11-16',
    );
    // Honolulu is 10 hours behind.
    expect(dateInZone('Pacific/Honolulu', at('2026-11-15T05:00:00.000Z'))).toBe(
      '2026-11-14',
    );
  });

  it('is the UTC date for a zone the runtime does not know, and never throws', () => {
    for (const zone of [
      'Not/AZone',
      '',
      'Europe/London; drop table',
      'UTC+99',
    ]) {
      expect(dateInZone(zone, at('2026-11-15T23:59:59.000Z'))).toBe(
        '2026-11-15',
      );
    }
  });

  it('turns over at local midnight, by the clock of the zone', () => {
    expect(dateInZone('Europe/London', at('2026-11-15T23:59:59.000Z'))).toBe(
      '2026-11-15',
    );
    expect(dateInZone('Europe/London', at('2026-11-16T00:00:00.000Z'))).toBe(
      '2026-11-16',
    );
    // Summer time: London is an hour ahead of UTC in July.
    expect(dateInZone('Europe/London', at('2026-07-15T23:30:00.000Z'))).toBe(
      '2026-07-16',
    );
  });
});

describe('a project that is open for grants', () => {
  const now = at('2026-11-15T10:00:00.000Z');

  it('is open before it is closed, with no wrap date', () => {
    for (const status of [
      'development',
      'pre-production',
      'production',
      'post-production',
    ] as const) {
      expect(projectIsOpen(open({ status }), now), status).toBe(true);
    }
  });

  it('is closed once it is delivered or archived, and the list says so', () => {
    expect([...CLOSED_PROJECT_STATUSES]).toEqual(['delivered', 'archived']);
    for (const status of CLOSED_PROJECT_STATUSES) {
      expect(projectIsOpen(open({ status }), now), status).toBe(false);
    }
  });

  it('is closed when it is deleted, whatever else is true of it', () => {
    expect(projectIsOpen(open({ deletedAt: now }), now)).toBe(false);
    expect(
      projectIsOpen(open({ deletedAt: now, wrapDate: '2099-01-01' }), now),
    ).toBe(false);
  });

  it('is open through the wrap date and closed the day after', () => {
    expect(projectIsOpen(open({ wrapDate: '2026-11-16' }), now)).toBe(true);
    expect(projectIsOpen(open({ wrapDate: '2026-11-15' }), now)).toBe(true);
    expect(projectIsOpen(open({ wrapDate: '2026-11-14' }), now)).toBe(false);
  });

  it('counts the wrap date by the date in the project’s own zone', () => {
    const wrapped = open({
      wrapDate: '2026-11-15',
      timezone: 'Pacific/Auckland',
    });
    expect(projectIsOpen(wrapped, at('2026-11-15T10:00:00.000Z'))).toBe(true);
    expect(projectIsOpen(wrapped, at('2026-11-15T11:30:00.000Z'))).toBe(false);
    const west = open({ wrapDate: '2026-11-15', timezone: 'Pacific/Honolulu' });
    // Already the 16th in London and UTC, still the 15th in Honolulu.
    expect(projectIsOpen(west, at('2026-11-16T05:00:00.000Z'))).toBe(true);
  });
});

describe('a person who is still on the project', () => {
  it('is proposed or confirmed, and not released', () => {
    expect([...LIVE_ENGAGEMENT_STATUSES]).toEqual(['proposed', 'confirmed']);
  });
});
