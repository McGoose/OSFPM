import { z } from 'zod';

/**
 * Payload schemas for the sensitive personal data categories. Every schema is a
 * strict object: unknown keys are refused, so a payload cannot smuggle in
 * fields no category defines.
 */

/**
 * The eight categories of crew personal data kept in `person_sensitive`
 * (CLAUDE.md, Privacy rule). Must equal `PERSON_SENSITIVE_CATEGORIES`; a test
 * checks it. A new category needs a payload schema below, a retention class in
 * `service.ts`, and a migration for the table's CHECK.
 */
export const SENSITIVE_CATEGORIES = [
  'dietary',
  'medical',
  'accessibility',
  'emergency',
  'identity',
  'financial',
  'representation',
  'compliance',
] as const;
/** One value of `SENSITIVE_CATEGORIES`. */
export type SensitiveCategory = (typeof SENSITIVE_CATEGORIES)[number];

/** ISO 3166-1 alpha-2 shape, upper case. */
const country = z
  .string()
  .regex(/^[A-Z]{2}$/, 'Expected a two-letter country code');

/** A calendar date, `YYYY-MM-DD`. */
const isoDate = z.iso.date();

const text = z.string().min(1);

const dietary = z.strictObject({
  restrictions: z.array(text),
  allergies: z.array(text),
  notes: text.optional(),
});

const medical = z.strictObject({
  conditions: text.optional(),
  medication: text.optional(),
  notes: text.optional(),
});

/** A time of day on a 24-hour clock, `HH:MM`. Zod's own format, so no pattern of ours runs on request data. */
const timeOfDay = z.iso.time({ precision: -1 });

/** A whole number from `min` to `max`, both included. */
const wholeNumber = (min: number, max: number) =>
  z.number().int().min(min).max(max);

/** The longest language tag we accept. RFC 5646 advises room for 35 characters. */
const LANGUAGE_TAG_MAX_LENGTH = 35;
/** The most subtags we accept in one tag, the language included. */
const LANGUAGE_TAG_MAX_SUBTAGS = 8;
/** The longest subtag in RFC 5646. */
const LANGUAGE_SUBTAG_MAX_LENGTH = 8;

/**
 * True when `value` has the shape of a BCP 47 language tag, such as `hr-HR-SL`:
 * two to eight letters for the language, then up to seven more subtags of one to
 * eight letters or digits each, joined by hyphens, in at most 35 characters. It
 * checks the shape only, not the IANA registry, so a tag nobody registered passes.
 * It reads each character once and uses no regular expression, so a hostile
 * string costs no more than its own length, and a long one is refused by its length
 * before anything reads it (CLAUDE.md, Code rules).
 */
export function isLanguageTagShaped(value: string): boolean {
  if (value.length < 2 || value.length > LANGUAGE_TAG_MAX_LENGTH) return false;
  const subtags = value.split('-');
  if (subtags.length > LANGUAGE_TAG_MAX_SUBTAGS) return false;
  return subtags.every((subtag, index) => {
    const shortest = index === 0 ? 2 : 1;
    if (
      subtag.length < shortest ||
      subtag.length > LANGUAGE_SUBTAG_MAX_LENGTH
    ) {
      return false;
    }
    for (let at = 0; at < subtag.length; at += 1) {
      const code = subtag.charCodeAt(at);
      const letter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
      const digit = code >= 48 && code <= 57;
      // The language is letters only; the subtags after it may hold digits.
      if (!letter && !(digit && index > 0)) return false;
    }
    return true;
  });
}

/** A BCP 47-shaped language tag (`isLanguageTagShaped`). */
const languageTag = z
  .string()
  .refine(isLanguageTagShaped, 'Expected a language tag such as hr-HR-SL');

/**
 * The adjustments a person can ask for (decision D-69): practical things that change
 * what a production does, never a condition or a diagnosis. Every field is optional
 * and the keys are the same in every group; `ACCESS_FIELDS` says which group each is
 * in. Booleans say "this is needed"; numbers are whole numbers.
 */
const accessibilityShape = {
  // schedule
  noEarlierThan: timeOfDay.optional(),
  noLaterThan: timeOfDay.optional(),
  maxWorkingHours: wholeNumber(1, 24).optional(),
  breakEveryMinutes: wholeNumber(15, 480).optional(),
  breakLengthMinutes: wholeNumber(5, 120).optional(),
  advanceNoticeHours: wholeNumber(1, 336).optional(),
  // physical
  stepFreeRequired: z.boolean().optional(),
  seatingNeeded: z.boolean().optional(),
  maxWalkMetres: wholeNumber(0, 5000).optional(),
  accessibleToiletMaxMetres: wholeNumber(0, 5000).optional(),
  // transport
  accessibleParking: z.boolean().optional(),
  cannotDrive: z.boolean().optional(),
  needsTransport: z.boolean().optional(),
  // communication
  noEarpiece: z.boolean().optional(),
  textFirst: z.boolean().optional(),
  extraThinkingTime: z.boolean().optional(),
  signLanguageInterpreter: languageTag.optional(),
  // environment
  quietSpace: z.boolean().optional(),
  noiseSensitive: z.boolean().optional(),
  previewLocation: z.boolean().optional(),
  // support
  supportWorker: z.boolean().optional(),
  assistanceAnimal: z.boolean().optional(),
  // notes
  notes: z.string().min(1).max(2000).optional(),
};

/**
 * The accessibility payload: structured adjustments in a strict object, so an
 * unknown key is refused. At least one field must be set; a field set to `false` or
 * `0` counts as set. Nothing here asks for a condition or a diagnosis.
 */
const accessibility = z
  .strictObject(accessibilityShape)
  .refine(
    (adjustments) => Object.values(adjustments).some((v) => v !== undefined),
    {
      message: 'Set at least one adjustment',
    },
  );

/**
 * The groups the adjustments are shared in, in the order the spec lists them. A person
 * can share a whole group with a role at once; `notes` is a group of its own because it
 * is free text and is never shared with the others (see `shareWithSuggestedRoles`).
 */
export const ACCESS_GROUPS = [
  'schedule',
  'physical',
  'transport',
  'communication',
  'environment',
  'support',
  'notes',
] as const;
/** One value of `ACCESS_GROUPS`. */
export type AccessGroup = (typeof ACCESS_GROUPS)[number];

/** One key of the accessibility payload. */
export type AccessField = keyof typeof accessibilityShape;

// The group of every field. `satisfies` makes the compiler refuse a field with no
// group and a group for no field, so the payload and this list cannot drift apart.
const GROUP_OF_FIELD = {
  noEarlierThan: 'schedule',
  noLaterThan: 'schedule',
  maxWorkingHours: 'schedule',
  breakEveryMinutes: 'schedule',
  breakLengthMinutes: 'schedule',
  advanceNoticeHours: 'schedule',
  stepFreeRequired: 'physical',
  seatingNeeded: 'physical',
  maxWalkMetres: 'physical',
  accessibleToiletMaxMetres: 'physical',
  accessibleParking: 'transport',
  cannotDrive: 'transport',
  needsTransport: 'transport',
  noEarpiece: 'communication',
  textFirst: 'communication',
  extraThinkingTime: 'communication',
  signLanguageInterpreter: 'communication',
  quietSpace: 'environment',
  noiseSensitive: 'environment',
  previewLocation: 'environment',
  supportWorker: 'support',
  assistanceAnimal: 'support',
  notes: 'notes',
} as const satisfies Record<AccessField, AccessGroup>;

/**
 * Every field of the accessibility payload with its group: the keys a grant may name
 * (P-02l1, decision D-69). Field names are a hint at a condition, so they never go
 * into a log, an audit event or an error (CLAUDE.md, Privacy rule).
 */
export const ACCESS_FIELDS: readonly {
  readonly key: AccessField;
  readonly group: AccessGroup;
}[] = (Object.keys(GROUP_OF_FIELD) as AccessField[]).map((key) => ({
  key,
  group: GROUP_OF_FIELD[key],
}));

// A Map, so a string from a caller is looked up and never used to index an object
// (CLAUDE.md, Data rules): `constructor` and `__proto__` are not fields.
const GROUPS_BY_KEY: ReadonlyMap<string, AccessGroup> = new Map(
  ACCESS_FIELDS.map((entry) => [entry.key, entry.group]),
);

/** True when `value` is a key of the accessibility payload. Never reads an inherited name. */
export function isAccessField(value: unknown): value is AccessField {
  return typeof value === 'string' && GROUPS_BY_KEY.has(value);
}

/** The group of an accessibility field, or `undefined` for a string that is not one. */
export function accessFieldGroup(key: string): AccessGroup | undefined {
  return GROUPS_BY_KEY.get(key);
}

/**
 * The keys of the medical payload, which a grant may name too: `conditions`,
 * `medication` and `notes`. Taken from the payload schema, so they cannot drift from it.
 * Like the accessibility keys they never go into a log, an audit event or an error.
 */
export const MEDICAL_FIELDS = Object.keys(medical.shape) as Extract<
  keyof typeof medical.shape,
  string
>[];

const emergency = z.strictObject({
  contacts: z
    .array(
      z.strictObject({
        name: text,
        relation: text.optional(),
        phone: text,
        email: text.optional(),
      }),
    )
    .min(1),
});

const identity = z.strictObject({
  dateOfBirth: isoDate.optional(),
  document: z
    .strictObject({
      type: z.enum(['passport', 'id-card', 'other']),
      number: text,
      issuingCountry: country,
      expiry: isoDate.optional(),
    })
    .optional(),
  homeAddress: z
    .strictObject({
      line1: text,
      line2: text.optional(),
      city: text,
      postcode: text.optional(),
      region: text.optional(),
      country,
    })
    .optional(),
});

const financial = z.strictObject({
  iban: text.optional(),
  bic: text.optional(),
  accountHolder: text.optional(),
  taxNumber: text.optional(),
});

const representation = z.strictObject({
  agentName: text.optional(),
  agencyCompanyId: z.uuid().optional(),
  phone: text.optional(),
  email: text.optional(),
});

const compliance = z.strictObject({
  taxResidency: country.optional(),
  citizenships: z.array(country),
  relatedParty: z
    .strictObject({
      isRelated: z.boolean(),
      relation: text.optional(),
    })
    .optional(),
});

/**
 * One strict Zod schema per category. `writeSensitive` checks a payload against
 * its schema before anything is stored, and `complianceReport` reads the
 * `compliance` one back. The compiler checks that every category has a schema.
 */
export const payloadSchemas = {
  dietary,
  medical,
  accessibility,
  emergency,
  identity,
  financial,
  representation,
  compliance,
} satisfies Record<SensitiveCategory, z.ZodType>;

/** The payload type of each category, taken from its schema. */
export type SensitivePayloads = {
  [C in SensitiveCategory]: z.infer<(typeof payloadSchemas)[C]>;
};
/** The payload type of category `C`, or of any category if `C` is omitted. */
export type SensitivePayload<C extends SensitiveCategory = SensitiveCategory> =
  SensitivePayloads[C];

/**
 * True when `value` is one of the categories. It checks the constant list, so a
 * string from a caller is never used to index an object (CLAUDE.md, Data
 * rules): call it before `payloadSchemas[category]`.
 */
export function isSensitiveCategory(
  value: unknown,
): value is SensitiveCategory {
  return (SENSITIVE_CATEGORIES as readonly unknown[]).includes(value);
}
