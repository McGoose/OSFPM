import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncPermissions } from '../access/permission-sync.js';
import {
  base,
  grantOnOrganisation,
  grantOnProject,
  ORIGIN,
  seedCompany,
  seedOrganisation,
  seedPerson,
  seedProject,
  seedUser,
  type SeedOrganisation,
} from '../access/test-fixtures.js';
import { AccessDeniedError } from '../access/access-denied-error.js';
import type { Database } from '../db/client.js';
import {
  auditEvent,
  contract,
  person,
  personCompany,
  type PersonCompanyRelation,
} from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { isContractParty } from './party.js';
import { CONTRACT_PERMISSIONS } from './permissions.js';
import {
  addContractParty,
  createContract,
  getContract,
  listOwnContracts,
  removeContractParty,
  updateContract,
  type ContractContext,
  type ContractView,
} from './service.js';

// Written out here, not taken from the constants under test.
const READ = 'contracts:read';
const EDIT = 'contracts:edit';
const READ_VALUE = 'contracts:read-value';

/** The day the tests run on, and so the day a loan-out link is checked on. */
const NOW = new Date(Date.UTC(2026, 1, 1, 12));
const TODAY = '2026-02-01';
const at = (userId: string, clock: Date = NOW): ContractContext => ({
  userId,
  originServer: ORIGIN,
  clock: () => clock,
});

const WITH_AMOUNT = { currency: 'GBP', totalValue: '125000.5' } as const;

describe.each(testTargets)('contract parties on $name', (target) => {
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

  type World = SeedOrganisation & {
    /** Holds read, edit and read-value on the project and the organisation. */
    manager: string;
    /** A user with an account and no permission of any kind. */
    outsider: string;
  };

  async function setup(): Promise<World> {
    const org = await seedOrganisation(database);
    const manager = await seedUser(database);
    await grantOnProject(database, org.organisationId, org.projectId, manager, [
      READ,
      EDIT,
      READ_VALUE,
    ]);
    await grantOnOrganisation(database, org.organisationId, manager, 'owner', [
      READ,
      EDIT,
      READ_VALUE,
    ]);
    return { ...org, manager, outsider: await seedUser(database) };
  }

  /** A person with an account and no permission, and a contract they are a party to. */
  async function partyScene(w: World) {
    const userId = await seedUser(database);
    const personId = await seedPerson(database, w.organisationId, { userId });
    const view = await createContract(db(), at(w.manager), {
      organisationId: w.organisationId,
      projectId: w.projectId,
      kind: 'crew-contract',
      title: 'Camera operator agreement',
      status: 'signed',
      ...WITH_AMOUNT,
      parties: [{ personId, partyRole: 'camera operator' }],
    });
    return { userId, personId, contractId: view.id, view };
  }

  /** A loan-out company that is a party to a new contract, and a person linked to it. */
  async function loanOutScene(
    w: World,
    link: {
      relation: PersonCompanyRelation;
      startDate?: string | null;
      endDate?: string | null;
    },
  ) {
    const userId = await seedUser(database);
    const personId = await seedPerson(database, w.organisationId, { userId });
    const companyId = await seedCompany(database, w.organisationId, {
      name: 'Meadow Lighting Ltd',
    });
    const [linkRow] = await db()
      .insert(personCompany)
      .values({
        ...base(w.organisationId),
        personId,
        companyId,
        relation: link.relation,
        startDate: link.startDate ?? null,
        endDate: link.endDate ?? null,
      })
      .returning({ id: personCompany.id });
    const view = await createContract(db(), at(w.manager), {
      organisationId: w.organisationId,
      projectId: w.projectId,
      kind: 'crew-contract',
      title: 'Gaffer loan-out agreement',
      status: 'signed',
      ...WITH_AMOUNT,
      parties: [{ companyId, partyRole: 'loan-out company' }],
    });
    return {
      userId,
      personId,
      companyId,
      linkId: linkRow!.id,
      contractId: view.id,
    };
  }

  const isParty = (userId: string, contractId: string) =>
    isContractParty(db(), userId, contractId, TODAY);

  const errorOf = (call: Promise<unknown>) =>
    call.then(
      () => {
        throw new Error('Expected the call to fail, but it succeeded');
      },
      (error: unknown) => error,
    );

  describe('isContractParty', () => {
    it('is true for the user of a person who is a party, and false for anyone else', async () => {
      const w = await setup();
      const scene = await partyScene(w);
      expect(await isParty(scene.userId, scene.contractId)).toBe(true);
      expect(await isParty(w.outsider, scene.contractId)).toBe(false);
      // Holding every contracts permission does not make a user a party.
      expect(await isParty(w.manager, scene.contractId)).toBe(false);
    });

    it('is false for a person with no account, and for a contract that does not exist', async () => {
      const w = await setup();
      const scene = await partyScene(w);
      const noAccount = await seedPerson(database, w.organisationId);
      const other = await createContract(db(), at(w.manager), {
        organisationId: w.organisationId,
        projectId: w.projectId,
        kind: 'crew-contract',
        title: 'Runner agreement',
        status: 'draft',
        parties: [{ personId: noAccount, partyRole: 'runner' }],
      });
      expect(await isParty(scene.userId, other.id)).toBe(false);
      expect(
        await isParty(scene.userId, '00000000-0000-7000-8000-000000000000'),
      ).toBe(false);
    });

    it('is false once the party row is removed, and true again when it is restored', async () => {
      const w = await setup();
      const scene = await partyScene(w);
      const partyRow = scene.view.parties[0]!;
      await removeContractParty(
        db(),
        at(w.manager),
        partyRow.id,
        partyRow.version,
      );
      expect(await isParty(scene.userId, scene.contractId)).toBe(false);
      await addContractParty(db(), at(w.manager), scene.contractId, {
        personId: scene.personId,
        partyRole: 'camera operator',
      });
      expect(await isParty(scene.userId, scene.contractId)).toBe(true);
    });

    it('is false when the person record is deleted', async () => {
      const w = await setup();
      const scene = await partyScene(w);
      await db()
        .update(person)
        .set({ deletedAt: NOW })
        .where(eq(person.id, scene.personId));
      expect(await isParty(scene.userId, scene.contractId)).toBe(false);
    });

    it('is false when the contract is deleted', async () => {
      const w = await setup();
      const scene = await partyScene(w);
      await db()
        .update(contract)
        .set({ deletedAt: NOW })
        .where(eq(contract.id, scene.contractId));
      expect(await isParty(scene.userId, scene.contractId)).toBe(false);
    });

    describe('through a loan-out company', () => {
      it.each(['owner', 'director'] as const)(
        'is true for the %s of a company that is a party, while the link is current',
        async (relation) => {
          const w = await setup();
          const scene = await loanOutScene(w, { relation });
          expect(await isParty(scene.userId, scene.contractId)).toBe(true);
          expect(await isParty(w.outsider, scene.contractId)).toBe(false);
        },
      );

      it.each(['employee', 'represented-by', 'other'] as const)(
        'is false for a person whose relation to the company is %s',
        async (relation) => {
          const w = await setup();
          const scene = await loanOutScene(w, { relation });
          expect(await isParty(scene.userId, scene.contractId)).toBe(false);
        },
      );

      it('counts the first and the last day of the link, and nothing outside them', async () => {
        const w = await setup();
        const first = await loanOutScene(w, {
          relation: 'owner',
          startDate: TODAY,
          endDate: '2026-12-31',
        });
        const last = await loanOutScene(w, {
          relation: 'owner',
          startDate: '2025-01-01',
          endDate: TODAY,
        });
        const ended = await loanOutScene(w, {
          relation: 'owner',
          startDate: '2025-01-01',
          endDate: '2026-01-31',
        });
        const notStarted = await loanOutScene(w, {
          relation: 'director',
          startDate: '2026-02-02',
        });
        expect(await isParty(first.userId, first.contractId)).toBe(true);
        expect(await isParty(last.userId, last.contractId)).toBe(true);
        expect(await isParty(ended.userId, ended.contractId)).toBe(false);
        expect(await isParty(notStarted.userId, notStarted.contractId)).toBe(
          false,
        );
      });

      it('follows the day it is given, so a link ends on its end date', async () => {
        const w = await setup();
        const scene = await loanOutScene(w, {
          relation: 'director',
          endDate: '2026-06-30',
        });
        expect(
          await isContractParty(
            db(),
            scene.userId,
            scene.contractId,
            '2026-06-30',
          ),
        ).toBe(true);
        expect(
          await isContractParty(
            db(),
            scene.userId,
            scene.contractId,
            '2026-07-01',
          ),
        ).toBe(false);
      });

      it('is false when the link is deleted, or the person is deleted', async () => {
        const w = await setup();
        const removedLink = await loanOutScene(w, { relation: 'owner' });
        await db()
          .update(personCompany)
          .set({ deletedAt: NOW })
          .where(eq(personCompany.id, removedLink.linkId));
        expect(await isParty(removedLink.userId, removedLink.contractId)).toBe(
          false,
        );

        const removedPerson = await loanOutScene(w, { relation: 'owner' });
        await db()
          .update(person)
          .set({ deletedAt: NOW })
          .where(eq(person.id, removedPerson.personId));
        expect(
          await isParty(removedPerson.userId, removedPerson.contractId),
        ).toBe(false);
      });

      it('is false when the party row of the company is removed', async () => {
        const w = await setup();
        const scene = await loanOutScene(w, { relation: 'owner' });
        const view = await getContract(db(), at(w.manager), scene.contractId);
        const partyRow = view.parties[0]!;
        await removeContractParty(
          db(),
          at(w.manager),
          partyRow.id,
          partyRow.version,
        );
        expect(await isParty(scene.userId, scene.contractId)).toBe(false);
      });

      it('does not make a person a party to a contract of another company they own', async () => {
        const w = await setup();
        const scene = await loanOutScene(w, { relation: 'owner' });
        const other = await loanOutScene(w, { relation: 'owner' });
        expect(await isParty(scene.userId, other.contractId)).toBe(false);
      });
    });
  });

  describe('getContract for a party', () => {
    it('shows a party with no permission the whole contract: parties, amount and currency', async () => {
      const w = await setup();
      const scene = await partyScene(w);
      const auditBefore = await db()
        .select()
        .from(auditEvent)
        .where(eq(auditEvent.organisationId, w.organisationId));
      const view = await getContract(db(), at(scene.userId), scene.contractId);
      expect(view).toMatchObject({
        id: scene.contractId,
        title: 'Camera operator agreement',
        currency: 'GBP',
        totalValue: '125000.5000',
      });
      expect(view.parties.map((p) => p.personId)).toEqual([scene.personId]);
      // A party's read is not an audit event: contracts are not sensitive personal data.
      expect(
        await db()
          .select()
          .from(auditEvent)
          .where(eq(auditEvent.organisationId, w.organisationId)),
      ).toHaveLength(auditBefore.length);
    });

    it('shows the amount to a party who holds contracts:read but not contracts:read-value', async () => {
      const w = await setup();
      const userId = await seedUser(database);
      await grantOnProject(database, w.organisationId, w.projectId, userId, [
        READ,
      ]);
      const personId = await seedPerson(database, w.organisationId, { userId });
      const created = await createContract(db(), at(w.manager), {
        organisationId: w.organisationId,
        projectId: w.projectId,
        kind: 'cast-contract',
        title: 'Lead actor agreement',
        status: 'signed',
        ...WITH_AMOUNT,
        parties: [{ personId, partyRole: 'actor' }],
      });
      const own = await getContract(db(), at(userId), created.id);
      expect(own.totalValue).toBe('125000.5000');
      expect(own.currency).toBe('GBP');
    });

    it('shows a loan-out owner their company’s contract in full', async () => {
      const w = await setup();
      const scene = await loanOutScene(w, { relation: 'owner' });
      const view = await getContract(db(), at(scene.userId), scene.contractId);
      expect(view.totalValue).toBe('125000.5000');
      expect(view.parties.map((p) => p.companyId)).toEqual([scene.companyId]);
    });

    it('leaves a reader who is not a party without the amount, as before', async () => {
      const w = await setup();
      const scene = await partyScene(w);
      const reader = await seedUser(database);
      await grantOnProject(database, w.organisationId, w.projectId, reader, [
        READ,
      ]);
      const view = await getContract(db(), at(reader), scene.contractId);
      expect(view.title).toBe('Camera operator agreement');
      expect(Object.hasOwn(view, 'totalValue')).toBe(false);
      expect(Object.hasOwn(view, 'currency')).toBe(false);
    });

    it('refuses a user who is no party and holds no permission exactly as it refuses an unknown id', async () => {
      const w = await setup();
      const scene = await partyScene(w);
      const forbidden = await errorOf(
        getContract(db(), at(w.outsider), scene.contractId),
      );
      const unknown = await errorOf(
        getContract(
          db(),
          at(w.outsider),
          '00000000-0000-7000-8000-000000000000',
        ),
      );
      expect(forbidden).toBeInstanceOf(AccessDeniedError);
      expect(unknown).toBeInstanceOf(AccessDeniedError);
      expect(forbidden).toMatchObject({
        permission: READ,
        scope: undefined,
        message: (unknown as Error).message,
      });
    });

    it('refuses a party whose party row was removed, and one whose person is deleted', async () => {
      const w = await setup();
      const removed = await partyScene(w);
      const row = removed.view.parties[0]!;
      await removeContractParty(db(), at(w.manager), row.id, row.version);
      expect(
        await errorOf(
          getContract(db(), at(removed.userId), removed.contractId),
        ),
      ).toBeInstanceOf(AccessDeniedError);

      const gone = await partyScene(w);
      await db()
        .update(person)
        .set({ deletedAt: NOW })
        .where(eq(person.id, gone.personId));
      expect(
        await errorOf(getContract(db(), at(gone.userId), gone.contractId)),
      ).toBeInstanceOf(AccessDeniedError);
    });

    it('refuses the employee, and the owner after the link has ended', async () => {
      const w = await setup();
      const employee = await loanOutScene(w, { relation: 'employee' });
      expect(
        await errorOf(
          getContract(db(), at(employee.userId), employee.contractId),
        ),
      ).toBeInstanceOf(AccessDeniedError);
      const ended = await loanOutScene(w, {
        relation: 'owner',
        endDate: '2026-01-31',
      });
      expect(
        await errorOf(getContract(db(), at(ended.userId), ended.contractId)),
      ).toBeInstanceOf(AccessDeniedError);
    });

    it('never lets a party write: a party without contracts:edit cannot change or extend their contract', async () => {
      const w = await setup();
      const scene = await partyScene(w);
      const row = scene.view.parties[0]!;
      for (const write of [
        () =>
          updateContract(
            db(),
            at(scene.userId),
            scene.contractId,
            scene.view.version,
            { title: 'Renamed by the party' },
          ),
        () =>
          addContractParty(db(), at(scene.userId), scene.contractId, {
            personId: scene.personId,
            partyRole: 'producer',
          }),
        () => removeContractParty(db(), at(scene.userId), row.id, row.version),
      ]) {
        expect(await errorOf(write())).toMatchObject({
          name: 'AccessDeniedError',
          permission: EDIT,
        });
      }
      const after = await getContract(db(), at(w.manager), scene.contractId);
      expect(after.title).toBe('Camera operator agreement');
      expect(after.parties).toHaveLength(1);
    });
  });

  describe('listOwnContracts', () => {
    const titles = (views: ContractView[]) => views.map((v) => v.title);

    it('returns only the caller’s own contracts, from every project and the organisation, oldest first, in full', async () => {
      const w = await setup();
      const secondProject = await seedProject(database, w.organisationId);
      await grantOnProject(
        database,
        w.organisationId,
        secondProject,
        w.manager,
        [READ, EDIT, READ_VALUE],
      );
      const userId = await seedUser(database);
      const personId = await seedPerson(database, w.organisationId, { userId });
      const someoneElse = await seedPerson(database, w.organisationId, {
        userId: await seedUser(database),
      });
      const make = (
        title: string,
        clock: Date,
        projectId: string | null,
        partyId: string,
      ) =>
        createContract(db(), at(w.manager, clock), {
          organisationId: w.organisationId,
          projectId,
          kind: 'crew-contract',
          title,
          status: 'signed',
          ...WITH_AMOUNT,
          parties: [{ personId: partyId, partyRole: 'crew' }],
        });
      // Made out of order, so the answer shows it is sorted by creation time.
      await make('Third', new Date(Date.UTC(2026, 0, 3)), null, personId);
      await make(
        'First',
        new Date(Date.UTC(2026, 0, 1)),
        w.projectId,
        personId,
      );
      await make(
        'Not theirs',
        new Date(Date.UTC(2026, 0, 2)),
        w.projectId,
        someoneElse,
      );
      await make(
        'Second',
        new Date(Date.UTC(2026, 0, 2, 12)),
        secondProject,
        personId,
      );

      const own = await listOwnContracts(db(), at(userId), w.organisationId);
      expect(titles(own)).toEqual(['First', 'Second', 'Third']);
      for (const view of own) {
        expect(view.totalValue).toBe('125000.5000');
        expect(view.currency).toBe('GBP');
        expect(view.parties.map((p) => p.personId)).toEqual([personId]);
      }
    });

    it('includes the contracts of a loan-out company the caller owns, and leaves out an employee’s', async () => {
      const w = await setup();
      const owner = await loanOutScene(w, { relation: 'owner' });
      const employee = await loanOutScene(w, { relation: 'employee' });
      expect(
        (await listOwnContracts(db(), at(owner.userId), w.organisationId)).map(
          (v) => v.id,
        ),
      ).toEqual([owner.contractId]);
      expect(
        await listOwnContracts(db(), at(employee.userId), w.organisationId),
      ).toEqual([]);
    });

    it('leaves out deleted contracts, removed parties and other organisations', async () => {
      const w = await setup();
      const other = await setup();
      const userId = await seedUser(database);
      const personId = await seedPerson(database, w.organisationId, { userId });
      const otherPerson = await seedPerson(database, other.organisationId, {
        userId,
      });
      const make = (org: World, title: string, partyId: string) =>
        createContract(db(), at(org.manager), {
          organisationId: org.organisationId,
          projectId: org.projectId,
          kind: 'crew-contract',
          title,
          status: 'signed',
          parties: [{ personId: partyId, partyRole: 'crew' }],
        });
      await make(w, 'Kept', personId);
      const deleted = await make(w, 'Deleted', personId);
      const removed = await make(w, 'Removed party', personId);
      await make(other, 'Elsewhere', otherPerson);
      await db()
        .update(contract)
        .set({ deletedAt: NOW })
        .where(eq(contract.id, deleted.id));
      const row = removed.parties[0]!;
      await removeContractParty(db(), at(w.manager), row.id, row.version);

      expect(
        titles(await listOwnContracts(db(), at(userId), w.organisationId)),
      ).toEqual(['Kept']);
      expect(
        titles(await listOwnContracts(db(), at(userId), other.organisationId)),
      ).toEqual(['Elsewhere']);
    });

    it('returns an empty list for a caller who is a party to nothing, whatever they may read', async () => {
      const w = await setup();
      await partyScene(w);
      expect(
        await listOwnContracts(db(), at(w.outsider), w.organisationId),
      ).toEqual([]);
      // Reading every contract is not being a party to any.
      expect(
        await listOwnContracts(db(), at(w.manager), w.organisationId),
      ).toEqual([]);
    });
  });
});
