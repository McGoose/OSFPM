import { z } from 'zod';
import { PreferencesInvalidError } from './errors.js';

/**
 * The shape of a person's delivery preferences (decision D-69, P-02l2): how they want to
 * receive information. They are ordinary settings, not sensitive data, so nobody has to
 * disclose anything to get an accessible format. Every field is optional, only the choices
 * a person made are stored, and a default is applied when the preferences are read
 * (`withDefaults`). The schema is strict: a field it does not know is refused, and so is a
 * value it does not allow.
 *
 * An urgent message may override the quiet hours and the digest. That is a decision of the
 * email module (P-03c), made when that module exists, and not made here: the preferences
 * only say what the person chose, and `effectivePreferences` returns it as it is.
 */

/** The ways an email can be formatted. Every email also has a plain-text part, whatever is chosen. */
export const EMAIL_FORMATS = ['html', 'plain-text'] as const;
/** One value of `EMAIL_FORMATS`. */
export type EmailFormat = (typeof EMAIL_FORMATS)[number];

/** The formats a document, such as a call sheet, can be sent in. */
export const DOCUMENT_FORMATS = [
  'standard',
  'easy-read',
  'large-print',
] as const;
/** One value of `DOCUMENT_FORMATS`. */
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

/** The text sizes a person can ask for. */
export const TEXT_SIZES = ['default', 'large', 'extra-large'] as const;
/** One value of `TEXT_SIZES`. */
export type TextSize = (typeof TEXT_SIZES)[number];

/** The channels a person can ask to be reached on. */
export const PREFERRED_CHANNELS = ['email', 'sms', 'app'] as const;
/** One value of `PREFERRED_CHANNELS`. */
export type PreferredChannel = (typeof PREFERRED_CHANNELS)[number];

/** How often a person wants to hear: each message as it comes, or one digest a day. */
export const NOTIFICATION_RHYTHMS = ['instant', 'daily-digest'] as const;
/** One value of `NOTIFICATION_RHYTHMS`. */
export type NotificationRhythm = (typeof NOTIFICATION_RHYTHMS)[number];

/** A time of day, `HH:MM` on a 24-hour clock. Fixed length, so the check needs no loop. */
const timeOfDay = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);

/**
 * The hours a person does not want to be messaged, in their own time zone: `start` and
 * `end` as `HH:MM`. The window may cross midnight (22:00 to 07:00), so `end` is not
 * required to be later than `start`; the two may not be equal, because a window that
 * starts and ends at one time says nothing (is it no time, or the whole day?).
 */
export const quietHoursSchema = z
  .strictObject({ start: timeOfDay, end: timeOfDay })
  .refine((hours) => hours.start !== hours.end, {
    error: 'Quiet hours start and end at different times',
    path: ['end'],
  });

/**
 * What a person has chosen. Every field is optional, and a field that is left out is not
 * chosen. The one schema for the account holder's `user_preferences`, for a person's
 * `person.communication_preferences`, and for the body of `PUT /me/preferences`.
 */
export const preferencesSchema = z.strictObject({
  emailFormat: z.enum(EMAIL_FORMATS).optional(),
  documentFormat: z.enum(DOCUMENT_FORMATS).optional(),
  textSize: z.enum(TEXT_SIZES).optional(),
  preferredChannel: z.enum(PREFERRED_CHANNELS).optional(),
  notificationRhythm: z.enum(NOTIFICATION_RHYTHMS).optional(),
  quietHours: quietHoursSchema.optional(),
});
/** What a person has chosen: `preferencesSchema` as a type. */
export type Preferences = z.infer<typeof preferencesSchema>;

/**
 * What applies to a person: every field has a value, the person's choice or the default.
 * `quietHours` is `null` when there are none.
 */
export const effectivePreferencesSchema = z.strictObject({
  emailFormat: z.enum(EMAIL_FORMATS),
  documentFormat: z.enum(DOCUMENT_FORMATS),
  textSize: z.enum(TEXT_SIZES),
  preferredChannel: z.enum(PREFERRED_CHANNELS),
  notificationRhythm: z.enum(NOTIFICATION_RHYTHMS),
  quietHours: quietHoursSchema.nullable(),
});
/** What applies to a person: `effectivePreferencesSchema` as a type. */
export type EffectivePreferences = z.infer<typeof effectivePreferencesSchema>;

/**
 * What applies to a person who chose nothing. The one place the defaults live (decision
 * D-69). HTML is the default email format because every email also has a plain-text part,
 * whatever is chosen. Frozen, so no caller can change what everyone gets.
 */
export const PREFERENCE_DEFAULTS: Readonly<EffectivePreferences> =
  Object.freeze({
    emailFormat: 'html',
    documentFormat: 'standard',
    textSize: 'default',
    preferredChannel: 'email',
    notificationRhythm: 'instant',
    quietHours: null,
  });

/**
 * The preferences that apply, from what was chosen: each choice stands and every field left
 * out takes its default (`PREFERENCE_DEFAULTS`). A new object each time, so a caller may
 * change the answer. Reads and checks nothing; `stored` is taken as it is, so pass it
 * through `parsePreferences` first when it did not come from a schema-checked place.
 */
export function withDefaults(stored: Preferences): EffectivePreferences {
  return {
    emailFormat: stored.emailFormat ?? PREFERENCE_DEFAULTS.emailFormat,
    documentFormat: stored.documentFormat ?? PREFERENCE_DEFAULTS.documentFormat,
    textSize: stored.textSize ?? PREFERENCE_DEFAULTS.textSize,
    preferredChannel:
      stored.preferredChannel ?? PREFERENCE_DEFAULTS.preferredChannel,
    notificationRhythm:
      stored.notificationRhythm ?? PREFERENCE_DEFAULTS.notificationRhythm,
    quietHours:
      stored.quietHours === undefined
        ? PREFERENCE_DEFAULTS.quietHours
        : { start: stored.quietHours.start, end: stored.quietHours.end },
  };
}

/**
 * Checks `input` against `preferencesSchema` and returns what the schema parsed, which is
 * what gets stored. Every write of preferences goes through it, so the check is the same
 * wherever they are kept.
 *
 * @throws PreferencesInvalidError for input that breaks the schema; it lists paths and
 * codes, never values, and nothing is written.
 */
export function parsePreferences(input: unknown): Preferences {
  const parsed = preferencesSchema.safeParse(input);
  if (!parsed.success) {
    throw new PreferencesInvalidError(
      parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        code: issue.code,
      })),
    );
  }
  return parsed.data;
}
