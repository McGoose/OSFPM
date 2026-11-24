import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  base,
  seedOrganisation,
  type SeedOrganisation,
} from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import { contract, contractTerms } from '../db/schema/index.js';
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

type TermsInsert = typeof contractTerms.$inferInsert;

/**
 * The CHECKs, keys and defaults of `contract_terms`, by direct inserts that skip
 * the service, so each rule is shown to hold in the database itself and not only
 * in the code that calls it. A row is made so that only the rule under test can
 * fail: PostgreSQL reports the first of several broken CHECKs by name.
 */
describe.each(testTargets)('the contract_terms table on $name', (target) => {
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

  /** A contract with no terms yet; every test needs its own, as a contract has one row of terms. */
  const newContract = async (organisationId = a.organisationId) => {
    const [row] = await db()
      .insert(contract)
      .values({
        ...base(organisationId),
        kind: 'crew-contract',
        title: 'Camera operator agreement',
        status: 'draft',
      })
      .returning({ id: contract.id });
    return row!.id;
  };

  const insertTerms = async (
    overrides: Partial<TermsInsert> = {},
    organisationId = a.organisationId,
  ) => {
    const contractId = overrides.contractId ?? (await newContract());
    const [row] = await db()
      .insert(contractTerms)
      .values({ ...base(organisationId), contractId, ...overrides })
      .returning();
    return row!;
  };

  /** What the insert fails with, for terms made to break one rule. */
  const failureWith = async (overrides: Partial<TermsInsert>) => {
    const contractId = await newContract();
    return failureOf(() =>
      db()
        .insert(contractTerms)
        .values({ ...base(a.organisationId), contractId, ...overrides }),
    );
  };

  describe('the row', () => {
    it('defaults to private visibility and the contract retention class, with every term empty', async () => {
      const row = await insertTerms();
      expect(row).toMatchObject({
        visibility: 'private',
        retentionClass: 'contract',
        version: 1,
        deletedAt: null,
        currency: null,
        rate: null,
        rateBasis: null,
        guaranteedHours: null,
        overtimeRuleKey: null,
        kitFee: null,
        kitFeeBasis: null,
        kitInventory: null,
        perDiem: null,
        mileageRate: null,
        mileageUnit: null,
        paymentTermsDays: null,
        pensionApplies: null,
      });
    });

    it('holds a full set of terms exactly as given', async () => {
      const row = await insertTerms({
        currency: 'GBP',
        rate: '450.5',
        rateBasis: 'daily',
        guaranteedHours: '10',
        overtimeRuleKey: 'uk-film-overtime',
        kitFee: '75',
        kitFeeBasis: 'weekly',
        kitInventory: 'Two camera bodies',
        perDiem: '35.25',
        mileageRate: '0.45',
        mileageUnit: 'mi',
        paymentTermsDays: 30,
        pensionApplies: false,
      });
      expect(row).toMatchObject({
        rate: '450.5000',
        guaranteedHours: '10.00',
        kitFee: '75.0000',
        perDiem: '35.2500',
        mileageRate: '0.4500',
        pensionApplies: false,
      });
    });

    it('allows one row for each contract, a deleted one counted, and none for a contract of another organisation', async () => {
      const contractId = await newContract();
      await insertTerms({ contractId });
      expect(
        await failureOf(() =>
          db()
            .insert(contractTerms)
            .values({ ...base(a.organisationId), contractId }),
        ),
      ).toEqual({
        code: SQLSTATE.uniqueViolation,
        constraint: 'contract_terms_contract_unique',
      });

      const deletedId = await newContract();
      await insertTerms({ contractId: deletedId, deletedAt: new Date() });
      expect(
        (
          await failureOf(() =>
            db()
              .insert(contractTerms)
              .values({ ...base(a.organisationId), contractId: deletedId }),
          )
        ).constraint,
      ).toBe('contract_terms_contract_unique');

      const foreign = await newContract(b.organisationId);
      expect(
        await failureOf(() =>
          db()
            .insert(contractTerms)
            .values({ ...base(a.organisationId), contractId: foreign }),
        ),
      ).toEqual({
        code: SQLSTATE.foreignKeyViolation,
        constraint: 'contract_terms_contract_fk',
      });
    });
  });

  describe('currency', () => {
    it.each(['gbp', 'GB', 'GBPP', 'G1P', ''])(
      'rejects the currency %j',
      async (currency) => {
        expect(await failureWith({ currency })).toEqual(
          checkViolation('contract_terms_currency_check'),
        );
      },
    );

    it('is required when any of the four amounts is set', async () => {
      const amounts: Partial<TermsInsert>[] = [
        { rate: '1', rateBasis: 'daily' },
        { kitFee: '1', kitFeeBasis: 'daily' },
        { perDiem: '1' },
        { mileageRate: '1', mileageUnit: 'km' },
      ];
      for (const amount of amounts) {
        expect(await failureWith(amount)).toEqual(
          checkViolation('contract_terms_amount_currency_check'),
        );
        await insertTerms({ ...amount, currency: 'EUR' });
      }
    });

    it('may stand alone, with no amount', async () => {
      await insertTerms({ currency: 'GBP' });
    });
  });

  describe('the amounts', () => {
    const NEGATIVE: [string, Partial<TermsInsert>, string][] = [
      [
        'rate',
        { rate: '-0.0001', rateBasis: 'daily' },
        'contract_terms_rate_check',
      ],
      [
        'kit fee',
        { kitFee: '-0.0001', kitFeeBasis: 'daily' },
        'contract_terms_kit_fee_check',
      ],
      ['per diem', { perDiem: '-0.0001' }, 'contract_terms_per_diem_check'],
      [
        'mileage rate',
        { mileageRate: '-0.0001', mileageUnit: 'km' },
        'contract_terms_mileage_rate_check',
      ],
    ];

    it.each(NEGATIVE)('rejects a negative %s', async (_name, values, rule) => {
      expect(await failureWith({ currency: 'GBP', ...values })).toEqual(
        checkViolation(rule),
      );
    });

    it.each(NEGATIVE)('accepts a %s of zero', async (_name, values) => {
      const zeroed = Object.fromEntries(
        Object.entries(values).map(([key, value]) =>
          value === '-0.0001' ? [key, '0'] : [key, value],
        ),
      );
      await insertTerms({ currency: 'GBP', ...zeroed });
    });
  });

  describe('the rate basis', () => {
    it.each(['hourly', 'daily', 'weekly', 'flat', 'buyout'])(
      'accepts %s',
      async (rateBasis) => {
        await insertTerms({ rateBasis: rateBasis as never });
      },
    );

    it('rejects a basis that is not allowed', async () => {
      expect(await failureWith({ rateBasis: 'monthly' as never })).toEqual(
        checkViolation('contract_terms_rate_basis_check'),
      );
    });

    it('is required when there is a rate, and may stand alone', async () => {
      expect(await failureWith({ currency: 'GBP', rate: '100' })).toEqual(
        checkViolation('contract_terms_rate_basis_required_check'),
      );
      await insertTerms({ rateBasis: 'daily' });
    });
  });

  describe('the guaranteed hours', () => {
    it.each([
      ['zero', '0'],
      ['below a hundredth', '0.001'],
      ['more than a week', '168.01'],
      ['negative', '-1'],
    ])('rejects %s', async (_name, guaranteedHours) => {
      // `0.001` is rounded to `0.00` by the column, so it is no hour at all.
      expect(await failureWith({ guaranteedHours })).toEqual(
        checkViolation('contract_terms_guaranteed_hours_check'),
      );
    });

    it.each(['0.01', '10', '167.99', '168'])('accepts %s', async (hours) => {
      await insertTerms({ guaranteedHours: hours, rateBasis: 'weekly' });
    });

    it.each(['hourly', 'daily', 'weekly'] as const)(
      'goes with a %s rate',
      async (rateBasis) => {
        await insertTerms({ guaranteedHours: '10', rateBasis });
      },
    );

    it.each(['flat', 'buyout'] as const)(
      'is refused with a %s rate, which has no hours to guarantee',
      async (rateBasis) => {
        expect(await failureWith({ guaranteedHours: '10', rateBasis })).toEqual(
          checkViolation('contract_terms_guaranteed_hours_basis_check'),
        );
        await insertTerms({ rateBasis });
      },
    );

    it('is allowed when there is no basis to contradict it', async () => {
      await insertTerms({ guaranteedHours: '10' });
    });
  });

  describe('the overtime rule key', () => {
    it.each(['Overtime', '-rule', '', 'rule key', 'rule_key', 'ruleé'])(
      'rejects %j',
      async (overtimeRuleKey) => {
        expect(await failureWith({ overtimeRuleKey })).toEqual(
          checkViolation('contract_terms_overtime_rule_key_check'),
        );
      },
    );

    it.each(['a', '9', 'uk.film-2026.overtime', 'a-'])(
      'accepts %j',
      async (overtimeRuleKey) => {
        await insertTerms({ overtimeRuleKey });
      },
    );
  });

  describe('the kit fee', () => {
    it.each(['daily', 'weekly', 'flat'])(
      'accepts the basis %s',
      async (kitFeeBasis) => {
        await insertTerms({ kitFeeBasis: kitFeeBasis as never });
      },
    );

    it.each(['hourly', 'buyout', ''])('rejects the basis %j', async (basis) => {
      expect(await failureWith({ kitFeeBasis: basis as never })).toEqual(
        checkViolation('contract_terms_kit_fee_basis_check'),
      );
    });

    it('needs a basis, which may stand alone', async () => {
      expect(await failureWith({ currency: 'GBP', kitFee: '10' })).toEqual(
        checkViolation('contract_terms_kit_fee_basis_required_check'),
      );
      await insertTerms({ kitFeeBasis: 'daily' });
    });
  });

  describe('the kit inventory', () => {
    it('holds 2000 characters and refuses 2001', async () => {
      await insertTerms({ kitInventory: 'k'.repeat(2000) });
      expect(await failureWith({ kitInventory: 'k'.repeat(2001) })).toEqual(
        checkViolation('contract_terms_kit_inventory_check'),
      );
    });

    it('counts characters and not bytes', async () => {
      const emoji = String.fromCodePoint(0x1f3a5);
      await insertTerms({ kitInventory: emoji.repeat(2000) });
      expect(await failureWith({ kitInventory: emoji.repeat(2001) })).toEqual(
        checkViolation('contract_terms_kit_inventory_check'),
      );
    });
  });

  describe('the mileage rate', () => {
    it.each(['km', 'mi'])('accepts the unit %s', async (mileageUnit) => {
      await insertTerms({ mileageUnit: mileageUnit as never });
    });

    it.each(['miles', 'KM', ''])('rejects the unit %j', async (unit) => {
      expect(await failureWith({ mileageUnit: unit as never })).toEqual(
        checkViolation('contract_terms_mileage_unit_check'),
      );
    });

    it('needs a unit, which may stand alone', async () => {
      expect(await failureWith({ currency: 'GBP', mileageRate: '1' })).toEqual(
        checkViolation('contract_terms_mileage_unit_required_check'),
      );
      await insertTerms({ mileageUnit: 'km' });
    });
  });

  describe('the days to pay', () => {
    it.each([-1, 366, 1000])('rejects %d', async (paymentTermsDays) => {
      expect(await failureWith({ paymentTermsDays })).toEqual(
        checkViolation('contract_terms_payment_terms_days_check'),
      );
    });

    it.each([0, 1, 30, 365])('accepts %d', async (paymentTermsDays) => {
      await insertTerms({ paymentTermsDays });
    });
  });

  describe('the pension flag', () => {
    it.each([true, false, null])('holds %s', async (pensionApplies) => {
      const row = await insertTerms({ pensionApplies });
      expect(row.pensionApplies).toBe(pensionApplies);
    });
  });
});
