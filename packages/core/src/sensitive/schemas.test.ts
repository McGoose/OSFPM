import { describe, expect, it } from 'vitest';
import {
  SENSITIVE_CATEGORIES,
  payloadSchemas,
  type SensitiveCategory,
} from './schemas.js';

const AGENCY_ID = '0192f0a0-7c3e-7a3b-8a4d-1b2c3d4e5f60';

/** Invented data for people in the demo production, never real details. */
const VALID: Record<SensitiveCategory, unknown> = {
  dietary: {
    restrictions: ['vegetarian'],
    allergies: ['peanuts'],
    notes: 'No nuts on set',
  },
  medical: { conditions: 'Asthma', medication: 'Inhaler', notes: 'Carries it' },
  accessibility: {
    needs: 'Step-free access to trailer',
    notes: 'Ground floor',
  },
  emergency: {
    contacts: [
      {
        name: 'Jo Example',
        relation: 'Sibling',
        phone: '+44 7700 900123',
        email: 'jo@example.test',
      },
    ],
  },
  identity: {
    dateOfBirth: '1990-04-23',
    document: {
      type: 'passport',
      number: 'X1234567',
      issuingCountry: 'GB',
      expiry: '2031-01-31',
    },
    homeAddress: {
      line1: '1 Demo Street',
      city: 'Bristol',
      postcode: 'BS1 1AA',
      country: 'GB',
    },
  },
  financial: {
    iban: 'GB00DEMO00000000000000',
    bic: 'DEMOGB2L',
    accountHolder: 'Alex Demo',
    taxNumber: 'TAX-0000',
  },
  representation: {
    agentName: 'Sam Agent',
    agencyCompanyId: AGENCY_ID,
    phone: '+44 20 7946 0000',
    email: 'agent@example.test',
  },
  compliance: {
    taxResidency: 'GB',
    citizenships: ['GB', 'IE'],
    relatedParty: { isRelated: false },
  },
};

/** Payloads a category must refuse. */
const INVALID: Record<SensitiveCategory, unknown[]> = {
  dietary: [
    { restrictions: 'vegan', allergies: [] },
    { restrictions: [], allergies: [1] },
    { restrictions: [] },
    { restrictions: [], allergies: [], extra: true },
  ],
  medical: [{ conditions: 5 }, { unknown: 'x' }],
  accessibility: [{}, { needs: 5 }, { needs: 'ramp', extra: 'x' }],
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
    expect(payloadSchemas.accessibility.safeParse({ needs: 'x' }).success).toBe(
      true,
    );
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
