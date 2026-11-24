import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  integer,
  numeric,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sqlList, standardColumns, tenantTable } from '../columns.js';
import { registerProjectResolver } from '../project-resolver.js';
import { markSensitive } from '../sensitive.js';
import { contract, contractProjectResolver } from './contract.js';
import { organisation } from './organisation.js';
import { user } from './user.js';

/**
 * Allowed values of `contract_terms.rate_basis`. The CHECK is built from this
 * list, so a new value needs a new migration.
 */
export const CONTRACT_RATE_BASES = [
  'hourly',
  'daily',
  'weekly',
  'flat',
  'buyout',
] as const;
/** One value of `CONTRACT_RATE_BASES`. */
export type ContractRateBasis = (typeof CONTRACT_RATE_BASES)[number];

/**
 * The rate bases that have no hours to guarantee: a flat fee or a buyout pays the
 * same however long the work takes. `guaranteed_hours` must be empty for them.
 */
export const CONTRACT_RATE_BASES_WITHOUT_HOURS = ['flat', 'buyout'] as const;

/**
 * Allowed values of `contract_terms.kit_fee_basis`. The CHECK is built from this
 * list, so a new value needs a new migration.
 */
export const CONTRACT_KIT_FEE_BASES = ['daily', 'weekly', 'flat'] as const;
/** One value of `CONTRACT_KIT_FEE_BASES`. */
export type ContractKitFeeBasis = (typeof CONTRACT_KIT_FEE_BASES)[number];

/**
 * Allowed values of `contract_terms.mileage_unit`. The CHECK is built from this
 * list, so a new value needs a new migration.
 */
export const CONTRACT_MILEAGE_UNITS = ['km', 'mi'] as const;
/** One value of `CONTRACT_MILEAGE_UNITS`. */
export type ContractMileageUnit = (typeof CONTRACT_MILEAGE_UNITS)[number];

/** The most characters `contract_terms.kit_inventory` may hold. */
export const CONTRACT_KIT_INVENTORY_MAX_LENGTH = 2000;

/** The most hours there are in a week, and so the most a period can guarantee. */
export const CONTRACT_GUARANTEED_HOURS_MAX = 168;

/**
 * The agreed deal terms of one contract: what the person or company is paid, for
 * how many hours, what kit costs, and how soon they are paid. At most one row per
 * contract, a live one or a deleted one: removing the terms is a soft delete, and
 * setting them again restores the row, as parties are restored. Visibility
 * defaults to `private` and the retention class to `contract`.
 *
 * The terms exist so a later dispute about money has something structured to be
 * checked against (decision D-73, research R-10). They hold what was agreed and
 * calculate nothing. Only person-facing contracts have them, a deal memo, a crew
 * contract or a cast contract; a CHECK cannot see the contract's kind, so the
 * contracts service refuses the others.
 *
 * The agreed amounts are `rate`, `kit_fee`, `per_diem` and `mileage_rate`. All four
 * are sensitive: the write helper keeps their values out of change events and
 * records only that they changed (see `markSensitive` below), and the contracts
 * service shows them only to holders of `contracts:read-value` and to a party of
 * the contract. `currency` is not an amount and stays visible, like on `contract`;
 * it is required as soon as any amount is set. `guaranteed_hours` is a number of
 * hours per basis period (a day for `daily`, a week for `weekly`), not money.
 *
 * No overtime numbers live here. Overtime multipliers and thresholds are legal or
 * agreement data and belong in rule packs (CLAUDE.md, Data rules);
 * `overtime_rule_key` only names the rule that applies. `mileage_rate` is the
 * exception that proves the rule: it is a rate per unit the parties agreed, contract
 * data, not a legal default.
 *
 * Every optional column is NULL when nothing was agreed, and `pension_applies` is
 * NULL when the contract does not say.
 */
export const contractTerms = tenantTable(
  'contract_terms',
  () => organisation.id,
  {
    ...standardColumns(() => user.id, {
      defaultVisibility: 'private',
      defaultRetentionClass: 'contract',
    }),
    contractId: uuid('contract_id').notNull(),
    currency: text('currency'),
    rate: numeric('rate', { precision: 19, scale: 4 }),
    rateBasis: text('rate_basis').$type<ContractRateBasis>(),
    guaranteedHours: numeric('guaranteed_hours', { precision: 5, scale: 2 }),
    overtimeRuleKey: text('overtime_rule_key'),
    kitFee: numeric('kit_fee', { precision: 19, scale: 4 }),
    kitFeeBasis: text('kit_fee_basis').$type<ContractKitFeeBasis>(),
    kitInventory: text('kit_inventory'),
    perDiem: numeric('per_diem', { precision: 19, scale: 4 }),
    mileageRate: numeric('mileage_rate', { precision: 19, scale: 4 }),
    mileageUnit: text('mileage_unit').$type<ContractMileageUnit>(),
    paymentTermsDays: integer('payment_terms_days'),
    pensionApplies: boolean('pension_applies'),
  },
  (t) => [
    foreignKey({
      name: 'contract_terms_contract_fk',
      columns: [t.organisationId, t.contractId],
      foreignColumns: [contract.organisationId, contract.id],
    }),
    // One row per contract, deleted rows included: the terms of a contract are
    // restored, never made twice. `contract_id` is NOT NULL, so a plain UNIQUE is
    // already right and needs no NULLS NOT DISTINCT.
    unique('contract_terms_contract_unique').on(t.contractId),
    check('contract_terms_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    // An amount without a currency cannot be read, so any of the four needs one.
    check(
      'contract_terms_amount_currency_check',
      sql`(${t.rate} is null and ${t.kitFee} is null and ${t.perDiem} is null and ${t.mileageRate} is null) or ${t.currency} is not null`,
    ),
    check('contract_terms_rate_check', sql`${t.rate} >= 0`),
    check(
      'contract_terms_rate_basis_check',
      sql`${t.rateBasis} in (${sqlList(CONTRACT_RATE_BASES)})`,
    ),
    check(
      'contract_terms_rate_basis_required_check',
      sql`${t.rate} is null or ${t.rateBasis} is not null`,
    ),
    check(
      'contract_terms_guaranteed_hours_check',
      sql`${t.guaranteedHours} > 0 and ${t.guaranteedHours} <= ${sql.raw(String(CONTRACT_GUARANTEED_HOURS_MAX))}`,
    ),
    // A flat fee or a buyout has no hours to guarantee. A NULL basis passes: the
    // hours then have nothing to contradict.
    check(
      'contract_terms_guaranteed_hours_basis_check',
      sql`${t.rateBasis} is null or ${t.rateBasis} not in (${sqlList(CONTRACT_RATE_BASES_WITHOUT_HOURS)}) or ${t.guaranteedHours} is null`,
    ),
    // The key of a rule pack, written as `cost_line_scheme.scheme_key` is.
    check(
      'contract_terms_overtime_rule_key_check',
      sql`${t.overtimeRuleKey} ~ '^[a-z0-9][a-z0-9.-]*$'`,
    ),
    check('contract_terms_kit_fee_check', sql`${t.kitFee} >= 0`),
    check(
      'contract_terms_kit_fee_basis_check',
      sql`${t.kitFeeBasis} in (${sqlList(CONTRACT_KIT_FEE_BASES)})`,
    ),
    check(
      'contract_terms_kit_fee_basis_required_check',
      sql`${t.kitFee} is null or ${t.kitFeeBasis} is not null`,
    ),
    check(
      'contract_terms_kit_inventory_check',
      sql`char_length(${t.kitInventory}) <= ${sql.raw(String(CONTRACT_KIT_INVENTORY_MAX_LENGTH))}`,
    ),
    check('contract_terms_per_diem_check', sql`${t.perDiem} >= 0`),
    check('contract_terms_mileage_rate_check', sql`${t.mileageRate} >= 0`),
    check(
      'contract_terms_mileage_unit_check',
      sql`${t.mileageUnit} in (${sqlList(CONTRACT_MILEAGE_UNITS)})`,
    ),
    check(
      'contract_terms_mileage_unit_required_check',
      sql`${t.mileageRate} is null or ${t.mileageUnit} is not null`,
    ),
    check(
      'contract_terms_payment_terms_days_check',
      sql`${t.paymentTermsDays} >= 0 and ${t.paymentTermsDays} <= 365`,
    ),
  ],
);

/**
 * The agreed amounts must never reach `change_event`, which anyone who may read a
 * project's changes can read. The event still names the column in
 * `changed_fields`, so a change is visible without the number. `currency` is not
 * an amount and stays in the event.
 */
markSensitive(contractTerms, ['rate', 'kitFee', 'perDiem', 'mileageRate']);

/** Has no `project_id`: its project is the one its contract belongs to. */
registerProjectResolver(contractTerms, contractProjectResolver, {
  parentKeys: ['contractId'],
});
