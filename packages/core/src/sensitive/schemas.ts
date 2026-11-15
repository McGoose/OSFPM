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

const accessibility = z.strictObject({
  needs: text,
  notes: text.optional(),
});

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
