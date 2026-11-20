import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  numeric,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  sqlList,
  standardColumns,
  tenantTable,
  timestamptz,
} from '../columns.js';
import { registerProjectResolver } from '../project-resolver.js';
import { markSensitive } from '../sensitive.js';
import { costLine, costLineProjectResolver } from './cost-line.js';
import { organisation } from './organisation.js';
import { user } from './user.js';

/**
 * Allowed values of `cost_line_scheme.status`: whether the line counts towards
 * an incentive or funding scheme. `pending` is not decided yet and `excluded`
 * takes the line out of the scheme's calculations altogether. The CHECK is built
 * from this list, so a new value needs a new migration.
 */
export const COST_LINE_SCHEME_STATUSES = [
  'qualifying',
  'non-qualifying',
  'pending',
  'excluded',
] as const;
/** One value of `COST_LINE_SCHEME_STATUSES`. */
export type CostLineSchemeStatus = (typeof COST_LINE_SCHEME_STATUSES)[number];

/**
 * The tag a cost line carries for one incentive or funding scheme, such as a
 * tax rebate or a co-production rule. `scheme_key` is a lower-case word that may
 * hold digits, dots and hyphens, for example `uk-hetv`; the schemes themselves
 * and their rules come from rule packs later, so nothing here knows what a key
 * means. A line has at most one live tag per key.
 *
 * `qualifying_amount` is the part of the line that qualifies, and only a
 * `qualifying` tag may hold one. The service keeps it between zero and the
 * line's `amount_project_currency`, with the same sign. The write helper keeps
 * it out of change events, as it does the line's amounts. `decided_by` and
 * `decided_at` record who made the decision and when, and are both set or both
 * empty. Visibility defaults to `private` and the retention class to
 * `financial-record`, as for the cost line.
 *
 * Has no `project_id`: its project is the one its cost line belongs to.
 */
export const costLineScheme = tenantTable(
  'cost_line_scheme',
  () => organisation.id,
  {
    ...standardColumns(() => user.id, {
      defaultVisibility: 'private',
      defaultRetentionClass: 'financial-record',
    }),
    costLineId: uuid('cost_line_id').notNull(),
    schemeKey: text('scheme_key').notNull(),
    status: text('status').$type<CostLineSchemeStatus>().notNull(),
    qualifyingAmount: numeric('qualifying_amount', {
      precision: 19,
      scale: 4,
    }),
    reason: text('reason'),
    decidedBy: uuid('decided_by'),
    decidedAt: timestamptz('decided_at'),
  },
  (t) => [
    foreignKey({
      name: 'cost_line_scheme_cost_line_fk',
      columns: [t.organisationId, t.costLineId],
      foreignColumns: [costLine.organisationId, costLine.id],
    }),
    foreignKey({
      name: 'cost_line_scheme_user_fk',
      columns: [t.decidedBy],
      foreignColumns: [user.id],
    }),
    check(
      'cost_line_scheme_scheme_key_check',
      sql`${t.schemeKey} ~ '^[a-z0-9][a-z0-9.-]*$'`,
    ),
    check(
      'cost_line_scheme_status_check',
      sql`${t.status} in (${sqlList(COST_LINE_SCHEME_STATUSES)})`,
    ),
    check(
      'cost_line_scheme_qualifying_amount_check',
      sql`${t.status} = 'qualifying' or ${t.qualifyingAmount} is null`,
    ),
    check(
      'cost_line_scheme_decided_check',
      sql`(${t.decidedBy} is null) = (${t.decidedAt} is null)`,
    ),
    // A removed tag frees its key, so the line can be tagged for it again. Both
    // columns are NOT NULL, so a plain unique index is enough.
    uniqueIndex('cost_line_scheme_cost_line_key_unique')
      .on(t.costLineId, t.schemeKey)
      .where(sql`${t.deletedAt} is null`),
  ],
);

/**
 * The qualifying amount is part of what a line costs, so like the line's own
 * amounts it never reaches `change_event` (see `markSensitive` on `cost_line`).
 * The event still names `qualifying_amount` in `changed_fields`.
 */
markSensitive(costLineScheme, ['qualifyingAmount']);

/** Has no `project_id`: its project is the one its cost line belongs to. */
registerProjectResolver(costLineScheme, costLineProjectResolver, {
  parentKeys: ['costLineId'],
});
