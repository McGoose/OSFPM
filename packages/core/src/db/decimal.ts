/** Up to 15 digits before the point, which is what `numeric(19,4)` holds, and 4 after. */
const AMOUNT_PATTERN = /^-?\d{1,15}(\.\d{1,4})?$/;

/**
 * True when `value` is a decimal string that a money column of `numeric(19,4)`
 * holds exactly: at most 15 digits before the point and 4 after, so the database
 * never rounds it or refuses it for size. Money is never a JavaScript `number`
 * (CLAUDE.md, Data rules), so a number, a string with an exponent or a
 * thousands separator, a leading `+` or surrounding space is refused.
 *
 * A leading `-` is accepted unless `allowNegative` is `false`: a cost line may be a
 * credit, a rate or a fee may not be below zero. This is the one place the rule is
 * written, shared by cost lines and contract terms. Only the shape is checked, so
 * the caller decides what the message says; the value is never put in an error.
 */
export function isAmountString(
  value: unknown,
  options: { readonly allowNegative?: boolean } = {},
): value is string {
  if (typeof value !== 'string' || !AMOUNT_PATTERN.test(value)) return false;
  return options.allowNegative !== false || !value.startsWith('-');
}

/**
 * `value`, a non-negative decimal string that `isAmountString` accepted, written
 * with exactly `places` digits after the point and no leading zeros: `450.5`
 * becomes `450.5000` and `007` becomes `7.0000`. It is the form the database
 * gives a `numeric` column back, so a caller that repeats a stored value in
 * another spelling writes no change. Pure text: no number is ever made from the
 * value, and the database does any arithmetic.
 */
export function atColumnScale(value: string, places: number): string {
  const [whole = '0', fraction = ''] = value.split('.');
  return `${whole.replace(/^0+(?=\d)/, '')}.${fraction.padEnd(places, '0')}`;
}
