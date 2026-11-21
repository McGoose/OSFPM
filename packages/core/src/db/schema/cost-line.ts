import { and, eq, sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  numeric,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sqlList, standardColumns, tenantTable } from '../columns.js';
import type { ProjectResolver } from '../project-resolver.js';
import { markSensitive } from '../sensitive.js';
import { account } from './account.js';
import { company } from './company.js';
import { episode } from './episode.js';
import { organisation } from './organisation.js';
import { person } from './person.js';
import { project } from './project.js';
import { unit } from './unit.js';
import { user } from './user.js';

/**
 * Allowed values of `cost_line.stage`: a planned amount, a commitment such as a
 * purchase order, or money actually spent. The CHECK is built from this list,
 * so a new value needs a new migration.
 */
export const COST_STAGES = ['budget', 'committed', 'actual'] as const;
/** One value of `COST_STAGES`. */
export type CostStage = (typeof COST_STAGES)[number];

/**
 * Allowed values of `cost_line.source_type`: the kind of money document a line
 * belongs to. The CHECK is built from this list, so a new value needs a new
 * migration.
 */
export const COST_SOURCE_TYPES = [
  'budget',
  'purchase-order',
  'invoice',
  'expense',
  'timesheet',
  'other',
] as const;
/** One value of `COST_SOURCE_TYPES`. */
export type CostSourceType = (typeof COST_SOURCE_TYPES)[number];

/**
 * Allowed values of `cost_line.production_phase`. The CHECK is built from this
 * list, so a new value needs a new migration.
 */
export const PRODUCTION_PHASES = [
  'development',
  'pre-production',
  'principal-photography',
  'post-production',
  'delivery',
  'distribution',
] as const;
/** One value of `PRODUCTION_PHASES`. */
export type ProductionPhase = (typeof PRODUCTION_PHASES)[number];

/**
 * One line of money on a project: the row every money document (budget,
 * purchase order, invoice, expense, timesheet) will write to. `stage` says
 * whether the amount is planned, committed or spent. `source_type` and
 * `source_id` name the document the line came from; `source_id` has no foreign
 * key because the documents live in other tables, and is required unless the
 * source type is `other`. The line is booked to a postable `account` of the
 * project's own chart, which the service checks, because a foreign key cannot
 * see the chart's project.
 *
 * `amount` is in `currency`, and `amount_project_currency` is the same money in
 * the project's currency. Both are decimals with four places, and
 * `fx_rate` has ten: money is never floating point. Negative amounts are
 * allowed, for credits and refunds. Both amounts are sensitive: the write helper
 * keeps their values out of change events (see `markSensitive` below), and the
 * costs service shows them only to holders of `costs:read`. When `currency` is the project's currency,
 * `fx_rate` is NULL and the two amounts are equal; otherwise `fx_rate` is
 * required and the service has the database compute
 * `amount_project_currency` from it. Those two rules need the project's
 * currency, which a CHECK cannot read, so the service enforces them.
 *
 * `territory` is an ISO 3166-1 alpha-2 code, or `WW` for worldwide. A line has
 * at most one payee, a company or a person of the library; the payee's
 * residency is never copied here, because reports read it through the
 * sensitive-data service. `unit_id` and `episode_id` are optional; their
 * composite keys include the project, so a unit or episode of another project
 * is refused.
 *
 * `project_id` cannot change after creation. Visibility defaults to `private`
 * and the retention class to `financial-record`, as for charts of accounts
 * (source: `src/retention/README.md`; the class is seeded in
 * `0013_seed_retention_classes.sql`).
 */
export const costLine = tenantTable(
  'cost_line',
  () => organisation.id,
  {
    ...standardColumns(() => user.id, {
      defaultVisibility: 'private',
      defaultRetentionClass: 'financial-record',
    }),
    projectId: uuid('project_id').notNull(),
    stage: text('stage').$type<CostStage>().notNull(),
    sourceType: text('source_type').$type<CostSourceType>().notNull(),
    sourceId: uuid('source_id'),
    accountId: uuid('account_id').notNull(),
    description: text('description').notNull(),
    territory: text('territory').notNull(),
    productionPhase: text('production_phase')
      .$type<ProductionPhase>()
      .notNull(),
    payeeCompanyId: uuid('payee_company_id'),
    payeePersonId: uuid('payee_person_id'),
    costDate: date('cost_date', { mode: 'string' }),
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
    currency: text('currency').notNull(),
    fxRate: numeric('fx_rate', { precision: 19, scale: 10 }),
    amountProjectCurrency: numeric('amount_project_currency', {
      precision: 19,
      scale: 4,
    }).notNull(),
    episodeId: uuid('episode_id'),
    unitId: uuid('unit_id'),
  },
  (t) => [
    foreignKey({
      name: 'cost_line_project_fk',
      columns: [t.organisationId, t.projectId],
      foreignColumns: [project.organisationId, project.id],
    }),
    foreignKey({
      name: 'cost_line_account_fk',
      columns: [t.organisationId, t.accountId],
      foreignColumns: [account.organisationId, account.id],
    }),
    foreignKey({
      name: 'cost_line_person_fk',
      columns: [t.organisationId, t.payeePersonId],
      foreignColumns: [person.organisationId, person.id],
    }),
    foreignKey({
      name: 'cost_line_company_fk',
      columns: [t.organisationId, t.payeeCompanyId],
      foreignColumns: [company.organisationId, company.id],
    }),
    // Includes the project, so a unit of another project is refused. With a NULL
    // `unit_id` the key is not checked, which is right for a line with no unit.
    foreignKey({
      name: 'cost_line_unit_fk',
      columns: [t.organisationId, t.projectId, t.unitId],
      foreignColumns: [unit.organisationId, unit.projectId, unit.id],
    }),
    // Same, for episodes.
    foreignKey({
      name: 'cost_line_episode_fk',
      columns: [t.organisationId, t.projectId, t.episodeId],
      foreignColumns: [episode.organisationId, episode.projectId, episode.id],
    }),
    // Target for the composite tenant foreign key of scheme tags.
    unique('cost_line_organisation_id_id_unique').on(t.organisationId, t.id),
    // The only indexes on this table, both partial because every lookup is for
    // live lines. The first serves the guards in the accounts service, which ask
    // whether a live line is booked to an account, and the account filter of
    // `listCostLines`. The second serves that list: a project's lines, narrowed
    // by stage.
    index('cost_line_organisation_account_idx')
      .on(t.organisationId, t.accountId)
      .where(sql`${t.deletedAt} is null`),
    index('cost_line_organisation_project_stage_idx')
      .on(t.organisationId, t.projectId, t.stage)
      .where(sql`${t.deletedAt} is null`),
    check(
      'cost_line_stage_check',
      sql`${t.stage} in (${sqlList(COST_STAGES)})`,
    ),
    check(
      'cost_line_source_type_check',
      sql`${t.sourceType} in (${sqlList(COST_SOURCE_TYPES)})`,
    ),
    check(
      'cost_line_production_phase_check',
      sql`${t.productionPhase} in (${sqlList(PRODUCTION_PHASES)})`,
    ),
    check(
      'cost_line_source_id_check',
      sql`${t.sourceType} = 'other' or ${t.sourceId} is not null`,
    ),
    check('cost_line_territory_check', sql`${t.territory} ~ '^[A-Z]{2}$'`),
    check('cost_line_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check(
      'cost_line_fx_rate_check',
      sql`${t.fxRate} is null or ${t.fxRate} > 0`,
    ),
    check(
      'cost_line_one_payee_check',
      sql`${t.payeeCompanyId} is null or ${t.payeePersonId} is null`,
    ),
    check('cost_line_description_check', sql`${t.description} <> ''`),
  ],
);

/**
 * Amounts must never reach `change_event`, which anyone who may read a project's
 * changes can read, and what a line costs is what people are paid (CLAUDE.md,
 * Privacy rule). The event still names the field in `changed_fields`, so a
 * change is visible without the number. `currency` and `fx_rate` are not
 * amounts and stay in the event.
 */
markSensitive(costLine, ['amount', 'amountProjectCurrency']);

/**
 * The project of a record that belongs to a cost line and has no `project_id`
 * of its own, such as a scheme tag: the cost line's project. It also answers for
 * a removed cost line, so the tags removed with their line are filed under the
 * same project.
 */
export const costLineProjectResolver: ProjectResolver = async (tx, row) => {
  const [found] = await tx
    .select({ projectId: costLine.projectId })
    .from(costLine)
    .where(
      and(
        eq(costLine.id, row.costLineId as string),
        eq(costLine.organisationId, row.organisationId as string),
      ),
    )
    .limit(1);
  return found?.projectId ?? null;
};
