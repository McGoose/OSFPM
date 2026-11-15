import type { RetentionAnchor } from '../db/schema/retention-class.js';

/** A calendar date as `YYYY-MM-DD`, or a point in time, read as its UTC date. */
export type RetentionDate = string | Date;

export type RetentionDates = {
  readonly recordCreated: RetentionDate | null;
  readonly lastActivity: RetentionDate | null;
  readonly wrapDate: RetentionDate | null;
  readonly deliveryDate: RetentionDate | null;
  readonly firstExploitationDate: RetentionDate | null;
};

export type RetentionEndInput = {
  readonly anchor: RetentionAnchor;
  /**
   * Whole years from each rule that applies to the record. `null` means that
   * rule keeps the record until someone decides.
   */
  readonly periodsYears: readonly (number | null)[];
  readonly dates: RetentionDates;
};

const DATE_KEY: Record<RetentionAnchor, keyof RetentionDates> = {
  'record-created': 'recordCreated',
  'project-wrap': 'wrapDate',
  'project-delivery': 'deliveryDate',
  'first-exploitation': 'firstExploitationDate',
  'last-activity': 'lastActivity',
};

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Year, month (1 to 12) and day of `value` in UTC. */
function utcParts(value: RetentionDate): [number, number, number] {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new RangeError('Invalid date');
    return [
      value.getUTCFullYear(),
      value.getUTCMonth() + 1,
      value.getUTCDate(),
    ];
  }
  const match = CALENDAR_DATE.exec(value);
  if (match) {
    const parts: [number, number, number] = [
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
    ];
    const check = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    if (
      check.getUTCFullYear() !== parts[0] ||
      check.getUTCMonth() + 1 !== parts[1] ||
      check.getUTCDate() !== parts[2]
    ) {
      throw new RangeError('Invalid calendar date');
    }
    return parts;
  }
  return utcParts(new Date(value)); // an ISO timestamp
}

const isLeapYear = (year: number) =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

const pad = (n: number, width: number) => String(n).padStart(width, '0');

/**
 * When a record may be purged: the anchor's date plus the largest period, as
 * `YYYY-MM-DD` in UTC. When several rules apply the longest one wins.
 *
 * Returns `null`, meaning "no automatic purge", when the anchor's date is
 * missing, when any period is `null`, or when there are no periods at all.
 * One rule that keeps the record forever outweighs any finite one.
 *
 * Years are added to the calendar date, so 29 February plus a whole number of
 * years is 28 February when the target year has no 29 February.
 *
 * Throws `RangeError` for an anchor that is not a known anchor, for a period
 * that is not a whole number of years of at least zero, and for a date that
 * does not exist. An unknown anchor is an error, not "no date": returning
 * `null` for it would keep a record forever without anyone being told.
 */
export function retentionEndDate(input: RetentionEndInput): string | null {
  const { anchor, periodsYears, dates } = input;
  if (!Object.hasOwn(DATE_KEY, anchor)) {
    throw new RangeError('Unknown retention anchor');
  }
  for (const period of periodsYears) {
    if (period !== null && (!Number.isInteger(period) || period < 0)) {
      throw new RangeError('A retention period is a whole number of years');
    }
  }
  const raw = dates[DATE_KEY[anchor]];
  if (raw === null || raw === undefined) return null;
  if (periodsYears.length === 0 || periodsYears.includes(null)) return null;
  const longest = Math.max(...(periodsYears as number[]));
  const [year, month, day] = utcParts(raw);
  const endYear = year + longest;
  const endDay = month === 2 && day === 29 && !isLeapYear(endYear) ? 28 : day;
  return `${pad(endYear, 4)}-${pad(month, 2)}-${pad(endDay, 2)}`;
}
