import { and, asc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessDeniedError } from '../access/access-denied-error.js';
import { syncPermissions } from '../access/permission-sync.js';
import {
  grantOnOrganisation,
  grantOnProject,
  ORIGIN,
  seedCompany,
  seedEpisode,
  seedOrganisation,
  seedPerson,
  seedProject,
  seedUnit,
  seedUser,
  type SeedOrganisation,
} from '../access/test-fixtures.js';
import { ACCOUNT_PERMISSIONS } from '../accounts/permissions.js';
import {
  AccountInUseError,
  removeAccount,
  removeChart,
  updateAccount,
  type AccountContext,
} from '../accounts/service.js';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import {
  account,
  accountChart,
  auditEvent,
  changeEvent,
  changeSeq,
  costLine,
  costLineScheme,
  person,
  unit,
} from '../db/schema/index.js';
import {
  createMigratedDatabase,
  SQLSTATE,
  testTargets,
} from '../db/test-support.js';
import {
  RecordStateError,
  RecordWriteError,
  VersionConflictError,
} from '../db/write.js';
import {
  COST_PERMISSIONS,
  COSTS_EDIT_PERMISSION,
  COSTS_READ_PERMISSION,
  COSTS_TAG_SCHEMES_PERMISSION,
} from './permissions.js';
import {
  CostLineInputError,
  createCostLine,
  getCostLine,
  listCostLines,
  removeCostLine,
  removeCostLineScheme,
  setCostLineScheme,
  updateCostLine,
  type CostContext,
  type CreateCostLineValues,
} from './service.js';
import { seedAccount, seedChart } from './test-fixtures.js';

// The permission keys are stored in role grants, so they are written out here
// instead of being taken from the constants under test.
const READ = 'costs:read';
const EDIT = 'costs:edit';
const TAG = 'costs:tag-schemes';

const NOW = new Date(Date.UTC(2026, 1, 1, 12));
const at = (userId: string): CostContext => ({
  userId,
  originServer: ORIGIN,
  clock: () => NOW,
});

/**
 * An independent reference for `round(amount * rate, 4)`, half away from zero,
 * in BigInt: no number, no float, and not the database's own arithmetic.
 */
function referenceProduct(amount: string, rate: string): string {
  const scaled = (value: string, places: number) => {
    const negative = value.startsWith('-');
    const [whole = '0', fraction = ''] = value.replace('-', '').split('.');
    const n = BigInt(whole + fraction.padEnd(places, '0'));
    return negative ? -n : n;
  };
  const product = scaled(amount, 4) * scaled(rate, 10); // ten places too many
  const divisor = 10n ** 10n;
  const magnitude = product < 0n ? -product : product;
  let rounded = magnitude / divisor;
  if ((magnitude % divisor) * 2n >= divisor) rounded += 1n;
  const digits = rounded.toString().padStart(5, '0');
  const sign = product < 0n && rounded !== 0n ? '-' : '';
  return `${sign}${digits.slice(0, -4)}.${digits.slice(-4)}`;
}

describe('the reference arithmetic the tests compare with', () => {
  it('rounds half away from zero, exactly', () => {
    expect(referenceProduct('0.0001', '0.5')).toBe('0.0001');
    expect(referenceProduct('-0.0001', '0.5')).toBe('-0.0001');
    expect(referenceProduct('0.0001', '0.4999999999')).toBe('0.0000');
    expect(referenceProduct('-0.0001', '0.4999999999')).toBe('0.0000');
    expect(referenceProduct('0.1', '3')).toBe('0.3000');
    expect(referenceProduct('250.5', '1.265')).toBe('316.8825');
  });
});

describe('cost permissions', () => {
  it('are the three keys of the costs module, and only reading grants sensitive data', () => {
    expect(
      [
        COSTS_READ_PERMISSION,
        COSTS_EDIT_PERMISSION,
        COSTS_TAG_SCHEMES_PERMISSION,
      ].sort(),
    ).toEqual([EDIT, READ, TAG].sort());
    expect(COST_PERMISSIONS.map((p) => p.key).sort()).toEqual(
      [EDIT, READ, TAG].sort(),
    );
    for (const p of COST_PERMISSIONS) {
      expect(p.module).toBe('costs');
      expect(p.grantsSensitive, p.key).toBe(p.key === READ);
    }
  });
});

describe.each(testTargets)('cost lines on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  const db = () => database.db;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    await syncPermissions(database.db, [
      ...ACCOUNT_PERMISSIONS,
      ...COST_PERMISSIONS,
    ]);
  });
  afterAll(async () => {
    await cleanup();
  });

  type World = SeedOrganisation & {
    chartId: string;
    /** A postable account of the project's chart. */
    accountId: string;
    /** Its parent: an account that is not postable. */
    headingId: string;
    otherProjectId: string;
    // On the project.
    manager: string; // read, edit, tag-schemes
    reader: string; // read
    editor: string; // edit only
    tagger: string; // tag-schemes only
    taggerReader: string; // tag-schemes and read
    accountsEditor: string; // accounts:edit
    // On another project of the same organisation.
    elsewhere: string; // read, edit, tag-schemes
    // In the organisation, with own-scope grants: nothing on a project.
    orgManager: string;
    outsider: string;
  };

  async function setup(): Promise<World> {
    const org = await seedOrganisation(database);
    const chartId = await seedChart(database, org.organisationId, {
      projectId: org.projectId,
      key: 'house',
    });
    const headingId = await seedAccount(database, org.organisationId, chartId, {
      code: '5000',
      isPostable: false,
    });
    const accountId = await seedAccount(database, org.organisationId, chartId, {
      code: '5100',
      parentId: headingId,
    });
    const otherProjectId = await seedProject(database, org.organisationId);
    const onProject = async (keys: string[], projectId = org.projectId) => {
      const userId = await seedUser(database);
      await grantOnProject(
        database,
        org.organisationId,
        projectId,
        userId,
        keys,
      );
      return userId;
    };
    const orgManager = await seedUser(database);
    await grantOnOrganisation(
      database,
      org.organisationId,
      orgManager,
      'owner',
      [READ, EDIT, TAG],
    );
    return {
      ...org,
      chartId,
      accountId,
      headingId,
      otherProjectId,
      manager: await onProject([READ, EDIT, TAG]),
      reader: await onProject([READ]),
      editor: await onProject([EDIT]),
      tagger: await onProject([TAG]),
      taggerReader: await onProject([TAG, READ]),
      accountsEditor: await onProject(['accounts:edit']),
      elsewhere: await onProject([READ, EDIT, TAG], otherProjectId),
      orgManager,
      outsider: await seedUser(database),
    };
  }

  const values = (
    w: World,
    overrides: Partial<CreateCostLineValues> = {},
  ): CreateCostLineValues => ({
    organisationId: w.organisationId,
    projectId: w.projectId,
    stage: 'budget',
    sourceType: 'other',
    accountId: w.accountId,
    description: 'Camera hire',
    territory: 'GB',
    productionPhase: 'principal-photography',
    amount: '1000.0000',
    currency: 'GBP',
    ...overrides,
  });

  const linesIn = (organisationId: string) =>
    db()
      .select()
      .from(costLine)
      .where(eq(costLine.organisationId, organisationId))
      .orderBy(asc(costLine.id));
  const tagsIn = (organisationId: string) =>
    db()
      .select()
      .from(costLineScheme)
      .where(eq(costLineScheme.organisationId, organisationId))
      .orderBy(asc(costLineScheme.id));
  const eventsIn = (organisationId: string) =>
    db()
      .select()
      .from(changeEvent)
      .where(
        and(
          eq(changeEvent.organisationId, organisationId),
          inArray(changeEvent.entityType, ['cost_line', 'cost_line_scheme']),
        ),
      )
      .orderBy(asc(changeEvent.seq));
  const sequencesIn = (organisationId: string) =>
    db()
      .select()
      .from(changeSeq)
      .where(eq(changeSeq.organisationId, organisationId))
      .orderBy(asc(changeSeq.projectId));
  const auditIn = (organisationId: string) =>
    db()
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.organisationId, organisationId));

  /**
   * Everything a call could write for the organisation: the rows, the change
   * events and the change counters. A refused call must leave this unchanged.
   */
  const snapshot = async (w: World) => ({
    lines: await linesIn(w.organisationId),
    tags: await tagsIn(w.organisationId),
    events: await eventsIn(w.organisationId),
    sequences: await sequencesIn(w.organisationId),
    audit: await auditIn(w.organisationId),
  });

  const create = (
    w: World,
    overrides: Partial<CreateCostLineValues> = {},
    userId = w.manager,
  ) => createCostLine(db(), at(userId), values(w, overrides));

  /** A cost line made by the manager. The manager reads, so the amounts are there. */
  const seeded = async (
    w: World,
    overrides: Partial<CreateCostLineValues> = {},
  ) => {
    const row = await create(w, overrides);
    return row as typeof row & {
      amount: string;
      amountProjectCurrency: string;
    };
  };

  const inputError = (promise: Promise<unknown>) =>
    expect(promise).rejects.toBeInstanceOf(CostLineInputError);

  describe('createCostLine', () => {
    it('stores a line in the project’s currency with the amount as the project amount and no rate', async () => {
      const w = await setup();
      const row = await create(w, {
        stage: 'committed',
        sourceType: 'invoice',
        sourceId: newId(),
        description: 'Camera hire, week 1',
        territory: 'WW',
        costDate: '2026-03-02',
        amount: '1250.5',
      });
      expect(row).toMatchObject({
        organisationId: w.organisationId,
        ownerOrgId: w.organisationId,
        projectId: w.projectId,
        accountId: w.accountId,
        stage: 'committed',
        sourceType: 'invoice',
        description: 'Camera hire, week 1',
        territory: 'WW',
        productionPhase: 'principal-photography',
        costDate: '2026-03-02',
        // Stored the way the database holds it, so 12.5 and 12.5000 are one value.
        amount: '1250.5000',
        currency: 'GBP',
        fxRate: null,
        amountProjectCurrency: '1250.5000',
        visibility: 'private',
        retentionClass: 'financial-record',
        version: 1,
        createdBy: w.manager,
        updatedBy: w.manager,
      });
      expect(await linesIn(w.organisationId)).toHaveLength(1);
    });

    it('has the database compute the project amount of a foreign-currency line', async () => {
      const w = await setup();
      const row = await create(w, {
        amount: '100',
        currency: 'USD',
        fxRate: '1.265',
      });
      expect(row).toMatchObject({
        amount: '100.0000',
        currency: 'USD',
        fxRate: '1.2650000000',
        amountProjectCurrency: '126.5000',
      });
    });

    describe('exact arithmetic', () => {
      // Hand-checked cases first: halves round away from zero, and the sums a
      // float gets wrong (0.1 * 3, 1.005 * 100) come out exact.
      const CASES: [amount: string, rate: string, expected: string][] = [
        ['0.0001', '0.5', '0.0001'],
        ['-0.0001', '0.5', '-0.0001'],
        ['0.0001', '0.4999999999', '0.0000'],
        ['-0.0001', '0.4999999999', '0.0000'],
        ['1.0001', '0.5', '0.5001'],
        ['-1.0001', '0.5', '-0.5001'],
        ['0.1', '3', '0.3000'],
        ['1.005', '100', '100.5000'],
        ['0.0001', '999999999.9999999999', '100000.0000'],
        ['999999999999999.9999', '1', '999999999999999.9999'],
        ['123456789012345.6789', '0.0000000001', '12345.6789'],
        ['-250.5', '1.265', '-316.8825'],
        ['0.0000', '1.5', '0.0000'],
      ];

      it.each(CASES)('%j at %j is %j', async (amount, rate, expected) => {
        expect(referenceProduct(amount, rate)).toBe(expected);
        const w = await setup();
        const row = (await create(w, {
          amount,
          currency: 'EUR',
          fxRate: rate,
        })) as { amountProjectCurrency: string };
        expect(row.amountProjectCurrency).toBe(expected);
      });

      it('matches the BigInt reference on a spread of awkward values', async () => {
        const w = await setup();
        // A fixed generator, so a failure reproduces.
        let state = 123456789n;
        const roll = (digits: number) => {
          state =
            (state * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n;
          return (state >> 16n).toString().padStart(digits, '0').slice(-digits);
        };
        for (let i = 0; i < 40; i += 1) {
          // Up to 9 digits times up to 4 stays well inside 15 digits.
          const amount = `${i % 3 === 0 ? '-' : ''}${roll(1 + (i % 9))}.${roll(4)}`;
          const rate = `${roll(1 + (i % 4))}.${roll(10)}`;
          if (!/[1-9]/.test(rate)) continue;
          const row = (await create(w, {
            amount,
            currency: 'EUR',
            fxRate: rate,
          })) as { amountProjectCurrency: string };
          expect(row.amountProjectCurrency, `${amount} x ${rate}`).toBe(
            referenceProduct(amount, rate),
          );
        }
      });

      it('refuses more places than the columns hold instead of rounding the input', async () => {
        const w = await setup();
        await inputError(create(w, { amount: '10.00001' }));
        await inputError(
          create(w, { amount: '10', currency: 'EUR', fxRate: '1.12345678901' }),
        );
      });
    });

    describe('amounts and rates', () => {
      it.each([
        '',
        '-',
        '.5',
        '5.',
        '1e3',
        '1,000',
        ' 100',
        '100 ',
        '100\n',
        '+5',
        '0x10',
        'NaN',
        'Infinity',
        '1234567890123456',
        '10.12345',
      ])('refuses the amount %j', async (amount) => {
        const w = await setup();
        const before = await snapshot(w);
        const failure = await create(w, { amount }).catch((e: unknown) => e);
        expect(failure).toBeInstanceOf(CostLineInputError);
        // An error never carries the amount it refused.
        if (amount.trim() !== '') {
          expect((failure as Error).message).not.toContain(amount.trim());
        }
        expect(await snapshot(w)).toEqual(before);
      });

      it('refuses a JavaScript number, because money is never a float', async () => {
        const w = await setup();
        await inputError(create(w, { amount: 100.5 as never }));
        await inputError(
          create(w, { amount: '10', currency: 'EUR', fxRate: 1.25 as never }),
        );
      });

      it.each(['0', '0.0', '-1', '1e2', '.5', '1.12345678901', '1234567890.5'])(
        'refuses the rate %j',
        async (fxRate) => {
          const w = await setup();
          await inputError(create(w, { currency: 'EUR', fxRate }));
        },
      );

      it('allows a negative amount, for a credit or a refund', async () => {
        const w = await setup();
        const row = await seeded(w, { amount: '-75.25' });
        expect(row.amount).toBe('-75.2500');
        expect(row.amountProjectCurrency).toBe('-75.2500');
      });
    });

    describe('the project currency', () => {
      it('refuses a rate on a line in the project’s currency, even a rate of 1', async () => {
        const w = await setup();
        const before = await snapshot(w);
        await inputError(create(w, { currency: 'GBP', fxRate: '1' }));
        await inputError(
          create(w, { currency: 'GBP', fxRate: '1.0000000000' }),
        );
        expect(await snapshot(w)).toEqual(before);
      });

      it('refuses a line in another currency without a rate', async () => {
        const w = await setup();
        const before = await snapshot(w);
        await inputError(create(w, { currency: 'USD' }));
        await inputError(create(w, { currency: 'USD', fxRate: null }));
        expect(await snapshot(w)).toEqual(before);
      });
    });

    describe('the account', () => {
      it('refuses an account that is not postable', async () => {
        const w = await setup();
        const before = await snapshot(w);
        await inputError(create(w, { accountId: w.headingId }));
        expect(await snapshot(w)).toEqual(before);
      });

      it('refuses a removed account, and an account in a removed chart', async () => {
        const w = await setup();
        const gone = await seedAccount(database, w.organisationId, w.chartId, {
          code: '5200',
        });
        await db()
          .update(account)
          .set({ deletedAt: new Date() })
          .where(eq(account.id, gone));
        const chart = await seedChart(database, w.organisationId, {
          projectId: w.projectId,
        });
        const inChart = await seedAccount(database, w.organisationId, chart);
        await db()
          .update(accountChart)
          .set({ deletedAt: new Date() })
          .where(eq(accountChart.id, chart));
        const before = await snapshot(w);
        await inputError(create(w, { accountId: gone }));
        await inputError(create(w, { accountId: inChart }));
        expect(await snapshot(w)).toEqual(before);
      });

      it('refuses an account of another project’s chart, of an organisation template, and of another organisation', async () => {
        const w = await setup();
        const otherChart = await seedChart(database, w.organisationId, {
          projectId: w.otherProjectId,
        });
        const template = await seedChart(database, w.organisationId);
        const foreign = await setup();
        const before = await snapshot(w);
        await inputError(
          create(w, {
            accountId: await seedAccount(
              database,
              w.organisationId,
              otherChart,
            ),
          }),
        );
        await inputError(
          create(w, {
            accountId: await seedAccount(database, w.organisationId, template),
          }),
        );
        await inputError(create(w, { accountId: foreign.accountId }));
        await inputError(create(w, { accountId: newId() }));
        // Only the accounts the test added changed the snapshot.
        const after = await snapshot(w);
        expect(after.lines).toEqual(before.lines);
        expect(after.events).toEqual(before.events);
      });

      it('says nothing about an account outside the project that it would not say about a missing one', async () => {
        const w = await setup();
        const template = await seedChart(database, w.organisationId);
        const hidden = await seedAccount(database, w.organisationId, template, {
          isPostable: false,
        });
        const messageOf = async (accountId: string) =>
          ((await create(w, { accountId }).catch((e: unknown) => e)) as Error)
            .message;
        expect(await messageOf(hidden)).toBe(await messageOf(newId()));
      });
    });

    describe('payees, unit and episode', () => {
      it('accepts a person, a company, a unit and an episode of the project', async () => {
        const w = await setup();
        const personId = await seedPerson(database, w.organisationId);
        const companyId = await seedCompany(database, w.organisationId);
        const unitId = await seedUnit(
          database,
          w.organisationId,
          w.projectId,
          'second-camera',
        );
        const episodeId = await seedEpisode(
          database,
          w.organisationId,
          w.projectId,
        );
        const byPerson = await create(w, {
          payeePersonId: personId,
          unitId,
          episodeId,
        });
        expect(byPerson).toMatchObject({
          payeePersonId: personId,
          payeeCompanyId: null,
          unitId,
          episodeId,
        });
        const byCompany = await create(w, { payeeCompanyId: companyId });
        expect(byCompany).toMatchObject({
          payeeCompanyId: companyId,
          payeePersonId: null,
        });
      });

      it('refuses both payees at once', async () => {
        const w = await setup();
        await inputError(
          create(w, {
            payeePersonId: await seedPerson(database, w.organisationId),
            payeeCompanyId: await seedCompany(database, w.organisationId),
          }),
        );
      });

      it('refuses a payee that is removed, unknown, or of another organisation', async () => {
        const w = await setup();
        const other = await setup();
        const removedPerson = await seedPerson(database, w.organisationId);
        await db()
          .update(person)
          .set({ deletedAt: new Date() })
          .where(eq(person.id, removedPerson));
        const before = await snapshot(w);
        for (const payeePersonId of [
          removedPerson,
          newId(),
          await seedPerson(database, other.organisationId),
        ]) {
          await inputError(create(w, { payeePersonId }));
        }
        for (const payeeCompanyId of [
          newId(),
          await seedCompany(database, other.organisationId),
        ]) {
          await inputError(create(w, { payeeCompanyId }));
        }
        expect(await snapshot(w)).toEqual(before);
      });

      it('refuses a unit or episode that is removed, unknown, or of another project or organisation', async () => {
        const w = await setup();
        const other = await setup();
        const removedUnit = await seedUnit(
          database,
          w.organisationId,
          w.projectId,
          'removed-unit',
        );
        await db()
          .update(unit)
          .set({ deletedAt: new Date() })
          .where(eq(unit.id, removedUnit));
        const before = await snapshot(w);
        for (const unitId of [
          removedUnit,
          newId(),
          await seedUnit(database, w.organisationId, w.otherProjectId, 'x'),
          await seedUnit(database, other.organisationId, other.projectId, 'x'),
        ]) {
          await inputError(create(w, { unitId }));
        }
        for (const episodeId of [
          newId(),
          await seedEpisode(database, w.organisationId, w.otherProjectId),
          await seedEpisode(database, other.organisationId, other.projectId),
        ]) {
          await inputError(create(w, { episodeId }));
        }
        expect(await snapshot(w)).toEqual(before);
      });
    });

    describe('what the database refuses', () => {
      it('turns a refusal into a RecordWriteError with the SQLSTATE and constraint, never the values', async () => {
        const w = await setup();
        const failure = await create(w, {
          territory: 'gb',
          amount: '4217.3519',
        }).catch((e: unknown) => e);
        expect(failure).toBeInstanceOf(RecordWriteError);
        expect(failure).toMatchObject({
          code: SQLSTATE.checkViolation,
          constraint: 'cost_line_territory_check',
        });
        expect((failure as Error).message).not.toContain('4217.3519');
      });

      it('requires a source id for every source type but other', async () => {
        const w = await setup();
        await expect(
          create(w, { sourceType: 'invoice', sourceId: null }),
        ).rejects.toMatchObject({ constraint: 'cost_line_source_id_check' });
      });
    });

    describe('what a caller without costs:read is shown', () => {
      it('leaves the amounts out of the result, not null or zero, but keeps the rest', async () => {
        const w = await setup();
        const row = await create(
          w,
          { amount: '4217.3519', currency: 'USD', fxRate: '1.5' },
          w.editor,
        );
        expect(Object.hasOwn(row, 'amount')).toBe(false);
        expect(Object.hasOwn(row, 'amountProjectCurrency')).toBe(false);
        expect(row).toMatchObject({
          currency: 'USD',
          fxRate: '1.5000000000',
          description: 'Camera hire',
        });
        expect(JSON.stringify(row)).not.toContain('4217.3519');
        // The amount is stored all the same.
        const [stored] = await linesIn(w.organisationId);
        expect(stored!.amount).toBe('4217.3519');
        expect(stored!.amountProjectCurrency).toBe('6326.0279');
      });
    });
  });

  describe('updateCostLine', () => {
    it('changes fields, bumps the version and keeps the amounts when they are not named', async () => {
      const w = await setup();
      const line = await seeded(w, {
        amount: '800',
        currency: 'USD',
        fxRate: '1.25',
      });
      const updated = (await updateCostLine(db(), at(w.manager), line.id, 1, {
        description: 'Camera hire, revised',
        stage: 'actual',
        territory: 'FR',
      })) as typeof line;
      expect(updated).toMatchObject({
        version: 2,
        description: 'Camera hire, revised',
        stage: 'actual',
        territory: 'FR',
        amount: '800.0000',
        fxRate: '1.2500000000',
        amountProjectCurrency: '1000.0000',
        updatedBy: w.manager,
      });
    });

    it('computes the project amount again in the same write when the amount, the rate or the currency changes', async () => {
      const w = await setup();
      const line = await seeded(w, {
        amount: '800',
        currency: 'USD',
        fxRate: '1.25',
      });
      // The amount alone, with the stored rate.
      const byAmount = (await updateCostLine(db(), at(w.manager), line.id, 1, {
        amount: '0.0001',
      })) as typeof line;
      expect(byAmount.amountProjectCurrency).toBe(
        referenceProduct('0.0001', '1.25'),
      );
      // The rate alone, with the stored amount.
      const byRate = (await updateCostLine(db(), at(w.manager), line.id, 2, {
        fxRate: '0.5',
      })) as typeof line;
      expect(byRate.amountProjectCurrency).toBe('0.0001');
      // The currency, to another foreign one with a new rate.
      const byCurrency = (await updateCostLine(
        db(),
        at(w.manager),
        line.id,
        3,
        {
          currency: 'EUR',
          fxRate: '2',
          amount: '10.5',
        },
      )) as typeof line;
      expect(byCurrency).toMatchObject({
        currency: 'EUR',
        amount: '10.5000',
        fxRate: '2.0000000000',
        amountProjectCurrency: '21.0000',
      });
      const events = await eventsIn(w.organisationId);
      const updates = events.filter(
        (e) => e.entityId === line.id && e.action === 'update',
      );
      expect(updates).toHaveLength(3);
      // The project amount moved in the same event as the field that moved it.
      expect(updates[0]!.changedFields).toEqual(
        expect.arrayContaining(['amount', 'amount_project_currency']),
      );
    });

    it('moves a line into the project’s currency only with the rate cleared, and out of it only with a rate', async () => {
      const w = await setup();
      const line = await seeded(w, {
        amount: '800',
        currency: 'USD',
        fxRate: '1.25',
      });
      const before = await snapshot(w);
      await inputError(
        updateCostLine(db(), at(w.manager), line.id, 1, { currency: 'GBP' }),
      );
      expect(await snapshot(w)).toEqual(before);
      const home = (await updateCostLine(db(), at(w.manager), line.id, 1, {
        currency: 'GBP',
        fxRate: null,
      })) as typeof line;
      expect(home).toMatchObject({
        currency: 'GBP',
        fxRate: null,
        amount: '800.0000',
        amountProjectCurrency: '800.0000',
      });
      await inputError(
        updateCostLine(db(), at(w.manager), line.id, 2, { currency: 'USD' }),
      );
      const away = (await updateCostLine(db(), at(w.manager), line.id, 2, {
        currency: 'USD',
        fxRate: '1.2',
      })) as typeof line;
      expect(away.amountProjectCurrency).toBe('960.0000');
      // A rate on a line that stays in the project's currency is refused too.
      await inputError(
        updateCostLine(db(), at(w.manager), line.id, 3, {
          currency: 'GBP',
          fxRate: '1.2',
        }),
      );
    });

    it('writes nothing when the new amount is the stored one in another form', async () => {
      const w = await setup();
      const line = await seeded(w, { amount: '12.5' });
      const before = await snapshot(w);
      const same = await updateCostLine(db(), at(w.manager), line.id, 1, {
        amount: '12.50',
      });
      expect(same.version).toBe(1);
      expect(await snapshot(w)).toEqual(before);
    });

    it('refuses a bad amount or rate, and a new account, payee, unit or episode that is not allowed, writing nothing', async () => {
      const w = await setup();
      const line = await seeded(w);
      const before = await snapshot(w);
      const update = (changes: Parameters<typeof updateCostLine>[4]) =>
        updateCostLine(db(), at(w.manager), line.id, 1, changes);
      await inputError(update({ amount: '1.00001' }));
      await inputError(update({ amount: 12 as never }));
      await inputError(update({ fxRate: '0' }));
      await inputError(update({ accountId: w.headingId }));
      await inputError(update({ accountId: newId() }));
      await inputError(update({ payeePersonId: newId() }));
      await inputError(update({ unitId: newId() }));
      await inputError(update({ episodeId: newId() }));
      expect(await snapshot(w)).toEqual(before);
    });

    it('moves a line to another postable account of the project', async () => {
      const w = await setup();
      const line = await seeded(w);
      const other = await seedAccount(database, w.organisationId, w.chartId, {
        code: '5300',
      });
      const updated = await updateCostLine(db(), at(w.manager), line.id, 1, {
        accountId: other,
      });
      expect(updated.accountId).toBe(other);
    });

    it('keeps at most one payee, looking at the payee the line already has', async () => {
      const w = await setup();
      const personId = await seedPerson(database, w.organisationId);
      const companyId = await seedCompany(database, w.organisationId);
      const line = await seeded(w, { payeePersonId: personId });
      await inputError(
        updateCostLine(db(), at(w.manager), line.id, 1, {
          payeeCompanyId: companyId,
        }),
      );
      const swapped = await updateCostLine(db(), at(w.manager), line.id, 1, {
        payeeCompanyId: companyId,
        payeePersonId: null,
      });
      expect(swapped).toMatchObject({
        payeeCompanyId: companyId,
        payeePersonId: null,
      });
    });

    it('does not check again a payee that is already on the line and was removed since', async () => {
      const w = await setup();
      const personId = await seedPerson(database, w.organisationId);
      const line = await seeded(w, { payeePersonId: personId });
      await db()
        .update(person)
        .set({ deletedAt: new Date() })
        .where(eq(person.id, personId));
      const updated = await updateCostLine(db(), at(w.manager), line.id, 1, {
        description: 'Still payable to the removed person',
      });
      expect(updated.payeePersonId).toBe(personId);
    });

    it('ignores keys it does not list: the project and the organisation cannot change', async () => {
      const w = await setup();
      const line = await seeded(w);
      const updated = await updateCostLine(db(), at(w.manager), line.id, 1, {
        description: 'Moved?',
        projectId: w.otherProjectId,
        organisationId: newId(),
        id: newId(),
      } as never);
      expect(updated).toMatchObject({
        id: line.id,
        projectId: w.projectId,
        organisationId: w.organisationId,
        description: 'Moved?',
      });
    });

    it('refuses a stale version without writing', async () => {
      const w = await setup();
      const line = await seeded(w);
      const before = await snapshot(w);
      await expect(
        updateCostLine(db(), at(w.manager), line.id, 7, { description: 'x' }),
      ).rejects.toBeInstanceOf(VersionConflictError);
      expect(await snapshot(w)).toEqual(before);
    });

    it('hides the amounts from a caller without costs:read, however it changed them', async () => {
      const w = await setup();
      const line = await seeded(w, { amount: '4217.3519' });
      const result = await updateCostLine(db(), at(w.editor), line.id, 1, {
        amount: '5000.1234',
        description: 'Revised',
      });
      expect(Object.hasOwn(result, 'amount')).toBe(false);
      expect(Object.hasOwn(result, 'amountProjectCurrency')).toBe(false);
      expect(result.description).toBe('Revised');
      const [stored] = await linesIn(w.organisationId);
      expect(stored!.amountProjectCurrency).toBe('5000.1234');
    });
  });

  describe('removeCostLine', () => {
    it('removes the line and its live tags together, each with its own event', async () => {
      const w = await setup();
      const line = await seeded(w);
      await setCostLineScheme(db(), at(w.manager), line.id, 'uk-hetv', {
        status: 'qualifying',
        qualifyingAmount: '400',
      });
      await setCostLineScheme(db(), at(w.manager), line.id, 'fr-credit', {
        status: 'pending',
      });
      const gone = await setCostLineScheme(
        db(),
        at(w.manager),
        line.id,
        'old',
        {
          status: 'excluded',
        },
      );
      await removeCostLineScheme(
        db(),
        at(w.manager),
        line.id,
        'old',
        gone.version,
      );
      const removed = await removeCostLine(db(), at(w.manager), line.id, 1);
      expect(removed.deletedAt).toEqual(NOW);
      expect(removed.deletedBy).toBe(w.manager);
      const tags = await tagsIn(w.organisationId);
      expect(tags).toHaveLength(3);
      expect(tags.every((t) => t.deletedAt !== null)).toBe(true);
      const deletes = (await eventsIn(w.organisationId)).filter(
        (e) => e.action === 'delete',
      );
      // The tag removed earlier, the two that went with the line, and the line.
      expect(deletes).toHaveLength(4);
      expect(deletes.every((e) => e.projectId === w.projectId)).toBe(true);
    });

    it('refuses a stale version without touching the tags', async () => {
      const w = await setup();
      const line = await seeded(w);
      await setCostLineScheme(db(), at(w.manager), line.id, 'uk-hetv', {
        status: 'pending',
      });
      const before = await snapshot(w);
      await expect(
        removeCostLine(db(), at(w.manager), line.id, 9),
      ).rejects.toBeInstanceOf(VersionConflictError);
      expect(await snapshot(w)).toEqual(before);
    });

    it('treats a removed line like an unknown one afterwards', async () => {
      const w = await setup();
      const line = await seeded(w);
      await removeCostLine(db(), at(w.manager), line.id, 1);
      const ctx = at(w.manager);
      await expect(
        removeCostLine(db(), ctx, line.id, 2),
      ).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(getCostLine(db(), ctx, line.id)).rejects.toBeInstanceOf(
        AccessDeniedError,
      );
      await expect(
        updateCostLine(db(), ctx, line.id, 2, { description: 'x' }),
      ).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(
        setCostLineScheme(db(), ctx, line.id, 'uk-hetv', { status: 'pending' }),
      ).rejects.toBeInstanceOf(AccessDeniedError);
      expect(
        await listCostLines(db(), ctx, {
          organisationId: w.organisationId,
          projectId: w.projectId,
        }),
      ).toEqual([]);
    });

    it('hides the amounts from a caller without costs:read', async () => {
      const w = await setup();
      const line = await seeded(w, { amount: '4217.3519' });
      const removed = await removeCostLine(db(), at(w.editor), line.id, 1);
      expect(Object.hasOwn(removed, 'amount')).toBe(false);
      expect(Object.hasOwn(removed, 'amountProjectCurrency')).toBe(false);
    });
  });

  describe('getCostLine and listCostLines', () => {
    it('returns a line with its live tags, ordered by scheme key, and amounts', async () => {
      const w = await setup();
      const line = await seeded(w, { amount: '900' });
      await setCostLineScheme(db(), at(w.manager), line.id, 'uk-hetv', {
        status: 'qualifying',
        qualifyingAmount: '450',
        reason: 'UK spend',
      });
      await setCostLineScheme(db(), at(w.manager), line.id, 'fr-credit', {
        status: 'pending',
      });
      const removedTag = await setCostLineScheme(
        db(),
        at(w.manager),
        line.id,
        'gone',
        {
          status: 'excluded',
        },
      );
      await removeCostLineScheme(
        db(),
        at(w.manager),
        line.id,
        'gone',
        removedTag.version,
      );
      for (const userId of [w.manager, w.reader, w.taggerReader]) {
        const got = await getCostLine(db(), at(userId), line.id);
        expect(got).toMatchObject({ id: line.id, amount: '900.0000' });
        expect(got.schemes.map((s) => s.schemeKey)).toEqual([
          'fr-credit',
          'uk-hetv',
        ]);
        expect(got.schemes[1]).toMatchObject({
          status: 'qualifying',
          qualifyingAmount: '450.0000',
          reason: 'UK spend',
        });
      }
    });

    describe('listing', () => {
      let w: World;
      let first: Awaited<ReturnType<typeof seeded>>;
      let second: Awaited<ReturnType<typeof seeded>>;
      let third: Awaited<ReturnType<typeof seeded>>;
      let unitId: string;
      let episodeId: string;
      let otherAccountId: string;
      const list = (filter: object = {}, userId = w.reader) =>
        listCostLines(db(), at(userId), {
          organisationId: w.organisationId,
          projectId: w.projectId,
          ...filter,
        });
      const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

      beforeAll(async () => {
        w = await setup();
        unitId = await seedUnit(
          database,
          w.organisationId,
          w.projectId,
          'b-unit',
        );
        episodeId = await seedEpisode(database, w.organisationId, w.projectId);
        otherAccountId = await seedAccount(
          database,
          w.organisationId,
          w.chartId,
          {
            code: '5400',
          },
        );
        first = await seeded(w, {
          stage: 'budget',
          territory: 'GB',
          productionPhase: 'pre-production',
        });
        second = await seeded(w, {
          stage: 'actual',
          territory: 'FR',
          productionPhase: 'post-production',
          accountId: otherAccountId,
          unitId,
        });
        third = await seeded(w, {
          stage: 'actual',
          territory: 'GB',
          productionPhase: 'post-production',
          episodeId,
        });
        // Lines of another project and of a removed line never show.
        await createCostLine(
          db(),
          at(w.elsewhere),
          values(w, {
            projectId: w.otherProjectId,
            accountId: await seedAccount(
              database,
              w.organisationId,
              await seedChart(database, w.organisationId, {
                projectId: w.otherProjectId,
              }),
            ),
          }),
        );
        const removed = await seeded(w);
        await removeCostLine(db(), at(w.manager), removed.id, 1);
        await setCostLineScheme(db(), at(w.manager), first.id, 'uk-hetv', {
          status: 'qualifying',
        });
        await setCostLineScheme(db(), at(w.manager), second.id, 'uk-hetv', {
          status: 'non-qualifying',
        });
        await setCostLineScheme(db(), at(w.manager), second.id, 'fr-credit', {
          status: 'qualifying',
        });
        const dropped = await setCostLineScheme(
          db(),
          at(w.manager),
          third.id,
          'uk-hetv',
          {
            status: 'qualifying',
          },
        );
        await removeCostLineScheme(
          db(),
          at(w.manager),
          third.id,
          'uk-hetv',
          dropped.version,
        );
      });

      it('returns the live lines of the project, oldest first, each with its live tags', async () => {
        const rows = await list();
        expect(ids(rows)).toEqual([first.id, second.id, third.id]);
        expect(rows.map((r) => r.schemes.map((s) => s.schemeKey))).toEqual([
          ['uk-hetv'],
          ['fr-credit', 'uk-hetv'],
          [],
        ]);
      });

      it('filters by stage, account, production phase, territory, unit and episode', async () => {
        expect(ids(await list({ stage: 'actual' }))).toEqual([
          second.id,
          third.id,
        ]);
        expect(ids(await list({ accountId: otherAccountId }))).toEqual([
          second.id,
        ]);
        expect(ids(await list({ productionPhase: 'post-production' }))).toEqual(
          [second.id, third.id],
        );
        expect(ids(await list({ territory: 'GB' }))).toEqual([
          first.id,
          third.id,
        ]);
        expect(ids(await list({ unitId }))).toEqual([second.id]);
        expect(ids(await list({ episodeId }))).toEqual([third.id]);
        expect(
          ids(
            await list({
              stage: 'actual',
              territory: 'GB',
              productionPhase: 'post-production',
            }),
          ),
        ).toEqual([third.id]);
        expect(ids(await list({ territory: 'US' }))).toEqual([]);
      });

      it('filters by scheme key and status, looking at live tags only', async () => {
        expect(ids(await list({ schemeKey: 'uk-hetv' }))).toEqual([
          first.id,
          second.id,
        ]);
        expect(
          ids(await list({ schemeKey: 'uk-hetv', schemeStatus: 'qualifying' })),
        ).toEqual([first.id]);
        expect(
          ids(
            await list({
              schemeKey: 'uk-hetv',
              schemeStatus: 'non-qualifying',
            }),
          ),
        ).toEqual([second.id]);
        // A status alone matches a tag of any scheme.
        expect(ids(await list({ schemeStatus: 'qualifying' }))).toEqual([
          first.id,
          second.id,
        ]);
        // Both apply to the same tag: the second line has qualifying and non-qualifying tags, for different schemes.
        expect(
          ids(
            await list({
              schemeKey: 'fr-credit',
              schemeStatus: 'non-qualifying',
            }),
          ),
        ).toEqual([]);
        expect(ids(await list({ schemeKey: 'no-such-scheme' }))).toEqual([]);
      });

      it('takes a caller string as a value, never as a key', async () => {
        for (const text of [
          'constructor',
          '__proto__',
          'toString',
          "x' or '1'='1",
        ]) {
          expect(ids(await list({ schemeKey: text }))).toEqual([]);
          expect(ids(await list({ territory: text }))).toEqual([]);
        }
      });
    });
  });

  describe('setCostLineScheme', () => {
    it('creates the tag with the acting user and the time of the decision', async () => {
      const w = await setup();
      const line = await seeded(w, { amount: '1000' });
      const tag = await setCostLineScheme(
        db(),
        at(w.manager),
        line.id,
        'uk-hetv',
        {
          status: 'qualifying',
          qualifyingAmount: '600.5',
          reason: 'Shot in the UK',
        },
      );
      expect(tag).toMatchObject({
        organisationId: w.organisationId,
        costLineId: line.id,
        schemeKey: 'uk-hetv',
        status: 'qualifying',
        qualifyingAmount: '600.5000',
        reason: 'Shot in the UK',
        decidedBy: w.manager,
        decidedAt: NOW,
        visibility: 'private',
        retentionClass: 'financial-record',
        version: 1,
      });
    });

    it('updates the live tag instead of adding a second, replacing what was set before', async () => {
      const w = await setup();
      const line = await seeded(w, { amount: '1000' });
      const later = new Date(Date.UTC(2026, 2, 1, 9));
      const first = await setCostLineScheme(
        db(),
        at(w.manager),
        line.id,
        'uk-hetv',
        {
          status: 'qualifying',
          qualifyingAmount: '600',
          reason: 'First view',
        },
      );
      const second = await setCostLineScheme(
        db(),
        { ...at(w.taggerReader), clock: () => later },
        line.id,
        'uk-hetv',
        { status: 'non-qualifying' },
      );
      expect(second).toMatchObject({
        id: first.id,
        version: 2,
        status: 'non-qualifying',
        // Replaced: a non-qualifying tag cannot keep an amount, and the reason went with the decision.
        qualifyingAmount: null,
        reason: null,
        decidedBy: w.taggerReader,
        decidedAt: later,
      });
      expect(await tagsIn(w.organisationId)).toHaveLength(1);
    });

    it('keeps one tag per scheme and a separate tag per scheme', async () => {
      const w = await setup();
      const line = await seeded(w);
      for (const key of ['uk-hetv', 'fr-credit', 'uk-hetv']) {
        await setCostLineScheme(db(), at(w.manager), line.id, key, {
          status: 'pending',
        });
      }
      const got = await getCostLine(db(), at(w.manager), line.id);
      expect(got.schemes.map((s) => s.schemeKey)).toEqual([
        'fr-credit',
        'uk-hetv',
      ]);
    });

    describe('the qualifying amount', () => {
      const tag = (
        w: World,
        lineId: string,
        qualifyingAmount: string,
        userId = w.manager,
      ) =>
        setCostLineScheme(db(), at(userId), lineId, 'uk-hetv', {
          status: 'qualifying',
          qualifyingAmount,
        });

      it('is no larger than the project amount of a positive line, and not negative', async () => {
        const w = await setup();
        const line = await seeded(w, { amount: '1000' });
        for (const ok of ['0', '0.0001', '999.9999', '1000', '1000.0000']) {
          await tag(w, line.id, ok);
        }
        const before = await snapshot(w);
        for (const bad of ['1000.0001', '1001', '-0.0001', '-1000']) {
          await inputError(tag(w, line.id, bad));
        }
        expect(await snapshot(w)).toEqual(before);
      });

      it('is no larger in absolute value than the project amount of a credit, and not positive', async () => {
        const w = await setup();
        const line = await seeded(w, { amount: '-500' });
        for (const ok of ['0', '-0.0001', '-250', '-500.0000']) {
          await tag(w, line.id, ok);
        }
        for (const bad of ['0.0001', '250', '-500.0001', '-501']) {
          await inputError(tag(w, line.id, bad));
        }
      });

      it('can only be zero on a line of zero', async () => {
        const w = await setup();
        const line = await seeded(w, { amount: '0' });
        await tag(w, line.id, '0');
        await inputError(tag(w, line.id, '0.0001'));
        await inputError(tag(w, line.id, '-0.0001'));
      });

      it('is compared with the project amount, not the amount in the line’s own currency', async () => {
        const w = await setup();
        // 100 USD at 1.5 is 150 in the project's currency.
        const line = await seeded(w, {
          amount: '100',
          currency: 'USD',
          fxRate: '1.5',
        });
        await tag(w, line.id, '150');
        await inputError(tag(w, line.id, '150.0001'));
      });

      it('is exact at the edge of the largest amounts, where a float cannot tell the two apart', async () => {
        const w = await setup();
        // 19 significant digits: the three values below are one number as a double.
        const line = await seeded(w, { amount: '999999999999999.9998' });
        await tag(w, line.id, '999999999999999.9998');
        await tag(w, line.id, '999999999999999.9997');
        await inputError(tag(w, line.id, '999999999999999.9999'));
      });

      it('is stored as the database holds it, so the same value in another form changes nothing', async () => {
        const w = await setup();
        const line = await seeded(w, { amount: '1000' });
        const first = await tag(w, line.id, '400');
        expect(first.qualifyingAmount).toBe('400.0000');
        const before = await snapshot(w);
        const again = await tag(w, line.id, '400.0000');
        expect(again).toMatchObject({ id: first.id, version: 1 });
        expect(await snapshot(w)).toEqual(before);
      });

      it('is refused for a status other than qualifying, and when it is not a decimal with four places', async () => {
        const w = await setup();
        const line = await seeded(w, { amount: '100' });
        for (const status of [
          'non-qualifying',
          'pending',
          'excluded',
        ] as const) {
          await inputError(
            setCostLineScheme(db(), at(w.manager), line.id, 'uk-hetv', {
              status,
              qualifyingAmount: '10',
            }),
          );
        }
        for (const bad of ['', '1e1', '10.00001', 'ten', ' 10']) {
          await inputError(tag(w, line.id, bad));
        }
        expect(await tagsIn(w.organisationId)).toEqual([]);
      });

      it('does not appear in the refusals', async () => {
        const w = await setup();
        const line = await seeded(w, { amount: '4217.3519' });
        const failure = await tag(w, line.id, '9999.1111').catch(
          (e: unknown) => e,
        );
        expect(failure).toBeInstanceOf(CostLineInputError);
        expect((failure as Error).message).not.toMatch(/4217|9999/);
      });

      it('needs costs:read as well, so a tagger cannot find out the amount by trying', async () => {
        const w = await setup();
        const line = await seeded(w, { amount: '1000' });
        const before = await snapshot(w);
        // Too large, and just right: both are denied before the amount is looked at.
        for (const q of ['5000', '500']) {
          await expect(tag(w, line.id, q, w.tagger)).rejects.toMatchObject({
            name: 'AccessDeniedError',
            permission: READ,
            scope: undefined,
          });
        }
        expect(await snapshot(w)).toEqual(before);
      });
    });

    it('lets a tagger without costs:read set a status, and hides the qualifying amount from the result', async () => {
      const w = await setup();
      const line = await seeded(w, { amount: '1000' });
      const plain = await setCostLineScheme(
        db(),
        at(w.tagger),
        line.id,
        'uk-hetv',
        {
          status: 'pending',
          reason: 'Waiting for the auditor',
        },
      );
      expect(Object.hasOwn(plain, 'qualifyingAmount')).toBe(false);
      expect(plain).toMatchObject({ status: 'pending', decidedBy: w.tagger });
      // A tag that already has an amount, replaced by one without it, never shows it either.
      await setCostLineScheme(db(), at(w.taggerReader), line.id, 'fr-credit', {
        status: 'qualifying',
        qualifyingAmount: '300',
      });
      const replaced = await setCostLineScheme(
        db(),
        at(w.tagger),
        line.id,
        'fr-credit',
        {
          status: 'excluded',
        },
      );
      expect(Object.hasOwn(replaced, 'qualifyingAmount')).toBe(false);
      const seen = await setCostLineScheme(
        db(),
        at(w.taggerReader),
        line.id,
        'de-fund',
        {
          status: 'pending',
        },
      );
      expect(Object.hasOwn(seen, 'qualifyingAmount')).toBe(true);
    });

    it('turns a refusal of the database into a RecordWriteError', async () => {
      const w = await setup();
      const line = await seeded(w);
      for (const [key, status, constraint] of [
        ['UK', 'pending', 'cost_line_scheme_scheme_key_check'],
        ['', 'pending', 'cost_line_scheme_scheme_key_check'],
        ['uk-hetv', 'maybe', 'cost_line_scheme_status_check'],
      ] as const) {
        const failure = await setCostLineScheme(
          db(),
          at(w.manager),
          line.id,
          key,
          {
            status: status as never,
          },
        ).catch((e: unknown) => e);
        expect(failure).toBeInstanceOf(RecordWriteError);
        expect(failure).toMatchObject({
          code: SQLSTATE.checkViolation,
          constraint,
        });
      }
    });
  });

  describe('removeCostLineScheme', () => {
    it('removes the live tag, frees its key and lets the line be tagged again as a new tag', async () => {
      const w = await setup();
      const line = await seeded(w);
      const tag = await setCostLineScheme(
        db(),
        at(w.manager),
        line.id,
        'uk-hetv',
        {
          status: 'qualifying',
          qualifyingAmount: '10',
        },
      );
      const removed = await removeCostLineScheme(
        db(),
        at(w.manager),
        line.id,
        'uk-hetv',
        tag.version,
      );
      expect(removed).toMatchObject({
        id: tag.id,
        deletedAt: NOW,
        deletedBy: w.manager,
      });
      expect((await getCostLine(db(), at(w.manager), line.id)).schemes).toEqual(
        [],
      );
      const again = await setCostLineScheme(
        db(),
        at(w.manager),
        line.id,
        'uk-hetv',
        {
          status: 'pending',
        },
      );
      expect(again.id).not.toBe(tag.id);
      expect(await tagsIn(w.organisationId)).toHaveLength(2);
    });

    it('refuses a key the line has no live tag for, a stale version, and a removed tag, writing nothing', async () => {
      const w = await setup();
      const line = await seeded(w);
      const tag = await setCostLineScheme(
        db(),
        at(w.manager),
        line.id,
        'uk-hetv',
        {
          status: 'pending',
        },
      );
      const before = await snapshot(w);
      await inputError(
        removeCostLineScheme(db(), at(w.manager), line.id, 'no-such', 1),
      );
      await expect(
        removeCostLineScheme(db(), at(w.manager), line.id, 'uk-hetv', 5),
      ).rejects.toBeInstanceOf(VersionConflictError);
      expect(await snapshot(w)).toEqual(before);
      await removeCostLineScheme(
        db(),
        at(w.manager),
        line.id,
        'uk-hetv',
        tag.version,
      );
      await inputError(
        removeCostLineScheme(
          db(),
          at(w.manager),
          line.id,
          'uk-hetv',
          tag.version + 1,
        ),
      );
    });

    it('takes a caller string as a value, never as a key', async () => {
      const w = await setup();
      const line = await seeded(w);
      for (const text of [
        'constructor',
        '__proto__',
        'toString',
        'hasOwnProperty',
      ]) {
        await inputError(
          removeCostLineScheme(db(), at(w.manager), line.id, text, 1),
        );
      }
    });

    it('hides the qualifying amount from a caller without costs:read', async () => {
      const w = await setup();
      const line = await seeded(w, { amount: '100' });
      const tag = await setCostLineScheme(
        db(),
        at(w.manager),
        line.id,
        'uk-hetv',
        {
          status: 'qualifying',
          qualifyingAmount: '55.5555',
        },
      );
      const removed = await removeCostLineScheme(
        db(),
        at(w.tagger),
        line.id,
        'uk-hetv',
        tag.version,
      );
      expect(Object.hasOwn(removed, 'qualifyingAmount')).toBe(false);
    });
  });

  describe('permissions', () => {
    /** One call per function, run as `userId` on the cost line `lineId`. */
    type Call = {
      readonly name: string;
      readonly needs: string;
      readonly run: (
        w: World,
        userId: string,
        lineId: string,
      ) => Promise<unknown>;
    };

    const CALLS: Call[] = [
      {
        name: 'getCostLine',
        needs: READ,
        run: (_w, userId, lineId) => getCostLine(db(), at(userId), lineId),
      },
      {
        name: 'updateCostLine',
        needs: EDIT,
        run: (_w, userId, lineId) =>
          updateCostLine(db(), at(userId), lineId, 1, { description: 'x' }),
      },
      {
        name: 'removeCostLine',
        needs: EDIT,
        run: (_w, userId, lineId) =>
          removeCostLine(db(), at(userId), lineId, 1),
      },
      {
        name: 'setCostLineScheme',
        needs: TAG,
        run: (_w, userId, lineId) =>
          setCostLineScheme(db(), at(userId), lineId, 'uk-hetv', {
            status: 'pending',
          }),
      },
      {
        name: 'removeCostLineScheme',
        needs: TAG,
        run: (_w, userId, lineId) =>
          removeCostLineScheme(db(), at(userId), lineId, 'uk-hetv', 1),
      },
    ];

    const holders = (w: World): Record<string, string[]> => ({
      [READ]: [w.manager, w.reader, w.taggerReader],
      [EDIT]: [w.manager, w.editor],
      [TAG]: [w.manager, w.tagger, w.taggerReader],
    });
    const everyone = (w: World) => [
      w.manager,
      w.reader,
      w.editor,
      w.tagger,
      w.taggerReader,
      w.elsewhere,
      w.orgManager,
      w.outsider,
    ];

    describe.each(CALLS)('$name needs $needs', ({ name, needs, run }) => {
      it('is refused for everyone without it, with the key named, no scope, and nothing written', async () => {
        const w = await setup();
        const line = await seeded(w);
        // The tag the removal call wants to find.
        await setCostLineScheme(db(), at(w.manager), line.id, 'uk-hetv', {
          status: 'pending',
        });
        const before = await snapshot(w);
        const denied = everyone(w).filter(
          (u) => !holders(w)[needs]!.includes(u),
        );
        expect(denied.length, name).toBeGreaterThanOrEqual(5);
        for (const userId of denied) {
          await expect(run(w, userId, line.id)).rejects.toMatchObject({
            name: 'AccessDeniedError',
            permission: needs,
            scope: undefined,
          });
        }
        expect(await snapshot(w)).toEqual(before);
      });

      it('is allowed for those who hold it', async () => {
        const w = await setup();
        for (const userId of holders(w)[needs]!) {
          const line = await seeded(w);
          await setCostLineScheme(db(), at(w.manager), line.id, 'uk-hetv', {
            status: 'pending',
          });
          // The removal call needs the tag's version, which is 1 for a new tag.
          await run(w, userId, line.id);
        }
      });

      it('answers an unknown, a removed and another organisation’s line exactly as a forbidden one', async () => {
        const w = await setup();
        const other = await setup();
        const line = await seeded(w);
        const removed = await seeded(w);
        await removeCostLine(db(), at(w.manager), removed.id, 1);
        const foreign = await seeded(other);
        const holder = holders(w)[needs]![0]!;
        const errors = [];
        for (const lineId of [line.id, removed.id, newId(), foreign.id]) {
          // The holder is denied on the last three and, on the first, someone
          // without the permission is denied.
          const userId =
            lineId === line.id
              ? everyone(w).find((u) => !holders(w)[needs]!.includes(u))!
              : holder;
          errors.push(await run(w, userId, lineId).catch((e: unknown) => e));
        }
        for (const error of errors) {
          expect(error).toBeInstanceOf(AccessDeniedError);
          expect((error as AccessDeniedError).message).toBe(
            (errors[0] as AccessDeniedError).message,
          );
          expect(error).toMatchObject({ permission: needs, scope: undefined });
        }
      });
    });

    it('denies a role held in the organisation or on another project nothing on this project', async () => {
      const w = await setup();
      const line = await seeded(w);
      for (const userId of [w.orgManager, w.elsewhere]) {
        await expect(
          getCostLine(db(), at(userId), line.id),
        ).rejects.toBeInstanceOf(AccessDeniedError);
        await expect(
          listCostLines(db(), at(userId), {
            organisationId: w.organisationId,
            projectId: w.projectId,
          }),
        ).rejects.toBeInstanceOf(AccessDeniedError);
        await expect(
          createCostLine(db(), at(userId), values(w)),
        ).rejects.toBeInstanceOf(AccessDeniedError);
      }
    });

    it('names the project in the denial of a create or a list, because the caller named it', async () => {
      const w = await setup();
      await expect(create(w, {}, w.reader)).rejects.toMatchObject({
        name: 'AccessDeniedError',
        permission: EDIT,
        scope: 'project',
      });
      await expect(
        listCostLines(db(), at(w.editor), {
          organisationId: w.organisationId,
          projectId: w.projectId,
        }),
      ).rejects.toMatchObject({
        name: 'AccessDeniedError',
        permission: READ,
        scope: 'project',
      });
    });

    it('answers a create or a list for a project that does not exist, or is not in the organisation, as for a forbidden one', async () => {
      const w = await setup();
      const other = await setup();
      const forbidden = await create(w, {}, w.reader).catch((e: unknown) => e);
      for (const bad of [
        { projectId: newId() },
        { projectId: other.projectId },
        { organisationId: other.organisationId },
      ]) {
        const failure = await createCostLine(
          db(),
          at(w.manager),
          values(w, bad),
        ).catch((e: unknown) => e);
        expect(failure).toBeInstanceOf(AccessDeniedError);
        expect(failure).toMatchObject({ permission: EDIT, scope: 'project' });
        expect((failure as Error).message).toBe((forbidden as Error).message);
        await expect(
          listCostLines(db(), at(w.manager), {
            organisationId: w.organisationId,
            projectId: w.projectId,
            ...bad,
          }),
        ).rejects.toBeInstanceOf(AccessDeniedError);
      }
    });

    it('needs costs:edit, not costs:read or costs:tag-schemes, to create', async () => {
      const w = await setup();
      for (const userId of [w.reader, w.tagger, w.taggerReader, w.outsider]) {
        await expect(create(w, {}, userId)).rejects.toBeInstanceOf(
          AccessDeniedError,
        );
      }
      await create(w, {}, w.editor);
    });

    it('writes no audit event for a denial: costs are not sensitive personal data', async () => {
      const w = await setup();
      const line = await seeded(w);
      const before = await auditIn(w.organisationId);
      await getCostLine(db(), at(w.outsider), line.id).catch(() => undefined);
      await create(w, {}, w.outsider).catch(() => undefined);
      expect(await auditIn(w.organisationId)).toEqual(before);
    });
  });

  describe('accounts in use', () => {
    const accountsCtx = (w: World): AccountContext => ({
      userId: w.accountsEditor,
      originServer: ORIGIN,
      clock: () => NOW,
    });
    const accountRow = async (id: string) =>
      (await db().select().from(account).where(eq(account.id, id)))[0]!;
    const chartRow = async (id: string) =>
      (
        await db().select().from(accountChart).where(eq(accountChart.id, id))
      )[0]!;

    it('refuses to remove an account while a live cost line is booked to it, then allows it once the line is gone', async () => {
      const w = await setup();
      const line = await seeded(w);
      const row = await accountRow(w.accountId);
      const before = await snapshot(w);
      const failure = await removeAccount(
        db(),
        accountsCtx(w),
        w.accountId,
        row.version,
      ).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(AccountInUseError);
      // A RecordStateError, as the refusal for an account with children is.
      expect(failure).toBeInstanceOf(RecordStateError);
      expect((failure as Error).message).toContain('cost line');
      expect(await snapshot(w)).toEqual(before);
      expect((await accountRow(w.accountId)).deletedAt).toBeNull();

      await removeCostLine(db(), at(w.manager), line.id, 1);
      await removeAccount(db(), accountsCtx(w), w.accountId, row.version);
      expect((await accountRow(w.accountId)).deletedAt).toEqual(NOW);
    });

    it('does not count a removed cost line, or a line booked to another account', async () => {
      const w = await setup();
      const spare = await seedAccount(database, w.organisationId, w.chartId, {
        code: '5900',
      });
      const line = await seeded(w);
      await removeCostLine(db(), at(w.manager), line.id, 1);
      await removeAccount(db(), accountsCtx(w), w.accountId, 1);
      await seeded(w, { accountId: spare });
      const sibling = await seedAccount(database, w.organisationId, w.chartId, {
        code: '5901',
      });
      await removeAccount(db(), accountsCtx(w), sibling, 1);
    });

    it('refuses to remove a chart while a live cost line is booked to any of its accounts, writing nothing', async () => {
      const w = await setup();
      const line = await seeded(w);
      const before = await snapshot(w);
      const chartBefore = await chartRow(w.chartId);
      const failure = await removeChart(
        db(),
        accountsCtx(w),
        w.chartId,
        chartBefore.version,
      ).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(AccountInUseError);
      expect(failure).toBeInstanceOf(RecordStateError);
      expect(await snapshot(w)).toEqual(before);
      const events = await db()
        .select()
        .from(changeEvent)
        .where(
          and(
            eq(changeEvent.organisationId, w.organisationId),
            inArray(changeEvent.entityType, ['account_chart', 'account']),
            eq(changeEvent.action, 'delete'),
          ),
        );
      expect(events).toEqual([]);
      expect((await chartRow(w.chartId)).deletedAt).toBeNull();
      expect((await accountRow(w.accountId)).deletedAt).toBeNull();
      expect((await accountRow(w.headingId)).deletedAt).toBeNull();

      await removeCostLine(db(), at(w.manager), line.id, 1);
      await removeChart(db(), accountsCtx(w), w.chartId, chartBefore.version);
      expect((await chartRow(w.chartId)).deletedAt).toEqual(NOW);
      expect((await accountRow(w.accountId)).deletedAt).toEqual(NOW);
    });

    it('removes a chart with cost lines on no account of it', async () => {
      const w = await setup();
      const empty = await seedChart(database, w.organisationId, {
        projectId: w.projectId,
      });
      await seedAccount(database, w.organisationId, empty);
      await seeded(w);
      await removeChart(db(), accountsCtx(w), empty, 1);
      expect((await chartRow(empty)).deletedAt).toEqual(NOW);
    });

    it('stops a cost line from being booked to an account that has just been removed', async () => {
      const w = await setup();
      const spare = await seedAccount(database, w.organisationId, w.chartId, {
        code: '5800',
      });
      await removeAccount(db(), accountsCtx(w), spare, 1);
      await inputError(create(w, { accountId: spare }));
    });

    describe('making an account non-postable', () => {
      it('is refused while a live cost line is booked to the account, writing nothing', async () => {
        const w = await setup();
        await seeded(w);
        const before = await snapshot(w);
        const row = await accountRow(w.accountId);
        const failure = await updateAccount(
          db(),
          accountsCtx(w),
          w.accountId,
          row.version,
          { isPostable: false },
        ).catch((e: unknown) => e);
        expect(failure).toBeInstanceOf(AccountInUseError);
        // A RecordStateError, as the refusal to remove it is, and the error says
        // which change was refused.
        expect(failure).toBeInstanceOf(RecordStateError);
        expect(failure).toMatchObject({ attempted: 'stop-posting' });
        expect((failure as Error).message).toContain('non-postable');
        expect(await snapshot(w)).toEqual(before);
        expect(await accountRow(w.accountId)).toEqual(row);
        // The same account is still refused for a removal, with the other `attempted`.
        const removal = await removeAccount(
          db(),
          accountsCtx(w),
          w.accountId,
          row.version,
        ).catch((e: unknown) => e);
        expect(removal).toMatchObject({ attempted: 'remove' });
      });

      it('is allowed once the live cost lines are gone, and then no new line can be booked to it', async () => {
        const w = await setup();
        const line = await seeded(w);
        await removeCostLine(db(), at(w.manager), line.id, 1);
        const row = await accountRow(w.accountId);
        const updated = await updateAccount(
          db(),
          accountsCtx(w),
          w.accountId,
          row.version,
          { isPostable: false },
        );
        expect(updated.isPostable).toBe(false);
        await inputError(create(w));
      });

      it('does not block other edits of an account in use, or setting it postable when it already is', async () => {
        const w = await setup();
        await seeded(w);
        let row = await accountRow(w.accountId);
        row = await updateAccount(
          db(),
          accountsCtx(w),
          w.accountId,
          row.version,
          {
            name: 'Camera department',
            glCode: '5100-GL',
            sortOrder: 4,
            isPostable: true,
          },
        );
        expect(row).toMatchObject({
          name: 'Camera department',
          glCode: '5100-GL',
          sortOrder: 4,
          isPostable: true,
        });
      });

      it('does not count a line booked to another account, and a non-postable account can be made postable again', async () => {
        const w = await setup();
        await seeded(w);
        const spare = await seedAccount(database, w.organisationId, w.chartId, {
          code: '5950',
        });
        const off = await updateAccount(db(), accountsCtx(w), spare, 1, {
          isPostable: false,
        });
        expect(off.isPostable).toBe(false);
        const on = await updateAccount(
          db(),
          accountsCtx(w),
          spare,
          off.version,
          {
            isPostable: true,
          },
        );
        expect(on.isPostable).toBe(true);
      });
    });
  });
});
