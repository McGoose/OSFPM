import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  integer,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { standardColumns, tenantTable } from '../columns.js';
import { registerProjectResolver } from '../project-resolver.js';
import { accountChart, accountChartProjectResolver } from './account-chart.js';
import { organisation } from './organisation.js';
import { user } from './user.js';

/**
 * One account of a chart: a node in a tree. `code` is what people read (for
 * example `1100`) and is unique among the live accounts of its chart. A parent
 * is always in the same chart; the composite foreign key on
 * `(organisation_id, chart_id, parent_id)` enforces that. Only a postable
 * account takes cost lines. `gl_code` is the code in an external ledger, if any.
 *
 * A cycle through `parent_id` cannot be caught by a constraint; the service
 * refuses it (`updateAccount`).
 *
 * Has no `project_id`: its project is the one its chart belongs to. Retention
 * class `financial-record`, as for the chart (see `account_chart`).
 */
export const account = tenantTable(
  'account',
  () => organisation.id,
  {
    ...standardColumns(() => user.id, {
      defaultRetentionClass: 'financial-record',
    }),
    chartId: uuid('chart_id').notNull(),
    parentId: uuid('parent_id'),
    code: text('code').notNull(),
    name: text('name').notNull(),
    isPostable: boolean('is_postable').notNull().default(true),
    glCode: text('gl_code'),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [
    foreignKey({
      name: 'account_account_chart_fk',
      columns: [t.organisationId, t.chartId],
      foreignColumns: [accountChart.organisationId, accountChart.id],
    }),
    // Target for the composite tenant foreign key of cost lines, which book to
    // an account without naming its chart.
    unique('account_organisation_id_id_unique').on(t.organisationId, t.id),
    // Target for the parent key below, which must stay inside one chart.
    unique('account_organisation_id_chart_id_id_unique').on(
      t.organisationId,
      t.chartId,
      t.id,
    ),
    // The table references itself, so the name follows the column. With a NULL
    // `parent_id` the key is not checked, which is right for a root account.
    foreignKey({
      name: 'account_parent_fk',
      columns: [t.organisationId, t.chartId, t.parentId],
      foreignColumns: [t.organisationId, t.chartId, t.id],
    }),
    check('account_parent_not_self_check', sql`${t.parentId} <> ${t.id}`),
    check('account_code_check', sql`${t.code} <> ''`),
    // A removed account frees its code, so it can be added again as a new one.
    uniqueIndex('account_chart_id_code_unique')
      .on(t.chartId, t.code)
      .where(sql`${t.deletedAt} is null`),
  ],
);

/** Has no `project_id`: its project is the one its chart belongs to. */
registerProjectResolver(account, accountChartProjectResolver, {
  parentKeys: ['chartId'],
});
