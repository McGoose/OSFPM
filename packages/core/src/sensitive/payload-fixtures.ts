import type { SensitiveCategory } from './schemas.js';

/** An invented company id for the `representation` payload below. */
export const AGENCY_ID = '0192f0a0-7c3e-7a3b-8a4d-1b2c3d4e5f60';

/**
 * Valid payloads for tests, one per category. Invented details for people in
 * the demo production The Last Withdrawal; never real data (CLAUDE.md, Test
 * data).
 */
export const VALID_PAYLOADS: Record<
  SensitiveCategory,
  Record<string, unknown>
> = {
  dietary: {
    restrictions: ['vegetarian'],
    allergies: ['peanuts'],
    notes: 'No nuts on set',
  },
  medical: {
    conditions: 'Asthma',
    medication: 'Inhaler',
    notes: 'Carries it',
  },
  accessibility: {
    noEarlierThan: '08:30',
    maxWorkingHours: 10,
    stepFreeRequired: true,
    maxWalkMetres: 100,
    quietSpace: true,
    signLanguageInterpreter: 'hr-HR-SL',
    notes: 'Prefers the ground-floor trailer',
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

/** Every string value inside `value`, however deeply nested. */
export function leafStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(leafStrings);
  if (value && typeof value === 'object') {
    return Object.values(value).flatMap(leafStrings);
  }
  return [];
}
