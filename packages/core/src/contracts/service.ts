import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { AccessDeniedError } from '../access/access-denied-error.js';
import {
  hasScopedPermission,
  type PermissionScope,
} from '../access/scoped-permission.js';
import {
  company,
  contract,
  contractLink,
  contractParty,
  contractTerms,
  episode,
  location,
  person,
  project,
  unit,
  type ContractKind,
  type ContractLinkEntityType,
  type ContractStatus,
} from '../db/schema/index.js';
import {
  insertRecord,
  lockOrganisationChanges,
  lockProjectChanges,
  RecordNotFoundError,
  RecordWriteError,
  restoreRecord,
  softDeleteRecord,
  updateRecord,
  type Tx,
  type UpdatePatch,
  type WriteContext,
} from '../db/write.js';
import { isContractParty, isPartyCondition } from './party.js';
import {
  CONTRACTS_EDIT_PERMISSION,
  CONTRACTS_READ_PERMISSION,
  CONTRACTS_READ_VALUE_PERMISSION,
} from './permissions.js';
import {
  readValueKeysIn,
  applyTerms,
  checkTermsInput,
  checkTermsState,
  contractKindHasTerms,
  EMPTY_TERMS,
  normaliseTerms,
  stateOf,
  withoutTermAmounts,
  type ContractTermsInput,
  type ContractTermsRow,
  type ContractTermsView,
} from './terms.js';

/**
 * The contracts registry: contracts with their parties and the records they
 * concern. Nothing here stores files, signatures or reminders.
 *
 * Permissions: `contracts:read`, `contracts:edit` and `contracts:read-value`.
 * A contract with a project is checked on that project; an organisation-level
 * contract, one with no project, is checked in the organisation
 * (`hasScopedPermission`). A role of one scope grants nothing in the other,
 * except that an organisation role's grant with `reach = 'all-projects'` also
 * applies on every project of the organisation. `contracts:read-value` is
 * sensitive and never reaches all projects, so amounts on a project contract
 * need project membership.
 *
 * Amounts: `total_value` and `currency` reach only users holding
 * `contracts:read-value`. For everyone else the two keys are absent from every
 * result, including the result of a create or an update, so they are never
 * `null` or `0`. Setting or changing either needs `contracts:read-value` as
 * well as `contracts:edit`, so nobody overwrites an amount they cannot see.
 *
 * A party to a contract always sees that contract, whatever permissions they hold
 * (decision D-73, Q6): its parties, links, `total_value` and `currency` in full.
 * `isContractParty`, in `party.ts`, is the one definition of a party.
 * `getContract` and `listOwnContracts` read for a party. Being a party never grants
 * a write: every edit still needs `contracts:edit`, and an amount still needs
 * `contracts:read-value` as well.
 *
 * A call on a contract that does not exist, is deleted or belongs to another
 * organisation fails like any other denial, so ids cannot be probed. For that
 * reason the `AccessDeniedError` of a call that names a contract by id does not
 * say which scope the contract is in; one that names the scope, a create or a
 * list, does. Contracts are not sensitive personal data, so a denial writes no
 * audit event.
 *
 * Parties and links are removed by soft delete. Adding one that was removed
 * restores it, because the unique keys count deleted rows too.
 *
 * Deal terms: a deal memo, a crew contract or a cast contract has at most one set
 * of agreed terms (`contract_terms`, see `terms.ts`): rate, guaranteed hours, kit
 * fee, per diem, mileage, payment days, pension and the key of an overtime rule.
 * They hold no overtime numbers and calculate nothing; those live in rule packs.
 * `setContractTerms` and `removeContractTerms` write them. The four amounts follow
 * the rule of `total_value`: only `contracts:read-value` holders and the parties to
 * the contract see them, they are absent for everyone else, and setting or clearing
 * one needs `contracts:read-value` as well as `contracts:edit`. So does changing the
 * currency, the rate basis, the kit fee basis or the mileage unit, which say what an
 * amount means. The other terms are visible to anyone who can read the contract and
 * need only `contracts:edit`. A contract with live terms cannot
 * change to a kind that has none: `updateContract` refuses it until the terms are
 * removed.
 */

/** Who is acting, and on which server and clock. Always a user. */
export type ContractContext = {
  /** The user acting. */
  readonly userId: string;
  readonly requestId?: string | null;
  /** The server doing the work. */
  readonly originServer: string;
  readonly clock: () => Date;
};

/**
 * A party or link target is refused, a link has an unknown type, or a set of
 * terms is refused: for a contract kind that has none, or for a field or a rule
 * between fields that is broken. Carries no ids and no values: the message names
 * the field and the rule, so it is safe to show.
 */
export class ContractInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractInputError';
  }
}

/**
 * The terms were set, changed or removed by someone else between the read and the
 * write: a first-time set that another first-time set got to first, or a call that
 * expected terms where there are none now. The caller reads the terms again. Carries
 * no ids and no values.
 */
export class ContractTermsConflictError extends Error {
  constructor() {
    super('The contract terms were set, changed or removed by someone else');
    this.name = 'ContractTermsConflictError';
  }
}

/** A party to add: exactly one of a person or a company, in a role. */
export type ContractPartyInput =
  | {
      readonly personId: string;
      readonly companyId?: null;
      /** What the party is to the contract, for example `artist` or `licensor`. */
      readonly partyRole: string;
    }
  | {
      readonly companyId: string;
      readonly personId?: null;
      readonly partyRole: string;
    };

/** A record a contract concerns, named by table and id. */
export type ContractLinkInput = {
  readonly entityType: ContractLinkEntityType;
  readonly entityId: string;
};

/**
 * What `createContract` needs. Leave out `projectId` for an organisation-level
 * contract. `currency` and `totalValue` need `contracts:read-value`.
 */
export type CreateContractValues = {
  readonly organisationId: string;
  /** Leave out for an organisation-level contract. */
  readonly projectId?: string | null;
  readonly kind: ContractKind;
  readonly title: string;
  readonly status: ContractStatus;
  /** Calendar dates, `YYYY-MM-DD`. */
  readonly signedOn?: string | null;
  readonly effectiveFrom?: string | null;
  readonly effectiveTo?: string | null;
  /** ISO 3166-1 alpha-2 codes, or `WW` for worldwide. */
  readonly territories?: readonly string[];
  /** Needs `contracts:read-value`. */
  readonly currency?: string | null;
  /** A decimal string such as `12500.50`. Needs `contracts:read-value`. */
  readonly totalValue?: string | null;
  readonly parties?: readonly ContractPartyInput[];
  readonly links?: readonly ContractLinkInput[];
};

/** The fields of a contract that can change. Its project cannot. */
export type ContractChanges = {
  readonly kind?: ContractKind;
  readonly title?: string;
  readonly status?: ContractStatus;
  readonly signedOn?: string | null;
  readonly effectiveFrom?: string | null;
  readonly effectiveTo?: string | null;
  readonly territories?: readonly string[];
  /** Needs `contracts:read-value`. */
  readonly currency?: string | null;
  /** Needs `contracts:read-value`. */
  readonly totalValue?: string | null;
};

/** Which contracts `listContracts` returns: one scope, optionally narrowed. */
export type ContractFilter = {
  readonly organisationId: string;
  /**
   * The project whose contracts to list. Leave out, or pass `null`, for the
   * organisation-level contracts.
   */
  readonly projectId?: string | null;
  readonly kind?: ContractKind;
  readonly status?: ContractStatus;
};

type ContractRow = typeof contract.$inferSelect;
/** A stored `contract_party` row, as the party calls return it. */
export type ContractPartyRow = typeof contractParty.$inferSelect;
/** A stored `contract_link` row, as the link calls return it. */
export type ContractLinkRow = typeof contractLink.$inferSelect;

/**
 * A contract with its live parties and links, and its deal terms, or `null` when
 * it has none. `currency` and `totalValue`, and the four amounts inside `terms`
 * (`rate`, `kitFee`, `perDiem`, `mileageRate`), are present only for a caller
 * holding `contracts:read-value`, or a party to the contract. For everyone else
 * the keys are absent, never `null` or `0`.
 */
export type ContractView = Omit<ContractRow, 'currency' | 'totalValue'> &
  Partial<Pick<ContractRow, 'currency' | 'totalValue'>> & {
    readonly parties: ContractPartyRow[];
    readonly links: ContractLinkRow[];
    readonly terms: ContractTermsView | null;
  };

function writeContext(ctx: ContractContext): WriteContext {
  return {
    actor: { type: 'user', id: ctx.userId },
    originServer: ctx.originServer,
    clock: ctx.clock,
    requestId: ctx.requestId ?? null,
  };
}

/** The calendar day of the caller's clock, in UTC: the day a loan-out link is checked on. */
function todayOf(ctx: ContractContext): string {
  return ctx.clock().toISOString().slice(0, 10);
}

function scopeOf(row: PermissionScope): PermissionScope {
  return { organisationId: row.organisationId, projectId: row.projectId };
}

/** For a scope the caller named: the error says whether it is a project or the organisation. */
async function requireInScope(
  tx: Tx,
  ctx: ContractContext,
  scope: PermissionScope,
  key: string,
): Promise<void> {
  if (!(await hasScopedPermission(tx, ctx.userId, scope, key))) {
    throw new AccessDeniedError(key, scope);
  }
}

/**
 * For a contract the caller named by id: `scope` is where the contract is, and
 * the error does not say so, or an unknown id would answer differently from a
 * forbidden one.
 */
async function requireOnRecord(
  tx: Tx,
  ctx: ContractContext,
  scope: PermissionScope,
  key: string,
): Promise<void> {
  if (!(await hasScopedPermission(tx, ctx.userId, scope, key))) {
    throw new AccessDeniedError(key);
  }
}

/** A contract that is not deleted. */
async function findContract(tx: Tx, id: string) {
  const [found] = await tx
    .select()
    .from(contract)
    .where(and(eq(contract.id, id), isNull(contract.deletedAt)))
    .limit(1);
  return found;
}

// The keys are removed, not set to null or 0, so a caller cannot tell a hidden
// amount from an empty one.
function withoutAmounts(
  row: ContractRow,
): Omit<ContractRow, 'currency' | 'totalValue'> {
  const copy: Partial<ContractRow> = { ...row };
  delete copy.currency;
  delete copy.totalValue;
  return copy as Omit<ContractRow, 'currency' | 'totalValue'>;
}

function groupBy<T>(items: readonly T[], key: (item: T) => string) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(key(item));
    if (group) group.push(item);
    else groups.set(key(item), [item]);
  }
  return groups;
}

/** The views of `rows`, each with its live parties and links, in creation order. */
async function viewsOf(
  tx: Tx,
  rows: readonly ContractRow[],
  canSeeValue: boolean,
): Promise<ContractView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const parties = groupBy(
    await tx
      .select()
      .from(contractParty)
      .where(
        and(
          inArray(contractParty.contractId, ids),
          isNull(contractParty.deletedAt),
        ),
      )
      .orderBy(asc(contractParty.id)),
    (party) => party.contractId,
  );
  const links = groupBy(
    await tx
      .select()
      .from(contractLink)
      .where(
        and(
          inArray(contractLink.contractId, ids),
          isNull(contractLink.deletedAt),
        ),
      )
      .orderBy(asc(contractLink.id)),
    (link) => link.contractId,
  );
  // One live row per contract at most: the table is unique on `contract_id`.
  const terms = new Map(
    (
      await tx
        .select()
        .from(contractTerms)
        .where(
          and(
            inArray(contractTerms.contractId, ids),
            isNull(contractTerms.deletedAt),
          ),
        )
    ).map((row) => [row.contractId, row]),
  );
  return rows.map((row) => ({
    ...(canSeeValue ? row : withoutAmounts(row)),
    parties: parties.get(row.id) ?? [],
    links: links.get(row.id) ?? [],
    terms: terms.has(row.id)
      ? termsView(terms.get(row.id)!, canSeeValue)
      : null,
  }));
}

/** The terms row as a caller may see it: the four amounts only when `canSeeValue`. */
function termsView(
  row: ContractTermsRow,
  canSeeValue: boolean,
): ContractTermsView {
  return canSeeValue ? row : withoutTermAmounts(row);
}

type LinkTarget = {
  readonly table: PgTable & {
    id: AnyPgColumn;
    organisationId: AnyPgColumn;
    deletedAt: AnyPgColumn;
  };
  /** The column holding the project, for targets that belong to one. */
  readonly projectKey: AnyPgColumn | null;
};

// Where each link type points. The compiler requires an entry for every
// `ContractLinkEntityType`, and `checkLinkTarget` only reads it for own keys.
const LINK_TARGETS: Record<ContractLinkEntityType, LinkTarget> = {
  project: { table: project, projectKey: project.id },
  person: { table: person, projectKey: null },
  company: { table: company, projectKey: null },
  location: { table: location, projectKey: null },
  unit: { table: unit, projectKey: unit.projectId },
  episode: { table: episode, projectKey: episode.projectId },
};

/**
 * True when the record exists, is not deleted and is in the contract's
 * organisation. For a project contract, a target that belongs to a project must
 * belong to the contract's own project.
 */
async function isLiveTarget(
  tx: Tx,
  contractScope: PermissionScope,
  target: LinkTarget,
  entityId: string,
): Promise<boolean> {
  const [found] = await tx
    .select({ one: sql<number>`1` })
    .from(target.table)
    .where(
      and(
        eq(target.table.id, entityId),
        eq(target.table.organisationId, contractScope.organisationId),
        isNull(target.table.deletedAt),
        contractScope.projectId !== null && target.projectKey !== null
          ? eq(target.projectKey, contractScope.projectId)
          : undefined,
      ),
    )
    .limit(1);
  return found !== undefined;
}

/**
 * A link is accepted only when its target is live (see `isLiveTarget`). One
 * message covers every reason, so a caller learns nothing about records it may
 * not see.
 */
async function checkLinkTarget(
  tx: Tx,
  contractScope: PermissionScope,
  link: ContractLinkInput,
): Promise<void> {
  // Own keys only: an object also answers to the names every object inherits,
  // such as `constructor`, `__proto__` and `toString`.
  const target = Object.hasOwn(LINK_TARGETS, link.entityType)
    ? LINK_TARGETS[link.entityType]
    : undefined;
  if (!target) {
    throw new ContractInputError('The link has an unknown entity type');
  }
  if (!(await isLiveTarget(tx, contractScope, target, link.entityId))) {
    throw new ContractInputError(
      `The ${link.entityType} to link does not exist, is deleted, or is not in the contract's organisation or project`,
    );
  }
}

/**
 * A party is accepted only when its person or company is live, as for a link.
 * A party already on a contract stays when its person or company is deleted
 * later: this runs only when a party is added.
 */
async function checkPartyTarget(
  tx: Tx,
  contractScope: PermissionScope,
  party: ContractPartyInput,
): Promise<void> {
  for (const [entityType, entityId] of [
    ['person', party.personId],
    ['company', party.companyId],
  ] as const) {
    if (entityId == null) continue;
    if (
      !(await isLiveTarget(
        tx,
        contractScope,
        LINK_TARGETS[entityType],
        entityId,
      ))
    ) {
      throw new ContractInputError(
        `The ${entityType} to add as a party does not exist, is deleted, or is not in the contract's organisation`,
      );
    }
  }
}

function partyValues(parent: ContractRow, party: ContractPartyInput) {
  return {
    organisationId: parent.organisationId,
    ownerOrgId: parent.ownerOrgId,
    contractId: parent.id,
    personId: party.personId ?? null,
    companyId: party.companyId ?? null,
    partyRole: party.partyRole,
  };
}

function linkValues(parent: ContractRow, link: ContractLinkInput) {
  return {
    organisationId: parent.organisationId,
    ownerOrgId: parent.ownerOrgId,
    contractId: parent.id,
    entityType: link.entityType,
    entityId: link.entityId,
  };
}

/**
 * Creates a contract, with its parties and links, in one savepoint: it all
 * happens or none of it does, including the change events and their sequence
 * numbers. Needs `contracts:edit`, and `contracts:read-value` as well when it
 * sets an amount or a currency. Throws `AccessDeniedError`,
 * `ContractInputError` for a refused party or link target (before anything is
 * written), and `RecordWriteError` when the database refuses a row, for
 * example a repeated party.
 */
export async function createContract(
  tx: Tx,
  ctx: ContractContext,
  values: CreateContractValues,
): Promise<ContractView> {
  const scope: PermissionScope = {
    organisationId: values.organisationId,
    projectId: values.projectId ?? null,
  };
  await requireInScope(tx, ctx, scope, CONTRACTS_EDIT_PERMISSION);
  if (values.currency != null || values.totalValue != null) {
    await requireInScope(tx, ctx, scope, CONTRACTS_READ_VALUE_PERMISSION);
  }
  for (const party of values.parties ?? []) {
    await checkPartyTarget(tx, scope, party);
  }
  const links = values.links ?? [];
  for (const link of links) await checkLinkTarget(tx, scope, link);

  const created = await tx.transaction(async (inner) => {
    const write = writeContext(ctx);
    const parent = await insertRecord(
      inner,
      contract,
      {
        organisationId: values.organisationId,
        ownerOrgId: values.organisationId,
        projectId: scope.projectId,
        kind: values.kind,
        title: values.title,
        status: values.status,
        signedOn: values.signedOn,
        effectiveFrom: values.effectiveFrom,
        effectiveTo: values.effectiveTo,
        territories: values.territories ? [...values.territories] : undefined,
        currency: values.currency,
        totalValue: values.totalValue,
      },
      write,
    );
    for (const party of values.parties ?? []) {
      await insertRecord(
        inner,
        contractParty,
        partyValues(parent, party),
        write,
      );
    }
    for (const link of links) {
      await insertRecord(inner, contractLink, linkValues(parent, link), write);
    }
    return parent;
  });
  const canSeeValue = await hasScopedPermission(
    tx,
    ctx.userId,
    scope,
    CONTRACTS_READ_VALUE_PERMISSION,
  );
  return (await viewsOf(tx, [created], canSeeValue))[0]!;
}

/**
 * Changes fields of a contract. Needs `contracts:edit`; naming `totalValue`
 * or `currency` in `changes`, even to clear it, needs `contracts:read-value`
 * as well. The result hides the amount from a caller without
 * `contracts:read-value`, whatever changed. Changes that alter no field write
 * nothing and return the current contract (see `updateRecord`).
 *
 * A contract that has live deal terms cannot change to a kind that has none (only
 * a deal memo, a crew contract and a cast contract have terms); remove the terms
 * first. The check runs under the locks of `setContractTerms`, so it cannot be
 * overtaken by a set of terms that is running at the same moment.
 *
 * @throws AccessDeniedError, with no scope, for a contract that is unknown,
 * deleted or forbidden: all three look the same, so ids cannot be probed.
 * @throws ContractInputError, "Remove the terms before changing this contract's
 * kind", for a change to a kind that has no terms while live terms exist.
 * @throws VersionConflictError for a stale `version`.
 */
export async function updateContract(
  tx: Tx,
  ctx: ContractContext,
  id: string,
  version: number,
  changes: ContractChanges,
): Promise<ContractView> {
  const found = await findContract(tx, id);
  if (!found) throw new AccessDeniedError(CONTRACTS_EDIT_PERMISSION);
  const scope = scopeOf(found);
  await requireOnRecord(tx, ctx, scope, CONTRACTS_EDIT_PERMISSION);
  const changesAmount =
    changes.totalValue !== undefined || changes.currency !== undefined;
  if (changesAmount) {
    await requireOnRecord(tx, ctx, scope, CONTRACTS_READ_VALUE_PERMISSION);
  }
  if (changes.kind !== undefined && !contractKindHasTerms(changes.kind)) {
    await refuseKindChangeWithTerms(tx, scope, id);
  }
  const patch: UpdatePatch<typeof contract> = {
    kind: changes.kind,
    title: changes.title,
    status: changes.status,
    signedOn: changes.signedOn,
    effectiveFrom: changes.effectiveFrom,
    effectiveTo: changes.effectiveTo,
    territories: changes.territories ? [...changes.territories] : undefined,
    currency: changes.currency,
    totalValue: changes.totalValue,
  };
  const updated = await updateRecord(
    tx,
    contract,
    id,
    version,
    patch,
    writeContext(ctx),
  );
  const canSeeValue =
    changesAmount ||
    (await hasScopedPermission(
      tx,
      ctx.userId,
      scope,
      CONTRACTS_READ_VALUE_PERMISSION,
    ));
  return (await viewsOf(tx, [updated], canSeeValue))[0]!;
}

/**
 * Adds a party to a contract. Needs `contracts:edit`. The party's person or
 * company must exist, not be deleted and be in the contract's organisation, or
 * `ContractInputError` is thrown, also when the party was removed earlier. A
 * party removed earlier is restored; a repeated live one is refused by the
 * database (`RecordWriteError`).
 *
 * @throws AccessDeniedError, with no scope, as `updateContract`.
 */
export async function addContractParty(
  tx: Tx,
  ctx: ContractContext,
  contractId: string,
  party: ContractPartyInput,
): Promise<ContractPartyRow> {
  const parent = await findContract(tx, contractId);
  if (!parent) throw new AccessDeniedError(CONTRACTS_EDIT_PERMISSION);
  await requireOnRecord(tx, ctx, scopeOf(parent), CONTRACTS_EDIT_PERMISSION);
  await checkPartyTarget(tx, scopeOf(parent), party);
  const values = partyValues(parent, party);
  const [removed] = await tx
    .select()
    .from(contractParty)
    .where(
      and(
        eq(contractParty.contractId, contractId),
        values.personId === null
          ? isNull(contractParty.personId)
          : eq(contractParty.personId, values.personId),
        values.companyId === null
          ? isNull(contractParty.companyId)
          : eq(contractParty.companyId, values.companyId),
        eq(contractParty.partyRole, values.partyRole),
        isNotNull(contractParty.deletedAt),
      ),
    )
    .limit(1);
  if (removed) {
    return restoreRecord(
      tx,
      contractParty,
      removed.id,
      removed.version,
      writeContext(ctx),
    );
  }
  return insertRecord(tx, contractParty, values, writeContext(ctx));
}

/**
 * Removes a party by soft delete. Needs `contracts:edit` on its contract.
 *
 * @throws AccessDeniedError, with no scope, for an unknown, removed or
 * forbidden party.
 * @throws VersionConflictError for a stale `version`.
 */
export async function removeContractParty(
  tx: Tx,
  ctx: ContractContext,
  partyId: string,
  version: number,
): Promise<ContractPartyRow> {
  const [party] = await tx
    .select()
    .from(contractParty)
    .where(and(eq(contractParty.id, partyId), isNull(contractParty.deletedAt)))
    .limit(1);
  const parent = party ? await findContract(tx, party.contractId) : undefined;
  if (!party || !parent) {
    throw new AccessDeniedError(CONTRACTS_EDIT_PERMISSION);
  }
  await requireOnRecord(tx, ctx, scopeOf(parent), CONTRACTS_EDIT_PERMISSION);
  return softDeleteRecord(
    tx,
    contractParty,
    partyId,
    version,
    writeContext(ctx),
  );
}

/**
 * Links a contract to a record it concerns. Needs `contracts:edit`. The target
 * must exist, not be deleted and be in the contract's organisation, and for a
 * project contract a target of a project must be in that project, or
 * `ContractInputError` is thrown. A link removed earlier is restored; a
 * repeated live one is refused by the database (`RecordWriteError`).
 *
 * @throws AccessDeniedError, with no scope, as `updateContract`.
 */
export async function addContractLink(
  tx: Tx,
  ctx: ContractContext,
  contractId: string,
  link: ContractLinkInput,
): Promise<ContractLinkRow> {
  const parent = await findContract(tx, contractId);
  if (!parent) throw new AccessDeniedError(CONTRACTS_EDIT_PERMISSION);
  const scope = scopeOf(parent);
  await requireOnRecord(tx, ctx, scope, CONTRACTS_EDIT_PERMISSION);
  await checkLinkTarget(tx, scope, link);
  const [removed] = await tx
    .select()
    .from(contractLink)
    .where(
      and(
        eq(contractLink.contractId, contractId),
        eq(contractLink.entityType, link.entityType),
        eq(contractLink.entityId, link.entityId),
        isNotNull(contractLink.deletedAt),
      ),
    )
    .limit(1);
  if (removed) {
    return restoreRecord(
      tx,
      contractLink,
      removed.id,
      removed.version,
      writeContext(ctx),
    );
  }
  return insertRecord(
    tx,
    contractLink,
    linkValues(parent, link),
    writeContext(ctx),
  );
}

/**
 * Removes a link by soft delete. Needs `contracts:edit` on its contract.
 *
 * @throws AccessDeniedError, with no scope, for an unknown, removed or
 * forbidden link.
 * @throws VersionConflictError for a stale `version`.
 */
export async function removeContractLink(
  tx: Tx,
  ctx: ContractContext,
  linkId: string,
  version: number,
): Promise<ContractLinkRow> {
  const [link] = await tx
    .select()
    .from(contractLink)
    .where(and(eq(contractLink.id, linkId), isNull(contractLink.deletedAt)))
    .limit(1);
  const parent = link ? await findContract(tx, link.contractId) : undefined;
  if (!link || !parent) {
    throw new AccessDeniedError(CONTRACTS_EDIT_PERMISSION);
  }
  await requireOnRecord(tx, ctx, scopeOf(parent), CONTRACTS_EDIT_PERMISSION);
  return softDeleteRecord(tx, contractLink, linkId, version, writeContext(ctx));
}

/** The one terms row of a contract, live or removed. */
async function findTermsRow(tx: Tx, contractId: string) {
  const [found] = await tx
    .select()
    .from(contractTerms)
    .where(eq(contractTerms.contractId, contractId))
    .limit(1);
  return found;
}

/** Terms apply to the person-facing deals only; a CHECK cannot see the contract's kind. */
function checkTermsKind(kind: ContractKind): void {
  if (!contractKindHasTerms(kind)) {
    throw new ContractInputError(
      'Terms apply only to deal memos and crew or cast contracts',
    );
  }
}

/**
 * Refuses a change of contract `contractId` to a kind that has no terms while the
 * contract has live terms: the terms would be left on a contract that cannot have
 * them. Removed terms do not count.
 *
 * It decides on rows another call may be writing at this moment, so it takes
 * the locks in the order of `setContractTerms` (CLAUDE.md, Data rules: lock
 * order): the change counter, then the contract row `FOR UPDATE`, then the
 * live terms row `FOR SHARE`. `setContractTerms` holds the contract `FOR SHARE`
 * from before it checks the kind until its transaction ends, so whichever comes
 * second waits for the first and then sees its result: terms that were just added
 * refuse this change, and a kind that was just changed refuses those terms. The
 * contract lock matters most when the project has no change counter row yet, as
 * the counter then locks nothing.
 *
 * @throws ContractInputError when the contract has live terms.
 * @throws AccessDeniedError, with no scope, when the contract was deleted since
 * the caller read it.
 */
async function refuseKindChangeWithTerms(
  tx: Tx,
  scope: PermissionScope,
  contractId: string,
): Promise<void> {
  const [held] = await tx
    .select({ id: contract.id })
    .from(contract)
    .where(and(eq(contract.id, contractId), isNull(contract.deletedAt)))
    .limit(1)
    .for('update');
  if (!held) throw new AccessDeniedError(CONTRACTS_EDIT_PERMISSION);
  const [terms] = await tx
    .select({ id: contractTerms.id })
    .from(contractTerms)
    .where(
      and(
        eq(contractTerms.contractId, contractId),
        isNull(contractTerms.deletedAt),
      ),
    )
    .limit(1)
    .for('share');
  if (terms !== undefined) {
    throw new ContractInputError(
      "Remove the terms before changing this contract's kind",
    );
  }
}

/** The change counter of the contract's project, or of the organisation for a contract with none. */
async function lockChangesOf(tx: Tx, scope: PermissionScope): Promise<void> {
  if (scope.projectId !== null) {
    await lockProjectChanges(tx, scope.organisationId, scope.projectId);
  } else {
    await lockOrganisationChanges(tx, scope.organisationId);
  }
}

// SQLSTATE of a unique violation, and the key that allows one terms row per contract.
const UNIQUE_VIOLATION = '23505';
const ONE_TERMS_PER_CONTRACT = 'contract_terms_contract_unique';

/**
 * Sets the deal terms of a contract: creates the one terms row, changes it, or
 * restores a removed one. Needs `contracts:edit`, and `contracts:read-value` as
 * well when `terms` names any amount (`rate`, `kitFee`, `perDiem`, `mileageRate`)
 * or any field that says what an amount means (`currency`, `rateBasis`,
 * `kitFeeBasis`, `mileageUnit`), to whatever value and even to clear it, so nobody
 * overwrites or relabels an amount they cannot see. The gate is on the fields
 * named, never on what is stored: a caller without `contracts:read-value` is
 * refused the same way whether the terms hold an amount or not, so a refusal never
 * shows that one is set. Being a party to the contract grants nothing here. Only a
 * deal memo, a crew contract or a cast contract has terms.
 *
 * `terms` is a patch on a live row: a key that is left out stays as it is, `null`
 * clears it. A removed row is restored with exactly the terms given, every other
 * field empty, so nothing from before the removal comes back. Amounts and
 * `guaranteedHours` are decimal strings (at most 15 digits before the point and 4
 * after for an amount, not below zero; see `isAmountString`). The terms as they will
 * be stored must keep the rules between fields, the ones the CHECKs hold: an
 * amount needs a currency, a rate its basis, a kit fee its basis, a mileage rate its
 * unit, and a flat rate or a buyout has no guaranteed hours. A caller without
 * `contracts:read-value` cannot name the fields those rules join to an amount, so
 * none of them can be broken by, or refused because of, an amount they cannot see.
 *
 * `options.expectedVersion` is the version of the terms the caller read. Without
 * it the call acts on the terms as it reads them at its start; with it, the terms
 * must be live and at that version. Either way a write that finds the terms
 * changed since that read is refused, never merged. Takes the contract's change
 * counter, then holds the contract `FOR SHARE` until the transaction ends, so the
 * contract's kind cannot change under the check (CLAUDE.md, Data rules: lock
 * order).
 *
 * The result hides the four amounts from a caller without `contracts:read-value`.
 * Change events name the amounts that changed and never their values.
 *
 * @throws AccessDeniedError, with no scope, for a contract that is unknown,
 * deleted or forbidden: all three look the same, so ids cannot be probed.
 * @throws ContractInputError for a contract kind that has no terms, and for terms
 * that break a field rule or a rule between fields.
 * @throws VersionConflictError when the live terms are not at the version expected,
 * or changed before the write.
 * @throws ContractTermsConflictError when a first-time set meets terms made by
 * another call, or `expectedVersion` was given and there are no live terms.
 */
export async function setContractTerms(
  tx: Tx,
  ctx: ContractContext,
  contractId: string,
  terms: ContractTermsInput,
  options: { readonly expectedVersion?: number } = {},
): Promise<ContractTermsView> {
  const found = await findContract(tx, contractId);
  if (!found) throw new AccessDeniedError(CONTRACTS_EDIT_PERMISSION);
  const scope = scopeOf(found);
  await requireOnRecord(tx, ctx, scope, CONTRACTS_EDIT_PERMISSION);
  const setsValue = readValueKeysIn(terms).length > 0;
  if (setsValue) {
    await requireOnRecord(tx, ctx, scope, CONTRACTS_READ_VALUE_PERMISSION);
  }
  checkTermsKind(found.kind);
  const badInput = checkTermsInput(terms);
  if (badInput !== undefined) throw new ContractInputError(badInput);
  const given = normaliseTerms(terms);

  // What the call decides on: the terms as they are now. A concurrent write that
  // changes them before this one lands is caught below, by the version check or by
  // the unique key, and refused.
  const stored = await findTermsRow(tx, contractId);
  const live = stored !== undefined && stored.deletedAt === null;
  const { expectedVersion } = options;
  if (expectedVersion !== undefined && !live) {
    throw new ContractTermsConflictError();
  }
  const next = applyTerms(live ? stateOf(stored) : EMPTY_TERMS, given);
  const badState = checkTermsState(next);
  if (badState !== undefined) throw new ContractInputError(badState);

  // The change counter first, then the contract row (CLAUDE.md, Data rules: lock
  // order). The kind is read again under the lock: an update of the contract that
  // was waiting for the counter may have changed it.
  await lockChangesOf(tx, scope);
  const [held] = await tx
    .select({ kind: contract.kind })
    .from(contract)
    .where(and(eq(contract.id, contractId), isNull(contract.deletedAt)))
    .limit(1)
    .for('share');
  if (!held) throw new AccessDeniedError(CONTRACTS_EDIT_PERMISSION);
  checkTermsKind(held.kind);

  const write = writeContext(ctx);
  let row: ContractTermsRow;
  if (stored === undefined) {
    try {
      row = await insertRecord(
        tx,
        contractTerms,
        {
          organisationId: found.organisationId,
          ownerOrgId: found.ownerOrgId,
          contractId,
          ...next,
        },
        write,
      );
    } catch (error) {
      // Two first-time sets at once: the other one got there first.
      if (
        error instanceof RecordWriteError &&
        error.code === UNIQUE_VIOLATION &&
        error.constraint === ONE_TERMS_PER_CONTRACT
      ) {
        throw new ContractTermsConflictError();
      }
      throw error;
    }
  } else if (live) {
    const patch: UpdatePatch<typeof contractTerms> = { ...given };
    row = await updateRecord(
      tx,
      contractTerms,
      stored.id,
      expectedVersion ?? stored.version,
      patch,
      write,
    );
  } else {
    row = await restoreRecord(
      tx,
      contractTerms,
      stored.id,
      stored.version,
      write,
      next,
    );
  }
  const canSeeValue =
    setsValue ||
    (await hasScopedPermission(
      tx,
      ctx.userId,
      scope,
      CONTRACTS_READ_VALUE_PERMISSION,
    ));
  return termsView(row, canSeeValue);
}

/**
 * Removes the deal terms of a contract by soft delete; `setContractTerms` brings
 * them back as a fresh set. Needs `contracts:edit` and `contracts:read-value`,
 * the permissions of a change that clears every amount: removing the terms hides
 * amounts the caller must be allowed to see. Being a party grants nothing here.
 * The result is the removed row, amounts included, which this caller may see.
 *
 * @throws AccessDeniedError, with no scope, for a contract that is unknown,
 * deleted or forbidden.
 * @throws RecordNotFoundError, naming the contract, when it has no live terms.
 * @throws VersionConflictError for a stale `version`, the version of the terms.
 */
export async function removeContractTerms(
  tx: Tx,
  ctx: ContractContext,
  contractId: string,
  version: number,
): Promise<ContractTermsView> {
  const found = await findContract(tx, contractId);
  if (!found) throw new AccessDeniedError(CONTRACTS_EDIT_PERMISSION);
  const scope = scopeOf(found);
  await requireOnRecord(tx, ctx, scope, CONTRACTS_EDIT_PERMISSION);
  await requireOnRecord(tx, ctx, scope, CONTRACTS_READ_VALUE_PERMISSION);
  const stored = await findTermsRow(tx, contractId);
  if (stored === undefined || stored.deletedAt !== null) {
    throw new RecordNotFoundError('contract_terms', contractId);
  }
  const removed = await softDeleteRecord(
    tx,
    contractTerms,
    stored.id,
    version,
    writeContext(ctx),
  );
  return termsView(removed, true);
}

/**
 * Reads one contract with its parties and links. Needs `contracts:read`, or being
 * a party to the contract (`isContractParty`): a party reads it in full whatever
 * permissions they hold. Anyone else gets `currency` and `totalValue` only with
 * `contracts:read-value`.
 *
 * @throws AccessDeniedError, with no scope, as `updateContract`: the same answer
 * for an unknown contract, a deleted one, and one the caller may not read and is
 * no party to.
 */
export async function getContract(
  tx: Tx,
  ctx: ContractContext,
  id: string,
): Promise<ContractView> {
  const found = await findContract(tx, id);
  if (!found) throw new AccessDeniedError(CONTRACTS_READ_PERMISSION);
  const scope = scopeOf(found);
  const isParty = await isContractParty(tx, ctx.userId, id, todayOf(ctx));
  if (!isParty) {
    await requireOnRecord(tx, ctx, scope, CONTRACTS_READ_PERMISSION);
  }
  const canSeeValue =
    isParty ||
    (await hasScopedPermission(
      tx,
      ctx.userId,
      scope,
      CONTRACTS_READ_VALUE_PERMISSION,
    ));
  return (await viewsOf(tx, [found], canSeeValue))[0]!;
}

/**
 * Lists every live contract of the organisation that the caller is a party to,
 * across all its projects and the organisation-level ones, oldest first, in full:
 * with `currency` and `totalValue`. Needs no permission beyond being a party
 * (decision D-73, Q6), by the rule in `isContractParty`. A caller who is a party to
 * no contract gets an empty list. Writes no audit event: contracts are not
 * sensitive personal data.
 */
export async function listOwnContracts(
  tx: Tx,
  ctx: ContractContext,
  organisationId: string,
): Promise<ContractView[]> {
  const rows = await tx
    .select()
    .from(contract)
    .where(
      and(
        eq(contract.organisationId, organisationId),
        isNull(contract.deletedAt),
        isPartyCondition(ctx.userId, contract.id, todayOf(ctx)),
      ),
    )
    .orderBy(asc(contract.createdAt), asc(contract.id));
  return viewsOf(tx, rows, true);
}

/**
 * Lists the contracts of one project, or the organisation-level ones, oldest
 * first, with their parties and links. Needs `contracts:read` on that scope;
 * amounts follow the same rule as `getContract`.
 *
 * @throws AccessDeniedError, naming the scope, because the caller supplied it.
 */
export async function listContracts(
  tx: Tx,
  ctx: ContractContext,
  filter: ContractFilter,
): Promise<ContractView[]> {
  const scope: PermissionScope = {
    organisationId: filter.organisationId,
    projectId: filter.projectId ?? null,
  };
  await requireInScope(tx, ctx, scope, CONTRACTS_READ_PERMISSION);
  const canSeeValue = await hasScopedPermission(
    tx,
    ctx.userId,
    scope,
    CONTRACTS_READ_VALUE_PERMISSION,
  );
  const conditions: (SQL | undefined)[] = [
    eq(contract.organisationId, scope.organisationId),
    scope.projectId === null
      ? isNull(contract.projectId)
      : eq(contract.projectId, scope.projectId),
    isNull(contract.deletedAt),
    filter.kind ? eq(contract.kind, filter.kind) : undefined,
    filter.status ? eq(contract.status, filter.status) : undefined,
  ];
  const rows = await tx
    .select()
    .from(contract)
    .where(and(...conditions))
    .orderBy(asc(contract.createdAt), asc(contract.id));
  return viewsOf(tx, rows, canSeeValue);
}
