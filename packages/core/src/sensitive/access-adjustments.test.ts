import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ACCESS_FIELDS,
  ACCESS_GROUPS,
  accessFieldGroup,
  isAccessField,
  isLanguageTagShaped,
  MEDICAL_FIELDS,
  payloadSchemas,
  type AccessField,
  type AccessGroup,
} from './schemas.js';

/**
 * The accessibility payload: structured adjustments, not diagnoses (decision D-69).
 * Every field is optional, at least one must be set, and no field asks for a
 * condition. The tests below pin each field to the group and bounds the spec gives.
 */

const schema = payloadSchemas.accessibility;

type Case = {
  readonly group: AccessGroup;
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
};

/** `HH:MM` on a 24-hour clock, and nothing else. */
const TIME = {
  valid: ['00:00', '08:30', '19:45', '23:59'],
  invalid: [
    '24:00',
    '08:60',
    '8:30',
    '08:30:00',
    '0830',
    '08.30',
    ' 08:30',
    '08:30 ',
    '',
    830,
    true,
    null,
  ],
};

/** A whole number from `min` to `max`, both included. */
const between = (min: number, max: number) => ({
  valid: [min, Math.floor((min + max) / 2), max],
  invalid: [
    min - 1,
    max + 1,
    min + 0.5,
    String(min),
    Number.NaN,
    Number.POSITIVE_INFINITY,
    true,
    null,
  ],
});

const FLAG = {
  valid: [true, false],
  invalid: ['true', 'yes', 1, 0, null, []],
};

/**
 * One case for every field, so the compiler asks for a new one when a field is added.
 * The groups and the bounds are the spec's table (P-02l1, section 1).
 */
const CASES: Record<AccessField, Case> = {
  noEarlierThan: { group: 'schedule', ...TIME },
  noLaterThan: { group: 'schedule', ...TIME },
  maxWorkingHours: { group: 'schedule', ...between(1, 24) },
  breakEveryMinutes: { group: 'schedule', ...between(15, 480) },
  breakLengthMinutes: { group: 'schedule', ...between(5, 120) },
  advanceNoticeHours: { group: 'schedule', ...between(1, 336) },
  stepFreeRequired: { group: 'physical', ...FLAG },
  seatingNeeded: { group: 'physical', ...FLAG },
  maxWalkMetres: { group: 'physical', ...between(0, 5000) },
  accessibleToiletMaxMetres: { group: 'physical', ...between(0, 5000) },
  accessibleParking: { group: 'transport', ...FLAG },
  cannotDrive: { group: 'transport', ...FLAG },
  needsTransport: { group: 'transport', ...FLAG },
  noEarpiece: { group: 'communication', ...FLAG },
  textFirst: { group: 'communication', ...FLAG },
  extraThinkingTime: { group: 'communication', ...FLAG },
  signLanguageInterpreter: {
    group: 'communication',
    valid: ['hr-HR-SL', 'bfi', 'sgn-GB', 'ase', 'en-GB-oxendict', 'HR-hr-sl'],
    invalid: [
      '',
      'h',
      'hr_HR',
      'hr-',
      '-hr',
      'hr--SL',
      'hr-HR-SL-',
      'hr HR',
      'hr-HR SL',
      '1r-HR',
      'hr-HR-123456789',
      'hrhrhrhrh-HR',
      'a-b-c-d-e-f-g-h-i',
      `hr-${String.fromCodePoint(0x0106)}R`,
      'hr-HR\n',
      5,
      true,
      null,
    ],
  },
  quietSpace: { group: 'environment', ...FLAG },
  noiseSensitive: { group: 'environment', ...FLAG },
  previewLocation: { group: 'environment', ...FLAG },
  supportWorker: { group: 'support', ...FLAG },
  assistanceAnimal: { group: 'support', ...FLAG },
  notes: {
    group: 'notes',
    valid: ['x', 'Prefers the ground-floor trailer', 'n'.repeat(2000)],
    invalid: ['', 'n'.repeat(2001), 5, true, null],
  },
};

const FIELD_KEYS = Object.keys(CASES) as AccessField[];

describe('the groups of adjustments', () => {
  it('are the seven the spec names, in its order', () => {
    expect([...ACCESS_GROUPS]).toEqual([
      'schedule',
      'physical',
      'transport',
      'communication',
      'environment',
      'support',
      'notes',
    ]);
  });

  it('give ACCESS_FIELDS every field once, each in the group the spec names', () => {
    expect(ACCESS_FIELDS.map((entry) => entry.key)).toEqual(FIELD_KEYS);
    expect(new Set(ACCESS_FIELDS.map((entry) => entry.key)).size).toBe(
      ACCESS_FIELDS.length,
    );
    for (const entry of ACCESS_FIELDS) {
      expect(entry.group, entry.key).toBe(CASES[entry.key].group);
      expect(ACCESS_GROUPS).toContain(entry.group);
    }
    // Every group holds a field, so no group is a name with nothing under it.
    for (const group of ACCESS_GROUPS) {
      expect(
        ACCESS_FIELDS.some((entry) => entry.group === group),
        group,
      ).toBe(true);
    }
  });

  it('are the fields the schema accepts, no more and no fewer', () => {
    expect(Object.keys(schema.shape).sort()).toEqual([...FIELD_KEYS].sort());
  });

  it('look up a field by a string from a caller without reading inherited names', () => {
    for (const key of FIELD_KEYS) {
      expect(isAccessField(key), key).toBe(true);
      expect(accessFieldGroup(key), key).toBe(CASES[key].group);
    }
    for (const name of [
      'constructor',
      '__proto__',
      'toString',
      'hasOwnProperty',
      'schedule',
      'diagnosis',
      '',
    ]) {
      expect(isAccessField(name), name).toBe(false);
      expect(accessFieldGroup(name), name).toBeUndefined();
    }
    expect(isAccessField(5)).toBe(false);
    expect(isAccessField(null)).toBe(false);
  });

  it('leave the medical fields as the payload has them, and ask for no diagnosis in the adjustments', () => {
    expect([...MEDICAL_FIELDS]).toEqual(['conditions', 'medication', 'notes']);
    for (const key of FIELD_KEYS) {
      expect(key.toLowerCase(), key).not.toMatch(
        /condition|diagnos|medic|illness|disab/,
      );
    }
  });
});

describe.each(FIELD_KEYS)('the accessibility field %s', (key) => {
  const { valid, invalid } = CASES[key];

  it.each(valid.map((value) => [value] as const))(
    'accepts %j, alone, unchanged',
    (value) => {
      const parsed = schema.safeParse({ [key]: value });
      expect(parsed.success).toBe(true);
      expect(parsed.data).toEqual({ [key]: value });
    },
  );

  it.each(invalid.map((value) => [value] as const))('refuses %j', (value) => {
    expect(schema.safeParse({ [key]: value }).success).toBe(false);
  });
});

describe('the accessibility payload as a whole', () => {
  it('accepts a payload with every field set, unchanged', () => {
    const everything = Object.fromEntries(
      FIELD_KEYS.map((key) => [key, CASES[key].valid[0]]),
    );
    expect(schema.parse(everything)).toEqual(everything);
  });

  it('needs at least one field to be set', () => {
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ stepFreeRequired: undefined }).success).toBe(
      false,
    );
    // A field set to false is set: the person chose to say so.
    expect(schema.safeParse({ stepFreeRequired: false }).success).toBe(true);
    expect(schema.safeParse({ maxWalkMetres: 0 }).success).toBe(true);
  });

  it('refuses a key the schema does not name, and says where without the value', () => {
    for (const payload of [
      { stepFreeRequired: true, extra: 'x' },
      { diagnosis: 'a name' },
      // The shape the payload had before decision D-69.
      { needs: 'Step-free access to trailer', notes: 'Ground floor' },
    ]) {
      const parsed = schema.safeParse(payload);
      expect(parsed.success).toBe(false);
    }
    const parsed = schema.safeParse({ diagnosis: 'a name' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        expect(
          JSON.stringify({ path: issue.path, code: issue.code }),
        ).not.toContain('a name');
      }
    }
  });

  it('refuses what is not an object', () => {
    for (const payload of [null, 'step-free', 5, [], true, undefined]) {
      expect(schema.safeParse(payload).success).toBe(false);
    }
  });
});

describe('language tag shapes', () => {
  it('check the shape only, by looking at each character once', () => {
    expect(isLanguageTagShaped('hr-HR-SL')).toBe(true);
    expect(isLanguageTagShaped('bfi')).toBe(true);
    expect(isLanguageTagShaped('hr_HR')).toBe(false);
    expect(isLanguageTagShaped('')).toBe(false);
  });

  it('refuse a hostile string at once, whatever its length', () => {
    const hostile = [
      'a-'.repeat(500_000),
      `${'a'.repeat(1_000_000)}!`,
      '-'.repeat(1_000_000),
      `${'a'.repeat(34)}-`.repeat(10_000),
    ];
    const started = performance.now();
    for (const value of hostile) {
      expect(isLanguageTagShaped(value)).toBe(false);
      expect(schema.safeParse({ signLanguageInterpreter: value }).success).toBe(
        false,
      );
    }
    // A few strings of a million characters, refused by their length: nowhere near a second.
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('refuse a long run of near misses in the time and notes fields at once too', () => {
    const started = performance.now();
    for (const key of ['noEarlierThan', 'noLaterThan', 'notes'] as const) {
      const value = `${'1'.repeat(200_000)}:`;
      expect(schema.safeParse({ [key]: value }).success).toBe(false);
    }
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

/**
 * CLAUDE.md, Code rules: no regular expression with nested or overlapping quantifiers
 * runs on request data. A payload is request data, so no pattern in the sensitive
 * module may have a group with a quantifier inside that is itself quantified.
 */
describe('the regular expressions of the sensitive module', () => {
  /** Whether `pattern` has a group with a quantifier in it that is quantified too. */
  function hasNestedQuantifier(pattern: string): boolean {
    // Escapes and character classes hold no groups or quantifiers of their own.
    const plain = pattern
      .replace(/\\./g, '_')
      .replace(/\[(?:\\.|[^\]\\])*\]/g, '_');
    const quantified: boolean[] = [];
    const closedWithQuantifier = (index: number) => {
      const next = plain[index + 1];
      return next === '+' || next === '*' || next === '{';
    };
    for (let i = 0; i < plain.length; i += 1) {
      const char = plain[i]!;
      if (char === '(') quantified.push(false);
      else if (char === ')') {
        const inner = quantified.pop() ?? false;
        if (inner && closedWithQuantifier(i)) return true;
        // A quantified group counts as a quantifier for the group around it.
        if (closedWithQuantifier(i) && quantified.length > 0) {
          quantified[quantified.length - 1] = true;
        }
        if (inner && quantified.length > 0) {
          quantified[quantified.length - 1] = true;
        }
      } else if (char === '+' || char === '*') {
        if (quantified.length > 0) quantified[quantified.length - 1] = true;
      } else if (char === '{' && /^\{\d+,\d*\}/.test(plain.slice(i))) {
        if (quantified.length > 0) quantified[quantified.length - 1] = true;
      }
    }
    return false;
  }

  /** The regular expression literals in a source text, as their patterns. */
  function patternsIn(source: string): string[] {
    const found: string[] = [];
    const literal =
      /(?:regex\(\s*|=\s*|\(\s*|,\s*)\/((?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+)\/[dgimsuvy]*/g;
    for (const match of source.matchAll(literal)) found.push(match[1]!);
    return found;
  }

  it('catches a nested quantifier, and passes the shapes it must', () => {
    for (const bad of [
      '(a+)+',
      '(a*)*',
      '(\\d+)*',
      '([a-z]+){2,}',
      '((a+)b)+',
    ]) {
      expect(hasNestedQuantifier(bad), bad).toBe(true);
    }
    for (const good of [
      '^[A-Z]{2}$',
      '^(?:[01]\\d|2[0-3]):[0-5]\\d$',
      '^(\\d{4})-(\\d{2})-(\\d{2})$',
      '[+*]+',
      '^a+b*$',
    ]) {
      expect(hasNestedQuantifier(good), good).toBe(false);
    }
    expect(patternsIn("const x = /^[A-Z]{2}$/; y.regex(/a+/, 'm')")).toEqual([
      '^[A-Z]{2}$',
      'a+',
    ]);
  });

  it('have none in the module, which the scan covers by reading its sources', () => {
    const folder = fileURLToPath(new URL('.', import.meta.url));
    const files = readdirSync(folder).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    );
    expect(files).toContain('schemas.ts');
    const patterns = files.flatMap((name) =>
      patternsIn(readFileSync(join(folder, name), 'utf8')).map(
        (pattern) => `${name}: ${pattern}`,
      ),
    );
    // Guards against the scan finding nothing and passing for nothing.
    expect(patterns.length).toBeGreaterThanOrEqual(1);
    expect(
      patterns.filter((entry) =>
        hasNestedQuantifier(entry.slice(entry.indexOf(': ') + 2)),
      ),
    ).toEqual([]);
  });
});
