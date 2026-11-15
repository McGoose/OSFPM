import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  base,
  seedCompany,
  seedOrganisation,
  seedPerson,
  type SeedOrganisation,
} from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import { contract, contractLink, contractParty } from '../db/schema/index.js';
import {
  createMigratedDatabase,
  failureOf,
  SQLSTATE,
  testTargets,
} from '../db/test-support.js';

// Typed out by hand from the design, not taken from the schema constants, so
// a kind dropped from the schema is noticed here.
const KINDS = [
  'deal-memo',
  'crew-contract',
  'cast-contract',
  'location-agreement',
  'release',
  'chain-of-title',
  'option',
  'insurance-certificate',
  'co-production-agreement',
  'financing-agreement',
  'sales-agency',
  'distribution',
  'music-licence',
  'other',
];
const STATUSES = [
  'draft',
  'negotiating',
  'signed',
  'active',
  'expired',
  'terminated',
];
const LINK_TYPES = [
  'project',
  'person',
  'company',
  'location',
  'unit',
  'episode',
];

const checkViolation = (constraint: string) => ({
  code: SQLSTATE.checkViolation,
  constraint,
});
const fkViolation = (constraint: string) => ({
  code: SQLSTATE.foreignKeyViolation,
  constraint,
});
const uniqueViolation = (constraint: string) => ({
  code: SQLSTATE.uniqueViolation,
  constraint,
});

describe.each(testTargets)('the contract tables on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  let a: SeedOrganisation;
  let b: SeedOrganisation;
  const db = () => database.db;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    a = await seedOrganisation(database);
    b = await seedOrganisation(database);
  });
  afterAll(async () => {
    await cleanup();
  });

  const contractValues = (
    organisationId: string,
    overrides: Partial<typeof contract.$inferInsert> = {},
  ) =>
    ({
      ...base(organisationId),
      kind: 'deal-memo',
      title: 'Deal memo: first assistant director',
      status: 'draft',
      ...overrides,
    }) satisfies typeof contract.$inferInsert;

  const insertContract = async (
    organisationId: string,
    overrides: Partial<typeof contract.$inferInsert> = {},
  ) => {
    const [row] = await db()
      .insert(contract)
      .values(contractValues(organisationId, overrides))
      .returning();
    return row!;
  };

  const partyValues = (
    organisationId: string,
    contractId: string,
    who: { personId?: string; companyId?: string },
    partyRole = 'engaged',
  ) =>
    ({
      ...base(organisationId),
      contractId,
      personId: who.personId ?? null,
      companyId: who.companyId ?? null,
      partyRole,
    }) satisfies typeof contractParty.$inferInsert;

  const linkValues = (
    organisationId: string,
    contractId: string,
    entityType: string,
    entityId = newId(),
  ) =>
    ({
      ...base(organisationId),
      contractId,
      entityType,
      entityId,
    }) as typeof contractLink.$inferInsert;

  describe('contract', () => {
    it('defaults to private visibility and the contract retention class, with no territories, currency or amount', async () => {
      const row = await insertContract(a.organisationId);
      expect(row).toMatchObject({
        visibility: 'private',
        retentionClass: 'contract',
        projectId: null,
        territories: [],
        currency: null,
        totalValue: null,
        signedOn: null,
        effectiveFrom: null,
        effectiveTo: null,
      });
    });

    it.each(KINDS)('accepts the kind %s', async (kind) => {
      await insertContract(a.organisationId, { kind: kind as never });
    });

    it('rejects an unknown kind', async () => {
      expect(
        await failureOf(() =>
          db()
            .insert(contract)
            .values(
              contractValues(a.organisationId, { kind: 'handshake' as never }),
            ),
        ),
      ).toEqual(checkViolation('contract_kind_check'));
    });

    it.each(STATUSES)('accepts the status %s', async (status) => {
      await insertContract(a.organisationId, { status: status as never });
    });

    it('rejects an unknown status', async () => {
      expect(
        await failureOf(() =>
          db()
            .insert(contract)
            .values(
              contractValues(a.organisationId, { status: 'void' as never }),
            ),
        ),
      ).toEqual(checkViolation('contract_status_check'));
    });

    describe('the effective period', () => {
      it('rejects an end before the start', async () => {
        expect(
          await failureOf(() =>
            db()
              .insert(contract)
              .values(
                contractValues(a.organisationId, {
                  effectiveFrom: '2026-03-01',
                  effectiveTo: '2026-02-28',
                }),
              ),
          ),
        ).toEqual(checkViolation('contract_effective_period_check'));
      });

      it('accepts an end on the start day, and a start or an end alone', async () => {
        await insertContract(a.organisationId, {
          effectiveFrom: '2026-03-01',
          effectiveTo: '2026-03-01',
        });
        await insertContract(a.organisationId, { effectiveFrom: '2026-03-01' });
        await insertContract(a.organisationId, { effectiveTo: '2025-01-01' });
      });
    });

    describe('currency and amount', () => {
      it.each(['gbp', 'GB', 'GBPP', 'G1P', ''])(
        'rejects the currency %j',
        async (currency) => {
          expect(
            await failureOf(() =>
              db()
                .insert(contract)
                .values(contractValues(a.organisationId, { currency })),
            ),
          ).toEqual(checkViolation('contract_currency_check'));
        },
      );

      it('rejects an amount without a currency', async () => {
        expect(
          await failureOf(() =>
            db()
              .insert(contract)
              .values(
                contractValues(a.organisationId, { totalValue: '1000.00' }),
              ),
          ),
        ).toEqual(checkViolation('contract_total_value_currency_check'));
      });

      it('accepts a currency without an amount, and keeps four decimal places of an amount', async () => {
        const withoutAmount = await insertContract(a.organisationId, {
          currency: 'EUR',
        });
        expect(withoutAmount).toMatchObject({
          currency: 'EUR',
          totalValue: null,
        });
        const withAmount = await insertContract(a.organisationId, {
          currency: 'GBP',
          totalValue: '12500.5',
        });
        expect(withAmount.totalValue).toBe('12500.5000');
      });
    });

    describe('territories', () => {
      it.each([[['WW']], [['GB', 'FR', 'US']], [[]]])(
        'accepts %j',
        async (territories) => {
          const row = await insertContract(a.organisationId, { territories });
          expect(row.territories).toEqual(territories);
        },
      );

      it.each([
        ['lower case', sql`ARRAY['gb']::text[]`],
        ['three letters', sql`ARRAY['GBR']::text[]`],
        ['one letter', sql`ARRAY['G']::text[]`],
        ['an empty code', sql`ARRAY['']::text[]`],
        ['a digit', sql`ARRAY['U2']::text[]`],
        ['one bad code among good ones', sql`ARRAY['US', 'u2', 'GB']::text[]`],
        ['two codes in one element', sql`ARRAY['US,GB']::text[]`],
        ['a trailing space', sql`ARRAY['US ']::text[]`],
        ['a null element', sql`ARRAY['US', NULL]::text[]`],
        ['two dimensions', sql`'{{US},{GB}}'::text[]`],
      ])('rejects %s', async (_name, territories) => {
        expect(
          await failureOf(() =>
            db()
              .insert(contract)
              .values(
                contractValues(a.organisationId, {
                  territories: territories as never,
                }),
              ),
          ),
        ).toEqual(checkViolation('contract_territories_check'));
      });
    });

    describe('the project', () => {
      it('accepts a project of the same organisation', async () => {
        const row = await insertContract(a.organisationId, {
          projectId: a.projectId,
        });
        expect(row.projectId).toBe(a.projectId);
      });

      it('rejects a project of another organisation', async () => {
        expect(
          await failureOf(() =>
            db()
              .insert(contract)
              .values(
                contractValues(a.organisationId, { projectId: b.projectId }),
              ),
          ),
        ).toEqual(fkViolation('contract_project_fk'));
      });

      it('rejects an organisation that does not exist', async () => {
        expect(
          await failureOf(() =>
            db().insert(contract).values(contractValues(newId())),
          ),
        ).toEqual(fkViolation('contract_organisation_fk'));
      });
    });
  });

  describe('contract_party', () => {
    it('defaults to private visibility and the contract retention class', async () => {
      const c = await insertContract(a.organisationId);
      const personId = await seedPerson(database, a.organisationId);
      const [row] = await db()
        .insert(contractParty)
        .values(partyValues(a.organisationId, c.id, { personId }))
        .returning();
      expect(row).toMatchObject({
        visibility: 'private',
        retentionClass: 'contract',
        personId,
        companyId: null,
      });
    });

    it('accepts a company', async () => {
      const c = await insertContract(a.organisationId);
      const companyId = await seedCompany(database, a.organisationId);
      const [row] = await db()
        .insert(contractParty)
        .values(partyValues(a.organisationId, c.id, { companyId }))
        .returning();
      expect(row).toMatchObject({ personId: null, companyId });
    });

    it('rejects a party that is both a person and a company, and one that is neither', async () => {
      const c = await insertContract(a.organisationId);
      const personId = await seedPerson(database, a.organisationId);
      const companyId = await seedCompany(database, a.organisationId);
      for (const who of [{ personId, companyId }, {}]) {
        expect(
          await failureOf(() =>
            db()
              .insert(contractParty)
              .values(partyValues(a.organisationId, c.id, who)),
          ),
        ).toEqual(checkViolation('contract_party_one_party_check'));
      }
    });

    it('rejects a contract of another organisation', async () => {
      const bContract = await insertContract(b.organisationId);
      const personId = await seedPerson(database, a.organisationId);
      expect(
        await failureOf(() =>
          db()
            .insert(contractParty)
            .values(partyValues(a.organisationId, bContract.id, { personId })),
        ),
      ).toEqual(fkViolation('contract_party_contract_fk'));
    });

    it('rejects a person of another organisation', async () => {
      const c = await insertContract(a.organisationId);
      const bPerson = await seedPerson(database, b.organisationId);
      expect(
        await failureOf(() =>
          db()
            .insert(contractParty)
            .values(partyValues(a.organisationId, c.id, { personId: bPerson })),
        ),
      ).toEqual(fkViolation('contract_party_person_fk'));
    });

    it('rejects a company of another organisation', async () => {
      const c = await insertContract(a.organisationId);
      const bCompany = await seedCompany(database, b.organisationId);
      expect(
        await failureOf(() =>
          db()
            .insert(contractParty)
            .values(
              partyValues(a.organisationId, c.id, { companyId: bCompany }),
            ),
        ),
      ).toEqual(fkViolation('contract_party_company_fk'));
    });

    // A party is a person or a company, so one of the two columns is always
    // NULL, and a plain UNIQUE would let either kind of party repeat a role.
    describe('duplicates', () => {
      const DUPLICATE = uniqueViolation(
        'contract_party_contract_person_company_role_unique',
      );

      it('rejects the same person in the same role twice', async () => {
        const c = await insertContract(a.organisationId);
        const personId = await seedPerson(database, a.organisationId);
        await db()
          .insert(contractParty)
          .values(partyValues(a.organisationId, c.id, { personId }, 'artist'));
        expect(
          await failureOf(() =>
            db()
              .insert(contractParty)
              .values(
                partyValues(a.organisationId, c.id, { personId }, 'artist'),
              ),
          ),
        ).toEqual(DUPLICATE);
      });

      it('rejects the same company in the same role twice', async () => {
        const c = await insertContract(a.organisationId);
        const companyId = await seedCompany(database, a.organisationId);
        await db()
          .insert(contractParty)
          .values(
            partyValues(a.organisationId, c.id, { companyId }, 'licensor'),
          );
        expect(
          await failureOf(() =>
            db()
              .insert(contractParty)
              .values(
                partyValues(a.organisationId, c.id, { companyId }, 'licensor'),
              ),
          ),
        ).toEqual(DUPLICATE);
      });

      it('allows another role, another person, and the same person on another contract', async () => {
        const c = await insertContract(a.organisationId);
        const other = await insertContract(a.organisationId);
        const first = await seedPerson(database, a.organisationId);
        const second = await seedPerson(database, a.organisationId);
        const insert = (contractId: string, personId: string, role: string) =>
          db()
            .insert(contractParty)
            .values(
              partyValues(a.organisationId, contractId, { personId }, role),
            );
        await insert(c.id, first, 'artist');
        await insert(c.id, first, 'producer');
        await insert(c.id, second, 'artist');
        await insert(other.id, first, 'artist');
      });
    });
  });

  describe('contract_link', () => {
    it('defaults to private visibility and the contract retention class', async () => {
      const c = await insertContract(a.organisationId);
      const [row] = await db()
        .insert(contractLink)
        .values(linkValues(a.organisationId, c.id, 'location'))
        .returning();
      expect(row).toMatchObject({
        visibility: 'private',
        retentionClass: 'contract',
        entityType: 'location',
      });
    });

    it.each(LINK_TYPES)('accepts the entity type %s', async (entityType) => {
      const c = await insertContract(a.organisationId);
      await db()
        .insert(contractLink)
        .values(linkValues(a.organisationId, c.id, entityType));
    });

    it('rejects an unknown entity type', async () => {
      const c = await insertContract(a.organisationId);
      expect(
        await failureOf(() =>
          db()
            .insert(contractLink)
            .values(linkValues(a.organisationId, c.id, 'budget')),
        ),
      ).toEqual(checkViolation('contract_link_entity_type_check'));
    });

    it('rejects a contract of another organisation', async () => {
      const bContract = await insertContract(b.organisationId);
      expect(
        await failureOf(() =>
          db()
            .insert(contractLink)
            .values(linkValues(a.organisationId, bContract.id, 'location')),
        ),
      ).toEqual(fkViolation('contract_link_contract_fk'));
    });

    it('rejects the same record twice on one contract, but allows it on another contract or under another type', async () => {
      const c = await insertContract(a.organisationId);
      const other = await insertContract(a.organisationId);
      const entityId = newId();
      await db()
        .insert(contractLink)
        .values(linkValues(a.organisationId, c.id, 'person', entityId));
      expect(
        await failureOf(() =>
          db()
            .insert(contractLink)
            .values(linkValues(a.organisationId, c.id, 'person', entityId)),
        ),
      ).toEqual(
        uniqueViolation('contract_link_contract_entity_type_entity_unique'),
      );
      await db()
        .insert(contractLink)
        .values(linkValues(a.organisationId, other.id, 'person', entityId));
      await db()
        .insert(contractLink)
        .values(linkValues(a.organisationId, c.id, 'company', entityId));
    });
  });
});
