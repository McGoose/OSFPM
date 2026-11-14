import { z } from 'zod';

/**
 * Payload schemas for the sensitive personal data categories. Every schema is a
 * strict object: unknown keys are refused, so a payload cannot smuggle in
 * fields no category defines.
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

export type SensitivePayloads = {
  [C in SensitiveCategory]: z.infer<(typeof payloadSchemas)[C]>;
};
export type SensitivePayload<C extends SensitiveCategory = SensitiveCategory> =
  SensitivePayloads[C];

export function isSensitiveCategory(
  value: unknown,
): value is SensitiveCategory {
  return (SENSITIVE_CATEGORIES as readonly unknown[]).includes(value);
}
