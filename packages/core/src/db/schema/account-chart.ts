import { and, eq, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { standardColumns, tenantTable } from '../columns.js';
import type { ProjectResolver } from '../project-resolver.js';
import { organisation } from './organisation.js';
import { project } from './project.js';
import { user } from './user.js';

/**
 * A chart of accounts: the list of accounts cost lines are booked against. With
 * no `project_id` it is an organisation template that projects copy; with one it
 * is that project's own chart, which the project edits freely. Its accounts are
 * in `account`. Cost lines will point at a project's accounts.
 *
 * `project_id` cannot change after creation. `key` names the chart within its
 * scope and `format` says what it follows, for example `custom` or a named
 * industry layout; both are lower-case words joined by hyphens. `copied_from_chart_id`
 * records the template a project chart was copied from, and nothing else: the
 * copy never follows later changes to the template.
 *
 * Retention class `financial-record`: a chart is needed to read cost lines for as
 * long as the cost lines are kept (source: prompt P-02i; the class is seeded in
 * `0013_seed_retention_classes.sql`).
 *
 * Two partial unique indexes, written by hand in the migration to add NULLS NOT
 * DISTINCT, which Drizzle cannot express on an index (see
 * `0019_charts_of_accounts.sql`):
 * - `account_chart_organisation_project_key_unique`: a live key is unique per
 *   scope, where an organisation template and a project chart are two scopes.
 * - `account_chart_default_unique`: at most one live default chart per scope.
 */
export const accountChart = tenantTable(
  'account_chart',
  () => organisation.id,
  {
    ...standardColumns(() => user.id, {
      defaultRetentionClass: 'financial-record',
    }),
    projectId: uuid('project_id'),
    key: text('key').notNull(),
    name: text('name').notNull(),
    format: text('format').notNull().default('custom'),
    isDefault: boolean('is_default').notNull().default(false),
    copiedFromChartId: uuid('copied_from_chart_id'),
  },
  (t) => [
    foreignKey({
      name: 'account_chart_project_fk',
      columns: [t.organisationId, t.projectId],
      foreignColumns: [project.organisationId, project.id],
    }),
    // The table references itself, so the name follows the column.
    foreignKey({
      name: 'account_chart_copied_from_chart_fk',
      columns: [t.organisationId, t.copiedFromChartId],
      foreignColumns: [t.organisationId, t.id],
    }),
    // Target for the composite tenant foreign keys of accounts and copies.
    unique('account_chart_organisation_id_id_unique').on(
      t.organisationId,
      t.id,
    ),
    check(
      'account_chart_format_check',
      sql`${t.format} ~ '^[a-z0-9][a-z0-9-]*$'`,
    ),
    check('account_chart_key_check', sql`${t.key} ~ '^[a-z0-9][a-z0-9-]*$'`),
    // NULLS NOT DISTINCT is added by hand in the migration: a template has a
    // NULL `project_id`, and a plain unique index would let two templates share
    // a key.
    uniqueIndex('account_chart_organisation_project_key_unique')
      .on(t.organisationId, t.projectId, t.key)
      .where(sql`${t.deletedAt} is null`),
    // Same reason. A removed chart frees its place as the default.
    uniqueIndex('account_chart_default_unique')
      .on(t.organisationId, t.projectId)
      .where(sql`${t.isDefault} and ${t.deletedAt} is null`),
  ],
);

/**
 * The project of a record that belongs to a chart and has no `project_id` of
 * its own, such as an account: the chart's project, or `null` for an
 * organisation template.
 */
export const accountChartProjectResolver: ProjectResolver = async (tx, row) => {
  const [found] = await tx
    .select({ projectId: accountChart.projectId })
    .from(accountChart)
    .where(
      and(
        eq(accountChart.id, row.chartId as string),
        eq(accountChart.organisationId, row.organisationId as string),
      ),
    )
    .limit(1);
  return found?.projectId ?? null;
};
