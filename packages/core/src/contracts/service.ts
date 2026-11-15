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
import { hasOrganisationPermission } from '../access/organisation-permission.js';
import { hasProjectPermission } from '../access/project-permission.js';
import {
  company,
  contract,
  contractLink,
  contractParty,
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
  restoreRecord,
  softDeleteRecord,
  updateRecord,
  type Tx,
  type UpdatePatch,
  type WriteContext,
} from '../db/write.js';
import {
  CONTRACTS_EDIT_PERMISSION,
  CONTRACTS_READ_PERMISSION,
  CONTRACTS_READ_VALUE_PERMISSION,
} from './permissions.js';

/**
 * The contracts registry: contracts with their parties and the records they
 * concern. Nothing here stores files, signatures or reminders.
 *
 * Permissions: `contracts:read`, `contracts:edit` and `contracts:read-value`.
 * A contract with a project is checked on that project
 * (`hasProjectPermission`); an organisation-level contract, one with no
 * project, is checked in the organisation (`hasOrganisationPermission`). Roles
 * of one scope grant nothing in the other.
 *
 * Amounts: `total_value` and `currency` reach only users holding
 * `contracts:read-value`. For everyone else the two keys are absent from every
 * result, including the result of a create or an update, so they are never
 * `null` or `0`. Setting or changing either needs `contracts:read-value` as
 * well as `contracts:edit`, so nobody overwrites an amount they cannot see.
 *
 * A call on a contract that does not exist, is deleted or belongs to another
 * organisation fails like any other denial, so ids cannot be probed.
 * Contracts are not sensitive personal data, so a denial throws
 * `ContractAccessDeniedError` and writes no audit event.
 *
 * Parties and links are removed by soft delete. Adding one that was removed
 * restores it, because the unique keys count deleted rows too.
 */

export type ContractContext = {
  /** The user acting. */
  readonly userId: string;
  readonly requestId?: string | null;
  /** The server doing the work. */
  readonly originServer: string;
  readonly clock: () => Date;
};

/** The caller lacks `permission`. Carries no ids and no values. */
export class ContractAccessDeniedError extends Error {
  constructor(readonly permission: string) {
    super(`Contract access denied: ${permission} is needed`);
    this.name = 'ContractAccessDeniedError';
  }
}

/** A link target is refused, or a link has an unknown type. Carries no ids. */
export class ContractInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractInputError';
  }
}

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

export type ContractLinkInput = {
  readonly entityType: ContractLinkEntityType;
  readonly entityId: string;
};

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
export type ContractPartyRow = typeof contractParty.$inferSelect;
export type ContractLinkRow = typeof contractLink.$inferSelect;

/**
 * A contract with its live parties and links. `currency` and `totalValue`
 * are present only for a caller holding `contracts:read-value`.
 */
export type ContractView = Omit<ContractRow, 'currency' | 'totalValue'> &
  Partial<Pick<ContractRow, 'currency' | 'totalValue'>> & {
    readonly parties: ContractPartyRow[];
    readonly links: ContractLinkRow[];
  };

type Scope = {
  readonly organisationId: string;
  readonly projectId: string | null;
};

function writeContext(ctx: ContractContext): WriteContext {
  return {
    actor: { type: 'user', id: ctx.userId },
    originServer: ctx.originServer,
    clock: ctx.clock,
    requestId: ctx.requestId ?? null,
  };
}

function scopeOf(row: Scope): Scope {
  return { organisationId: row.organisationId, projectId: row.projectId };
}

function holds(
  tx: Tx,
  ctx: ContractContext,
  scope: Scope,
  key: string,
): Promise<boolean> {
  return scope.projectId !== null
    ? hasProjectPermission(tx, ctx.userId, scope.projectId, key)
    : hasOrganisationPermission(tx, ctx.userId, scope.organisationId, key);
}

async function requirePermission(
  tx: Tx,
  ctx: ContractContext,
  scope: Scope,
  key: string,
): Promise<void> {
  if (!(await holds(tx, ctx, scope, key))) {
    throw new ContractAccessDeniedError(key);
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
  return rows.map((row) => ({
    ...(canSeeValue ? row : withoutAmounts(row)),
    parties: parties.get(row.id) ?? [],
    links: links.get(row.id) ?? [],
  }));
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
  contractScope: Scope,
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
  contractScope: Scope,
  link: ContractLinkInput,
): Promise<void> {
  const target = LINK_TARGETS[link.entityType] as LinkTarget | undefined;
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
  contractScope: Scope,
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
 * sets an amount or a currency. Throws `ContractAccessDeniedError`,
 * `ContractInputError` for a refused party or link target (before anything is
 * written), and `RecordWriteError` when the database refuses a row, for
 * example a repeated party.
 */
export async function createContract(
  tx: Tx,
  ctx: ContractContext,
  values: CreateContractValues,
): Promise<ContractView> {
  const scope: Scope = {
    organisationId: values.organisationId,
    projectId: values.projectId ?? null,
  };
  await requirePermission(tx, ctx, scope, CONTRACTS_EDIT_PERMISSION);
  if (values.currency != null || values.totalValue != null) {
    await requirePermission(tx, ctx, scope, CONTRACTS_READ_VALUE_PERMISSION);
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
  const canSeeValue = await holds(
    tx,
    ctx,
    scope,
    CONTRACTS_READ_VALUE_PERMISSION,
  );
  return (await viewsOf(tx, [created], canSeeValue))[0]!;
}

/**
 * Changes fields of a contract. Needs `contracts:edit`; naming `totalValue`
 * or `currency` in `changes`, even to clear it, needs `contracts:read-value`
 * as well. A stale `version` throws `VersionConflictError`. The result hides
 * the amount from a caller without `contracts:read-value`, whatever changed.
 */
export async function updateContract(
  tx: Tx,
  ctx: ContractContext,
  id: string,
  version: number,
  changes: ContractChanges,
): Promise<ContractView> {
  const found = await findContract(tx, id);
  if (!found) throw new ContractAccessDeniedError(CONTRACTS_EDIT_PERMISSION);
  const scope = scopeOf(found);
  await requirePermission(tx, ctx, scope, CONTRACTS_EDIT_PERMISSION);
  const changesAmount =
    changes.totalValue !== undefined || changes.currency !== undefined;
  if (changesAmount) {
    await requirePermission(tx, ctx, scope, CONTRACTS_READ_VALUE_PERMISSION);
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
    (await holds(tx, ctx, scope, CONTRACTS_READ_VALUE_PERMISSION));
  return (await viewsOf(tx, [updated], canSeeValue))[0]!;
}

/**
 * Adds a party to a contract. Needs `contracts:edit`. The party's person or
 * company must exist, not be deleted and be in the contract's organisation, or
 * `ContractInputError` is thrown, also when the party was removed earlier. A
 * party removed earlier is restored; a repeated live one is refused by the
 * database.
 */
export async function addContractParty(
  tx: Tx,
  ctx: ContractContext,
  contractId: string,
  party: ContractPartyInput,
): Promise<ContractPartyRow> {
  const parent = await findContract(tx, contractId);
  if (!parent) throw new ContractAccessDeniedError(CONTRACTS_EDIT_PERMISSION);
  await requirePermission(tx, ctx, scopeOf(parent), CONTRACTS_EDIT_PERMISSION);
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

/** Removes a party by soft delete. Needs `contracts:edit` on its contract. */
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
    throw new ContractAccessDeniedError(CONTRACTS_EDIT_PERMISSION);
  }
  await requirePermission(tx, ctx, scopeOf(parent), CONTRACTS_EDIT_PERMISSION);
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
 * repeated live one is refused by the database.
 */
export async function addContractLink(
  tx: Tx,
  ctx: ContractContext,
  contractId: string,
  link: ContractLinkInput,
): Promise<ContractLinkRow> {
  const parent = await findContract(tx, contractId);
  if (!parent) throw new ContractAccessDeniedError(CONTRACTS_EDIT_PERMISSION);
  const scope = scopeOf(parent);
  await requirePermission(tx, ctx, scope, CONTRACTS_EDIT_PERMISSION);
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

/** Removes a link by soft delete. Needs `contracts:edit` on its contract. */
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
    throw new ContractAccessDeniedError(CONTRACTS_EDIT_PERMISSION);
  }
  await requirePermission(tx, ctx, scopeOf(parent), CONTRACTS_EDIT_PERMISSION);
  return softDeleteRecord(tx, contractLink, linkId, version, writeContext(ctx));
}

/**
 * Reads one contract with its parties and links. Needs `contracts:read`;
 * `currency` and `totalValue` are in the result only with
 * `contracts:read-value`.
 */
export async function getContract(
  tx: Tx,
  ctx: ContractContext,
  id: string,
): Promise<ContractView> {
  const found = await findContract(tx, id);
  if (!found) throw new ContractAccessDeniedError(CONTRACTS_READ_PERMISSION);
  const scope = scopeOf(found);
  await requirePermission(tx, ctx, scope, CONTRACTS_READ_PERMISSION);
  const canSeeValue = await holds(
    tx,
    ctx,
    scope,
    CONTRACTS_READ_VALUE_PERMISSION,
  );
  return (await viewsOf(tx, [found], canSeeValue))[0]!;
}

/**
 * Lists the contracts of one project, or the organisation-level ones, oldest
 * first, with their parties and links. Needs `contracts:read` on that scope;
 * amounts follow the same rule as `getContract`.
 */
export async function listContracts(
  tx: Tx,
  ctx: ContractContext,
  filter: ContractFilter,
): Promise<ContractView[]> {
  const scope: Scope = {
    organisationId: filter.organisationId,
    projectId: filter.projectId ?? null,
  };
  await requirePermission(tx, ctx, scope, CONTRACTS_READ_PERMISSION);
  const canSeeValue = await holds(
    tx,
    ctx,
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
