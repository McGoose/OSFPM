import { and, eq, sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  numeric,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sqlList, standardColumns, tenantTable } from '../columns.js';
import type { ProjectResolver } from '../project-resolver.js';
import { organisation } from './organisation.js';
import { project } from './project.js';
import { user } from './user.js';

export const CONTRACT_KINDS = [
  'deal-memo',
  'crew-contract',
  'cast-contract',
  'location-agreement',
  'release',
  'chain-of-title',
  'option',
  'insurance-certificate',
  'co-production-agreement',
  'financing-agreement',
  'sales-agency',
  'distribution',
  'music-licence',
  'other',
] as const;
export type ContractKind = (typeof CONTRACT_KINDS)[number];

export const CONTRACT_STATUSES = [
  'draft',
  'negotiating',
  'signed',
  'active',
  'expired',
  'terminated',
] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

/**
 * One record per contract: a deal memo, a crew or cast contract, a location
 * agreement, a release, a chain-of-title document, a financing or sales
 * agreement and so on. Its parties are in `contract_party` and the records it
 * concerns in `contract_link`.
 *
 * `project_id` is NULL for an organisation-level contract, such as a sales
 * agency agreement that covers several projects. It cannot change after
 * creation. Visibility defaults to `private` and the retention class to
 * `contract`.
 *
 * `territories` holds ISO 3166-1 alpha-2 codes, or `WW` for worldwide.
 * `total_value` is a decimal with four places, in `currency`. Dates are
 * calendar dates, not instants, so they carry no time zone.
 */
export const contract = tenantTable(
  'contract',
  () => organisation.id,
  {
    ...standardColumns(() => user.id, {
      defaultVisibility: 'private',
      defaultRetentionClass: 'contract',
    }),
    projectId: uuid('project_id'),
    kind: text('kind').$type<ContractKind>().notNull(),
    title: text('title').notNull(),
    status: text('status').$type<ContractStatus>().notNull(),
    signedOn: date('signed_on', { mode: 'string' }),
    effectiveFrom: date('effective_from', { mode: 'string' }),
    effectiveTo: date('effective_to', { mode: 'string' }),
    territories: text('territories').array().notNull().default([]),
    currency: text('currency'),
    totalValue: numeric('total_value', { precision: 19, scale: 4 }),
  },
  (t) => [
    foreignKey({
      name: 'contract_project_fk',
      columns: [t.organisationId, t.projectId],
      foreignColumns: [project.organisationId, project.id],
    }),
    // Target for the composite tenant foreign keys of parties and links.
    unique('contract_organisation_id_id_unique').on(t.organisationId, t.id),
    check(
      'contract_kind_check',
      sql`${t.kind} in (${sqlList(CONTRACT_KINDS)})`,
    ),
    check(
      'contract_status_check',
      sql`${t.status} in (${sqlList(CONTRACT_STATUSES)})`,
    ),
    check(
      'contract_effective_period_check',
      sql`${t.effectiveFrom} is null or ${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
    check('contract_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check(
      'contract_total_value_currency_check',
      sql`${t.totalValue} is null or ${t.currency} is not null`,
    ),
    // A CHECK cannot run a subquery over the elements, so the array's text
    // form is matched instead: `{}`, or `{GB,FR}`. Anything else, such as an
    // element that is a NULL, lower case, longer, or quoted because it holds a
    // comma or a space, or an array of arrays, prints differently and fails.
    check(
      'contract_territories_check',
      sql`${t.territories}::text ~ '^[{]([A-Z]{2}(,[A-Z]{2})*)?[}]$'`,
    ),
  ],
);

/**
 * The project of a record that belongs to a contract and has no `project_id`
 * of its own, such as a party or a link: the contract's project, or `null`
 * for an organisation-level contract.
 */
export const contractProjectResolver: ProjectResolver = async (tx, row) => {
  const [found] = await tx
    .select({ projectId: contract.projectId })
    .from(contract)
    .where(
      and(
        eq(contract.id, row.contractId as string),
        eq(contract.organisationId, row.organisationId as string),
      ),
    )
    .limit(1);
  return found?.projectId ?? null;
};
