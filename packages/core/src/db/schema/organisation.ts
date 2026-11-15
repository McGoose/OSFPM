import { sql } from 'drizzle-orm';
import {
  check,
  text,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sqlList, standardColumns, tenantTable } from '../columns.js';
import { declareOrganisationLevel } from '../project-resolver.js';
import { user } from './user.js';

export const ORGANISATION_STATUSES = ['active', 'suspended'] as const;
export type OrganisationStatus = (typeof ORGANISATION_STATUSES)[number];

/** The tenant. Its own `organisation_id` is always its `id`. */
export const organisation = tenantTable(
  'organisation',
  (): AnyPgColumn => organisation.id,
  {
    ...standardColumns(() => user.id, { defaultVisibility: 'private' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    legalName: text('legal_name'),
    /** ISO 3166-1 alpha-2 */
    country: text('country').notNull(),
    /** BCP 47 */
    defaultLocale: text('default_locale').notNull(),
    /** IANA time zone */
    defaultTimezone: text('default_timezone').notNull(),
    /** ISO 4217 */
    baseCurrency: text('base_currency').notNull(),
    status: text('status').$type<OrganisationStatus>().notNull(),
  },
  (t) => [
    uniqueIndex('organisation_slug_unique').on(t.slug),
    check(
      'organisation_is_own_tenant_check',
      sql`${t.organisationId} = ${t.id}`,
    ),
    check('organisation_country_check', sql`${t.country} ~ '^[A-Z]{2}$'`),
    check(
      'organisation_base_currency_check',
      sql`${t.baseCurrency} ~ '^[A-Z]{3}$'`,
    ),
    check(
      'organisation_status_check',
      sql`${t.status} in (${sqlList(ORGANISATION_STATUSES)})`,
    ),
  ],
);

/** Belongs to the organisation, never to a project: no project_id, no resolver. */
declareOrganisationLevel(organisation);
