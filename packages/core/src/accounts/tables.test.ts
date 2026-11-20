import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  base,
  seedOrganisation,
  seedProject,
  type SeedOrganisation,
} from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import { declaredRetentionClasses } from '../db/columns.js';
import { newId } from '../db/ids.js';
import { account, accountChart } from '../db/schema/index.js';
import {
  createMigratedDatabase,
  failureOf,
  SQLSTATE,
  testTargets,
} from '../db/test-support.js';

const checkViolation = (constraint: string) => ({
  code: SQLSTATE.checkViolation,
  constraint,
});
const fkViolation = (constraint: string) => ({
  code: SQLSTATE.foreignKeyViolation,
  constraint,
});
const uniqueViolation = (constraint: string) => ({
  code: SQLSTATE.uniqueViolation,
  constraint,
});

// Typed out by hand from the design, not taken from the schema, so a rule
// dropped from the schema is noticed here.
const LOWER_CASE_WORDS = ['custom', 'mmb', 'showbiz-2', '0', '9-lives', 'a'];
const NOT_LOWER_CASE_WORDS = [
  '',
  'Custom',
  'CHART',
  '-custom',
  'my_chart',
  'my chart',
  'chart!',
  'chart.',
  ' chart',
  'chart ',
  // A trailing line break must not slip past the end anchor.
  'chart\n',
];

describe('the retention class the accounts tables declare', () => {
  it('is financial-record on both, so a chart outlives the cost lines that use it', () => {
    expect(declaredRetentionClasses().get('account_chart')).toBe(
      'financial-record',
    );
    expect(declaredRetentionClasses().get('account')).toBe('financial-record');
  });
});

describe.each(testTargets)('the accounts tables on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  let a: SeedOrganisation;
  let b: SeedOrganisation;
  const db = () => database.db;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    a = await seedOrganisation(database);
    b = await seedOrganisation(database);
  });
  afterAll(async () => {
    await cleanup();
  });

  let counter = 0;
  const next = () => (counter += 1);

  const chartValues = (
    organisationId: string,
    overrides: Partial<typeof accountChart.$inferInsert> = {},
  ) =>
    ({
      ...base(organisationId),
      key: `chart-${next()}`,
      name: 'Standard chart',
      ...overrides,
    }) satisfies typeof accountChart.$inferInsert;

  const insertChart = async (
    organisationId: string,
    overrides: Partial<typeof accountChart.$inferInsert> = {},
  ) => {
    const [row] = await db()
      .insert(accountChart)
      .values(chartValues(organisationId, overrides))
      .returning();
    return row!;
  };

  const accountValues = (
    organisationId: string,
    chartId: string,
    overrides: Partial<typeof account.$inferInsert> = {},
  ) =>
    ({
      ...base(organisationId),
      chartId,
      code: `${1000 + next()}`,
      name: 'Camera',
      ...overrides,
    }) satisfies typeof account.$inferInsert;

  const insertAccount = async (
    organisationId: string,
    chartId: string,
    overrides: Partial<typeof account.$inferInsert> = {},
  ) => {
    const [row] = await db()
      .insert(account)
      .values(accountValues(organisationId, chartId, overrides))
      .returning();
    return row!;
  };

  const remove = (table: typeof accountChart | typeof account, id: string) =>
    db().update(table).set({ deletedAt: new Date() }).where(eq(table.id, id));

  /** The columns of a unique constraint, by name. */
  const uniqueColumns = async (relation: string, name: string) => {
    const result = (await db().execute(
      sql`select a.attname
          from pg_constraint c
          join pg_attribute a
            on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
          where c.contype = 'u'
            and c.conrelid = ${sql.raw(`'${relation}'::regclass`)}
            and c.conname = ${name}
          order by a.attname`,
    )) as { rows: { attname: string }[] };
    return result.rows.map((row) => row.attname);
  };

  describe('account_chart', () => {
    it('defaults to project visibility and the financial-record retention class, as a custom chart that is not the default and is not a copy', async () => {
      const row = await insertChart(a.organisationId);
      expect(row).toMatchObject({
        visibility: 'project',
        retentionClass: 'financial-record',
        projectId: null,
        format: 'custom',
        isDefault: false,
        copiedFromChartId: null,
      });
    });

    it('accepts a project of the same organisation, and rejects one of another organisation', async () => {
      const row = await insertChart(a.organisationId, {
        projectId: a.projectId,
      });
      expect(row.projectId).toBe(a.projectId);
      expect(
        await failureOf(() =>
          db()
            .insert(accountChart)
            .values(chartValues(a.organisationId, { projectId: b.projectId })),
        ),
      ).toEqual(fkViolation('account_chart_project_fk'));
    });

    it('rejects an organisation that does not exist', async () => {
      expect(
        await failureOf(() =>
          db().insert(accountChart).values(chartValues(newId())),
        ),
      ).toEqual(fkViolation('account_chart_organisation_fk'));
    });

    describe('the format', () => {
      it.each(LOWER_CASE_WORDS)('accepts %j', async (format) => {
        const row = await insertChart(a.organisationId, { format });
        expect(row.format).toBe(format);
      });

      it.each(NOT_LOWER_CASE_WORDS)('rejects %j', async (format) => {
        expect(
          await failureOf(() =>
            db()
              .insert(accountChart)
              .values(chartValues(a.organisationId, { format })),
          ),
        ).toEqual(checkViolation('account_chart_format_check'));
      });
    });

    describe('the key', () => {
      it.each(LOWER_CASE_WORDS)('accepts %j', async (key) => {
        // A fresh organisation, so a key used by an earlier case cannot clash.
        const org = await seedOrganisation(database);
        const row = await insertChart(org.organisationId, { key });
        expect(row.key).toBe(key);
      });

      it.each(NOT_LOWER_CASE_WORDS)('rejects %j', async (key) => {
        expect(
          await failureOf(() =>
            db()
              .insert(accountChart)
              .values(chartValues(a.organisationId, { key })),
          ),
        ).toEqual(checkViolation('account_chart_key_check'));
      });
    });

    describe('live keys, unique per scope', () => {
      const DUPLICATE = uniqueViolation(
        'account_chart_organisation_project_key_unique',
      );

      // A template has a NULL project, and a plain unique index treats two NULLs
      // as different, so this is the case that needs NULLS NOT DISTINCT.
      it('rejects a second live key among the organisation templates', async () => {
        const org = await seedOrganisation(database);
        await insertChart(org.organisationId, { key: 'house' });
        expect(
          await failureOf(() =>
            db()
              .insert(accountChart)
              .values(chartValues(org.organisationId, { key: 'house' })),
          ),
        ).toEqual(DUPLICATE);
      });

      it('rejects a second live key in one project', async () => {
        const org = await seedOrganisation(database);
        const inProject = { key: 'house', projectId: org.projectId };
        await insertChart(org.organisationId, inProject);
        expect(
          await failureOf(() =>
            db()
              .insert(accountChart)
              .values(chartValues(org.organisationId, inProject)),
          ),
        ).toEqual(DUPLICATE);
      });

      it('allows the same key as a template, in each project, and in another organisation', async () => {
        const org = await seedOrganisation(database);
        const second = await seedProject(database, org.organisationId);
        await insertChart(org.organisationId, { key: 'house' });
        await insertChart(org.organisationId, {
          key: 'house',
          projectId: org.projectId,
        });
        await insertChart(org.organisationId, {
          key: 'house',
          projectId: second,
        });
        const other = await seedOrganisation(database);
        await insertChart(other.organisationId, { key: 'house' });
      });

      it('lets a removed chart’s key be used again, in both scopes', async () => {
        const org = await seedOrganisation(database);
        for (const projectId of [null, org.projectId]) {
          const first = await insertChart(org.organisationId, {
            key: 'retired',
            projectId,
          });
          await remove(accountChart, first.id);
          const second = await insertChart(org.organisationId, {
            key: 'retired',
            projectId,
          });
          expect(second.id).not.toBe(first.id);
        }
      });
    });

    describe('one live default per scope', () => {
      const SECOND_DEFAULT = uniqueViolation('account_chart_default_unique');

      it('rejects two live defaults among the organisation templates', async () => {
        const org = await seedOrganisation(database);
        await insertChart(org.organisationId, { isDefault: true });
        expect(
          await failureOf(() =>
            db()
              .insert(accountChart)
              .values(chartValues(org.organisationId, { isDefault: true })),
          ),
        ).toEqual(SECOND_DEFAULT);
      });

      it('rejects two live defaults in one project', async () => {
        const org = await seedOrganisation(database);
        const inProject = { projectId: org.projectId, isDefault: true };
        await insertChart(org.organisationId, inProject);
        expect(
          await failureOf(() =>
            db()
              .insert(accountChart)
              .values(chartValues(org.organisationId, inProject)),
          ),
        ).toEqual(SECOND_DEFAULT);
      });

      it('rejects turning a second chart into a default', async () => {
        const org = await seedOrganisation(database);
        await insertChart(org.organisationId, { isDefault: true });
        const other = await insertChart(org.organisationId);
        expect(
          await failureOf(() =>
            db()
              .update(accountChart)
              .set({ isDefault: true })
              .where(eq(accountChart.id, other.id)),
          ),
        ).toEqual(SECOND_DEFAULT);
      });

      it('lets the organisation templates and each project have a default of their own', async () => {
        const org = await seedOrganisation(database);
        const second = await seedProject(database, org.organisationId);
        await insertChart(org.organisationId, { isDefault: true });
        await insertChart(org.organisationId, {
          projectId: org.projectId,
          isDefault: true,
        });
        await insertChart(org.organisationId, {
          projectId: second,
          isDefault: true,
        });
        const other = await seedOrganisation(database);
        await insertChart(other.organisationId, { isDefault: true });
      });

      it('allows any number of charts that are not the default', async () => {
        const org = await seedOrganisation(database);
        await insertChart(org.organisationId, { isDefault: true });
        await insertChart(org.organisationId);
        await insertChart(org.organisationId);
      });

      it('frees the place when the default chart is removed', async () => {
        const org = await seedOrganisation(database);
        for (const projectId of [null, org.projectId]) {
          const first = await insertChart(org.organisationId, {
            projectId,
            isDefault: true,
          });
          await remove(accountChart, first.id);
          await insertChart(org.organisationId, { projectId, isDefault: true });
        }
      });
    });

    describe('the chart a copy came from', () => {
      it('accepts a chart of the same organisation', async () => {
        const template = await insertChart(a.organisationId);
        const copy = await insertChart(a.organisationId, {
          projectId: a.projectId,
          copiedFromChartId: template.id,
        });
        expect(copy.copiedFromChartId).toBe(template.id);
      });

      it('rejects a chart of another organisation, and one that does not exist', async () => {
        const bTemplate = await insertChart(b.organisationId);
        for (const copiedFromChartId of [bTemplate.id, newId()]) {
          expect(
            await failureOf(() =>
              db()
                .insert(accountChart)
                .values(chartValues(a.organisationId, { copiedFromChartId })),
            ),
          ).toEqual(fkViolation('account_chart_copied_from_chart_fk'));
        }
      });
    });

    it('is the target of composite tenant keys: (organisation_id, id) is unique', async () => {
      expect(
        await uniqueColumns(
          'account_chart',
          'account_chart_organisation_id_id_unique',
        ),
      ).toEqual(['id', 'organisation_id']);
    });
  });

  describe('account', () => {
    it('defaults to project visibility and the financial-record retention class, postable, with no parent or ledger code, in sort position 0', async () => {
      const chart = await insertChart(a.organisationId);
      const row = await insertAccount(a.organisationId, chart.id);
      expect(row).toMatchObject({
        visibility: 'project',
        retentionClass: 'financial-record',
        parentId: null,
        isPostable: true,
        glCode: null,
        sortOrder: 0,
      });
    });

    describe('the chart', () => {
      it('rejects a chart of another organisation, and one that does not exist', async () => {
        const bChart = await insertChart(b.organisationId);
        for (const chartId of [bChart.id, newId()]) {
          expect(
            await failureOf(() =>
              db()
                .insert(account)
                .values(accountValues(a.organisationId, chartId)),
            ),
          ).toEqual(fkViolation('account_account_chart_fk'));
        }
      });

      it('rejects an organisation that does not exist', async () => {
        const chart = await insertChart(a.organisationId);
        expect(
          await failureOf(() =>
            db().insert(account).values(accountValues(newId(), chart.id)),
          ),
        ).toEqual(fkViolation('account_organisation_fk'));
      });
    });

    describe('the code', () => {
      it('rejects an empty code, and accepts any other text', async () => {
        const chart = await insertChart(a.organisationId);
        expect(
          await failureOf(() =>
            db()
              .insert(account)
              .values(accountValues(a.organisationId, chart.id, { code: '' })),
          ),
        ).toEqual(checkViolation('account_code_check'));
        for (const code of [' ', '0', '10-A', 'Above the line']) {
          await insertAccount(a.organisationId, chart.id, { code });
        }
      });

      it('rejects a second live account with the code in one chart', async () => {
        const chart = await insertChart(a.organisationId);
        await insertAccount(a.organisationId, chart.id, { code: '1100' });
        expect(
          await failureOf(() =>
            db()
              .insert(account)
              .values(
                accountValues(a.organisationId, chart.id, { code: '1100' }),
              ),
          ),
        ).toEqual(uniqueViolation('account_chart_id_code_unique'));
      });

      it('allows the code in another chart, also of another organisation', async () => {
        const first = await insertChart(a.organisationId);
        const second = await insertChart(a.organisationId);
        const other = await insertChart(b.organisationId);
        await insertAccount(a.organisationId, first.id, { code: '1100' });
        await insertAccount(a.organisationId, second.id, { code: '1100' });
        await insertAccount(b.organisationId, other.id, { code: '1100' });
      });

      it('lets a removed account’s code be used again, and keeps the removed row', async () => {
        const chart = await insertChart(a.organisationId);
        const first = await insertAccount(a.organisationId, chart.id, {
          code: '1100',
        });
        await remove(account, first.id);
        const second = await insertAccount(a.organisationId, chart.id, {
          code: '1100',
        });
        expect(second.id).not.toBe(first.id);
        const found = await db()
          .select({ id: account.id })
          .from(account)
          .where(eq(account.chartId, chart.id));
        expect(found).toHaveLength(2);
      });
    });

    describe('the parent', () => {
      it('accepts a parent in the same chart, and none', async () => {
        const chart = await insertChart(a.organisationId);
        const parent = await insertAccount(a.organisationId, chart.id);
        const child = await insertAccount(a.organisationId, chart.id, {
          parentId: parent.id,
        });
        expect(child.parentId).toBe(parent.id);
        expect(parent.parentId).toBeNull();
      });

      it('rejects a parent in another chart of the same organisation', async () => {
        const first = await insertChart(a.organisationId);
        const second = await insertChart(a.organisationId);
        const parent = await insertAccount(a.organisationId, first.id);
        expect(
          await failureOf(() =>
            db()
              .insert(account)
              .values(
                accountValues(a.organisationId, second.id, {
                  parentId: parent.id,
                }),
              ),
          ),
        ).toEqual(fkViolation('account_parent_fk'));
      });

      it('rejects moving an account under a parent of another chart', async () => {
        const first = await insertChart(a.organisationId);
        const second = await insertChart(a.organisationId);
        const parent = await insertAccount(a.organisationId, first.id);
        const child = await insertAccount(a.organisationId, second.id);
        expect(
          await failureOf(() =>
            db()
              .update(account)
              .set({ parentId: parent.id })
              .where(eq(account.id, child.id)),
          ),
        ).toEqual(fkViolation('account_parent_fk'));
      });

      it('rejects a parent in another organisation, and one that does not exist', async () => {
        const chart = await insertChart(a.organisationId);
        const bChart = await insertChart(b.organisationId);
        const bParent = await insertAccount(b.organisationId, bChart.id);
        for (const parentId of [bParent.id, newId()]) {
          expect(
            await failureOf(() =>
              db()
                .insert(account)
                .values(
                  accountValues(a.organisationId, chart.id, { parentId }),
                ),
            ),
          ).toEqual(fkViolation('account_parent_fk'));
        }
      });

      it('rejects an account that is its own parent, on insert and on update', async () => {
        const chart = await insertChart(a.organisationId);
        const id = newId();
        expect(
          await failureOf(() =>
            db()
              .insert(account)
              .values(
                accountValues(a.organisationId, chart.id, {
                  id,
                  parentId: id,
                }),
              ),
          ),
        ).toEqual(checkViolation('account_parent_not_self_check'));
        const row = await insertAccount(a.organisationId, chart.id);
        expect(
          await failureOf(() =>
            db()
              .update(account)
              .set({ parentId: row.id })
              .where(eq(account.id, row.id)),
          ),
        ).toEqual(checkViolation('account_parent_not_self_check'));
      });
    });

    it('is the target of the parent key: (organisation_id, chart_id, id) is unique', async () => {
      expect(
        await uniqueColumns(
          'account',
          'account_organisation_id_chart_id_id_unique',
        ),
      ).toEqual(['chart_id', 'id', 'organisation_id']);
    });
  });
});
