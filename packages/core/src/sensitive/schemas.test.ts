import { describe, expect, it } from 'vitest';
import { VALID_PAYLOADS as VALID } from './payload-fixtures.js';
import {
  SENSITIVE_CATEGORIES,
  payloadSchemas,
  type SensitiveCategory,
} from './schemas.js';

/** Payloads a category must refuse. */
const INVALID: Record<SensitiveCategory, unknown[]> = {
  dietary: [
    { restrictions: 'vegan', allergies: [] },
    { restrictions: [], allergies: [1] },
    { restrictions: [] },
    { restrictions: [], allergies: [], extra: true },
  ],
  medical: [{ conditions: 5 }, { unknown: 'x' }],
  accessibility: [
    {},
    { stepFreeRequired: 'yes' },
    { stepFreeRequired: true, extra: 'x' },
    { needs: 'ramp' },
  ],
  emergency: [
    { contacts: [] },
    { contacts: [{ name: 'Jo Example' }] },
    { contacts: [{ name: 'Jo Example', phone: '1', extra: 'x' }] },
    {},
  ],
  identity: [
    { dateOfBirth: '23/04/1990' },
    { dateOfBirth: '1990-13-40' },
    { document: { type: 'licence', number: '1', issuingCountry: 'GB' } },
    { document: { type: 'passport', number: '1', issuingCountry: 'gb' } },
    { document: { type: 'passport', number: '1', issuingCountry: 'GBR' } },
    {
      document: {
        type: 'passport',
        number: '1',
        issuingCountry: 'GB',
        expiry: '2031',
      },
    },
    {
      homeAddress: { line1: '1 Demo Street', city: 'Bristol', country: 'Eng' },
    },
    { homeAddress: { city: 'Bristol', country: 'GB' } },
  ],
  financial: [{ iban: 5 }, { sortCode: '00-00-00' }],
  representation: [
    { agencyCompanyId: 'not-a-uuid' },
    { agentName: 5 },
    { agentName: 'Sam', extra: 'x' },
  ],
  compliance: [
    { citizenships: [], taxResidency: 'gb' },
    { citizenships: ['GBR'] },
    { citizenships: 'GB' },
    { citizenships: [], relatedParty: { relation: 'cousin' } },
    { citizenships: [], relatedParty: { isRelated: 'no' } },
    {},
  ],
};

describe('sensitive categories', () => {
  it('lists the eight categories', () => {
    expect([...SENSITIVE_CATEGORIES].sort()).toEqual([
      'accessibility',
      'compliance',
      'dietary',
      'emergency',
      'financial',
      'identity',
      'medical',
      'representation',
    ]);
    expect(Object.keys(payloadSchemas).sort()).toEqual(
      [...SENSITIVE_CATEGORIES].sort(),
    );
  });
});

describe.each(SENSITIVE_CATEGORIES)('%s payload', (category) => {
  const schema = payloadSchemas[category];

  it('accepts a valid payload unchanged', () => {
    expect(schema.parse(VALID[category])).toEqual(VALID[category]);
  });

  it.each(INVALID[category].map((payload, i) => [i, payload] as const))(
    'rejects invalid example %i',
    (_i, payload) => {
      expect(schema.safeParse(payload).success).toBe(false);
    },
  );
});

describe('optional fields', () => {
  it('accepts the smallest valid payload of each category', () => {
    expect(
      payloadSchemas.dietary.safeParse({ restrictions: [], allergies: [] })
        .success,
    ).toBe(true);
    expect(payloadSchemas.medical.safeParse({}).success).toBe(true);
    expect(
      payloadSchemas.accessibility.safeParse({ stepFreeRequired: true })
        .success,
    ).toBe(true);
    expect(
      payloadSchemas.emergency.safeParse({
        contacts: [{ name: 'Jo Example', phone: '1' }],
      }).success,
    ).toBe(true);
    expect(payloadSchemas.identity.safeParse({}).success).toBe(true);
    expect(payloadSchemas.financial.safeParse({}).success).toBe(true);
    expect(payloadSchemas.representation.safeParse({}).success).toBe(true);
    expect(
      payloadSchemas.compliance.safeParse({ citizenships: [] }).success,
    ).toBe(true);
  });
});
