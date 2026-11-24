import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncPermissions } from '../access/permission-sync.js';
import {
  base,
  grantOnOrganisation,
  seedCompany,
  seedPerson,
  seedUser,
} from '../access/test-fixtures.js';
import { AccessDeniedError } from '../access/access-denied-error.js';
import type { Database } from '../db/client.js';
import { CONTRACT_KINDS } from '../db/schema/contract.js';
import {
  changeEvent,
  contract,
  contractTerms,
  personCompany,
} from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { RecordNotFoundError, VersionConflictError } from '../db/write.js';
import { CONTRACT_PERMISSIONS } from './permissions.js';
import {
  ContractInputError,
  ContractTermsConflictError,
  getContract,
  listContracts,
  listOwnContracts,
  removeContractTerms,
  setContractTerms,
  updateContract,
} from './service.js';
import {
  at,
  EDIT,
  errorOf,
  FULL_TERMS,
  FULL_TERMS_AMOUNTS,
  FULL_TERMS_WITHOUT_AMOUNTS,
  NOW,
  READ,
  READ_VALUE,
  seedContract,
  seedTermsWorld,
  type TermsWorld,
} from './test-support.js';
import type { ContractTermsInput } from './terms.js';

const AMOUNT_KEYS = ['rate', 'kitFee', 'perDiem', 'mileageRate'] as const;

describe.each(testTargets)('contract terms on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  const db = () => database.db;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    await syncPermissions(database.db, CONTRACT_PERMISSIONS);
  });
  afterAll(async () => {
    await cleanup();
  });

  const world = () => seedTermsWorld(database);
  const termsRows = (organisationId: string) =>
    db()
      .select()
      .from(contractTerms)
      .where(eq(contractTerms.organisationId, organisationId));
  const termsEvents = (organisationId: string) =>
    db()
      .select()
      .from(changeEvent)
      .where(
        and(
          eq(changeEvent.organisationId, organisationId),
          eq(changeEvent.entityType, 'contract_terms'),
        ),
      )
      .orderBy(asc(changeEvent.seq));
  const hasAmount = (view: object) =>
    AMOUNT_KEYS.filter((key) => Object.hasOwn(view, key));

  async function nothingWritten(w: TermsWorld) {
    expect(await termsRows(w.organisationId)).toEqual([]);
    expect(await termsEvents(w.organisationId)).toEqual([]);
  }

  describe('setContractTerms', () => {
    it('creates the terms of a contract, and the contract then shows them', async () => {
      const w = await world();
      const made = await seedContract(database, w);
      expect(made.terms).toBeNull();

      const terms = await setContractTerms(
        db(),
        at(w.manager),
        made.id,
        FULL_TERMS,
      );
      expect(terms).toMatchObject({
        contractId: made.id,
        organisationId: w.organisationId,
        version: 1,
        deletedAt: null,
        ...FULL_TERMS_AMOUNTS,
        ...FULL_TERMS_WITHOUT_AMOUNTS,
      });
      const seen = await getContract(db(), at(w.manager), made.id);
      expect(seen.terms).toEqual(terms);
      expect(await termsRows(w.organisationId)).toHaveLength(1);
    });

    it('keeps the fields that are left out, and clears a field set to null, when it changes the terms', async () => {
      const w = await world();
      const made = await seedContract(database, w);
      const first = await setContractTerms(
        db(),
        at(w.manager),
        made.id,
        FULL_TERMS,
      );
      const second = await setContractTerms(db(), at(w.manager), made.id, {
        perDiem: '40',
        pensionApplies: null,
      });
      expect(second).toMatchObject({
        id: first.id,
        version: 2,
        perDiem: '40.0000',
        pensionApplies: null,
        rate: '450.5000',
        kitInventory: FULL_TERMS.kitInventory,
        paymentTermsDays: 30,
      });
      expect(await termsRows(w.organisationId)).toHaveLength(1);
    });

    it('writes nothing for a change that changes nothing', async () => {
      const w = await world();
      const made = await seedContract(database, w);
      await setContractTerms(db(), at(w.manager), made.id, FULL_TERMS);
      const again = await setContractTerms(db(), at(w.manager), made.id, {
        rate: '450.50',
        paymentTermsDays: 30,
      });
      expect(again.version).toBe(1);
      expect(await termsEvents(w.organisationId)).toHaveLength(1);
    });

    it('sets terms on an organisation-level contract, checked in the organisation', async () => {
      const w = await world();
      const made = await seedContract(database, w, {
        projectId: null,
        kind: 'deal-memo',
        title: 'Facility deal memo',
      });
      const orgEditor = await seedUser(database);
      await grantOnOrganisation(
        database,
        w.organisationId,
        orgEditor,
        'admin',
        [READ, EDIT],
      );
      const terms = await setContractTerms(db(), at(orgEditor), made.id, {
        currency: 'GBP',
        rateBasis: 'flat',
        paymentTermsDays: 14,
      });
      expect(terms.rateBasis).toBe('flat');
      // The project role of the assistant grants nothing in the organisation.
      expect(
        await errorOf(
          setContractTerms(db(), at(w.assistant), made.id, {
            paymentTermsDays: 7,
          }),
        ),
      ).toBeInstanceOf(AccessDeniedError);
    });

    describe('contract kinds', () => {
      const WITH_TERMS = ['deal-memo', 'crew-contract', 'cast-contract'];

      it.each(WITH_TERMS)('accepts terms on a %s', async (kind) => {
        const w = await world();
        const made = await seedContract(database, w, {
          kind: kind as (typeof CONTRACT_KINDS)[number],
        });
        const terms = await setContractTerms(db(), at(w.manager), made.id, {
          paymentTermsDays: 30,
        });
        expect(terms.paymentTermsDays).toBe(30);
      });

      it.each(CONTRACT_KINDS.filter((kind) => !WITH_TERMS.includes(kind)))(
        'refuses terms on a %s, and writes nothing',
        async (kind) => {
          const w = await world();
          const made = await seedContract(database, w, { kind });
          const error = await errorOf(
            setContractTerms(db(), at(w.manager), made.id, {
              paymentTermsDays: 30,
            }),
          );
          expect(error).toBeInstanceOf(ContractInputError);
          expect((error as Error).message).toBe(
            'Terms apply only to deal memos and crew or cast contracts',
          );
          await nothingWritten(w);
        },
      );
    });

    describe('who sees the amounts', () => {
      it('leaves the four amounts out for a reader without contracts:read-value, and keeps every other term', async () => {
        const w = await world();
        const made = await seedContract(database, w);
        await setContractTerms(db(), at(w.manager), made.id, FULL_TERMS);

        const seen = await getContract(db(), at(w.reader), made.id);
        expect(hasAmount(seen.terms!)).toEqual([]);
        expect(seen.terms).toMatchObject(FULL_TERMS_WITHOUT_AMOUNTS);
        // The contract's own amount rule is unchanged.
        expect(Object.hasOwn(seen, 'totalValue')).toBe(false);

        const listed = await listContracts(db(), at(w.reader), {
          organisationId: w.organisationId,
          projectId: w.projectId,
        });
        expect(listed).toHaveLength(1);
        expect(hasAmount(listed[0]!.terms!)).toEqual([]);
        expect(listed[0]!.terms).toMatchObject(FULL_TERMS_WITHOUT_AMOUNTS);
      });

      it('shows every term to a reader with contracts:read-value, in a get and in a list', async () => {
        const w = await world();
        const made = await seedContract(database, w);
        await setContractTerms(db(), at(w.manager), made.id, FULL_TERMS);
        const expected = {
          ...FULL_TERMS_AMOUNTS,
          ...FULL_TERMS_WITHOUT_AMOUNTS,
        };
        expect(
          (await getContract(db(), at(w.valueReader), made.id)).terms,
        ).toMatchObject(expected);
        const listed = await listContracts(db(), at(w.valueReader), {
          organisationId: w.organisationId,
          projectId: w.projectId,
        });
        expect(listed[0]!.terms).toMatchObject(expected);
      });

      it('shows the terms of a contract that has none as null, in a get and in a list', async () => {
        const w = await world();
        const made = await seedContract(database, w);
        expect(
          (await getContract(db(), at(w.reader), made.id)).terms,
        ).toBeNull();
        const listed = await listContracts(db(), at(w.reader), {
          organisationId: w.organisationId,
          projectId: w.projectId,
        });
        expect(listed.map((view) => view.terms)).toEqual([null]);
      });

      it('hides the amounts from the result of a set made without contracts:read-value', async () => {
        const w = await world();
        const made = await seedContract(database, w);
        await setContractTerms(db(), at(w.manager), made.id, FULL_TERMS);
        const result = await setContractTerms(db(), at(w.assistant), made.id, {
          paymentTermsDays: 45,
        });
        expect(result.paymentTermsDays).toBe(45);
        expect(hasAmount(result)).toEqual([]);
      });

      it('shows a party with no permission the whole terms, in a get and in the list of their own contracts', async () => {
        const w = await world();
        const userId = await seedUser(database);
        const personId = await seedPerson(database, w.organisationId, {
          userId,
        });
        const made = await seedContract(database, w, {
          parties: [{ personId, partyRole: 'camera operator' }],
        });
        await setContractTerms(db(), at(w.manager), made.id, FULL_TERMS);
        const expected = {
          ...FULL_TERMS_AMOUNTS,
          ...FULL_TERMS_WITHOUT_AMOUNTS,
        };
        expect(
          (await getContract(db(), at(userId), made.id)).terms,
        ).toMatchObject(expected);
        const own = await listOwnContracts(db(), at(userId), w.organisationId);
        expect(own.map((view) => view.id)).toEqual([made.id]);
        expect(own[0]!.terms).toMatchObject(expected);
        // A person with no account of their own contract's party is not shown it.
        expect(
          await errorOf(getContract(db(), at(w.outsider), made.id)),
        ).toBeInstanceOf(AccessDeniedError);
      });

      it('shows a loan-out owner the terms of their company’s contract', async () => {
        const w = await world();
        const userId = await seedUser(database);
        const personId = await seedPerson(database, w.organisationId, {
          userId,
        });
        const companyId = await seedCompany(database, w.organisationId);
        await db()
          .insert(personCompany)
          .values({
            ...base(w.organisationId),
            personId,
            companyId,
            relation: 'owner',
          });
        const made = await seedContract(database, w, {
          parties: [{ companyId, partyRole: 'loan-out company' }],
        });
        await setContractTerms(db(), at(w.manager), made.id, FULL_TERMS);
        const view = await getContract(db(), at(userId), made.id);
        expect(view.terms).toMatchObject(FULL_TERMS_AMOUNTS);
      });
    });

    describe('who may write', () => {
      it('refuses a caller without contracts:edit, a party to the contract included, and writes nothing', async () => {
        const w = await world();
        const userId = await seedUser(database);
        const personId = await seedPerson(database, w.organisationId, {
          userId,
        });
        const made = await seedContract(database, w, {
          parties: [{ personId, partyRole: 'camera operator' }],
        });
        for (const caller of [userId, w.reader, w.valueReader, w.outsider]) {
          expect(
            await errorOf(
              setContractTerms(db(), at(caller), made.id, {
                paymentTermsDays: 30,
              }),
            ),
          ).toMatchObject({
            name: 'AccessDeniedError',
            permission: EDIT,
            scope: undefined,
          });
        }
        await nothingWritten(w);
      });

      it('answers an unknown contract exactly as it answers a forbidden one', async () => {
        const w = await world();
        const made = await seedContract(database, w);
        const forbidden = await errorOf(
          setContractTerms(db(), at(w.outsider), made.id, {
            paymentTermsDays: 30,
          }),
        );
        const unknown = await errorOf(
          setContractTerms(
            db(),
            at(w.outsider),
            '00000000-0000-7000-8000-000000000000',
            { paymentTermsDays: 30 },
          ),
        );
        expect(forbidden).toMatchObject({
          name: 'AccessDeniedError',
          permission: EDIT,
          scope: undefined,
          message: (unknown as Error).message,
        });
      });

      it('lets contracts:edit alone set the terms that are not amounts', async () => {
        const w = await world();
        const made = await seedContract(database, w);
        const terms = await setContractTerms(db(), at(w.assistant), made.id, {
          currency: 'GBP',
          rateBasis: 'daily',
          guaranteedHours: '10',
          overtimeRuleKey: 'uk-film-overtime',
          kitFeeBasis: 'daily',
          kitInventory: 'A tripod',
          mileageUnit: 'km',
          paymentTermsDays: 30,
          pensionApplies: false,
        });
        expect(terms.paymentTermsDays).toBe(30);
        expect(hasAmount(terms)).toEqual([]);
      });

      it.each(AMOUNT_KEYS)(
        'refuses contracts:edit alone for %s, set or cleared, and leaves the stored terms as they were',
        async (key) => {
          const w = await world();
          const made = await seedContract(database, w);
          await setContractTerms(db(), at(w.manager), made.id, FULL_TERMS);
          const before = await termsRows(w.organisationId);
          for (const value of ['1', null]) {
            expect(
              await errorOf(
                setContractTerms(db(), at(w.assistant), made.id, {
                  [key]: value,
                }),
              ),
            ).toMatchObject({
              name: 'AccessDeniedError',
              permission: READ_VALUE,
              scope: undefined,
            });
          }
          expect(await termsRows(w.organisationId)).toEqual(before);
        },
      );

      it('lets contracts:edit with contracts:read-value set and clear an amount', async () => {
        const w = await world();
        const made = await seedContract(database, w);
        await setContractTerms(db(), at(w.manager), made.id, FULL_TERMS);
        const cleared = await setContractTerms(db(), at(w.manager), made.id, {
          perDiem: null,
          kitFee: null,
        });
        expect(cleared).toMatchObject({
          rate: '450.5000',
          perDiem: null,
          kitFee: null,
        });
      });
    });

    describe('what it refuses', () => {
      const refused = async (
        terms: ContractTermsInput,
        expected: RegExp,
        first: ContractTermsInput = {},
      ) => {
        const w = await world();
        const made = await seedContract(database, w);
        if (Object.keys(first).length > 0) {
          await setContractTerms(db(), at(w.manager), made.id, first);
        }
        const before = await termsRows(w.organisationId);
        const error = await errorOf(
          setContractTerms(db(), at(w.manager), made.id, terms),
        );
        expect(error).toBeInstanceOf(ContractInputError);
        expect((error as Error).message).toMatch(expected);
        expect(await termsRows(w.organisationId)).toEqual(before);
      };

      it.each([
        ['5 places after the point', '12.12345'],
        ['16 digits before the point', '1234567890123456'],
        ['a negative amount', '-1'],
        ['an exponent', '1e3'],
        ['a leading space', ' 5'],
        ['an empty string', ''],
      ])('refuses an amount with %s', async (_name, value) => {
        for (const key of AMOUNT_KEYS) {
          await refused(
            { currency: 'GBP', rateBasis: 'daily', [key]: value },
            /decimal string of at most 15 digits/,
          );
        }
      });

      it('refuses an amount that is a number, never a string', async () => {
        await refused(
          { currency: 'GBP', rateBasis: 'daily', rate: 12.5 as never },
          /decimal string/,
        );
      });

      it('accepts the largest amount the column holds', async () => {
        const w = await world();
        const made = await seedContract(database, w);
        const terms = await setContractTerms(db(), at(w.manager), made.id, {
          currency: 'GBP',
          rateBasis: 'flat',
          rate: '999999999999999.9999',
        });
        expect(terms.rate).toBe('999999999999999.9999');
      });

      it.each([
        ['zero', '0'],
        ['above a week', '168.01'],
        ['169', '169'],
        ['3 places', '10.123'],
        ['text', 'ten'],
        ['negative', '-5'],
      ])('refuses guaranteed hours of %s', async (_name, value) => {
        await refused({ guaranteedHours: value }, /guaranteed hours/);
      });

      it.each(['168', '0.01', '8.5'])(
        'accepts guaranteed hours of %s',
        async (hours) => {
          const w = await world();
          const made = await seedContract(database, w);
          const terms = await setContractTerms(db(), at(w.manager), made.id, {
            guaranteedHours: hours,
          });
          expect(Number(terms.guaranteedHours)).toBe(Number(hours));
        },
      );

      it.each(['Overtime', '-rule', '', 'rule key', 'rule_key'])(
        'refuses the overtime rule key %j',
        async (key) => {
          await refused({ overtimeRuleKey: key }, /overtime rule key/);
        },
      );

      it('accepts the shapes of a rule key that a rule pack uses', async () => {
        const w = await world();
        const made = await seedContract(database, w);
        for (const key of ['a', '9x', 'uk.film-2026.overtime']) {
          const terms = await setContractTerms(db(), at(w.manager), made.id, {
            overtimeRuleKey: key,
          });
          expect(terms.overtimeRuleKey).toBe(key);
        }
      });

      it.each([-1, 366, 1.5, Number.NaN, '30' as never])(
        'refuses %j days to pay',
        async (days) => {
          await refused({ paymentTermsDays: days }, /payment terms/);
        },
      );

      it.each([0, 365])('accepts %d days to pay', async (days) => {
        const w = await world();
        const made = await seedContract(database, w);
        const terms = await setContractTerms(db(), at(w.manager), made.id, {
          paymentTermsDays: days,
        });
        expect(terms.paymentTermsDays).toBe(days);
      });

      it('refuses a kit inventory over 2000 characters, and accepts exactly 2000', async () => {
        await refused({ kitInventory: 'k'.repeat(2001) }, /kit inventory/);
        const w = await world();
        const made = await seedContract(database, w);
        const terms = await setContractTerms(db(), at(w.manager), made.id, {
          kitInventory: 'k'.repeat(2000),
        });
        expect(terms.kitInventory).toHaveLength(2000);
        // Counted in characters, not in UTF-16 units: 2000 emoji are 4000 units.
        const emoji = String.fromCodePoint(0x1f3a5);
        const second = await setContractTerms(db(), at(w.manager), made.id, {
          kitInventory: emoji.repeat(2000),
        });
        expect(Array.from(second.kitInventory!)).toHaveLength(2000);
        await refused({ kitInventory: emoji.repeat(2001) }, /kit inventory/);
      });

      it.each([
        ['a currency in lower case', { currency: 'gbp' }, /currency/],
        ['a currency of four letters', { currency: 'GBPX' }, /currency/],
        [
          'a rate basis that is not allowed',
          { rateBasis: 'monthly' },
          /rate basis/,
        ],
        [
          'a kit fee basis of hourly',
          { kitFeeBasis: 'hourly' },
          /kit fee basis/,
        ],
        ['a mileage unit of miles', { mileageUnit: 'miles' }, /mileage unit/],
        [
          'a pension flag that is not a boolean',
          { pensionApplies: 'yes' },
          /pension/,
        ],
        ['a field that does not exist', { bonus: '5' }, /does not exist/],
        [
          'a field named like an inherited one',
          { constructor: 1 },
          /does not exist/,
        ],
      ])('refuses %s', async (_name, terms, expected) => {
        await refused(terms as ContractTermsInput, expected);
      });

      it('refuses an amount with no currency, and clearing the currency while an amount stays', async () => {
        await refused({ rateBasis: 'daily', rate: '10' }, /needs a currency/);
        await refused({ currency: null }, /needs a currency/, {
          currency: 'GBP',
          rateBasis: 'daily',
          rate: '10',
        });
      });

      it('refuses a rate with no basis, a kit fee with no basis and a mileage rate with no unit', async () => {
        await refused(
          { currency: 'GBP', rate: '10' },
          /rate needs a rate basis/,
        );
        await refused(
          { currency: 'GBP', kitFee: '10' },
          /kit fee needs a kit fee basis/,
        );
        await refused(
          { currency: 'GBP', mileageRate: '1' },
          /mileage rate needs a mileage unit/,
        );
        await refused({ rateBasis: null }, /rate needs a rate basis/, {
          currency: 'GBP',
          rateBasis: 'daily',
          rate: '10',
        });
      });

      it.each(['flat', 'buyout'] as const)(
        'refuses guaranteed hours with a %s rate, whichever comes second',
        async (basis) => {
          await refused(
            { rateBasis: basis, guaranteedHours: '10' },
            /no guaranteed hours/,
          );
          await refused({ rateBasis: basis }, /no guaranteed hours/, {
            rateBasis: 'daily',
            guaranteedHours: '10',
          });
          await refused({ guaranteedHours: '10' }, /no guaranteed hours/, {
            rateBasis: basis,
          });
        },
      );

      it.each(['hourly', 'daily', 'weekly'] as const)(
        'accepts guaranteed hours with a %s rate',
        async (basis) => {
          const w = await world();
          const made = await seedContract(database, w);
          const terms = await setContractTerms(db(), at(w.manager), made.id, {
            rateBasis: basis,
            guaranteedHours: '10',
          });
          expect(terms.rateBasis).toBe(basis);
        },
      );
    });

    describe('versions', () => {
      it('updates the terms the caller read, and refuses a stale version', async () => {
        const w = await world();
        const made = await seedContract(database, w);
        const first = await setContractTerms(db(), at(w.manager), made.id, {
          paymentTermsDays: 30,
        });
        const second = await setContractTerms(
          db(),
          at(w.manager),
          made.id,
          { paymentTermsDays: 45 },
          { expectedVersion: first.version },
        );
        expect(second.version).toBe(2);
        expect(
          await errorOf(
            setContractTerms(
              db(),
              at(w.manager),
              made.id,
              { paymentTermsDays: 60 },
              { expectedVersion: first.version },
            ),
          ),
        ).toBeInstanceOf(VersionConflictError);
        expect((await termsRows(w.organisationId))[0]!.paymentTermsDays).toBe(
          45,
        );
      });

      it('refuses an expected version when there are no live terms, never made or removed', async () => {
        const w = await world();
        const made = await seedContract(database, w);
        expect(
          await errorOf(
            setContractTerms(
              db(),
              at(w.manager),
              made.id,
              { paymentTermsDays: 30 },
              { expectedVersion: 1 },
            ),
          ),
        ).toBeInstanceOf(ContractTermsConflictError);
        const set = await setContractTerms(db(), at(w.manager), made.id, {
          paymentTermsDays: 30,
        });
        await removeContractTerms(db(), at(w.manager), made.id, set.version);
        expect(
          await errorOf(
            setContractTerms(
              db(),
              at(w.manager),
              made.id,
              { paymentTermsDays: 30 },
              { expectedVersion: set.version + 1 },
            ),
          ),
        ).toBeInstanceOf(ContractTermsConflictError);
        await nothingWrittenButRemoved(w);
      });

      async function nothingWrittenButRemoved(w: TermsWorld) {
        const rows = await termsRows(w.organisationId);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.deletedAt).not.toBeNull();
      }
    });
  });

  describe('removeContractTerms', () => {
    it('removes the terms by soft delete, and the contract then shows none', async () => {
      const w = await world();
      const made = await seedContract(database, w);
      const set = await setContractTerms(
        db(),
        at(w.manager),
        made.id,
        FULL_TERMS,
      );
      const removed = await removeContractTerms(
        db(),
        at(w.manager),
        made.id,
        set.version,
      );
      expect(removed.deletedAt).toEqual(NOW);
      expect(
        (await getContract(db(), at(w.manager), made.id)).terms,
      ).toBeNull();
      expect(await termsRows(w.organisationId)).toHaveLength(1);
    });

    it('needs contracts:edit and contracts:read-value, the permissions of clearing every amount', async () => {
      const w = await world();
      const made = await seedContract(database, w);
      const set = await setContractTerms(db(), at(w.manager), made.id, {
        paymentTermsDays: 30,
      });
      for (const [caller, permission] of [
        [w.assistant, READ_VALUE],
        [w.valueReader, EDIT],
        [w.reader, EDIT],
        [w.outsider, EDIT],
      ] as const) {
        expect(
          await errorOf(
            removeContractTerms(db(), at(caller), made.id, set.version),
          ),
        ).toMatchObject({
          name: 'AccessDeniedError',
          permission,
          scope: undefined,
        });
      }
      expect((await termsRows(w.organisationId))[0]!.deletedAt).toBeNull();
    });

    it('is refused for a party without the permissions, as a write', async () => {
      const w = await world();
      const userId = await seedUser(database);
      const personId = await seedPerson(database, w.organisationId, { userId });
      const made = await seedContract(database, w, {
        parties: [{ personId, partyRole: 'camera operator' }],
      });
      const set = await setContractTerms(
        db(),
        at(w.manager),
        made.id,
        FULL_TERMS,
      );
      expect(
        await errorOf(
          removeContractTerms(db(), at(userId), made.id, set.version),
        ),
      ).toMatchObject({ name: 'AccessDeniedError', permission: EDIT });
    });

    it('refuses a stale version, a contract with no live terms and an unknown contract', async () => {
      const w = await world();
      const made = await seedContract(database, w);
      expect(
        await errorOf(removeContractTerms(db(), at(w.manager), made.id, 1)),
      ).toBeInstanceOf(RecordNotFoundError);
      const set = await setContractTerms(db(), at(w.manager), made.id, {
        paymentTermsDays: 30,
      });
      expect(
        await errorOf(
          removeContractTerms(db(), at(w.manager), made.id, set.version + 1),
        ),
      ).toBeInstanceOf(VersionConflictError);
      await removeContractTerms(db(), at(w.manager), made.id, set.version);
      expect(
        await errorOf(
          removeContractTerms(db(), at(w.manager), made.id, set.version + 1),
        ),
      ).toBeInstanceOf(RecordNotFoundError);
      expect(
        await errorOf(
          removeContractTerms(
            db(),
            at(w.manager),
            '00000000-0000-7000-8000-000000000000',
            1,
          ),
        ),
      ).toBeInstanceOf(AccessDeniedError);
    });

    it('is undone by setting the terms again, which restores the same row with nothing from before', async () => {
      const w = await world();
      const made = await seedContract(database, w);
      const first = await setContractTerms(
        db(),
        at(w.manager),
        made.id,
        FULL_TERMS,
      );
      await removeContractTerms(db(), at(w.manager), made.id, first.version);
      const restored = await setContractTerms(db(), at(w.manager), made.id, {
        currency: 'EUR',
        paymentTermsDays: 14,
      });
      expect(restored).toMatchObject({
        id: first.id,
        deletedAt: null,
        deletedBy: null,
        currency: 'EUR',
        paymentTermsDays: 14,
        rate: null,
        rateBasis: null,
        guaranteedHours: null,
        overtimeRuleKey: null,
        kitFee: null,
        kitFeeBasis: null,
        kitInventory: null,
        perDiem: null,
        mileageRate: null,
        mileageUnit: null,
        pensionApplies: null,
      });
      expect(restored.version).toBe(first.version + 2);
      expect(await termsRows(w.organisationId)).toHaveLength(1);
      expect(
        (await termsEvents(w.organisationId)).map((event) => event.action),
      ).toEqual(['create', 'delete', 'restore']);
      expect((await getContract(db(), at(w.manager), made.id)).terms).toEqual(
        restored,
      );
    });

    it('lets a caller without contracts:read-value restore terms without amounts, but never with one', async () => {
      const w = await world();
      const made = await seedContract(database, w);
      const first = await setContractTerms(
        db(),
        at(w.manager),
        made.id,
        FULL_TERMS,
      );
      await removeContractTerms(db(), at(w.manager), made.id, first.version);
      expect(
        await errorOf(
          setContractTerms(db(), at(w.assistant), made.id, {
            currency: 'GBP',
            rateBasis: 'daily',
            rate: '1',
          }),
        ),
      ).toMatchObject({ permission: READ_VALUE });
      const restored = await setContractTerms(db(), at(w.assistant), made.id, {
        paymentTermsDays: 7,
      });
      expect(restored.paymentTermsDays).toBe(7);
      expect((await termsRows(w.organisationId))[0]!.rate).toBeNull();
    });
  });

  describe('updateContract and the kind of a contract with terms', () => {
    const WITH_TERMS = ['deal-memo', 'crew-contract', 'cast-contract'] as const;
    const WITHOUT_TERMS = CONTRACT_KINDS.filter(
      (kind) => !(WITH_TERMS as readonly string[]).includes(kind),
    );
    const REFUSAL = "Remove the terms before changing this contract's kind";

    const contractRow = async (id: string) => {
      const [row] = await db()
        .select({
          kind: contract.kind,
          title: contract.title,
          version: contract.version,
        })
        .from(contract)
        .where(eq(contract.id, id));
      return row!;
    };
    const eventCount = async (organisationId: string) =>
      (
        await db()
          .select({ id: changeEvent.id })
          .from(changeEvent)
          .where(eq(changeEvent.organisationId, organisationId))
      ).length;

    it.each(WITHOUT_TERMS)(
      'refuses to change a contract with live terms to %s, and changes nothing',
      async (kind) => {
        const w = await world();
        const made = await seedContract(database, w);
        await setContractTerms(db(), at(w.manager), made.id, FULL_TERMS);
        const events = await eventCount(w.organisationId);
        const error = await errorOf(
          updateContract(db(), at(w.manager), made.id, made.version, {
            kind,
            title: 'Renamed in the same call',
          }),
        );
        expect(error).toBeInstanceOf(ContractInputError);
        expect((error as Error).message).toBe(REFUSAL);
        // The whole call is refused: the title that came with the kind did not change either.
        expect(await contractRow(made.id)).toEqual({
          kind: 'crew-contract',
          title: made.title,
          version: made.version,
        });
        expect(await eventCount(w.organisationId)).toBe(events);
      },
    );

    it('allows a change among the kinds that have terms, and keeps the terms', async () => {
      const w = await world();
      const made = await seedContract(database, w);
      await setContractTerms(db(), at(w.manager), made.id, FULL_TERMS);
      let version = made.version;
      for (const kind of [
        'cast-contract',
        'deal-memo',
        'crew-contract',
      ] as const) {
        const updated = await updateContract(
          db(),
          at(w.manager),
          made.id,
          version,
          {
            kind,
          },
        );
        expect(updated.kind).toBe(kind);
        expect(updated.terms).toMatchObject(FULL_TERMS_WITHOUT_AMOUNTS);
        version = updated.version;
      }
    });

    it('allows the change when the contract has no terms', async () => {
      const w = await world();
      const made = await seedContract(database, w);
      const updated = await updateContract(
        db(),
        at(w.manager),
        made.id,
        made.version,
        {
          kind: 'location-agreement',
        },
      );
      expect(updated.kind).toBe('location-agreement');
    });

    it('does not count removed terms, and then refuses terms for the new kind', async () => {
      const w = await world();
      const made = await seedContract(database, w);
      const set = await setContractTerms(
        db(),
        at(w.manager),
        made.id,
        FULL_TERMS,
      );
      await removeContractTerms(db(), at(w.manager), made.id, set.version);
      const updated = await updateContract(
        db(),
        at(w.manager),
        made.id,
        made.version,
        {
          kind: 'release',
        },
      );
      expect(updated.kind).toBe('release');
      expect(updated.terms).toBeNull();
      expect(
        await errorOf(
          setContractTerms(db(), at(w.manager), made.id, {
            paymentTermsDays: 30,
          }),
        ),
      ).toBeInstanceOf(ContractInputError);
    });

    it('leaves every other change alone while terms exist', async () => {
      const w = await world();
      const made = await seedContract(database, w);
      await setContractTerms(db(), at(w.manager), made.id, FULL_TERMS);
      const updated = await updateContract(
        db(),
        at(w.manager),
        made.id,
        made.version,
        {
          title: 'Camera operator agreement, revised',
          status: 'signed',
        },
      );
      expect(updated).toMatchObject({
        title: 'Camera operator agreement, revised',
        status: 'signed',
        kind: 'crew-contract',
      });
    });

    it('answers a caller who may not edit with the denial, never with the refusal about terms', async () => {
      const w = await world();
      const made = await seedContract(database, w);
      await setContractTerms(db(), at(w.manager), made.id, FULL_TERMS);
      for (const caller of [w.reader, w.valueReader, w.outsider]) {
        expect(
          await errorOf(
            updateContract(db(), at(caller), made.id, made.version, {
              kind: 'location-agreement',
            }),
          ),
        ).toMatchObject({
          name: 'AccessDeniedError',
          permission: EDIT,
          scope: undefined,
        });
      }
    });

    it('answers a stale version with the version conflict once the kind is allowed', async () => {
      const w = await world();
      const made = await seedContract(database, w);
      expect(
        await errorOf(
          updateContract(db(), at(w.manager), made.id, made.version + 1, {
            kind: 'location-agreement',
          }),
        ),
      ).toBeInstanceOf(VersionConflictError);
    });
  });

  describe('change events', () => {
    it('name the amounts that changed and never hold their values', async () => {
      const w = await world();
      const made = await seedContract(database, w);
      const first = await setContractTerms(db(), at(w.manager), made.id, {
        ...FULL_TERMS,
        rate: '123456.78',
      });
      await setContractTerms(db(), at(w.manager), made.id, {
        rate: '654321.09',
        perDiem: null,
        paymentTermsDays: 45,
      });
      await removeContractTerms(db(), at(w.manager), made.id, 2);
      const events = await termsEvents(w.organisationId);
      expect(events.map((event) => event.action)).toEqual([
        'create',
        'update',
        'delete',
      ]);
      expect(events[0]!.entityId).toBe(first.id);

      // The update names the amounts that changed, and the plain field that changed.
      expect([...events[1]!.changedFields].sort()).toEqual([
        'payment_terms_days',
        'per_diem',
        'rate',
      ]);
      expect(events[1]!.after).toEqual({ payment_terms_days: 45 });
      expect(events[1]!.before).toEqual({ payment_terms_days: 30 });

      // The create names every field, the amounts among them, and holds no amount.
      expect(events[0]!.changedFields).toEqual(
        expect.arrayContaining(['rate', 'kit_fee', 'per_diem', 'mileage_rate']),
      );
      const everything = JSON.stringify(events);
      for (const secret of [
        '123456',
        '654321',
        '450.5',
        '35.25',
        '0.45',
        '"75',
      ]) {
        expect(everything, secret).not.toContain(secret);
      }
      // The currency is not an amount and stays in the event.
      expect(events[0]!.after).toMatchObject({ currency: 'GBP' });
    });

    it('files the events of a project contract under the project’s sequence', async () => {
      const w = await world();
      const made = await seedContract(database, w);
      await setContractTerms(db(), at(w.manager), made.id, {
        paymentTermsDays: 30,
      });
      const [event] = await termsEvents(w.organisationId);
      expect(event!.projectId).toBe(w.projectId);
    });
  });

  describe('errors', () => {
    it('carry no value of the terms', async () => {
      const w = await world();
      const made = await seedContract(database, w);
      const secret = '77777777.7777';
      const errors = [
        await errorOf(
          setContractTerms(db(), at(w.manager), made.id, {
            currency: 'gbp',
            rate: secret,
          }),
        ),
        await errorOf(
          setContractTerms(db(), at(w.manager), made.id, {
            rate: `${secret}9`,
          }),
        ),
        await errorOf(
          setContractTerms(db(), at(w.assistant), made.id, { rate: secret }),
        ),
      ];
      for (const error of errors) {
        expect(JSON.stringify([(error as Error).message, error])).not.toContain(
          '77777777',
        );
      }
    });

    it('leave the contract it was called on untouched', async () => {
      const w = await world();
      const made = await seedContract(database, w);
      await errorOf(
        setContractTerms(db(), at(w.manager), made.id, { rate: 'x' }),
      );
      const [stored] = await db()
        .select({ version: contract.version })
        .from(contract)
        .where(eq(contract.id, made.id));
      expect(stored!.version).toBe(made.version);
    });
  });
});
