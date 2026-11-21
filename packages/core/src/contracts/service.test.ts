import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessDeniedError } from '../access/access-denied-error.js';
import { syncPermissions } from '../access/permission-sync.js';
import {
  grantOnOrganisation,
  grantOnProject,
  ORIGIN,
  seedCompany,
  seedEpisode,
  seedLocation,
  seedOrganisation,
  seedPerson,
  seedProject,
  seedUnit,
  seedUser,
  type SeedOrganisation,
} from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import {
  auditEvent,
  changeEvent,
  contract,
  contractLink,
  contractParty,
  permission,
  type OrgRole,
} from '../db/schema/index.js';
import {
  createMigratedDatabase,
  SQLSTATE,
  testTargets,
} from '../db/test-support.js';
import { RecordWriteError, VersionConflictError } from '../db/write.js';
import {
  CONTRACT_PERMISSIONS,
  CONTRACTS_EDIT_PERMISSION,
  CONTRACTS_READ_PERMISSION,
  CONTRACTS_READ_VALUE_PERMISSION,
} from './permissions.js';
import {
  addContractLink,
  addContractParty,
  ContractInputError,
  createContract,
  getContract,
  listContracts,
  removeContractLink,
  removeContractParty,
  updateContract,
  type ContractContext,
  type CreateContractValues,
} from './service.js';

// The permission keys are stored in role grants, so they are written out here
// instead of being taken from the constants under test.
const READ = 'contracts:read';
const EDIT = 'contracts:edit';
const READ_VALUE = 'contracts:read-value';

const NOW = new Date(Date.UTC(2026, 1, 1, 12));
const at = (userId: string): ContractContext => ({
  userId,
  originServer: ORIGIN,
  clock: () => NOW,
});

const WITH_AMOUNT = { currency: 'GBP', totalValue: '125000.5' } as const;
const AMOUNT_DIGITS = '125000';

describe('contract permissions', () => {
  it('are the three keys of the contracts module', () => {
    expect([
      CONTRACTS_READ_PERMISSION,
      CONTRACTS_EDIT_PERMISSION,
      CONTRACTS_READ_VALUE_PERMISSION,
    ]).toEqual([READ, EDIT, READ_VALUE]);
    expect(CONTRACT_PERMISSIONS.map((p) => p.key).sort()).toEqual(
      [EDIT, READ, READ_VALUE].sort(),
    );
    expect(CONTRACT_PERMISSIONS.every((p) => p.module === 'contracts')).toBe(
      true,
    );
  });
});

describe.each(testTargets)('contracts on $name', (target) => {
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
    // On the project.
    projectManager: string; // read, edit, read-value
    projectAssistant: string; // read, edit
    projectReader: string; // read
    projectValueReader: string; // read, read-value
    projectValueOnly: string; // read-value only
    projectEditor: string; // edit only
    // In the organisation. The tier grants nothing; the linked role does.
    orgManager: string; // read, edit, read-value
    orgAssistant: string; // read, edit
    orgReader: string; // read
    orgValueReader: string; // read, read-value
    orgEditor: string; // edit only
    outsider: string;
  };

  async function setup(): Promise<World> {
    const org = await seedOrganisation(database);
    const onProject = async (keys: string[]) => {
      const userId = await seedUser(database);
      await grantOnProject(
        database,
        org.organisationId,
        org.projectId,
        userId,
        keys,
      );
      return userId;
    };
    const inOrganisation = async (tier: OrgRole, keys: string[]) => {
      const userId = await seedUser(database);
      await grantOnOrganisation(
        database,
        org.organisationId,
        userId,
        tier,
        keys,
      );
      return userId;
    };
    return {
      ...org,
      projectManager: await onProject([READ, EDIT, READ_VALUE]),
      projectAssistant: await onProject([READ, EDIT]),
      projectReader: await onProject([READ]),
      projectValueReader: await onProject([READ, READ_VALUE]),
      projectValueOnly: await onProject([READ_VALUE]),
      projectEditor: await onProject([EDIT]),
      orgManager: await inOrganisation('owner', [READ, EDIT, READ_VALUE]),
      orgAssistant: await inOrganisation('admin', [READ, EDIT]),
      orgReader: await inOrganisation('member', [READ]),
      orgValueReader: await inOrganisation('supervisor', [READ, READ_VALUE]),
      orgEditor: await inOrganisation('guest', [EDIT]),
      outsider: await seedUser(database),
    };
  }

  const projectContract = (
    w: World,
    overrides: Partial<CreateContractValues> = {},
  ): CreateContractValues => ({
    organisationId: w.organisationId,
    projectId: w.projectId,
    kind: 'cast-contract',
    title: 'Lead actor agreement',
    status: 'negotiating',
    ...overrides,
  });

  const organisationContract = (
    w: World,
    overrides: Partial<CreateContractValues> = {},
  ): CreateContractValues => ({
    organisationId: w.organisationId,
    kind: 'sales-agency',
    title: 'Sales agency agreement',
    status: 'draft',
    ...overrides,
  });

  const contractsIn = (organisationId: string) =>
    db()
      .select()
      .from(contract)
      .where(eq(contract.organisationId, organisationId));
  const partiesIn = (organisationId: string) =>
    db()
      .select()
      .from(contractParty)
      .where(eq(contractParty.organisationId, organisationId));
  const linksIn = (organisationId: string) =>
    db()
      .select()
      .from(contractLink)
      .where(eq(contractLink.organisationId, organisationId));
  const eventsIn = (organisationId: string) =>
    db()
      .select()
      .from(changeEvent)
      .where(
        and(
          eq(changeEvent.organisationId, organisationId),
          inArray(changeEvent.entityType, [
            'contract',
            'contract_party',
            'contract_link',
          ]),
        ),
      )
      .orderBy(asc(changeEvent.seq));
  const auditIn = (organisationId: string) =>
    db()
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.organisationId, organisationId));

  /** The error a call fails with. Fails the test when the call succeeds. */
  const errorOf = (call: Promise<unknown>) =>
    call.then(
      () => {
        throw new Error('Expected the call to fail, but it succeeded');
      },
      (error: unknown) => error,
    );

  const denied = (permissionKey: string) => ({
    name: 'AccessDeniedError',
    permission: permissionKey,
  });

  async function expectNothingWritten(w: World) {
    expect(await contractsIn(w.organisationId)).toEqual([]);
    expect(await partiesIn(w.organisationId)).toEqual([]);
    expect(await linksIn(w.organisationId)).toEqual([]);
    expect(await eventsIn(w.organisationId)).toEqual([]);
  }

  describe('the permission catalogue', () => {
    // Amounts are what crew and cast are paid, so the permission that shows
    // them is the one flagged as granting sensitive data.
    it('is accepted by the permission table, and only contracts:read-value grants sensitive data', async () => {
      const found = await db()
        .select({
          key: permission.key,
          module: permission.module,
          grantsSensitive: permission.grantsSensitive,
        })
        .from(permission)
        .where(eq(permission.module, 'contracts'))
        .orderBy(asc(permission.key));
      expect(found).toEqual([
        { key: EDIT, module: 'contracts', grantsSensitive: false },
        { key: READ, module: 'contracts', grantsSensitive: false },
        { key: READ_VALUE, module: 'contracts', grantsSensitive: true },
      ]);
    });
  });

  describe('createContract', () => {
    it('writes the contract with its parties and links, and one change event for each, in the project sequence', async () => {
      const w = await setup();
      const personId = await seedPerson(database, w.organisationId);
      const companyId = await seedCompany(database, w.organisationId);
      const locationId = await seedLocation(database, w.organisationId);
      const created = await createContract(
        db(),
        at(w.projectManager),
        projectContract(w, {
          ...WITH_AMOUNT,
          territories: ['GB', 'IE'],
          signedOn: '2026-01-15',
          parties: [
            { personId, partyRole: 'artist' },
            { companyId, partyRole: 'loan-out company' },
          ],
          links: [
            { entityType: 'location', entityId: locationId },
            { entityType: 'project', entityId: w.projectId },
          ],
        }),
      );
      expect(created).toMatchObject({
        organisationId: w.organisationId,
        projectId: w.projectId,
        kind: 'cast-contract',
        title: 'Lead actor agreement',
        status: 'negotiating',
        signedOn: '2026-01-15',
        territories: ['GB', 'IE'],
        currency: 'GBP',
        totalValue: '125000.5000',
        visibility: 'private',
        retentionClass: 'contract',
        createdBy: w.projectManager,
        version: 1,
      });
      expect(
        created.parties.map((p) => [p.personId, p.companyId, p.partyRole]),
      ).toEqual([
        [personId, null, 'artist'],
        [null, companyId, 'loan-out company'],
      ]);
      expect(created.links.map((l) => [l.entityType, l.entityId])).toEqual([
        ['location', locationId],
        ['project', w.projectId],
      ]);
      expect(
        (await eventsIn(w.organisationId)).map((e) => [
          e.entityType,
          e.action,
          e.projectId,
          e.seq,
        ]),
      ).toEqual([
        ['contract', 'create', w.projectId, 1],
        ['contract_party', 'create', w.projectId, 2],
        ['contract_party', 'create', w.projectId, 3],
        ['contract_link', 'create', w.projectId, 4],
        ['contract_link', 'create', w.projectId, 5],
      ]);
    });

    it('writes an organisation-level contract with no project, checked in the organisation', async () => {
      const w = await setup();
      const created = await createContract(
        db(),
        at(w.orgManager),
        organisationContract(w, WITH_AMOUNT),
      );
      expect(created.projectId).toBeNull();
      expect(created.totalValue).toBe('125000.5000');
      const [event] = await eventsIn(w.organisationId);
      expect(event).toMatchObject({ entityType: 'contract', projectId: null });
    });

    it('needs contracts:edit, and says which permission was missing without naming the organisation or the contract', async () => {
      const w = await setup();
      for (const userId of [
        w.outsider,
        w.projectReader,
        w.projectValueReader,
      ]) {
        const error = await errorOf(
          createContract(db(), at(userId), projectContract(w)),
        );
        expect(error).toBeInstanceOf(AccessDeniedError);
        // The caller names the scope here, so the error says which kind it was.
        expect(error).toMatchObject({ ...denied(EDIT), scope: 'project' });
        expect((error as Error).message).not.toContain(w.organisationId);
        expect((error as Error).message).not.toContain(w.projectId);
      }
      await expectNothingWritten(w);
    });

    it('keeps project and organisation permissions apart', async () => {
      const w = await setup();
      const forOrganisation = await errorOf(
        createContract(db(), at(w.projectManager), organisationContract(w)),
      );
      expect(forOrganisation).toMatchObject({
        ...denied(EDIT),
        scope: 'organisation',
      });
      const forProject = await errorOf(
        createContract(db(), at(w.orgManager), projectContract(w)),
      );
      expect(forProject).toMatchObject({ ...denied(EDIT), scope: 'project' });
      await expectNothingWritten(w);
    });

    it('needs contracts:read-value as well to set an amount or a currency', async () => {
      const w = await setup();
      for (const amount of [WITH_AMOUNT, { currency: 'GBP' }]) {
        const error = await errorOf(
          createContract(
            db(),
            at(w.projectAssistant),
            projectContract(w, amount),
          ),
        );
        expect(error).toMatchObject(denied(READ_VALUE));
      }
      await expectNothingWritten(w);
      // Without an amount the same user may create the contract, and gets no
      // amount keys back.
      const created = await createContract(
        db(),
        at(w.projectAssistant),
        projectContract(w),
      );
      expect(created.title).toBe('Lead actor agreement');
      expect(Object.keys(created)).not.toContain('totalValue');
      expect(Object.keys(created)).not.toContain('currency');
    });

    it('leaves no contract, party or link behind when a link target is refused', async () => {
      const w = await setup();
      const personId = await seedPerson(database, w.organisationId);
      const error = await errorOf(
        createContract(
          db(),
          at(w.projectManager),
          projectContract(w, {
            parties: [{ personId, partyRole: 'artist' }],
            links: [
              { entityType: 'person', entityId: personId },
              { entityType: 'unit', entityId: newId() },
            ],
          }),
        ),
      );
      expect(error).toBeInstanceOf(ContractInputError);
      await expectNothingWritten(w);
    });

    it('leaves nothing behind, and uses no change sequence number, when the database refuses a later row', async () => {
      const w = await setup();
      const personId = await seedPerson(database, w.organisationId);
      const duplicateParty = await errorOf(
        createContract(
          db(),
          at(w.projectManager),
          projectContract(w, {
            parties: [
              { personId, partyRole: 'artist' },
              { personId, partyRole: 'artist' },
            ],
          }),
        ),
      );
      expect(duplicateParty).toBeInstanceOf(RecordWriteError);
      expect(duplicateParty).toMatchObject({
        code: SQLSTATE.uniqueViolation,
        constraint: 'contract_party_contract_person_company_role_unique',
      });
      const duplicateLink = await errorOf(
        createContract(
          db(),
          at(w.projectManager),
          projectContract(w, {
            parties: [{ personId, partyRole: 'artist' }],
            links: [
              { entityType: 'person', entityId: personId },
              { entityType: 'person', entityId: personId },
            ],
          }),
        ),
      );
      expect(duplicateLink).toMatchObject({
        code: SQLSTATE.uniqueViolation,
        constraint: 'contract_link_contract_entity_type_entity_unique',
      });
      await expectNothingWritten(w);
      // The counter went back with the rollback: the next event is number 1.
      await createContract(db(), at(w.projectManager), projectContract(w));
      expect((await eventsIn(w.organisationId)).map((e) => e.seq)).toEqual([1]);
    });

    it('refuses a database check violation without writing, and without the amount in the error', async () => {
      const w = await setup();
      const error = await errorOf(
        createContract(
          db(),
          at(w.projectManager),
          projectContract(w, {
            ...WITH_AMOUNT,
            effectiveFrom: '2026-03-01',
            effectiveTo: '2026-02-01',
          }),
        ),
      );
      expect(error).toMatchObject({
        code: SQLSTATE.checkViolation,
        constraint: 'contract_effective_period_check',
      });
      expect((error as Error).message).not.toContain(AMOUNT_DIGITS);
      await expectNothingWritten(w);
    });

    it('records the amount in no change event', async () => {
      const w = await setup();
      const created = await createContract(
        db(),
        at(w.projectManager),
        projectContract(w, WITH_AMOUNT),
      );
      await updateContract(db(), at(w.projectManager), created.id, 1, {
        totalValue: '250000',
      });
      const events = await eventsIn(w.organisationId);
      expect(events.map((e) => e.action)).toEqual(['create', 'update']);
      // The events say the amount was set and then changed, without the numbers.
      expect(events[0]!.changedFields).toContain('total_value');
      expect(events[1]!.changedFields).toEqual(['total_value']);
      const text = JSON.stringify(events);
      expect(text).not.toContain(AMOUNT_DIGITS);
      expect(text).not.toContain('250000');
    });
  });

  describe('link targets', () => {
    const TYPES = [
      'project',
      'person',
      'company',
      'location',
      'unit',
      'episode',
    ] as const;
    type LinkType = (typeof TYPES)[number];

    /** A live record of that type in the project (or the organisation). */
    async function targetOf(
      w: World,
      type: LinkType,
      projectId = w.projectId,
    ): Promise<string> {
      switch (type) {
        case 'project':
          return projectId;
        case 'person':
          return seedPerson(database, w.organisationId);
        case 'company':
          return seedCompany(database, w.organisationId);
        case 'location':
          return seedLocation(database, w.organisationId);
        case 'unit':
          return seedUnit(database, w.organisationId, projectId, newId());
        case 'episode':
          return seedEpisode(database, w.organisationId, projectId, newId());
      }
    }

    const softDelete = (type: LinkType, id: string) =>
      db().execute(
        sql`update ${sql.identifier(type)} set deleted_at = now() where id = ${id}`,
      );

    it.each(TYPES)(
      'accepts a %s of the contract’s organisation and project',
      async (type) => {
        const w = await setup();
        const made = await createContract(
          db(),
          at(w.projectManager),
          projectContract(w),
        );
        const entityId = await targetOf(w, type);
        const link = await addContractLink(
          db(),
          at(w.projectManager),
          made.id,
          {
            entityType: type,
            entityId,
          },
        );
        expect(link).toMatchObject({
          contractId: made.id,
          entityType: type,
          entityId,
          visibility: 'private',
          retentionClass: 'contract',
        });
      },
    );

    it.each(TYPES)('refuses a %s that does not exist', async (type) => {
      const w = await setup();
      const made = await createContract(
        db(),
        at(w.orgManager),
        organisationContract(w),
      );
      const error = await errorOf(
        addContractLink(db(), at(w.orgManager), made.id, {
          entityType: type,
          entityId: newId(),
        }),
      );
      expect(error).toBeInstanceOf(ContractInputError);
      expect(await linksIn(w.organisationId)).toEqual([]);
    });

    it.each(TYPES)('refuses a %s that is soft-deleted', async (type) => {
      const w = await setup();
      const made = await createContract(
        db(),
        at(w.orgManager),
        organisationContract(w),
      );
      // A project is deleted while it still has a live second project to hold the contract.
      const projectId =
        type === 'project'
          ? await seedProject(database, w.organisationId)
          : w.projectId;
      const entityId = await targetOf(w, type, projectId);
      await softDelete(type, entityId);
      const error = await errorOf(
        addContractLink(db(), at(w.orgManager), made.id, {
          entityType: type,
          entityId,
        }),
      );
      expect(error).toBeInstanceOf(ContractInputError);
      expect(await linksIn(w.organisationId)).toEqual([]);
    });

    it.each(TYPES)(
      'refuses a %s of another organisation, for an organisation contract and a project contract',
      async (type) => {
        const w = await setup();
        const other = await setup();
        const foreign = await targetOf(other, type, other.projectId);
        const organisationLevel = await createContract(
          db(),
          at(w.orgManager),
          organisationContract(w),
        );
        const projectLevel = await createContract(
          db(),
          at(w.projectManager),
          projectContract(w),
        );
        for (const [made, userId] of [
          [organisationLevel, w.orgManager],
          [projectLevel, w.projectManager],
        ] as const) {
          const error = await errorOf(
            addContractLink(db(), at(userId), made.id, {
              entityType: type,
              entityId: foreign,
            }),
          );
          expect(error).toBeInstanceOf(ContractInputError);
          expect((error as Error).message).not.toContain(foreign);
        }
        expect(await linksIn(w.organisationId)).toEqual([]);
      },
    );

    it.each(['project', 'unit', 'episode'] as const)(
      'refuses a %s of another project for a project contract',
      async (type) => {
        const w = await setup();
        const otherProject = await seedProject(database, w.organisationId);
        const made = await createContract(
          db(),
          at(w.projectManager),
          projectContract(w),
        );
        const error = await errorOf(
          addContractLink(db(), at(w.projectManager), made.id, {
            entityType: type,
            entityId: await targetOf(w, type, otherProject),
          }),
        );
        expect(error).toBeInstanceOf(ContractInputError);
        expect(await linksIn(w.organisationId)).toEqual([]);
      },
    );

    it.each(['project', 'unit', 'episode'] as const)(
      'accepts a %s of any project of the organisation for an organisation contract',
      async (type) => {
        const w = await setup();
        const otherProject = await seedProject(database, w.organisationId);
        const made = await createContract(
          db(),
          at(w.orgManager),
          organisationContract(w),
        );
        const link = await addContractLink(db(), at(w.orgManager), made.id, {
          entityType: type,
          entityId: await targetOf(w, type, otherProject),
        });
        expect(link.entityType).toBe(type);
      },
    );

    it('refuses an unknown entity type with an input error, not a crash', async () => {
      const w = await setup();
      const made = await createContract(
        db(),
        at(w.orgManager),
        organisationContract(w),
      );
      const error = await errorOf(
        addContractLink(db(), at(w.orgManager), made.id, {
          entityType: 'budget' as never,
          entityId: newId(),
        }),
      );
      expect(error).toBeInstanceOf(ContractInputError);
      expect(await linksIn(w.organisationId)).toEqual([]);
    });

    // The link types sit in a plain object, and every object inherits these
    // names. They must be refused like any other name that is not a type.
    it.each(['constructor', '__proto__', 'toString'])(
      'refuses the inherited property name %s as the type of a link added later',
      async (entityType) => {
        const w = await setup();
        const made = await createContract(
          db(),
          at(w.orgManager),
          organisationContract(w),
        );
        const error = await errorOf(
          addContractLink(db(), at(w.orgManager), made.id, {
            entityType: entityType as never,
            entityId: newId(),
          }),
        );
        expect(error).toBeInstanceOf(ContractInputError);
        expect((error as Error).message).toContain('unknown entity type');
        expect(await linksIn(w.organisationId)).toEqual([]);
      },
    );

    it.each(['constructor', '__proto__', 'toString'])(
      'refuses a new contract whose link has the inherited property name %s as its type',
      async (entityType) => {
        const w = await setup();
        const error = await errorOf(
          createContract(
            db(),
            at(w.projectManager),
            projectContract(w, {
              links: [{ entityType: entityType as never, entityId: newId() }],
            }),
          ),
        );
        expect(error).toBeInstanceOf(ContractInputError);
        expect((error as Error).message).toContain('unknown entity type');
        await expectNothingWritten(w);
      },
    );

    it('refuses the whole contract when one link of several is refused', async () => {
      const w = await setup();
      const personId = await seedPerson(database, w.organisationId);
      const error = await errorOf(
        createContract(
          db(),
          at(w.projectManager),
          projectContract(w, {
            links: [
              { entityType: 'person', entityId: personId },
              { entityType: 'company', entityId: newId() },
            ],
          }),
        ),
      );
      expect(error).toBeInstanceOf(ContractInputError);
      await expectNothingWritten(w);
    });
  });

  describe('parties', () => {
    it('adds a party with contracts:edit and writes its change event in the project sequence', async () => {
      const w = await setup();
      const made = await createContract(
        db(),
        at(w.projectManager),
        projectContract(w),
      );
      const personId = await seedPerson(database, w.organisationId);
      const party = await addContractParty(db(), at(w.projectEditor), made.id, {
        personId,
        partyRole: 'artist',
      });
      expect(party).toMatchObject({
        contractId: made.id,
        personId,
        companyId: null,
        partyRole: 'artist',
        visibility: 'private',
        retentionClass: 'contract',
        createdBy: w.projectEditor,
      });
      const events = await eventsIn(w.organisationId);
      expect(events.at(-1)).toMatchObject({
        entityType: 'contract_party',
        entityId: party.id,
        action: 'create',
        projectId: w.projectId,
      });
    });

    it('needs contracts:edit on the contract’s own scope', async () => {
      const w = await setup();
      const projectLevel = await createContract(
        db(),
        at(w.projectManager),
        projectContract(w),
      );
      const organisationLevel = await createContract(
        db(),
        at(w.orgManager),
        organisationContract(w),
      );
      const personId = await seedPerson(database, w.organisationId);
      const attempts = [
        [w.outsider, projectLevel.id],
        [w.projectReader, projectLevel.id],
        [w.orgManager, projectLevel.id],
        [w.projectManager, organisationLevel.id],
        [w.projectManager, newId()],
      ] as const;
      for (const [userId, contractId] of attempts) {
        const error = await errorOf(
          addContractParty(db(), at(userId), contractId, {
            personId,
            partyRole: 'artist',
          }),
        );
        expect(error).toMatchObject(denied(EDIT));
      }
      expect(await partiesIn(w.organisationId)).toEqual([]);
    });

    it('lets the database refuse a repeated party', async () => {
      const w = await setup();
      const made = await createContract(
        db(),
        at(w.projectManager),
        projectContract(w),
      );
      const personId = await seedPerson(database, w.organisationId);
      await addContractParty(db(), at(w.projectManager), made.id, {
        personId,
        partyRole: 'artist',
      });
      const repeated = await errorOf(
        addContractParty(db(), at(w.projectManager), made.id, {
          personId,
          partyRole: 'artist',
        }),
      );
      expect(repeated).toBeInstanceOf(RecordWriteError);
      expect(repeated).toMatchObject({
        code: SQLSTATE.uniqueViolation,
        constraint: 'contract_party_contract_person_company_role_unique',
      });
    });

    describe('party targets', () => {
      const KINDS = ['person', 'company'] as const;
      type Kind = (typeof KINDS)[number];

      const seedTarget = (kind: Kind, organisationId: string) =>
        kind === 'person'
          ? seedPerson(database, organisationId)
          : seedCompany(database, organisationId);
      const asParty = (kind: Kind, id: string) =>
        kind === 'person'
          ? ({ personId: id, partyRole: 'artist' } as const)
          : ({ companyId: id, partyRole: 'licensor' } as const);
      const softDelete = (kind: Kind, id: string) =>
        db().execute(
          sql`update ${sql.identifier(kind)} set deleted_at = now() where id = ${id}`,
        );

      it.each(KINDS)('refuses a %s that does not exist', async (kind) => {
        const w = await setup();
        const made = await createContract(
          db(),
          at(w.projectManager),
          projectContract(w),
        );
        const error = await errorOf(
          addContractParty(
            db(),
            at(w.projectManager),
            made.id,
            asParty(kind, newId()),
          ),
        );
        expect(error).toBeInstanceOf(ContractInputError);
        expect(await partiesIn(w.organisationId)).toEqual([]);
      });

      it.each(KINDS)('refuses a %s that is soft-deleted', async (kind) => {
        const w = await setup();
        const made = await createContract(
          db(),
          at(w.projectManager),
          projectContract(w),
        );
        const id = await seedTarget(kind, w.organisationId);
        await softDelete(kind, id);
        const error = await errorOf(
          addContractParty(
            db(),
            at(w.projectManager),
            made.id,
            asParty(kind, id),
          ),
        );
        expect(error).toBeInstanceOf(ContractInputError);
        expect((error as Error).message).not.toContain(id);
        expect(await partiesIn(w.organisationId)).toEqual([]);
        expect(await eventsIn(w.organisationId)).toHaveLength(1);
      });

      it.each(KINDS)('refuses a %s of another organisation', async (kind) => {
        const w = await setup();
        const other = await setup();
        const made = await createContract(
          db(),
          at(w.projectManager),
          projectContract(w),
        );
        const error = await errorOf(
          addContractParty(
            db(),
            at(w.projectManager),
            made.id,
            asParty(kind, await seedTarget(kind, other.organisationId)),
          ),
        );
        expect(error).toBeInstanceOf(ContractInputError);
        expect(await partiesIn(w.organisationId)).toEqual([]);
      });

      it.each(KINDS)(
        'refuses the whole contract when one party of several has a deleted %s',
        async (kind) => {
          const w = await setup();
          const alive = await seedPerson(database, w.organisationId);
          const deleted = await seedTarget(kind, w.organisationId);
          await softDelete(kind, deleted);
          const error = await errorOf(
            createContract(
              db(),
              at(w.projectManager),
              projectContract(w, {
                parties: [
                  { personId: alive, partyRole: 'producer' },
                  asParty(kind, deleted),
                ],
              }),
            ),
          );
          expect(error).toBeInstanceOf(ContractInputError);
          await expectNothingWritten(w);
        },
      );

      it.each(KINDS)(
        'keeps an existing party when its %s is soft-deleted later, and still lets it be removed',
        async (kind) => {
          const w = await setup();
          const id = await seedTarget(kind, w.organisationId);
          const made = await createContract(
            db(),
            at(w.projectManager),
            projectContract(w, { parties: [asParty(kind, id)] }),
          );
          await softDelete(kind, id);
          const read = await getContract(db(), at(w.projectManager), made.id);
          expect(read.parties.map((p) => p.id)).toEqual([made.parties[0]!.id]);
          await removeContractParty(
            db(),
            at(w.projectManager),
            made.parties[0]!.id,
            1,
          );
          expect(
            (await getContract(db(), at(w.projectManager), made.id)).parties,
          ).toEqual([]);
        },
      );

      it('refuses to restore a removed party whose person has been deleted since', async () => {
        const w = await setup();
        const personId = await seedPerson(database, w.organisationId);
        const made = await createContract(
          db(),
          at(w.projectManager),
          projectContract(w, { parties: [{ personId, partyRole: 'artist' }] }),
        );
        await removeContractParty(
          db(),
          at(w.projectManager),
          made.parties[0]!.id,
          1,
        );
        await softDelete('person', personId);
        const error = await errorOf(
          addContractParty(db(), at(w.projectManager), made.id, {
            personId,
            partyRole: 'artist',
          }),
        );
        expect(error).toBeInstanceOf(ContractInputError);
        const [row] = await partiesIn(w.organisationId);
        expect(row).toMatchObject({ deletedAt: NOW, version: 2 });
      });
    });

    it('removes a party by soft delete, and a stale version removes nothing', async () => {
      const w = await setup();
      const personId = await seedPerson(database, w.organisationId);
      const made = await createContract(
        db(),
        at(w.projectManager),
        projectContract(w, { parties: [{ personId, partyRole: 'artist' }] }),
      );
      const [party] = made.parties;
      const stale = await errorOf(
        removeContractParty(db(), at(w.projectEditor), party!.id, 7),
      );
      expect(stale).toBeInstanceOf(VersionConflictError);
      expect(
        (await getContract(db(), at(w.projectManager), made.id)).parties,
      ).toHaveLength(1);

      const removed = await removeContractParty(
        db(),
        at(w.projectEditor),
        party!.id,
        party!.version,
      );
      expect(removed.deletedAt).toEqual(NOW);
      expect(removed.deletedBy).toBe(w.projectEditor);
      expect(
        (await getContract(db(), at(w.projectManager), made.id)).parties,
      ).toEqual([]);
      expect((await eventsIn(w.organisationId)).at(-1)).toMatchObject({
        entityType: 'contract_party',
        action: 'delete',
        projectId: w.projectId,
      });
    });

    it('restores a removed party instead of failing on the unique key when it is added again', async () => {
      const w = await setup();
      const personId = await seedPerson(database, w.organisationId);
      const made = await createContract(
        db(),
        at(w.projectManager),
        projectContract(w, { parties: [{ personId, partyRole: 'artist' }] }),
      );
      const [party] = made.parties;
      await removeContractParty(db(), at(w.projectEditor), party!.id, 1);
      const again = await addContractParty(db(), at(w.projectEditor), made.id, {
        personId,
        partyRole: 'artist',
      });
      expect(again).toMatchObject({
        id: party!.id,
        deletedAt: null,
        version: 3,
      });
      expect(
        (await getContract(db(), at(w.projectManager), made.id)).parties.map(
          (p) => p.id,
        ),
      ).toEqual([party!.id]);
      expect((await eventsIn(w.organisationId)).map((e) => e.action)).toEqual([
        'create',
        'create',
        'delete',
        'restore',
      ]);
    });

    it('refuses to remove a party without contracts:edit, or one that does not exist', async () => {
      const w = await setup();
      const personId = await seedPerson(database, w.organisationId);
      const made = await createContract(
        db(),
        at(w.projectManager),
        projectContract(w, { parties: [{ personId, partyRole: 'artist' }] }),
      );
      const [party] = made.parties;
      for (const [userId, partyId] of [
        [w.projectReader, party!.id],
        [w.outsider, party!.id],
        [w.projectManager, newId()],
      ] as const) {
        const error = await errorOf(
          removeContractParty(db(), at(userId), partyId, 1),
        );
        expect(error).toMatchObject(denied(EDIT));
      }
      expect((await partiesIn(w.organisationId))[0]!.deletedAt).toBeNull();
    });
  });

  describe('links', () => {
    it('adds a link with contracts:edit and writes its change event', async () => {
      const w = await setup();
      const made = await createContract(
        db(),
        at(w.projectManager),
        projectContract(w),
      );
      const locationId = await seedLocation(database, w.organisationId);
      const link = await addContractLink(db(), at(w.projectEditor), made.id, {
        entityType: 'location',
        entityId: locationId,
      });
      expect((await eventsIn(w.organisationId)).at(-1)).toMatchObject({
        entityType: 'contract_link',
        entityId: link.id,
        action: 'create',
        projectId: w.projectId,
      });
    });

    it('needs contracts:edit on the contract’s own scope', async () => {
      const w = await setup();
      const made = await createContract(
        db(),
        at(w.orgManager),
        organisationContract(w),
      );
      const locationId = await seedLocation(database, w.organisationId);
      for (const userId of [w.outsider, w.orgReader, w.projectManager]) {
        const error = await errorOf(
          addContractLink(db(), at(userId), made.id, {
            entityType: 'location',
            entityId: locationId,
          }),
        );
        expect(error).toMatchObject(denied(EDIT));
      }
      expect(await linksIn(w.organisationId)).toEqual([]);
    });

    it('lets the database refuse a repeated link', async () => {
      const w = await setup();
      const made = await createContract(
        db(),
        at(w.projectManager),
        projectContract(w),
      );
      const locationId = await seedLocation(database, w.organisationId);
      const link = { entityType: 'location', entityId: locationId } as const;
      await addContractLink(db(), at(w.projectManager), made.id, link);
      const error = await errorOf(
        addContractLink(db(), at(w.projectManager), made.id, link),
      );
      expect(error).toMatchObject({
        code: SQLSTATE.uniqueViolation,
        constraint: 'contract_link_contract_entity_type_entity_unique',
      });
    });

    it('removes a link by soft delete, and restores it when it is added again', async () => {
      const w = await setup();
      const locationId = await seedLocation(database, w.organisationId);
      const link = { entityType: 'location', entityId: locationId } as const;
      const made = await createContract(
        db(),
        at(w.projectManager),
        projectContract(w, { links: [link] }),
      );
      const [first] = made.links;
      const stale = await errorOf(
        removeContractLink(db(), at(w.projectEditor), first!.id, 9),
      );
      expect(stale).toBeInstanceOf(VersionConflictError);
      await removeContractLink(db(), at(w.projectEditor), first!.id, 1);
      expect(
        (await getContract(db(), at(w.projectManager), made.id)).links,
      ).toEqual([]);
      const again = await addContractLink(
        db(),
        at(w.projectEditor),
        made.id,
        link,
      );
      expect(again).toMatchObject({
        id: first!.id,
        deletedAt: null,
        version: 3,
      });
    });

    it('refuses to remove a link without contracts:edit', async () => {
      const w = await setup();
      const locationId = await seedLocation(database, w.organisationId);
      const made = await createContract(
        db(),
        at(w.projectManager),
        projectContract(w, {
          links: [{ entityType: 'location', entityId: locationId }],
        }),
      );
      const error = await errorOf(
        removeContractLink(db(), at(w.projectReader), made.links[0]!.id, 1),
      );
      expect(error).toMatchObject(denied(EDIT));
      expect((await linksIn(w.organisationId))[0]!.deletedAt).toBeNull();
    });
  });

  describe('getContract', () => {
    async function withAmount(w: World) {
      const personId = await seedPerson(database, w.organisationId);
      const locationId = await seedLocation(database, w.organisationId);
      return createContract(
        db(),
        at(w.projectManager),
        projectContract(w, {
          ...WITH_AMOUNT,
          parties: [{ personId, partyRole: 'artist' }],
          links: [{ entityType: 'location', entityId: locationId }],
        }),
      );
    }

    it('leaves the amount and the currency out, as absent keys, for contracts:read alone', async () => {
      const w = await setup();
      const made = await withAmount(w);
      const view = await getContract(db(), at(w.projectReader), made.id);
      expect(view).toMatchObject({
        id: made.id,
        title: 'Lead actor agreement',
      });
      expect(Object.keys(view)).not.toContain('totalValue');
      expect(Object.keys(view)).not.toContain('currency');
      expect(JSON.stringify(view)).not.toContain(AMOUNT_DIGITS);
      expect(view.parties).toHaveLength(1);
      expect(view.links).toHaveLength(1);
    });

    it('gives the amount and the currency to contracts:read-value', async () => {
      const w = await setup();
      const made = await withAmount(w);
      for (const userId of [w.projectValueReader, w.projectManager]) {
        const view = await getContract(db(), at(userId), made.id);
        expect(view).toMatchObject({
          currency: 'GBP',
          totalValue: '125000.5000',
        });
      }
    });

    it('gives a contract with no amount the same shape, whoever reads it', async () => {
      const w = await setup();
      const made = await createContract(
        db(),
        at(w.projectManager),
        projectContract(w),
      );
      const plain = await getContract(db(), at(w.projectReader), made.id);
      const full = await getContract(db(), at(w.projectManager), made.id);
      expect(Object.keys(plain)).not.toContain('totalValue');
      expect(full).toMatchObject({ currency: null, totalValue: null });
    });

    it('needs contracts:read: read-value alone, edit alone and no role all fail', async () => {
      const w = await setup();
      const made = await withAmount(w);
      for (const userId of [w.projectValueOnly, w.projectEditor, w.outsider]) {
        const error = await errorOf(getContract(db(), at(userId), made.id));
        expect(error).toMatchObject(denied(READ));
      }
    });

    it('checks an organisation contract in the organisation, and a project contract on the project', async () => {
      const w = await setup();
      const organisationLevel = await createContract(
        db(),
        at(w.orgManager),
        organisationContract(w, WITH_AMOUNT),
      );
      const projectLevel = await withAmount(w);

      const seen = await getContract(
        db(),
        at(w.orgReader),
        organisationLevel.id,
      );
      expect(seen.title).toBe('Sales agency agreement');
      expect(Object.keys(seen)).not.toContain('totalValue');
      expect(
        (await getContract(db(), at(w.orgValueReader), organisationLevel.id))
          .totalValue,
      ).toBe('125000.5000');

      // Own-scope grants of the other scope grant nothing.
      for (const [userId, id] of [
        [w.projectManager, organisationLevel.id],
        [w.orgManager, projectLevel.id],
      ] as const) {
        const error = await errorOf(getContract(db(), at(userId), id));
        expect(error).toMatchObject(denied(READ));
      }
    });

    it('refuses an unknown contract, a deleted one and one of another organisation like any other denial', async () => {
      const w = await setup();
      const other = await setup();
      const made = await withAmount(w);
      const deleted = await createContract(
        db(),
        at(w.projectManager),
        projectContract(w),
      );
      await db().execute(
        sql`update contract set deleted_at = now() where id = ${deleted.id}`,
      );
      for (const [userId, id] of [
        [w.projectManager, newId()],
        [w.projectManager, deleted.id],
        [other.projectManager, made.id],
      ] as const) {
        const error = await errorOf(getContract(db(), at(userId), id));
        expect(error).toMatchObject(denied(READ));
        expect((error as Error).message).not.toContain(id);
      }
    });
  });

  describe('listContracts', () => {
    /**
     * Two contracts of the project, two organisation-level ones, and one of
     * another project of the same organisation.
     */
    async function seedList(w: World) {
      const cast = await createContract(
        db(),
        at(w.projectManager),
        projectContract(w, { title: 'Cast A', ...WITH_AMOUNT }),
      );
      const crew = await createContract(
        db(),
        at(w.projectManager),
        projectContract(w, {
          title: 'Crew B',
          kind: 'crew-contract',
          status: 'signed',
          ...WITH_AMOUNT,
        }),
      );
      await createContract(
        db(),
        at(w.orgManager),
        organisationContract(w, { title: 'Agency C', ...WITH_AMOUNT }),
      );
      await createContract(
        db(),
        at(w.orgManager),
        organisationContract(w, { title: 'Agency D' }),
      );
      const otherProject = await seedProject(database, w.organisationId);
      await grantOnProject(
        database,
        w.organisationId,
        otherProject,
        w.projectManager,
        [READ, EDIT, READ_VALUE],
      );
      await createContract(
        db(),
        at(w.projectManager),
        projectContract(w, {
          projectId: otherProject,
          title: 'Other project E',
        }),
      );
      return { cast, crew };
    }
    const titles = (views: { title: string }[]) => views.map((v) => v.title);

    it('lists the contracts of one project, without amounts for contracts:read alone', async () => {
      const w = await setup();
      await seedList(w);
      const views = await listContracts(db(), at(w.projectReader), {
        organisationId: w.organisationId,
        projectId: w.projectId,
      });
      expect(titles(views)).toEqual(['Cast A', 'Crew B']);
      for (const view of views) {
        expect(Object.keys(view)).not.toContain('totalValue');
        expect(Object.keys(view)).not.toContain('currency');
      }
      expect(JSON.stringify(views)).not.toContain(AMOUNT_DIGITS);
    });

    it('lists the organisation-level contracts, not those of any project', async () => {
      const w = await setup();
      await seedList(w);
      const views = await listContracts(db(), at(w.orgReader), {
        organisationId: w.organisationId,
      });
      expect(titles(views)).toEqual(['Agency C', 'Agency D']);
      const explicit = await listContracts(db(), at(w.orgValueReader), {
        organisationId: w.organisationId,
        projectId: null,
      });
      expect(explicit.map((v) => v.totalValue)).toEqual(['125000.5000', null]);
    });

    it('gives amounts to contracts:read-value', async () => {
      const w = await setup();
      await seedList(w);
      const views = await listContracts(db(), at(w.projectValueReader), {
        organisationId: w.organisationId,
        projectId: w.projectId,
      });
      expect(views.map((v) => v.totalValue)).toEqual([
        '125000.5000',
        '125000.5000',
      ]);
    });

    it('filters by kind and by status', async () => {
      const w = await setup();
      await seedList(w);
      const scope = {
        organisationId: w.organisationId,
        projectId: w.projectId,
      };
      expect(
        titles(
          await listContracts(db(), at(w.projectReader), {
            ...scope,
            kind: 'crew-contract',
          }),
        ),
      ).toEqual(['Crew B']);
      expect(
        titles(
          await listContracts(db(), at(w.projectReader), {
            ...scope,
            status: 'negotiating',
          }),
        ),
      ).toEqual(['Cast A']);
      expect(
        await listContracts(db(), at(w.projectReader), {
          ...scope,
          kind: 'crew-contract',
          status: 'negotiating',
        }),
      ).toEqual([]);
    });

    it('leaves out deleted contracts and carries each contract’s own parties', async () => {
      const w = await setup();
      const { cast, crew } = await seedList(w);
      const personId = await seedPerson(database, w.organisationId);
      await addContractParty(db(), at(w.projectManager), cast.id, {
        personId,
        partyRole: 'artist',
      });
      await db().execute(
        sql`update contract set deleted_at = now() where id = ${crew.id}`,
      );
      const views = await listContracts(db(), at(w.projectReader), {
        organisationId: w.organisationId,
        projectId: w.projectId,
      });
      expect(views.map((v) => [v.title, v.parties.length])).toEqual([
        ['Cast A', 1],
      ]);
    });

    it('needs contracts:read on the listed scope', async () => {
      const w = await setup();
      await seedList(w);
      const asked = [
        [w.outsider, w.projectId],
        [w.projectEditor, w.projectId],
        [w.orgReader, w.projectId],
        [w.projectReader, null],
      ] as const;
      for (const [userId, projectId] of asked) {
        const error = await errorOf(
          listContracts(db(), at(userId), {
            organisationId: w.organisationId,
            projectId,
          }),
        );
        // The caller names the scope in a list, so the error says which kind.
        expect(error).toMatchObject({
          ...denied(READ),
          scope: projectId === null ? 'organisation' : 'project',
        });
      }
    });
  });

  describe('updateContract', () => {
    async function made(w: World) {
      return createContract(
        db(),
        at(w.projectManager),
        projectContract(w, WITH_AMOUNT),
      );
    }

    it('changes fields with contracts:edit and returns no amount to a user without contracts:read-value', async () => {
      const w = await setup();
      const c = await made(w);
      const byEditor = await updateContract(
        db(),
        at(w.projectEditor),
        c.id,
        1,
        {
          title: 'Renamed by editor',
        },
      );
      const byAssistant = await updateContract(
        db(),
        at(w.projectAssistant),
        c.id,
        2,
        { title: 'Renamed by assistant' },
      );
      for (const view of [byEditor, byAssistant]) {
        expect(Object.keys(view)).not.toContain('totalValue');
        expect(Object.keys(view)).not.toContain('currency');
        expect(JSON.stringify(view)).not.toContain(AMOUNT_DIGITS);
      }
      const [row] = await contractsIn(w.organisationId);
      expect(row).toMatchObject({
        title: 'Renamed by assistant',
        totalValue: '125000.5000',
        currency: 'GBP',
        version: 3,
        updatedBy: w.projectAssistant,
      });
    });

    it('needs contracts:read-value to change the amount or the currency, and changes nothing without it', async () => {
      const w = await setup();
      const c = await made(w);
      for (const changes of [
        { totalValue: '1' },
        { totalValue: null },
        { currency: 'EUR' },
        { totalValue: '1', currency: 'EUR' },
      ]) {
        const error = await errorOf(
          updateContract(db(), at(w.projectAssistant), c.id, 1, changes),
        );
        expect(error).toMatchObject(denied(READ_VALUE));
      }
      const [row] = await contractsIn(w.organisationId);
      expect(row).toMatchObject({
        currency: 'GBP',
        totalValue: '125000.5000',
        version: 1,
      });
    });

    it('changes the amount for contracts:read-value together with contracts:edit, and shows it to them', async () => {
      const w = await setup();
      const c = await made(w);
      const view = await updateContract(db(), at(w.projectManager), c.id, 1, {
        currency: 'EUR',
        totalValue: '99.99',
      });
      expect(view).toMatchObject({
        currency: 'EUR',
        totalValue: '99.9900',
        version: 2,
      });
    });

    it('needs contracts:edit, even with contracts:read and contracts:read-value', async () => {
      const w = await setup();
      const c = await made(w);
      for (const userId of [
        w.projectValueReader,
        w.projectReader,
        w.outsider,
        w.orgManager,
      ]) {
        const error = await errorOf(
          updateContract(db(), at(userId), c.id, 1, { title: 'Nope' }),
        );
        expect(error).toMatchObject(denied(EDIT));
      }
      const [row] = await contractsIn(w.organisationId);
      expect(row).toMatchObject({ title: 'Lead actor agreement', version: 1 });
    });

    it('checks an organisation contract in the organisation', async () => {
      const w = await setup();
      const c = await createContract(
        db(),
        at(w.orgManager),
        organisationContract(w),
      );
      const byProject = await errorOf(
        updateContract(db(), at(w.projectManager), c.id, 1, { title: 'Nope' }),
      );
      expect(byProject).toMatchObject(denied(EDIT));
      const view = await updateContract(db(), at(w.orgEditor), c.id, 1, {
        status: 'negotiating',
      });
      expect(view.status).toBe('negotiating');
    });

    it('refuses an unknown contract and one of another organisation like any other denial', async () => {
      const w = await setup();
      const other = await setup();
      const c = await made(w);
      for (const [userId, id] of [
        [w.projectManager, newId()],
        [other.projectManager, c.id],
      ] as const) {
        const error = await errorOf(
          updateContract(db(), at(userId), id, 1, { title: 'Nope' }),
        );
        expect(error).toMatchObject(denied(EDIT));
      }
    });

    it('throws VersionConflictError for a stale version and writes nothing', async () => {
      const w = await setup();
      const c = await made(w);
      await updateContract(db(), at(w.projectManager), c.id, 1, {
        title: 'First',
      });
      const error = await errorOf(
        updateContract(db(), at(w.projectManager), c.id, 1, {
          title: 'Second',
        }),
      );
      expect(error).toBeInstanceOf(VersionConflictError);
      const [row] = await contractsIn(w.organisationId);
      expect(row).toMatchObject({ title: 'First', version: 2 });
    });

    it('lets the database refuse a bad change, without the amount in the error', async () => {
      const w = await setup();
      const c = await made(w);
      const error = await errorOf(
        updateContract(db(), at(w.projectManager), c.id, 1, { currency: null }),
      );
      expect(error).toBeInstanceOf(RecordWriteError);
      expect(error).toMatchObject({
        code: SQLSTATE.checkViolation,
        constraint: 'contract_total_value_currency_check',
      });
      expect((error as Error).message).not.toContain(AMOUNT_DIGITS);
      const [row] = await contractsIn(w.organisationId);
      expect(row).toMatchObject({ currency: 'GBP', version: 1 });
    });
  });

  describe('denials', () => {
    it('are not audited', async () => {
      const w = await setup();
      const c = await createContract(
        db(),
        at(w.projectManager),
        projectContract(w),
      );
      const personId = await seedPerson(database, w.organisationId);
      const who = at(w.outsider);
      const calls = [
        () => createContract(db(), who, projectContract(w)),
        () => updateContract(db(), who, c.id, 1, { title: 'Nope' }),
        () => getContract(db(), who, c.id),
        () =>
          listContracts(db(), who, {
            organisationId: w.organisationId,
            projectId: w.projectId,
          }),
        () =>
          addContractParty(db(), who, c.id, { personId, partyRole: 'artist' }),
        () =>
          addContractLink(db(), who, c.id, {
            entityType: 'person',
            entityId: personId,
          }),
        () => removeContractParty(db(), who, newId(), 1),
        () => removeContractLink(db(), who, newId(), 1),
      ];
      for (const call of calls) {
        expect(await errorOf(call())).toBeInstanceOf(AccessDeniedError);
      }
      expect(await auditIn(w.organisationId)).toEqual([]);
    });

    // The caller names only an id, so the error must not say which scope the
    // contract is in: an unknown id would have no scope to name, and the
    // difference would tell whether the id exists.
    it('do not say which scope a contract is in, so an unknown id answers like a forbidden one', async () => {
      const w = await setup();
      const projectLevel = await createContract(
        db(),
        at(w.projectManager),
        projectContract(w),
      );
      const organisationLevel = await createContract(
        db(),
        at(w.orgManager),
        organisationContract(w),
      );
      const who = at(w.outsider);
      const ids = [newId(), projectLevel.id, organisationLevel.id];
      const answers: [string, unknown][] = [];
      for (const id of ids) {
        answers.push([READ, await errorOf(getContract(db(), who, id))]);
        answers.push([
          EDIT,
          await errorOf(updateContract(db(), who, id, 1, { title: 'Nope' })),
        ]);
      }
      for (const [key, answer] of answers) {
        expect(answer).toBeInstanceOf(AccessDeniedError);
        expect(answer).toMatchObject(denied(key));
        expect((answer as AccessDeniedError).scope).toBeUndefined();
      }
      // Whatever the id, one operation gives one message.
      for (const key of [READ, EDIT]) {
        const messages = answers
          .filter(([k]) => k === key)
          .map(([, answer]) => (answer as Error).message);
        expect(new Set(messages).size).toBe(1);
      }
    });
  });
});
