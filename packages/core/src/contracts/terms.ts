import { atColumnScale, isAmountString } from '../db/decimal.js';
import {
  CONTRACT_GUARANTEED_HOURS_MAX,
  CONTRACT_KIT_FEE_BASES,
  CONTRACT_KIT_INVENTORY_MAX_LENGTH,
  CONTRACT_MILEAGE_UNITS,
  CONTRACT_RATE_BASES,
  CONTRACT_RATE_BASES_WITHOUT_HOURS,
  type ContractKind,
  type contractTerms,
} from '../db/schema/index.js';

/**
 * The pure part of the contract terms: which contracts have them, which fields are
 * amounts, and the rules a set of terms must keep. The service calls these before
 * it writes, so a caller's mistake is a `ContractInputError` and never the
 * database's `RecordWriteError`; the CHECKs of `contract_terms` stay as the
 * backstop and say the same thing. Nothing here reads or writes the database.
 *
 * No legal or agreement number is written here: the only numbers are what the
 * columns can hold (CLAUDE.md, Data rules). Overtime lives in rule packs and is
 * only named by `overtimeRuleKey`.
 */

/** A stored `contract_terms` row. */
export type ContractTermsRow = typeof contractTerms.$inferSelect;

/**
 * The contract kinds that have terms: the person-facing deals. A CHECK cannot see
 * the contract's kind, so the service refuses the other kinds.
 */
export const CONTRACT_TERMS_KINDS = [
  'deal-memo',
  'crew-contract',
  'cast-contract',
] as const satisfies readonly ContractKind[];

/**
 * True when a contract of `kind` can have deal terms: a deal memo, a crew contract
 * or a cast contract. The service asks it when terms are set, and when a contract
 * that has terms is about to change its kind.
 */
export function contractKindHasTerms(kind: ContractKind): boolean {
  return (CONTRACT_TERMS_KINDS as readonly string[]).includes(kind);
}

/**
 * The agreed amounts of a set of terms. They are sensitive (`markSensitive` on the
 * table) and reach only holders of `contracts:read-value` and the parties to the
 * contract. `currency` is not one of them.
 */
export const CONTRACT_TERMS_AMOUNT_KEYS = [
  'rate',
  'kitFee',
  'perDiem',
  'mileageRate',
] as const;
/** One amount field of the terms. */
export type ContractTermsAmountKey =
  (typeof CONTRACT_TERMS_AMOUNT_KEYS)[number];

/**
 * The fields that need `contracts:read-value` to set or clear: the four amounts,
 * and the currency, the rate basis, the kit fee basis and the mileage unit, which
 * say what an amount means. Someone who may not see an amount must not be able to
 * relabel it, and gating the whole set, not only the case where an amount is
 * stored, means a refusal never shows whether one is (CLAUDE.md, Code rules). The
 * other terms (guaranteed hours, overtime rule key, kit inventory, days to pay,
 * pension) are not amounts and need only `contracts:edit`.
 */
export const CONTRACT_TERMS_READ_VALUE_KEYS = [
  ...CONTRACT_TERMS_AMOUNT_KEYS,
  'currency',
  'rateBasis',
  'kitFeeBasis',
  'mileageUnit',
] as const;

/** Every field of the terms a caller can set. */
const TERM_KEYS = [
  'currency',
  'rate',
  'rateBasis',
  'guaranteedHours',
  'overtimeRuleKey',
  'kitFee',
  'kitFeeBasis',
  'kitInventory',
  'perDiem',
  'mileageRate',
  'mileageUnit',
  'paymentTermsDays',
  'pensionApplies',
] as const;
type TermKey = (typeof TERM_KEYS)[number];

/**
 * The terms a caller sets. A key left out, or `undefined`, is not touched; `null`
 * clears the field. Amounts and `guaranteedHours` are decimal strings, never
 * numbers.
 */
export type ContractTermsInput = {
  readonly [K in TermKey]?: ContractTermsRow[K];
};

/** The terms as they stand once an input is applied: every field, empty ones `null`. */
export type ContractTermsState = {
  readonly [K in TermKey]: ContractTermsRow[K];
};

/**
 * A set of terms as the contracts service returns it. The amounts (`rate`,
 * `kitFee`, `perDiem`, `mileageRate`) are present only for a caller who may see
 * them, and absent, never `null` or `0`, for everyone else.
 */
export type ContractTermsView = Omit<ContractTermsRow, ContractTermsAmountKey> &
  Partial<Pick<ContractTermsRow, ContractTermsAmountKey>>;

const termKeys: ReadonlySet<string> = new Set(TERM_KEYS);
const readValueKeys: ReadonlySet<string> = new Set(
  CONTRACT_TERMS_READ_VALUE_KEYS,
);

/** The places after the point of the amount columns, `numeric(19,4)`, and of the hours, `numeric(5,2)`. */
const AMOUNT_PLACES = 4;
const HOURS_PLACES = 2;

/** Up to 3 digits before the point and 2 after, which is what `numeric(5,2)` holds. */
const HOURS_PATTERN = /^\d{1,3}(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
// The same key shape as a scheme key. One character class under one star, so it
// cannot backtrack on a long key (CLAUDE.md, Code rules).
const RULE_KEY_PATTERN = /^[a-z0-9][a-z0-9.-]*$/;
const PAYMENT_TERMS_DAYS_MAX = 365;

/**
 * The fields of `input` that need `contracts:read-value` to set, which are those
 * of `CONTRACT_TERMS_READ_VALUE_KEYS`, whatever they are set to and even to `null`.
 * It looks only at the keys of `input`, never at what is stored, so the answer
 * cannot depend on whether the terms hold an amount.
 */
export function readValueKeysIn(input: ContractTermsInput): string[] {
  return Object.entries(input)
    .filter(([key, value]) => readValueKeys.has(key) && value !== undefined)
    .map(([key]) => key);
}

const oneOf = (list: readonly string[], value: unknown) =>
  typeof value === 'string' && list.includes(value);

/**
 * The first reason `input` cannot be stored, or `undefined` when every field it
 * sets is well formed: a field that does not exist, an amount that is not a
 * decimal string within the column (at most 15 digits before the point and 4
 * after, not below zero), hours outside the week, a basis or unit that is not
 * allowed, a rule key of the wrong shape, an inventory over the limit, a number of
 * days outside the range. The message names the field and the rule and never a
 * value, so it can be shown as it is.
 */
export function checkTermsInput(input: ContractTermsInput): string | undefined {
  for (const key of Object.keys(input)) {
    if (!termKeys.has(key)) return 'The terms name a field that does not exist';
  }
  const set = <K extends TermKey>(key: K) =>
    input[key] === undefined || input[key] === null ? undefined : input[key];

  const currency = set('currency');
  if (
    currency !== undefined &&
    !(typeof currency === 'string' && CURRENCY_PATTERN.test(currency))
  ) {
    return 'The currency must be three upper-case letters';
  }
  for (const key of CONTRACT_TERMS_AMOUNT_KEYS) {
    const amount = set(key);
    if (
      amount !== undefined &&
      !isAmountString(amount, { allowNegative: false })
    ) {
      return `The ${key} must be a decimal string of at most 15 digits before the point and 4 after, and not below zero`;
    }
  }
  const basis = set('rateBasis');
  if (basis !== undefined && !oneOf(CONTRACT_RATE_BASES, basis)) {
    return 'The rate basis is not one of the allowed values';
  }
  const kitBasis = set('kitFeeBasis');
  if (kitBasis !== undefined && !oneOf(CONTRACT_KIT_FEE_BASES, kitBasis)) {
    return 'The kit fee basis is not one of the allowed values';
  }
  const unit = set('mileageUnit');
  if (unit !== undefined && !oneOf(CONTRACT_MILEAGE_UNITS, unit)) {
    return 'The mileage unit is not one of the allowed values';
  }
  const hours = set('guaranteedHours');
  if (
    hours !== undefined &&
    !(
      typeof hours === 'string' &&
      HOURS_PATTERN.test(hours) &&
      Number(hours) > 0 &&
      Number(hours) <= CONTRACT_GUARANTEED_HOURS_MAX
    )
  ) {
    return `The guaranteed hours must be a decimal string above zero and at most ${CONTRACT_GUARANTEED_HOURS_MAX}, with at most 2 places after the point`;
  }
  const ruleKey = set('overtimeRuleKey');
  if (
    ruleKey !== undefined &&
    !(typeof ruleKey === 'string' && RULE_KEY_PATTERN.test(ruleKey))
  ) {
    return 'The overtime rule key must be lower-case letters, digits, dots and hyphens, starting with a letter or digit';
  }
  const inventory = set('kitInventory');
  if (
    inventory !== undefined &&
    // `length` counts UTF-16 units, so an inventory of at most the limit in code
    // points can be up to twice as long. Only a string that could be under the
    // limit is counted point by point.
    !(
      typeof inventory === 'string' &&
      inventory.length <= 2 * CONTRACT_KIT_INVENTORY_MAX_LENGTH &&
      Array.from(inventory).length <= CONTRACT_KIT_INVENTORY_MAX_LENGTH
    )
  ) {
    return `The kit inventory must be text of at most ${CONTRACT_KIT_INVENTORY_MAX_LENGTH} characters`;
  }
  const days = set('paymentTermsDays');
  if (
    days !== undefined &&
    !(
      typeof days === 'number' &&
      Number.isInteger(days) &&
      days >= 0 &&
      days <= PAYMENT_TERMS_DAYS_MAX
    )
  ) {
    return `The payment terms must be a whole number of days from 0 to ${PAYMENT_TERMS_DAYS_MAX}`;
  }
  const pension = set('pensionApplies');
  if (pension !== undefined && typeof pension !== 'boolean') {
    return 'The pension flag must be true, false or null';
  }
  return undefined;
}

/**
 * `input` with its decimals written the way the database returns them: the four
 * amounts with 4 places after the point and the guaranteed hours with 2. Call it
 * after `checkTermsInput` has accepted the input. A caller that repeats a stored
 * value as `450.5` then changes nothing, where `450.5000` is stored, instead of
 * writing a change event for an amount that is the same.
 */
export function normaliseTerms(input: ContractTermsInput): ContractTermsInput {
  const next: Record<string, unknown> = { ...input };
  for (const key of CONTRACT_TERMS_AMOUNT_KEYS) {
    const value = input[key];
    if (typeof value === 'string')
      next[key] = atColumnScale(value, AMOUNT_PLACES);
  }
  if (typeof input.guaranteedHours === 'string') {
    next.guaranteedHours = atColumnScale(input.guaranteedHours, HOURS_PLACES);
  }
  return next;
}

/**
 * The first rule that the terms as a whole break, or `undefined`. These are the
 * rules between fields, the ones the CHECKs of `contract_terms` hold too: an
 * amount needs a currency, a rate needs its basis, a kit fee its basis, a mileage
 * rate its unit, and a flat rate or a buyout has no guaranteed hours. Checked on
 * the terms as they will be stored, so an update that clears a currency while an
 * amount stays is refused.
 */
export function checkTermsState(state: ContractTermsState): string | undefined {
  const hasAmount = CONTRACT_TERMS_AMOUNT_KEYS.some(
    (key) => state[key] !== null,
  );
  if (hasAmount && state.currency === null) {
    return 'An amount needs a currency';
  }
  if (state.rate !== null && state.rateBasis === null) {
    return 'A rate needs a rate basis';
  }
  if (state.kitFee !== null && state.kitFeeBasis === null) {
    return 'A kit fee needs a kit fee basis';
  }
  if (state.mileageRate !== null && state.mileageUnit === null) {
    return 'A mileage rate needs a mileage unit';
  }
  if (
    state.guaranteedHours !== null &&
    state.rateBasis !== null &&
    oneOf(CONTRACT_RATE_BASES_WITHOUT_HOURS, state.rateBasis)
  ) {
    return 'A flat rate or a buyout has no guaranteed hours';
  }
  return undefined;
}

/** The stored fields of `row` that a caller sets, every one present, empty ones `null`. */
export function stateOf(row: ContractTermsRow): ContractTermsState {
  return Object.fromEntries(
    TERM_KEYS.map((key) => [key, row[key]]),
  ) as ContractTermsState;
}

/** `input` laid over `state`: a key that is set replaces the stored value, `null` clears it. */
export function applyTerms(
  state: ContractTermsState,
  input: ContractTermsInput,
): ContractTermsState {
  const next: Record<string, unknown> = { ...state };
  for (const key of TERM_KEYS) {
    if (input[key] !== undefined) next[key] = input[key];
  }
  return next as ContractTermsState;
}

/** No terms at all: every field `null`. What a new row, or a restored one, starts from. */
export const EMPTY_TERMS: ContractTermsState = Object.fromEntries(
  TERM_KEYS.map((key) => [key, null]),
) as ContractTermsState;

// The keys are removed, not set to null or 0, so a caller cannot tell a hidden
// amount from an empty one.
/** The terms without their four amounts, for a caller who may not see them. */
export function withoutTermAmounts(row: ContractTermsRow): ContractTermsView {
  const copy: Partial<ContractTermsRow> = { ...row };
  for (const key of CONTRACT_TERMS_AMOUNT_KEYS) delete copy[key];
  return copy as ContractTermsView;
}
