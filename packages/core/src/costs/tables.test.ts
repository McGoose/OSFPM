import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  seedCompany,
  seedEpisode,
  seedOrganisation,
  seedPerson,
  seedProject,
  seedUnit,
  seedUser,
  type SeedOrganisation,
} from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import { declaredRetentionClasses } from '../db/columns.js';
import { newId } from '../db/ids.js';
import { costLine, costLineScheme } from '../db/schema/index.js';
import {
  createMigratedDatabase,
  failureOf,
  SQLSTATE,
  testTargets,
} from '../db/test-support.js';
import {
  costLineValues,
  schemeValues,
  seedAccount,
  seedChart,
  seedCostLine,
} from './test-fixtures.js';

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
const STAGES = ['budget', 'committed', 'actual'];
const SOURCE_TYPES = [
  'budget',
  'purchase-order',
  'invoice',
  'expense',
  'timesheet',
  'other',
];
const PHASES = [
  'development',
  'pre-production',
  'principal-photography',
  'post-production',
  'delivery',
  'distribution',
];
const SCHEME_STATUSES = ['qualifying', 'non-qualifying', 'pending', 'excluded'];

describe('the retention class the cost tables declare', () => {
  it('is financial-record on both, so a line is kept as long as the accounts it is booked to', () => {
    expect(declaredRetentionClasses().get('cost_line')).toBe(
      'financial-record',
    );
    expect(declaredRetentionClasses().get('cost_line_scheme')).toBe(
      'financial-record',
    );
  });
});

describe.each(testTargets)('the cost tables on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  let a: SeedOrganisation & { accountId: string };
  let b: SeedOrganisation & { accountId: string };
  const db = () => database.db;

  async function seedWorld(): Promise<
    SeedOrganisation & { accountId: string }
  > {
    const org = await seedOrganisation(database);
    const chartId = await seedChart(database, org.organisationId, {
      projectId: org.projectId,
    });
    return {
      ...org,
      accountId: await seedAccount(database, org.organisationId, chartId),
    };
  }

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    a = await seedWorld();
    b = await seedWorld();
  });
  afterAll(async () => {
    await cleanup();
  });

  const lineValues = (
    overrides: Partial<typeof costLine.$inferInsert> = {},
    world = a,
  ) =>
    costLineValues(
      world.organisationId,
      world.projectId,
      world.accountId,
      overrides,
    );

  const insertLine = async (
    overrides: Partial<typeof costLine.$inferInsert> = {},
    world = a,
  ) => {
    const [row] = await db()
      .insert(costLine)
      .values(lineValues(overrides, world))
      .returning();
    return row!;
  };

  const lineFailure = (
    overrides: Partial<typeof costLine.$inferInsert>,
    world = a,
  ) =>
    failureOf(() => db().insert(costLine).values(lineValues(overrides, world)));

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

  describe('cost_line', () => {
    it('defaults to private visibility and the financial-record retention class', async () => {
      const row = await insertLine();
      expect(row).toMatchObject({
        visibility: 'private',
        retentionClass: 'financial-record',
        version: 1,
        sourceId: null,
        payeeCompanyId: null,
        payeePersonId: null,
        costDate: null,
        fxRate: null,
        unitId: null,
        episodeId: null,
        deletedAt: null,
      });
    });

    it('rejects an organisation that does not exist', async () => {
      expect(
        await failureOf(() =>
          db()
            .insert(costLine)
            .values(costLineValues(newId(), a.projectId, a.accountId)),
        ),
      ).toEqual(fkViolation('cost_line_organisation_fk'));
    });

    it('rejects an unknown visibility', async () => {
      expect(await lineFailure({ visibility: 'public' as never })).toEqual(
        checkViolation('cost_line_visibility_check'),
      );
    });

    describe('the enumerations', () => {
      it.each(STAGES)('accepts the stage %j', async (stage) => {
        expect((await insertLine({ stage: stage as never })).stage).toBe(stage);
      });
      it.each(['Budget', 'plan', ''])('rejects the stage %j', async (stage) => {
        expect(await lineFailure({ stage: stage as never })).toEqual(
          checkViolation('cost_line_stage_check'),
        );
      });

      it.each(SOURCE_TYPES)('accepts the source type %j', async (type) => {
        const row = await insertLine({
          sourceType: type as never,
          sourceId: newId(),
        });
        expect(row.sourceType).toBe(type);
      });
      it.each(['bill', 'Invoice', ''])(
        'rejects the source type %j',
        async (type) => {
          expect(
            await lineFailure({
              sourceType: type as never,
              sourceId: newId(),
            }),
          ).toEqual(checkViolation('cost_line_source_type_check'));
        },
      );

      it.each(PHASES)('accepts the production phase %j', async (phase) => {
        const row = await insertLine({ productionPhase: phase as never });
        expect(row.productionPhase).toBe(phase);
      });
      it.each(['shooting', 'Delivery', ''])(
        'rejects the production phase %j',
        async (phase) => {
          expect(
            await lineFailure({ productionPhase: phase as never }),
          ).toEqual(checkViolation('cost_line_production_phase_check'));
        },
      );
    });

    describe('the source', () => {
      it('needs a source id unless the source type is other', async () => {
        await insertLine({ sourceType: 'other', sourceId: null });
        await insertLine({ sourceType: 'other', sourceId: newId() });
        await insertLine({ sourceType: 'invoice', sourceId: newId() });
        for (const type of SOURCE_TYPES.filter((t) => t !== 'other')) {
          expect(
            await lineFailure({ sourceType: type as never, sourceId: null }),
            type,
          ).toEqual(checkViolation('cost_line_source_id_check'));
        }
      });
    });

    describe('the territory', () => {
      it.each(['GB', 'FR', 'WW', 'US'])('accepts %j', async (territory) => {
        expect((await insertLine({ territory })).territory).toBe(territory);
      });
      it.each(['gb', 'Gb', 'GBR', 'G', 'G1', '', ' GB', 'GB\n'])(
        'rejects %j',
        async (territory) => {
          expect(await lineFailure({ territory })).toEqual(
            checkViolation('cost_line_territory_check'),
          );
        },
      );
    });

    describe('the currency', () => {
      it.each(['GBP', 'EUR', 'USD'])('accepts %j', async (currency) => {
        const row = await insertLine({ currency, fxRate: '1.2500000000' });
        expect(row.currency).toBe(currency);
      });
      it.each(['gbp', 'GB', 'GBPP', 'G1P', '', 'GBP\n'])(
        'rejects %j',
        async (currency) => {
          expect(await lineFailure({ currency })).toEqual(
            checkViolation('cost_line_currency_check'),
          );
        },
      );
    });

    describe('the exchange rate', () => {
      it.each(['1.2650000000', '0.0000000001', '999999999.9999999999'])(
        'accepts %j',
        async (fxRate) => {
          const row = await insertLine({ currency: 'USD', fxRate });
          expect(row.fxRate).toBe(fxRate);
        },
      );
      it.each(['0', '0.0000000000', '-1', '-0.0000000001'])(
        'rejects %j',
        async (fxRate) => {
          expect(await lineFailure({ currency: 'USD', fxRate })).toEqual(
            checkViolation('cost_line_fx_rate_check'),
          );
        },
      );
    });

    describe('the payee', () => {
      it('allows no payee, a person, or a company, but not both', async () => {
        const personId = await seedPerson(database, a.organisationId);
        const companyId = await seedCompany(database, a.organisationId);
        await insertLine();
        expect(
          (await insertLine({ payeePersonId: personId })).payeePersonId,
        ).toBe(personId);
        expect(
          (await insertLine({ payeeCompanyId: companyId })).payeeCompanyId,
        ).toBe(companyId);
        expect(
          await lineFailure({
            payeePersonId: personId,
            payeeCompanyId: companyId,
          }),
        ).toEqual(checkViolation('cost_line_one_payee_check'));
      });

      it('rejects pointing a stored line at a second payee', async () => {
        const personId = await seedPerson(database, a.organisationId);
        const companyId = await seedCompany(database, a.organisationId);
        const row = await insertLine({ payeePersonId: personId });
        expect(
          await failureOf(() =>
            db()
              .update(costLine)
              .set({ payeeCompanyId: companyId })
              .where(eq(costLine.id, row.id)),
          ),
        ).toEqual(checkViolation('cost_line_one_payee_check'));
      });
    });

    describe('the description', () => {
      it('is required and not empty', async () => {
        expect(await lineFailure({ description: '' })).toEqual(
          checkViolation('cost_line_description_check'),
        );
        expect(
          await failureOf(() =>
            db()
              .insert(costLine)
              .values({ ...lineValues(), description: null as never }),
          ),
        ).toEqual({ code: '23502', constraint: undefined });
      });
    });

    describe('the amounts', () => {
      it('keeps four places exactly, with no float drift, and allows negative amounts', async () => {
        const row = await insertLine({
          amount: '123456789012345.6789',
          amountProjectCurrency: '-0.0001',
        });
        expect(row.amount).toBe('123456789012345.6789');
        expect(row.amountProjectCurrency).toBe('-0.0001');
        const credit = await insertLine({ amount: '-250.5000' });
        expect(credit.amount).toBe('-250.5000');
      });

      it('keeps ten places of the rate exactly', async () => {
        const row = await insertLine({
          currency: 'USD',
          fxRate: '0.1234567891',
        });
        expect(row.fxRate).toBe('0.1234567891');
      });

      it('requires both amounts, and the currency', async () => {
        for (const key of ['amount', 'amountProjectCurrency', 'currency']) {
          const values = { ...lineValues(), [key]: null };
          expect(
            await failureOf(() =>
              db()
                .insert(costLine)
                .values(values as never),
            ),
            key,
          ).toEqual({ code: '23502', constraint: undefined });
        }
      });
    });

    describe('references', () => {
      it('rejects a project of another organisation', async () => {
        expect(
          await failureOf(() =>
            db()
              .insert(costLine)
              .values(lineValues({ projectId: b.projectId })),
          ),
        ).toEqual(fkViolation('cost_line_project_fk'));
      });

      it('rejects an account that does not exist, and one of another organisation', async () => {
        expect(await lineFailure({ accountId: newId() })).toEqual(
          fkViolation('cost_line_account_fk'),
        );
        expect(await lineFailure({ accountId: b.accountId })).toEqual(
          fkViolation('cost_line_account_fk'),
        );
      });

      it('rejects a payee person or company of another organisation, or that does not exist', async () => {
        const otherPerson = await seedPerson(database, b.organisationId);
        const otherCompany = await seedCompany(database, b.organisationId);
        expect(await lineFailure({ payeePersonId: otherPerson })).toEqual(
          fkViolation('cost_line_person_fk'),
        );
        expect(await lineFailure({ payeePersonId: newId() })).toEqual(
          fkViolation('cost_line_person_fk'),
        );
        expect(await lineFailure({ payeeCompanyId: otherCompany })).toEqual(
          fkViolation('cost_line_company_fk'),
        );
        expect(await lineFailure({ payeeCompanyId: newId() })).toEqual(
          fkViolation('cost_line_company_fk'),
        );
      });

      it('accepts a unit and an episode of the same project', async () => {
        const unitId = await seedUnit(
          database,
          a.organisationId,
          a.projectId,
          'second-camera',
        );
        const episodeId = await seedEpisode(
          database,
          a.organisationId,
          a.projectId,
          '101',
        );
        const row = await insertLine({ unitId, episodeId });
        expect(row).toMatchObject({ unitId, episodeId });
      });

      it('rejects a unit or episode of another project of the same organisation', async () => {
        const otherProject = await seedProject(database, a.organisationId);
        const unitId = await seedUnit(
          database,
          a.organisationId,
          otherProject,
          'other-unit',
        );
        const episodeId = await seedEpisode(
          database,
          a.organisationId,
          otherProject,
          '201',
        );
        expect(await lineFailure({ unitId })).toEqual(
          fkViolation('cost_line_unit_fk'),
        );
        expect(await lineFailure({ episodeId })).toEqual(
          fkViolation('cost_line_episode_fk'),
        );
      });

      it('rejects a unit or episode of another organisation, or that does not exist', async () => {
        const unitId = await seedUnit(
          database,
          b.organisationId,
          b.projectId,
          'b-unit',
        );
        const episodeId = await seedEpisode(
          database,
          b.organisationId,
          b.projectId,
          '301',
        );
        expect(await lineFailure({ unitId })).toEqual(
          fkViolation('cost_line_unit_fk'),
        );
        expect(await lineFailure({ unitId: newId() })).toEqual(
          fkViolation('cost_line_unit_fk'),
        );
        expect(await lineFailure({ episodeId })).toEqual(
          fkViolation('cost_line_episode_fk'),
        );
        expect(await lineFailure({ episodeId: newId() })).toEqual(
          fkViolation('cost_line_episode_fk'),
        );
      });

      it('has the unique keys the composite foreign keys point at', async () => {
        expect(
          await uniqueColumns(
            'cost_line',
            'cost_line_organisation_id_id_unique',
          ),
        ).toEqual(['id', 'organisation_id']);
        expect(
          await uniqueColumns('account', 'account_organisation_id_id_unique'),
        ).toEqual(['id', 'organisation_id']);
        expect(
          await uniqueColumns('unit', 'unit_organisation_project_id_unique'),
        ).toEqual(['id', 'organisation_id', 'project_id']);
        expect(
          await uniqueColumns(
            'episode',
            'episode_organisation_project_id_unique',
          ),
        ).toEqual(['id', 'organisation_id', 'project_id']);
      });
    });
  });

  describe('cost_line_scheme', () => {
    let line: typeof costLine.$inferSelect;
    let userId: string;
    beforeAll(async () => {
      line = await seedCostLine(
        database,
        a.organisationId,
        a.projectId,
        a.accountId,
      );
      userId = await seedUser(database);
    });

    const insertTag = async (
      overrides: Partial<typeof costLineScheme.$inferInsert> = {},
      costLineId = line.id,
      organisationId = a.organisationId,
    ) => {
      const [row] = await db()
        .insert(costLineScheme)
        .values(schemeValues(organisationId, costLineId, overrides))
        .returning();
      return row!;
    };
    const tagFailure = (
      overrides: Partial<typeof costLineScheme.$inferInsert>,
      costLineId = line.id,
      organisationId = a.organisationId,
    ) =>
      failureOf(() =>
        db()
          .insert(costLineScheme)
          .values(schemeValues(organisationId, costLineId, overrides)),
      );

    // A line of its own, so a key used by one case cannot clash with another.
    const freshLine = () =>
      seedCostLine(database, a.organisationId, a.projectId, a.accountId);

    it('defaults to private visibility and the financial-record retention class', async () => {
      const row = await insertTag({ schemeKey: 'defaults' });
      expect(row).toMatchObject({
        visibility: 'private',
        retentionClass: 'financial-record',
        qualifyingAmount: null,
        reason: null,
        decidedBy: null,
        decidedAt: null,
      });
    });

    it('rejects a cost line of another organisation, and one that does not exist', async () => {
      const other = await seedCostLine(
        database,
        b.organisationId,
        b.projectId,
        b.accountId,
      );
      expect(await tagFailure({}, other.id)).toEqual(
        fkViolation('cost_line_scheme_cost_line_fk'),
      );
      expect(await tagFailure({}, newId())).toEqual(
        fkViolation('cost_line_scheme_cost_line_fk'),
      );
    });

    it('rejects an organisation that does not exist', async () => {
      expect(await tagFailure({}, line.id, newId())).toEqual(
        fkViolation('cost_line_scheme_organisation_fk'),
      );
    });

    describe('the scheme key', () => {
      it.each([
        'uk-hetv',
        'a',
        '0',
        'fr.credit-2',
        'eu.co-pro.2026',
        '9-lives',
      ])('accepts %j', async (schemeKey) => {
        const own = await freshLine();
        expect((await insertTag({ schemeKey }, own.id)).schemeKey).toBe(
          schemeKey,
        );
      });
      it.each([
        '',
        'UK',
        'Uk-hetv',
        '-uk',
        '.uk',
        'uk hetv',
        'uk_hetv',
        'uk!',
        'uk\n',
      ])('rejects %j', async (schemeKey) => {
        expect(await tagFailure({ schemeKey })).toEqual(
          checkViolation('cost_line_scheme_scheme_key_check'),
        );
      });
    });

    describe('the status', () => {
      it.each(SCHEME_STATUSES)('accepts %j', async (status) => {
        const own = await freshLine();
        expect(
          (await insertTag({ status: status as never }, own.id)).status,
        ).toBe(status);
      });
      it.each(['Qualifying', 'maybe', ''])('rejects %j', async (status) => {
        expect(await tagFailure({ status: status as never })).toEqual(
          checkViolation('cost_line_scheme_status_check'),
        );
      });
    });

    describe('the qualifying amount', () => {
      it('is allowed only on a qualifying tag', async () => {
        const own = await freshLine();
        const row = await insertTag(
          { status: 'qualifying', qualifyingAmount: '400.0000' },
          own.id,
        );
        expect(row.qualifyingAmount).toBe('400.0000');
        for (const status of ['non-qualifying', 'pending', 'excluded']) {
          expect(
            await tagFailure(
              {
                schemeKey: `amount-${status}`,
                status: status as never,
                qualifyingAmount: '1.0000',
              },
              own.id,
            ),
            status,
          ).toEqual(checkViolation('cost_line_scheme_qualifying_amount_check'));
        }
      });

      it('may be left empty on any status', async () => {
        const own = await freshLine();
        for (const status of SCHEME_STATUSES) {
          await insertTag(
            { schemeKey: `empty-${status}`, status: status as never },
            own.id,
          );
        }
      });

      it('rejects turning a stored non-qualifying tag into one with an amount', async () => {
        const own = await freshLine();
        const row = await insertTag({ status: 'pending' }, own.id);
        expect(
          await failureOf(() =>
            db()
              .update(costLineScheme)
              .set({ qualifyingAmount: '5.0000' })
              .where(eq(costLineScheme.id, row.id)),
          ),
        ).toEqual(checkViolation('cost_line_scheme_qualifying_amount_check'));
      });
    });

    describe('who decided, and when', () => {
      it('has both or neither', async () => {
        const own = await freshLine();
        const decidedAt = new Date(Date.UTC(2026, 1, 1, 12));
        const both = await insertTag(
          { schemeKey: 'both', decidedBy: userId, decidedAt },
          own.id,
        );
        expect(both.decidedBy).toBe(userId);
        expect(both.decidedAt).toEqual(decidedAt);
        await insertTag({ schemeKey: 'neither' }, own.id);
        expect(
          await tagFailure({ schemeKey: 'by-only', decidedBy: userId }, own.id),
        ).toEqual(checkViolation('cost_line_scheme_decided_check'));
        expect(
          await tagFailure({ schemeKey: 'at-only', decidedAt }, own.id),
        ).toEqual(checkViolation('cost_line_scheme_decided_check'));
      });

      it('rejects a deciding user that does not exist', async () => {
        const own = await freshLine();
        expect(
          await tagFailure(
            { decidedBy: newId(), decidedAt: new Date() },
            own.id,
          ),
        ).toEqual(fkViolation('cost_line_scheme_user_fk'));
      });
    });

    describe('live keys, unique per line', () => {
      const DUPLICATE = uniqueViolation(
        'cost_line_scheme_cost_line_key_unique',
      );

      it('rejects a second live tag for the same scheme on one line', async () => {
        const own = await freshLine();
        await insertTag({ schemeKey: 'dup' }, own.id);
        expect(await tagFailure({ schemeKey: 'dup' }, own.id)).toEqual(
          DUPLICATE,
        );
      });

      it('allows the same scheme on another line, and another scheme on the same line', async () => {
        const first = await freshLine();
        const second = await freshLine();
        await insertTag({ schemeKey: 'shared' }, first.id);
        await insertTag({ schemeKey: 'shared' }, second.id);
        await insertTag({ schemeKey: 'other' }, first.id);
      });

      it('lets a removed tag free its key, and then allows only one live tag again', async () => {
        const own = await freshLine();
        const removed = await insertTag({ schemeKey: 'again' }, own.id);
        await db()
          .update(costLineScheme)
          .set({ deletedAt: new Date() })
          .where(eq(costLineScheme.id, removed.id));
        await insertTag({ schemeKey: 'again' }, own.id);
        expect(await tagFailure({ schemeKey: 'again' }, own.id)).toEqual(
          DUPLICATE,
        );
      });
    });
  });
});
