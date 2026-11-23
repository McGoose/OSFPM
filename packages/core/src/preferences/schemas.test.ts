import { describe, expect, it } from 'vitest';
import { PreferencesInvalidError } from './errors.js';
import {
  DOCUMENT_FORMATS,
  EMAIL_FORMATS,
  NOTIFICATION_RHYTHMS,
  parsePreferences,
  PREFERENCE_DEFAULTS,
  PREFERRED_CHANNELS,
  TEXT_SIZES,
  withDefaults,
} from './schemas.js';

/** A value the tests look for in errors. It must never appear in one. */
const SECRET = 'secret-marker-4f9c';

/** The issues a refused value carries, or fails the test when it is accepted. */
function refusal(value: unknown) {
  try {
    parsePreferences(value);
  } catch (error) {
    if (error instanceof PreferencesInvalidError) return error;
    throw error;
  }
  throw new Error('Expected the preferences to be refused, but they were not');
}

describe('the preferences schema', () => {
  it('accepts every value of every field', () => {
    for (const emailFormat of EMAIL_FORMATS) {
      expect(parsePreferences({ emailFormat })).toEqual({ emailFormat });
    }
    for (const documentFormat of DOCUMENT_FORMATS) {
      expect(parsePreferences({ documentFormat })).toEqual({ documentFormat });
    }
    for (const textSize of TEXT_SIZES) {
      expect(parsePreferences({ textSize })).toEqual({ textSize });
    }
    for (const preferredChannel of PREFERRED_CHANNELS) {
      expect(parsePreferences({ preferredChannel })).toEqual({
        preferredChannel,
      });
    }
    for (const notificationRhythm of NOTIFICATION_RHYTHMS) {
      expect(parsePreferences({ notificationRhythm })).toEqual({
        notificationRhythm,
      });
    }
  });

  it('allows exactly the values the design names', () => {
    expect([...EMAIL_FORMATS]).toEqual(['html', 'plain-text']);
    expect([...DOCUMENT_FORMATS]).toEqual([
      'standard',
      'easy-read',
      'large-print',
    ]);
    expect([...TEXT_SIZES]).toEqual(['default', 'large', 'extra-large']);
    expect([...PREFERRED_CHANNELS]).toEqual(['email', 'sms', 'app']);
    expect([...NOTIFICATION_RHYTHMS]).toEqual(['instant', 'daily-digest']);
  });

  it('accepts all the fields at once', () => {
    const all = {
      emailFormat: 'plain-text',
      documentFormat: 'large-print',
      textSize: 'extra-large',
      preferredChannel: 'sms',
      notificationRhythm: 'daily-digest',
      quietHours: { start: '21:30', end: '06:45' },
    } as const;
    expect(parsePreferences(all)).toEqual(all);
  });

  it('accepts nothing at all, because every field is optional', () => {
    expect(parsePreferences({})).toEqual({});
  });

  it('accepts quiet hours that cross midnight, and ones that do not', () => {
    expect(
      parsePreferences({ quietHours: { start: '22:00', end: '07:00' } }),
    ).toEqual({ quietHours: { start: '22:00', end: '07:00' } });
    expect(
      parsePreferences({ quietHours: { start: '13:00', end: '14:30' } }),
    ).toEqual({ quietHours: { start: '13:00', end: '14:30' } });
    expect(
      parsePreferences({ quietHours: { start: '00:00', end: '23:59' } }),
    ).toEqual({ quietHours: { start: '00:00', end: '23:59' } });
  });

  it('refuses quiet hours that start and end at the same time: they say nothing', () => {
    const error = refusal({ quietHours: { start: '22:00', end: '22:00' } });
    expect(error.issues).toEqual([{ path: 'quietHours.end', code: 'custom' }]);
  });

  it.each([
    '24:00',
    '7:00',
    '07:60',
    '07:00:00',
    'noon',
    '',
    '2400',
    '07.00',
    ' 07:00',
    '07:00 ',
    '-1:00',
  ])('refuses the time %j', (time) => {
    expect(() =>
      parsePreferences({ quietHours: { start: time, end: '07:00' } }),
    ).toThrow(PreferencesInvalidError);
    expect(() =>
      parsePreferences({ quietHours: { start: '22:00', end: time } }),
    ).toThrow(PreferencesInvalidError);
  });

  it('refuses quiet hours with a start or an end missing, and ones that are not an object', () => {
    for (const quietHours of [
      { start: '22:00' },
      { end: '07:00' },
      {},
      null,
      '22:00-07:00',
      ['22:00', '07:00'],
    ]) {
      expect(
        () => parsePreferences({ quietHours }),
        JSON.stringify(quietHours),
      ).toThrow(PreferencesInvalidError);
    }
  });

  it.each([
    ['emailFormat', 'rich'],
    ['documentFormat', 'braille'],
    ['textSize', 'huge'],
    ['preferredChannel', 'post'],
    ['notificationRhythm', 'weekly'],
  ])('refuses a value %s does not allow', (field, value) => {
    for (const bad of [value, '', null, 5, true, ['html'], {}]) {
      const error = refusal({ [field]: bad });
      expect(error.issues.map((issue) => issue.path)).toEqual([field]);
    }
  });

  it('refuses a field it does not know, at the top and inside quiet hours', () => {
    expect(refusal({ emailFormat: 'html', fontName: 'Comic' }).issues).toEqual([
      { path: '', code: 'unrecognized_keys' },
    ]);
    expect(
      refusal({ quietHours: { start: '22:00', end: '07:00', days: 5 } }).issues,
    ).toEqual([{ path: 'quietHours', code: 'unrecognized_keys' }]);
  });

  it('refuses what is not an object', () => {
    for (const value of [null, undefined, 'html', 5, true, [], [{}]]) {
      expect(
        () => parsePreferences(value),
        JSON.stringify(value) ?? 'undefined',
      ).toThrow(PreferencesInvalidError);
    }
  });

  it('says where and why, and never what: no error holds a value the caller sent', () => {
    for (const value of [
      { emailFormat: SECRET },
      { textSize: [SECRET] },
      { quietHours: { start: SECRET, end: '07:00' } },
      { [SECRET]: 'html' },
      { quietHours: { start: '22:00', end: '07:00', [SECRET]: true } },
    ]) {
      const error = refusal(value);
      expect(error.message).not.toContain(SECRET);
      expect(JSON.stringify(error.issues)).not.toContain(SECRET);
      expect(error.issues.length).toBeGreaterThan(0);
    }
  });
});

describe('the defaults', () => {
  it('are the ones the design names', () => {
    expect(PREFERENCE_DEFAULTS).toEqual({
      emailFormat: 'html',
      documentFormat: 'standard',
      textSize: 'default',
      preferredChannel: 'email',
      notificationRhythm: 'instant',
      quietHours: null,
    });
  });

  it('are what a person who chose nothing gets', () => {
    expect(withDefaults({})).toEqual(PREFERENCE_DEFAULTS);
  });

  it('apply to every field that is left out, and only to those', () => {
    expect(
      withDefaults({
        textSize: 'large',
        quietHours: { start: '22:00', end: '07:00' },
      }),
    ).toEqual({
      ...PREFERENCE_DEFAULTS,
      textSize: 'large',
      quietHours: { start: '22:00', end: '07:00' },
    });
  });

  it('keep a choice that equals the default as a choice, so every value reads back', () => {
    expect(withDefaults({ emailFormat: 'html' }).emailFormat).toBe('html');
  });

  it('cannot be changed by a caller: the constant is frozen and each answer is a new object', () => {
    expect(Object.isFrozen(PREFERENCE_DEFAULTS)).toBe(true);
    const first = withDefaults({});
    first.textSize = 'extra-large';
    expect(withDefaults({}).textSize).toBe('default');
    expect(PREFERENCE_DEFAULTS.textSize).toBe('default');
  });
});
