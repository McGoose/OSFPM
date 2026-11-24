import { describe, expect, it } from 'vitest';
import { atColumnScale, isAmountString } from './decimal.js';

describe('isAmountString', () => {
  it.each([
    '0',
    '12',
    '12.5',
    '12.5000',
    '0.0001',
    '007',
    '999999999999999',
    '999999999999999.9999',
  ])('accepts %j', (value) => {
    expect(isAmountString(value)).toBe(true);
    expect(isAmountString(value, { allowNegative: false })).toBe(true);
  });

  it.each([
    '1234567890123456',
    '1.23456',
    '1.',
    '.5',
    '',
    ' 5',
    '5 ',
    '1,000',
    '1e3',
    '+5',
    '--5',
    '5-',
    'ten',
    '１２',
  ])('refuses %j', (value) => {
    expect(isAmountString(value)).toBe(false);
    expect(isAmountString(value, { allowNegative: false })).toBe(false);
  });

  it('refuses everything that is not a string, a number included', () => {
    for (const value of [12.5, 0, null, undefined, true, [], {}, 10n]) {
      expect(isAmountString(value)).toBe(false);
    }
  });

  it('allows a credit unless it is told not to', () => {
    expect(isAmountString('-12.5')).toBe(true);
    expect(isAmountString('-12.5', { allowNegative: true })).toBe(true);
    expect(isAmountString('-12.5', { allowNegative: false })).toBe(false);
    expect(isAmountString('-0', { allowNegative: false })).toBe(false);
  });

  it('keeps the limit of numeric(19,4): 15 digits before the point and 4 after', () => {
    expect(isAmountString('9'.repeat(15))).toBe(true);
    expect(isAmountString('9'.repeat(16))).toBe(false);
    expect(isAmountString(`1.${'9'.repeat(4)}`)).toBe(true);
    expect(isAmountString(`1.${'9'.repeat(5)}`)).toBe(false);
  });

  it('answers quickly on a long string that is nearly an amount', () => {
    const started = Date.now();
    expect(isAmountString(`${'1'.repeat(100_000)}x`)).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('atColumnScale', () => {
  it.each([
    ['450.5', 4, '450.5000'],
    ['450.5000', 4, '450.5000'],
    ['12', 4, '12.0000'],
    ['0.45', 4, '0.4500'],
    ['007', 4, '7.0000'],
    ['000.5', 4, '0.5000'],
    ['0', 4, '0.0000'],
    ['10', 2, '10.00'],
    ['168.5', 2, '168.50'],
  ])('writes %j with %d places as %j', (value, places, expected) => {
    expect(atColumnScale(value, places)).toBe(expected);
  });
});
