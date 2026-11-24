import {
  grantOnOrganisation,
  grantOnProject,
  ORIGIN,
  seedOrganisation,
  seedUser,
  type SeedOrganisation,
} from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import {
  createContract,
  type ContractContext,
  type ContractView,
} from './service.js';
import type { ContractTermsInput } from './terms.js';

/*
 * Shared by the tests of contract terms. People and contracts here are invented,
 * from the demo production The Last Withdrawal.
 */

/** The permission keys, written out so a test does not take them from the code under test. */
export const READ = 'contracts:read';
/** See `READ`. */
export const EDIT = 'contracts:edit';
/** See `READ`. */
export const READ_VALUE = 'contracts:read-value';

/** The instant the tests run at. */
export const NOW = new Date(Date.UTC(2026, 1, 1, 12));

/** A contract context for `userId`, on the test server and clock. */
export function at(userId: string, clock: Date = NOW): ContractContext {
  return { userId, originServer: ORIGIN, clock: () => clock };
}

/** An organisation with a project and the users the terms tests need, each with the grants named. */
export type TermsWorld = SeedOrganisation & {
  /** Reads, edits and reads values on the project and in the organisation. */
  manager: string;
  /** Reads and edits on the project, but may not see amounts. */
  assistant: string;
  /** Reads on the project only. */
  reader: string;
  /** Edits on the project only, and cannot read. */
  editor: string;
  /** Reads and sees amounts on the project, but cannot edit. */
  valueReader: string;
  /** Has an account and no permission of any kind. */
  outsider: string;
};

/** Seeds a `TermsWorld`. The caller syncs the contracts permissions first. */
export async function seedTermsWorld(database: Database): Promise<TermsWorld> {
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
  const manager = await onProject([READ, EDIT, READ_VALUE]);
  await grantOnOrganisation(database, org.organisationId, manager, 'owner', [
    READ,
    EDIT,
    READ_VALUE,
  ]);
  return {
    ...org,
    manager,
    assistant: await onProject([READ, EDIT]),
    reader: await onProject([READ]),
    editor: await onProject([EDIT]),
    valueReader: await onProject([READ, READ_VALUE]),
    outsider: await seedUser(database),
  };
}

/**
 * Makes a contract in the project, made by the manager. A `crew-contract` by
 * default, one of the kinds that has terms.
 */
export function seedContract(
  database: Database,
  w: TermsWorld,
  overrides: Partial<Parameters<typeof createContract>[2]> = {},
): Promise<ContractView> {
  return createContract(database.db, at(w.manager), {
    organisationId: w.organisationId,
    projectId: w.projectId,
    kind: 'crew-contract',
    title: 'Camera operator agreement',
    status: 'negotiating',
    ...overrides,
  });
}

/** A complete set of terms: every field set, in GBP, as for a day rate with kit. */
export const FULL_TERMS = {
  currency: 'GBP',
  rate: '450.5',
  rateBasis: 'daily',
  guaranteedHours: '10',
  overtimeRuleKey: 'uk-film-overtime',
  kitFee: '75',
  kitFeeBasis: 'daily',
  kitInventory: 'Two camera bodies, a follow-focus and a tripod',
  perDiem: '35.25',
  mileageRate: '0.45',
  mileageUnit: 'mi',
  paymentTermsDays: 30,
  pensionApplies: true,
} as const satisfies ContractTermsInput;

/** The four amounts of `FULL_TERMS`, as the database stores them. */
export const FULL_TERMS_AMOUNTS = {
  rate: '450.5000',
  kitFee: '75.0000',
  perDiem: '35.2500',
  mileageRate: '0.4500',
} as const;

/** The fields of the terms that are not amounts, as `FULL_TERMS` stores them. */
export const FULL_TERMS_WITHOUT_AMOUNTS = {
  currency: 'GBP',
  rateBasis: 'daily',
  guaranteedHours: '10.00',
  overtimeRuleKey: 'uk-film-overtime',
  kitFeeBasis: 'daily',
  kitInventory: 'Two camera bodies, a follow-focus and a tripod',
  mileageUnit: 'mi',
  paymentTermsDays: 30,
  pensionApplies: true,
} as const;

/** The error a call fails with. Fails the test when the call succeeds. */
export const errorOf = (call: Promise<unknown>) =>
  call.then(
    () => {
      throw new Error('Expected the call to fail, but it succeeded');
    },
    (error: unknown) => error,
  );
