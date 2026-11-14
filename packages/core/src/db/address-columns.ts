import { sql } from 'drizzle-orm';
import { check, text, type AnyPgColumn } from 'drizzle-orm/pg-core';

/** Postal address columns shared by `company` and `location`. All are optional. */
export function addressColumns() {
  return {
    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    addressCity: text('address_city'),
    addressPostcode: text('address_postcode'),
    addressRegion: text('address_region'),
    addressCountry: text('address_country'),
  };
}

/** CHECK that a country column is NULL or an ISO 3166-1 alpha-2 code in capitals. */
export function countryCheck(name: string, column: AnyPgColumn) {
  return check(name, sql`${column} ~ '^[A-Z]{2}$'`);
}

/** CHECK that an email column is NULL or already lower-case. */
export function lowerCaseCheck(name: string, column: AnyPgColumn) {
  return check(name, sql`${column} is null or ${column} = lower(${column})`);
}

/** CHECK that `end` is not before `start`; either may be NULL. */
export function dateRangeCheck(
  name: string,
  start: AnyPgColumn,
  end: AnyPgColumn,
) {
  return check(
    name,
    sql`${end} is null or ${start} is null or ${end} >= ${start}`,
  );
}
