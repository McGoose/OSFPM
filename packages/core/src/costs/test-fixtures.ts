import type { Database } from '../db/client.js';
import { base } from '../access/test-fixtures.js';
import {
  account,
  accountChart,
  costLine,
  costLineScheme,
} from '../db/schema/index.js';

/**
 * Seed helpers for the cost line tests. They insert straight into the tables,
 * as the other fixtures do, so a test can set up state the service would
 * refuse. Descriptions and amounts are invented, for the demo production The
 * Last Withdrawal.
 */

let counter = 0;
const next = () => (counter += 1);

/**
 * A chart of accounts: an organisation template when `projectId` is left out or
 * null, else that project's chart. Returns its id.
 */
export async function seedChart(
  database: Database,
  organisationId: string,
  options: { projectId?: string | null; key?: string } = {},
): Promise<string> {
  const [row] = await database.db
    .insert(accountChart)
    .values({
      ...base(organisationId),
      projectId: options.projectId ?? null,
      key: options.key ?? `fixture-chart-${next()}`,
      name: 'Fixture chart',
    })
    .returning();
  return row!.id;
}

/** An account of `chartId`, postable unless `isPostable` is false. Returns its id. */
export async function seedAccount(
  database: Database,
  organisationId: string,
  chartId: string,
  options: { code?: string; isPostable?: boolean; parentId?: string } = {},
): Promise<string> {
  const [row] = await database.db
    .insert(account)
    .values({
      ...base(organisationId),
      chartId,
      parentId: options.parentId ?? null,
      code: options.code ?? `${5000 + next()}`,
      name: 'Camera',
      isPostable: options.isPostable ?? true,
    })
    .returning();
  return row!.id;
}

/**
 * The values of a cost line in the project's currency, `GBP`, booked to
 * `accountId`. `overrides` replaces any of them.
 */
export function costLineValues(
  organisationId: string,
  projectId: string,
  accountId: string,
  overrides: Partial<typeof costLine.$inferInsert> = {},
) {
  return {
    ...base(organisationId),
    projectId,
    stage: 'budget',
    sourceType: 'other',
    accountId,
    description: 'Camera hire',
    territory: 'GB',
    productionPhase: 'principal-photography',
    amount: '1000.0000',
    currency: 'GBP',
    amountProjectCurrency: '1000.0000',
    ...overrides,
  } satisfies typeof costLine.$inferInsert;
}

/** Inserts a cost line with `costLineValues` and returns the stored row. */
export async function seedCostLine(
  database: Database,
  organisationId: string,
  projectId: string,
  accountId: string,
  overrides: Partial<typeof costLine.$inferInsert> = {},
) {
  const [row] = await database.db
    .insert(costLine)
    .values(costLineValues(organisationId, projectId, accountId, overrides))
    .returning();
  return row!;
}

/** The values of a pending scheme tag for `costLineId`. `overrides` replaces any of them. */
export function schemeValues(
  organisationId: string,
  costLineId: string,
  overrides: Partial<typeof costLineScheme.$inferInsert> = {},
) {
  return {
    ...base(organisationId),
    costLineId,
    schemeKey: 'uk-hetv',
    status: 'pending',
    ...overrides,
  } satisfies typeof costLineScheme.$inferInsert;
}
