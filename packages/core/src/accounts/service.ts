import { and, asc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import { AccessDeniedError } from '../access/access-denied-error.js';
import {
  hasScopedPermission,
  type PermissionScope,
} from '../access/scoped-permission.js';
import {
  account,
  accountChart,
  costLine,
  project,
} from '../db/schema/index.js';
import {
  insertRecord,
  RecordStateError,
  softDeleteRecord,
  updateRecord,
  type Tx,
  type UpdatePatch,
  type WriteContext,
} from '../db/write.js';
import {
  ACCOUNTS_EDIT_PERMISSION,
  ACCOUNTS_READ_PERMISSION,
} from './permissions.js';

/**
 * Charts of accounts: an organisation keeps template charts, and each project
 * copies one and edits its own copy. Cost lines, budgets and file import or
 * export are not here, but cost lines are booked to a project's accounts, so an
 * account or chart with a live cost line cannot be removed, and such an account
 * cannot be made non-postable (`AccountInUseError`).
 *
 * Permissions: `accounts:read` and `accounts:edit`. A project chart is checked
 * on its project; an organisation template, one with no project, is checked in
 * the organisation (`hasScopedPermission`). Roles of one scope grant nothing in
 * the other. Copying a template into a project needs `accounts:read` on the
 * organisation and `accounts:edit` on the project.
 *
 * A call that names a chart or an account by id, and a copy, which names two,
 * fails with `AccessDeniedError` when the record does not exist, is removed or
 * belongs to another organisation, exactly as for a forbidden one, so ids cannot
 * be probed. That error does not say which scope was checked. A create or a
 * list names the scope itself, so its error does. Charts of accounts are not
 * sensitive personal data, so a denial writes no audit event.
 *
 * Accounts and charts are removed by soft delete. Codes and keys are unique
 * among live records only, so adding a removed code, or creating a chart with a
 * removed key, makes a new record. A removed chart is no longer the default of
 * its scope.
 */

/** Who is acting, and on which server and clock. Always a user. */
export type AccountContext = {
  /** The user acting. */
  readonly userId: string;
  readonly requestId?: string | null;
  /** The server doing the work. */
  readonly originServer: string;
  readonly clock: () => Date;
};

/**
 * An account or a chart to copy is refused for a reason of its own: a parent
 * that is not a live account of the same chart, a move that would make an
 * account its own ancestor, or a source that is not a live template. Carries no
 * ids.
 */
export class AccountInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountInputError';
  }
}

/**
 * An account cannot be removed while it has live child accounts. It is a
 * `RecordStateError`, as the removal of a record in the wrong state is for every
 * other record, but with its own message: the stock one for a refused delete
 * says the record is already deleted, which is not the problem here. Nothing
 * was written.
 */
export class AccountHasChildrenError extends RecordStateError {
  constructor(entityId: string) {
    super('account', entityId, 'delete');
    this.message = `Cannot delete account ${entityId}: it has live child accounts`;
  }
}

/**
 * An account, or a chart with such an account, cannot be removed while a live
 * cost line is booked to it: the line would point at an account that is gone.
 * For the same reason an account cannot stop being postable while one is. It is
 * a `RecordStateError`, as `AccountHasChildrenError` is, with its own message,
 * because the stock one says the record is already deleted. `attempted` says
 * which change was refused (`RecordStateError.operation` has no value for the
 * second one, so it reads `delete` in both cases). Remove or rebook the cost
 * lines first. The error says nothing about the lines beyond their existence: no
 * ids, no amounts. Nothing was written.
 */
export class AccountInUseError extends RecordStateError {
  /** The change that was refused: removing the account or chart, or making an account non-postable. */
  readonly attempted: 'remove' | 'stop-posting';

  constructor(
    entityType: 'account' | 'account_chart',
    entityId: string,
    attempted: 'remove' | 'stop-posting' = 'remove',
  ) {
    super(entityType, entityId, 'delete');
    this.attempted = attempted;
    this.message =
      attempted === 'stop-posting'
        ? `Cannot make account ${entityId} non-postable: a live cost line is booked to it`
        : entityType === 'account'
          ? `Cannot delete account ${entityId}: a live cost line is booked to it`
          : `Cannot delete account_chart ${entityId}: a live cost line is booked to one of its accounts`;
  }
}

/**
 * What `createChart` needs. Leave out `projectId` for an organisation template.
 * `key` and `format` are lower-case letters and digits joined by hyphens; the
 * database refuses anything else (`RecordWriteError`).
 */
export type CreateChartValues = {
  readonly organisationId: string;
  /** Leave out for an organisation template. */
  readonly projectId?: string | null;
  /** Names the chart within its scope; a live key is unique per scope. */
  readonly key: string;
  readonly name: string;
  /** What the chart follows. Defaults to `custom`. */
  readonly format?: string;
  /** Makes this the default chart of its scope, replacing the old default. */
  readonly isDefault?: boolean;
};

/** What `copyChartToProject` needs. */
export type CopyChartInput = {
  /** A live organisation template of the project's organisation. */
  readonly sourceChartId: string;
  /** The project that receives the copy. */
  readonly projectId: string;
  /** Defaults to the template's key. */
  readonly key?: string;
  /** Defaults to the template's name. */
  readonly name?: string;
  /** Makes the copy the project's default chart. Defaults to false. */
  readonly makeDefault?: boolean;
};

/**
 * The fields of a chart that can change. Its project and the template it was
 * copied from cannot, and any other key in the object is ignored. `key` and
 * `format` are lower-case letters and digits joined by hyphens; the database
 * refuses anything else (`RecordWriteError`).
 */
export type ChartChanges = {
  readonly name?: string;
  /** A live key is unique per scope. */
  readonly key?: string;
  readonly format?: string;
  /**
   * `true` makes this the default chart of its scope and takes the default from
   * the old one. `false` leaves the scope with no default.
   */
  readonly isDefault?: boolean;
};

/** An account to add. Leave out `parentId` for a top-level account. */
export type AccountInput = {
  /** A live account of the same chart. */
  readonly parentId?: string | null;
  /** What people read; unique among the live accounts of the chart. */
  readonly code: string;
  readonly name: string;
  /** Whether cost lines may be booked to it. Defaults to true. */
  readonly isPostable?: boolean;
  /** The code in an external ledger, if any. */
  readonly glCode?: string | null;
  /** Orders siblings, before `code`. Defaults to 0. */
  readonly sortOrder?: number;
};

/**
 * The fields of an account that can change. Its chart cannot, and any other key
 * in the object is ignored. `parentId: null` moves the account to the top level.
 */
export type AccountChanges = {
  readonly parentId?: string | null;
  readonly code?: string;
  readonly name?: string;
  readonly isPostable?: boolean;
  readonly glCode?: string | null;
  readonly sortOrder?: number;
};

/** Which charts `listCharts` returns: one scope. */
export type ChartFilter = {
  readonly organisationId: string;
  /**
   * The project whose charts to list. Leave out, or pass `null`, for the
   * organisation templates.
   */
  readonly projectId?: string | null;
};

/** A stored `account_chart` row, as the chart calls return it. */
export type AccountChartRow = typeof accountChart.$inferSelect;
/** A stored `account` row, as the account calls return it. */
export type AccountRow = typeof account.$inferSelect;

/** A chart with its live accounts in tree order (see `getChart`). */
export type AccountChartView = AccountChartRow & {
  readonly accounts: AccountRow[];
};

function writeContext(ctx: AccountContext): WriteContext {
  return {
    actor: { type: 'user', id: ctx.userId },
    originServer: ctx.originServer,
    clock: ctx.clock,
    requestId: ctx.requestId ?? null,
  };
}

function scopeOf(row: PermissionScope): PermissionScope {
  return { organisationId: row.organisationId, projectId: row.projectId };
}

/** For a scope the caller named: the error says whether it is a project or the organisation. */
async function requireInScope(
  tx: Tx,
  ctx: AccountContext,
  scope: PermissionScope,
  key: string,
): Promise<void> {
  if (!(await hasScopedPermission(tx, ctx.userId, scope, key))) {
    throw new AccessDeniedError(key, scope);
  }
}

/**
 * For a record the caller named by id: `scope` is where the record is, and the
 * error does not say so, or an unknown id would answer differently from a
 * forbidden one.
 */
async function requireOnRecord(
  tx: Tx,
  ctx: AccountContext,
  scope: PermissionScope,
  key: string,
): Promise<void> {
  if (!(await hasScopedPermission(tx, ctx.userId, scope, key))) {
    throw new AccessDeniedError(key);
  }
}

/** A chart that is not removed. */
async function findChart(tx: Tx, id: string) {
  const [found] = await tx
    .select()
    .from(accountChart)
    .where(and(eq(accountChart.id, id), isNull(accountChart.deletedAt)))
    .limit(1);
  return found;
}

/** A live account with its live chart, or `undefined` when either is gone. */
async function findAccount(tx: Tx, id: string) {
  const [found] = await tx
    .select()
    .from(account)
    .where(and(eq(account.id, id), isNull(account.deletedAt)))
    .limit(1);
  if (!found) return undefined;
  const chart = await findChart(tx, found.chartId);
  return chart ? { account: found, chart } : undefined;
}

/**
 * True when a live cost line is booked to any account matching `accounts`.
 * Cost lines belong to projects, so for a project chart the project's change
 * counter is taken first (`lockProjectChanges`), as every write in the project
 * does before it locks a record: taking an account lock first would deadlock
 * with a cost line being written at the same moment. A template chart has no
 * project and no cost lines, so it takes no counter. Then the matching accounts
 * are locked and the lines are read after, so a cost line being written right
 * now, which holds a share lock on its account (see the costs service), either
 * finishes before the check or waits for the removal. Without the locks the
 * check could pass just before such a line commits, and the account would be
 * removed under it. The locks last until the caller's transaction ends.
 * Accounts and cost lines are both core tables, so this is the one place the
 * accounts folder reads `cost_line`: the rule is an integrity check of the
 * account, not a report on cost lines.
 */
async function hasLiveCostLines(
  tx: Tx,
  scope: PermissionScope,
  accounts: SQL,
): Promise<boolean> {
  void scope;
  await tx.select({ id: account.id }).from(account).where(accounts);
  const [found] = await tx
    .select({ id: costLine.id })
    .from(costLine)
    .where(
      and(
        isNull(costLine.deletedAt),
        inArray(
          costLine.accountId,
          tx.select({ id: account.id }).from(account).where(accounts),
        ),
      ),
    )
    .limit(1);
  return found !== undefined;
}

/** The live accounts of a chart, in no particular order. */
function liveAccountsOf(tx: Tx, chartId: string): Promise<AccountRow[]> {
  return tx
    .select()
    .from(account)
    .where(and(eq(account.chartId, chartId), isNull(account.deletedAt)));
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// Compared in JavaScript, not by the database, so the order does not depend on
// the collation of the server.
const bySiblingOrder = (a: AccountRow, b: AccountRow) =>
  a.sortOrder - b.sortOrder ||
  compareText(a.code, b.code) ||
  compareText(a.id, b.id);

/**
 * Orders accounts so a parent comes before its children: depth first, siblings
 * by `sort_order` and then `code`. An account whose parent is not among `rows`
 * counts as a top-level one. Accounts that cannot be reached from the top, which
 * only a loop in the stored parents causes and the service never writes, come
 * last in sibling order, so none is dropped.
 */
function inTreeOrder(rows: readonly AccountRow[]): AccountRow[] {
  const ids = new Set(rows.map((row) => row.id));
  const childrenOf = new Map<string | null, AccountRow[]>();
  for (const row of rows) {
    const key =
      row.parentId !== null && ids.has(row.parentId) ? row.parentId : null;
    const siblings = childrenOf.get(key);
    if (siblings) siblings.push(row);
    else childrenOf.set(key, [row]);
  }
  for (const siblings of childrenOf.values()) siblings.sort(bySiblingOrder);

  const ordered: AccountRow[] = [];
  const seen = new Set<string>();
  // An explicit stack, not recursion: a deep chart must not overflow the call stack.
  const walk = (tops: readonly AccountRow[]) => {
    const stack = [...tops].reverse();
    while (stack.length > 0) {
      const row = stack.pop()!;
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      ordered.push(row);
      stack.push(...[...(childrenOf.get(row.id) ?? [])].reverse());
    }
  };
  walk(childrenOf.get(null) ?? []);
  walk([...rows].sort(bySiblingOrder));
  return ordered;
}

async function viewOf(
  tx: Tx,
  chart: AccountChartRow,
): Promise<AccountChartView> {
  return {
    ...chart,
    accounts: inTreeOrder(await liveAccountsOf(tx, chart.id)),
  };
}

/** The refusal for a parent that is missing, removed or in another chart. One message covers all three. */
function notInChart() {
  return new AccountInputError(
    'The parent must be a live account of the same chart',
  );
}

/** The live default chart of a scope, if it has one. */
async function findDefaultChart(tx: Tx, scope: PermissionScope) {
  const [found] = await tx
    .select()
    .from(accountChart)
    .where(
      and(
        eq(accountChart.organisationId, scope.organisationId),
        scope.projectId === null
          ? isNull(accountChart.projectId)
          : eq(accountChart.projectId, scope.projectId),
        eq(accountChart.isDefault, true),
        isNull(accountChart.deletedAt),
      ),
    )
    .limit(1);
  return found;
}

/**
 * Takes the default away from the scope's current default chart, so a new
 * default can take its place: the unique index allows one live default per
 * scope. Runs inside the caller's savepoint, before the new chart is written.
 * `keepId` names the chart that is about to become the default: when it already
 * is the default there is nothing to clear.
 */
async function clearDefault(
  tx: Tx,
  write: WriteContext,
  scope: PermissionScope,
  keepId?: string,
) {
  const current = await findDefaultChart(tx, scope);
  if (current && current.id !== keepId) {
    await updateRecord(
      tx,
      accountChart,
      current.id,
      current.version,
      { isDefault: false },
      write,
    );
  }
}

/**
 * Creates a chart: an organisation template when `projectId` is left out, else a
 * chart of that project. Setting `isDefault` takes the default from the scope's
 * old default chart in the same savepoint, so the scope never has two defaults,
 * and if the create fails the old default stays. Needs `accounts:edit` on the
 * project, or in the organisation for a template.
 *
 * @throws AccessDeniedError, naming the scope, because the caller supplied it.
 * @throws RecordWriteError when the database refuses the row, for example a key
 * already live in the scope or one that is not lower case and hyphens.
 */
export async function createChart(
  tx: Tx,
  ctx: AccountContext,
  values: CreateChartValues,
): Promise<AccountChartView> {
  const scope: PermissionScope = {
    organisationId: values.organisationId,
    projectId: values.projectId ?? null,
  };
  await requireInScope(tx, ctx, scope, ACCOUNTS_EDIT_PERMISSION);
  const created = await tx.transaction(async (inner) => {
    const write = writeContext(ctx);
    if (values.isDefault) await clearDefault(inner, write, scope);
    return insertRecord(
      inner,
      accountChart,
      {
        organisationId: scope.organisationId,
        ownerOrgId: scope.organisationId,
        projectId: scope.projectId,
        key: values.key,
        name: values.name,
        format: values.format,
        isDefault: values.isDefault ?? false,
      },
      write,
    );
  });
  return viewOf(tx, created);
}

/**
 * Changes fields of a chart. Needs `accounts:edit` on the chart's scope. Setting
 * `isDefault` to true takes the default from the scope's old default chart in
 * the same savepoint, so the scope never has two defaults, and if the update
 * fails, for example on a stale `version`, the old default stays. Changes that
 * alter no field write nothing and return the current chart (see
 * `updateRecord`).
 *
 * @throws AccessDeniedError, with no scope, for a chart that is unknown, removed
 * or forbidden: all three look the same, so ids cannot be probed.
 * @throws VersionConflictError for a stale `version`.
 * @throws RecordWriteError when the database refuses a value, for example a key
 * already live in the scope or one that is not lower case and hyphens.
 */
export async function updateChart(
  tx: Tx,
  ctx: AccountContext,
  id: string,
  version: number,
  changes: ChartChanges,
): Promise<AccountChartView> {
  const found = await findChart(tx, id);
  if (!found) throw new AccessDeniedError(ACCOUNTS_EDIT_PERMISSION);
  const scope = scopeOf(found);
  await requireOnRecord(tx, ctx, scope, ACCOUNTS_EDIT_PERMISSION);
  // Named fields only: a key the type does not list, such as `projectId`, never
  // reaches the write.
  const patch: UpdatePatch<typeof accountChart> = {
    name: changes.name,
    key: changes.key,
    format: changes.format,
    isDefault: changes.isDefault,
  };
  const updated = await tx.transaction(async (inner) => {
    const write = writeContext(ctx);
    if (changes.isDefault === true) {
      await clearDefault(inner, write, scope, id);
    }
    return updateRecord(inner, accountChart, id, version, patch, write);
  });
  return viewOf(tx, updated);
}

/**
 * Removes a chart and all its live accounts by soft delete, in one savepoint:
 * either all of it is removed or none, change events and their sequence numbers
 * included. Needs `accounts:edit` on the chart's scope. The accounts go without
 * the check for live children that `removeAccount` makes, because the whole tree
 * goes. Accounts that were already removed are left as they were. The chart's
 * key is free afterwards, and so is its place as the default of its scope: the
 * same write sets `is_default` to false, so a removed chart is never a default
 * and restoring it later cannot give its scope a second one. Charts copied from
 * a template are not touched when the template is removed.
 *
 * A chart with a live cost line booked to one of its accounts is not removed:
 * the check runs before anything is written.
 *
 * @throws AccessDeniedError, with no scope, for a chart that is unknown, removed
 * or forbidden.
 * @throws AccountInUseError, a `RecordStateError`, while a live cost line is
 * booked to one of the chart's accounts.
 * @throws VersionConflictError for a stale `version` of the chart.
 * @throws RecordWriteError when the database refuses a write.
 */
export async function removeChart(
  tx: Tx,
  ctx: AccountContext,
  id: string,
  version: number,
): Promise<AccountChartRow> {
  const found = await findChart(tx, id);
  if (!found) throw new AccessDeniedError(ACCOUNTS_EDIT_PERMISSION);
  await requireOnRecord(tx, ctx, scopeOf(found), ACCOUNTS_EDIT_PERMISSION);
  return tx.transaction(async (inner) => {
    const write = writeContext(ctx);
    if (
      await hasLiveCostLines(
        inner,
        scopeOf(found),
        and(eq(account.chartId, id), isNull(account.deletedAt))!,
      )
    ) {
      throw new AccountInUseError('account_chart', id);
    }
    // The chart first, so a stale `version` is refused before any account is
    // touched. `is_default` goes in the same write: the unique index ignores a
    // removed row, but a restore clears the deletion mark only, and a removed
    // chart that kept the mark would then clash with the scope's new default.
    const removed = await softDeleteRecord(
      inner,
      accountChart,
      id,
      version,
      write,
      { isDefault: false },
    );
    for (const row of inTreeOrder(await liveAccountsOf(inner, id))) {
      await softDeleteRecord(inner, account, row.id, row.version, write);
    }
    return removed;
  });
}

/**
 * Copies an organisation template into a project, with every live account and
 * the tree they form, parents remapped to the copies. The copy records the
 * template in `copied_from_chart_id` and never follows later changes to it.
 * Removed accounts are left out. The chart and all its accounts are written in
 * one savepoint: if any write fails, nothing stays, including the change events
 * and their sequence numbers.
 *
 * Needs `accounts:edit` on the project and `accounts:read` on the template's
 * scope, the project's organisation.
 *
 * @throws AccessDeniedError, with no scope, for an unknown or removed project or
 * a missing permission: the caller named the project by id.
 * @throws AccountInputError, with one message for every reason, when the source
 * is not a live organisation template of the project's organisation, which also
 * covers an unknown id, so the call tells a caller who may read templates
 * nothing more.
 * @throws RecordWriteError when the database refuses a row, for example a key
 * already live in the project.
 */
export async function copyChartToProject(
  tx: Tx,
  ctx: AccountContext,
  input: CopyChartInput,
): Promise<AccountChartView> {
  const [target] = await tx
    .select({ id: project.id, organisationId: project.organisationId })
    .from(project)
    .where(and(eq(project.id, input.projectId), isNull(project.deletedAt)))
    .limit(1);
  if (!target) throw new AccessDeniedError(ACCOUNTS_EDIT_PERMISSION);
  const projectScope: PermissionScope = {
    organisationId: target.organisationId,
    projectId: target.id,
  };
  const templateScope: PermissionScope = {
    organisationId: target.organisationId,
    projectId: null,
  };
  await requireOnRecord(tx, ctx, projectScope, ACCOUNTS_EDIT_PERMISSION);
  await requireOnRecord(tx, ctx, templateScope, ACCOUNTS_READ_PERMISSION);

  const source = await findChart(tx, input.sourceChartId);
  if (
    !source ||
    source.projectId !== null ||
    source.organisationId !== target.organisationId
  ) {
    throw new AccountInputError(
      'The chart to copy does not exist, is removed, or is not an organisation template of the project’s organisation',
    );
  }

  const copy = await tx.transaction(async (inner) => {
    const write = writeContext(ctx);
    const makeDefault = input.makeDefault ?? false;
    if (makeDefault) await clearDefault(inner, write, projectScope);
    const chart = await insertRecord(
      inner,
      accountChart,
      {
        organisationId: target.organisationId,
        ownerOrgId: target.organisationId,
        projectId: target.id,
        key: input.key ?? source.key,
        name: input.name ?? source.name,
        format: source.format,
        isDefault: makeDefault,
        copiedFromChartId: source.id,
      },
      write,
    );
    // Tree order puts every parent before its children, which the parent key
    // needs: the copy of a parent must exist when its child is written.
    const copyOf = new Map<string, string>();
    for (const row of inTreeOrder(await liveAccountsOf(inner, source.id))) {
      const written = await insertRecord(
        inner,
        account,
        {
          organisationId: target.organisationId,
          ownerOrgId: target.organisationId,
          chartId: chart.id,
          // A parent that was not copied, which the service never leaves behind
          // (see `inTreeOrder`), makes the copy a top-level account.
          parentId:
            row.parentId === null ? null : (copyOf.get(row.parentId) ?? null),
          code: row.code,
          name: row.name,
          isPostable: row.isPostable,
          glCode: row.glCode,
          sortOrder: row.sortOrder,
        },
        write,
      );
      copyOf.set(row.id, written.id);
    }
    return chart;
  });
  return viewOf(tx, copy);
}

/**
 * Adds an account to a chart. Needs `accounts:edit` on the chart's scope. The
 * parent, when given, must be a live account of the same chart. Adding a code
 * that was removed earlier creates a new account.
 *
 * @throws AccessDeniedError, with no scope, for a chart that is unknown, removed
 * or forbidden: all three look the same, so ids cannot be probed.
 * @throws AccountInputError when the parent is not a live account of the chart.
 * @throws RecordWriteError when the database refuses the row, for example a code
 * already live in the chart or an empty one.
 */
export async function addAccount(
  tx: Tx,
  ctx: AccountContext,
  chartId: string,
  input: AccountInput,
): Promise<AccountRow> {
  const chart = await findChart(tx, chartId);
  if (!chart) throw new AccessDeniedError(ACCOUNTS_EDIT_PERMISSION);
  await requireOnRecord(tx, ctx, scopeOf(chart), ACCOUNTS_EDIT_PERMISSION);
  if (input.parentId != null) {
    const [parent] = await tx
      .select({ id: account.id })
      .from(account)
      .where(
        and(
          eq(account.id, input.parentId),
          eq(account.chartId, chart.id),
          isNull(account.deletedAt),
        ),
      )
      .limit(1);
    if (!parent) throw notInChart();
  }
  return insertRecord(
    tx,
    account,
    {
      organisationId: chart.organisationId,
      ownerOrgId: chart.organisationId,
      chartId: chart.id,
      parentId: input.parentId ?? null,
      code: input.code,
      name: input.name,
      isPostable: input.isPostable,
      glCode: input.glCode,
      sortOrder: input.sortOrder,
    },
    writeContext(ctx),
  );
}

/**
 * Changes fields of an account. Needs `accounts:edit` on its chart's scope. A
 * new parent must be a live account of the same chart and must not be the
 * account itself or one of its descendants. Changes that alter no field write
 * nothing and return the current account (see `updateRecord`).
 *
 * An account with a live cost line booked to it stays postable: `isPostable:
 * false` is refused until the lines are removed or rebooked. Other changes to
 * such an account are allowed.
 *
 * @throws AccessDeniedError, with no scope, for an account that is unknown,
 * removed or forbidden, or whose chart is removed.
 * @throws AccountInputError for a parent that is not in the chart, or one that
 * would make the account its own ancestor.
 * @throws AccountInUseError, a `RecordStateError`, when `isPostable` is set to
 * false while a live cost line is booked to the account.
 * @throws VersionConflictError for a stale `version`.
 * @throws RecordWriteError when the database refuses a value, for example a code
 * already live in the chart.
 */
export async function updateAccount(
  tx: Tx,
  ctx: AccountContext,
  id: string,
  version: number,
  changes: AccountChanges,
): Promise<AccountRow> {
  const found = await findAccount(tx, id);
  if (!found) throw new AccessDeniedError(ACCOUNTS_EDIT_PERMISSION);
  await requireOnRecord(
    tx,
    ctx,
    scopeOf(found.chart),
    ACCOUNTS_EDIT_PERMISSION,
  );
  // Only the change from postable to non-postable matters: an account that is
  // already non-postable has no cost lines to protect, and an unrelated edit of
  // an account in use must not be blocked.
  if (
    changes.isPostable === false &&
    found.account.isPostable &&
    (await hasLiveCostLines(tx, scopeOf(found.chart), eq(account.id, id)))
  ) {
    throw new AccountInUseError('account', id, 'stop-posting');
  }
  if (changes.parentId != null) {
    const parentOf = new Map(
      (await liveAccountsOf(tx, found.chart.id)).map((row) => [
        row.id,
        row.parentId,
      ]),
    );
    if (!parentOf.has(changes.parentId)) throw notInChart();
    // Walk up from the new parent: reaching the account means it would sit
    // below itself. Each account is visited once, so a stored loop ends the walk.
    const visited = new Set<string>();
    for (
      let current: string | null = changes.parentId;
      current !== null && !visited.has(current);
      current = parentOf.get(current) ?? null
    ) {
      if (current === id) {
        throw new AccountInputError(
          'An account cannot be moved below itself or one of its descendants',
        );
      }
      visited.add(current);
    }
  }
  // Named fields only: a key the type does not list, such as `chartId`, never
  // reaches the write.
  const patch: UpdatePatch<typeof account> = {
    parentId: changes.parentId,
    code: changes.code,
    name: changes.name,
    isPostable: changes.isPostable,
    glCode: changes.glCode,
    sortOrder: changes.sortOrder,
  };
  return updateRecord(tx, account, id, version, patch, writeContext(ctx));
}

/**
 * Removes an account by soft delete. Needs `accounts:edit` on its chart's scope.
 * Its code is free to use again afterwards. An account with a live cost line
 * booked to it is not removed.
 *
 * @throws AccessDeniedError, with no scope, as `updateAccount`.
 * @throws AccountHasChildrenError, a `RecordStateError`, while the account has
 * live children; remove or move them first.
 * @throws AccountInUseError, a `RecordStateError`, while a live cost line is
 * booked to the account; remove or rebook the cost lines first.
 * @throws VersionConflictError for a stale `version`.
 */
export async function removeAccount(
  tx: Tx,
  ctx: AccountContext,
  id: string,
  version: number,
): Promise<AccountRow> {
  const found = await findAccount(tx, id);
  if (!found) throw new AccessDeniedError(ACCOUNTS_EDIT_PERMISSION);
  await requireOnRecord(
    tx,
    ctx,
    scopeOf(found.chart),
    ACCOUNTS_EDIT_PERMISSION,
  );
  const [child] = await tx
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.parentId, id), isNull(account.deletedAt)))
    .limit(1);
  if (child) throw new AccountHasChildrenError(id);
  if (await hasLiveCostLines(tx, scopeOf(found.chart), eq(account.id, id))) {
    throw new AccountInUseError('account', id);
  }
  return softDeleteRecord(tx, account, id, version, writeContext(ctx));
}

/**
 * Reads one chart with its live accounts in tree order: each parent before its
 * children, siblings by `sort_order` and then `code`. Needs `accounts:read` on
 * the chart's scope.
 *
 * @throws AccessDeniedError, with no scope, for a chart that is unknown, removed
 * or forbidden.
 */
export async function getChart(
  tx: Tx,
  ctx: AccountContext,
  id: string,
): Promise<AccountChartView> {
  const found = await findChart(tx, id);
  if (!found) throw new AccessDeniedError(ACCOUNTS_READ_PERMISSION);
  await requireOnRecord(tx, ctx, scopeOf(found), ACCOUNTS_READ_PERMISSION);
  return viewOf(tx, found);
}

/**
 * Lists the live charts of one project, or the organisation templates, by key.
 * The charts come without their accounts: read one with `getChart`. Needs
 * `accounts:read` on that scope.
 *
 * @throws AccessDeniedError, naming the scope, because the caller supplied it.
 */
export async function listCharts(
  tx: Tx,
  ctx: AccountContext,
  filter: ChartFilter,
): Promise<AccountChartRow[]> {
  const scope: PermissionScope = {
    organisationId: filter.organisationId,
    projectId: filter.projectId ?? null,
  };
  await requireInScope(tx, ctx, scope, ACCOUNTS_READ_PERMISSION);
  const conditions: SQL[] = [
    eq(accountChart.organisationId, scope.organisationId),
    scope.projectId === null
      ? isNull(accountChart.projectId)
      : eq(accountChart.projectId, scope.projectId),
    isNull(accountChart.deletedAt),
  ];
  return tx
    .select()
    .from(accountChart)
    .where(and(...conditions))
    .orderBy(asc(accountChart.key), asc(accountChart.id));
}
