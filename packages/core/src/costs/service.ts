import {
  and,
  asc,
  eq,
  exists,
  inArray,
  isNull,
  sql,
  type SQL,
} from 'drizzle-orm';
import { AccessDeniedError } from '../access/access-denied-error.js';
import {
  hasScopedPermission,
  type PermissionScope,
} from '../access/scoped-permission.js';
import {
  account,
  accountChart,
  company,
  costLine,
  costLineScheme,
  episode,
  person,
  project,
  unit,
  type CostLineSchemeStatus,
  type CostSourceType,
  type CostStage,
  type ProductionPhase,
} from '../db/schema/index.js';
import {
  insertRecord,
  softDeleteRecord,
  updateRecord,
  type Tx,
  type UpdatePatch,
  type WriteContext,
} from '../db/write.js';
import {
  COSTS_EDIT_PERMISSION,
  COSTS_READ_PERMISSION,
  COSTS_TAG_SCHEMES_PERMISSION,
} from './permissions.js';

/**
 * Cost lines and their incentive-scheme tags: the shared rows that budgets,
 * purchase orders, invoices, expenses and timesheets will write to. Nothing here
 * is a budget, a total or a report, and no scheme rules live here: a tag only
 * records a decision, and what a scheme key means comes from rule packs later.
 *
 * Permissions: `costs:read`, `costs:edit` and `costs:tag-schemes`, all checked
 * on the cost line's project (`hasScopedPermission`). Amounts reach only holders
 * of `costs:read`, which is flagged as granting sensitive data. For everyone
 * else `amount` and `amountProjectCurrency` are absent from the result of a
 * create, an update and a removal, and `qualifyingAmount` from the result of a
 * tagging call: the keys are removed, never `null` or `0`. Setting a
 * qualifying amount needs `costs:read` too, because it is checked against the
 * line's own amount and the error would otherwise tell a caller how large that
 * amount is.
 *
 * Money is never a `number`. Amounts and rates are decimal strings. The
 * project-currency amount is computed by the database in `numeric`, never in
 * JavaScript: when the line is in the project's currency it equals the amount
 * and `fxRate` must be left out; otherwise `fxRate` is required and the amount
 * is `round(amount * fx_rate, 4)`, rounding halves away from zero. An amount
 * has at most four places and a rate ten; more is refused rather than rounded.
 * A line is priced in the project's currency under a share lock on the project,
 * taken after the project's change counter (see `requireInProject`), because
 * the database refuses to change that currency while the project has live cost
 * lines.
 *
 * A call that names a cost line by id fails with `AccessDeniedError` when the
 * line does not exist, is removed or belongs to another organisation, exactly
 * as for a forbidden one, so ids cannot be probed. That error does not say which
 * scope was checked. A create or a list names the project itself, so its error
 * does. Cost lines are not sensitive personal data in the sense of
 * `person_sensitive`, so a denial writes no audit event.
 *
 * Cost lines and tags are removed by soft delete. A removed line takes its live
 * tags with it, and a removed tag frees its key, so tagging the line again for
 * that scheme makes a new tag.
 */

/** Who is acting, and on which server and clock. Always a user. */
export type CostContext = {
  /** The user acting. */
  readonly userId: string;
  readonly requestId?: string | null;
  /** The server doing the work. */
  readonly originServer: string;
  readonly clock: () => Date;
};

/**
 * A cost line or tag is refused for a reason of its own: an amount or rate that
 * is not a decimal in range, a currency that breaks the project-currency rule,
 * an account that cannot take cost lines, a payee, unit or episode that is not
 * live in the project, or a qualifying amount outside the line's amount.
 * Carries no ids and no amounts.
 */
export class CostLineInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CostLineInputError';
  }
}

/**
 * What `createCostLine` needs. `amountProjectCurrency` is not an input: the
 * database computes it. `amount` and `fxRate` are decimal strings such as
 * `1250.50` and `1.2650000000`.
 */
export type CreateCostLineValues = {
  readonly organisationId: string;
  readonly projectId: string;
  readonly stage: CostStage;
  readonly sourceType: CostSourceType;
  /** Required unless `sourceType` is `other`. */
  readonly sourceId?: string | null;
  /** A postable, live account of one of the project's live charts. */
  readonly accountId: string;
  readonly description: string;
  /** ISO 3166-1 alpha-2 code, or `WW` for worldwide. */
  readonly territory: string;
  readonly productionPhase: ProductionPhase;
  /** At most one of the two payees. A live company of the organisation. */
  readonly payeeCompanyId?: string | null;
  /** A live person of the organisation. */
  readonly payeePersonId?: string | null;
  /** A calendar date, `YYYY-MM-DD`. */
  readonly costDate?: string | null;
  /** Up to 15 digits before the point and 4 after; negative for a credit. */
  readonly amount: string;
  /** Three upper-case letters, such as `GBP`. */
  readonly currency: string;
  /** Required unless `currency` is the project's currency, when it must be left out. */
  readonly fxRate?: string | null;
  /** A live episode of the project. */
  readonly episodeId?: string | null;
  /** A live unit of the project. */
  readonly unitId?: string | null;
};

/**
 * The fields of a cost line that can change. Its project cannot, and any other
 * key in the object is ignored. Naming `amount`, `currency` or `fxRate` makes
 * the database compute `amountProjectCurrency` again, from these values and the
 * stored ones, in the same write.
 */
export type CostLineChanges = {
  readonly stage?: CostStage;
  readonly sourceType?: CostSourceType;
  readonly sourceId?: string | null;
  readonly accountId?: string;
  readonly description?: string;
  readonly territory?: string;
  readonly productionPhase?: ProductionPhase;
  readonly payeeCompanyId?: string | null;
  readonly payeePersonId?: string | null;
  readonly costDate?: string | null;
  readonly amount?: string;
  readonly currency?: string;
  readonly fxRate?: string | null;
  readonly episodeId?: string | null;
  readonly unitId?: string | null;
};

/**
 * Which cost lines `listCostLines` returns: one project, optionally narrowed.
 * Every field given must match. `schemeKey` and `schemeStatus` apply to the same
 * live tag: a line matches when it has a live tag with that key and, if given,
 * that status. `schemeStatus` alone matches a tag of any scheme.
 */
export type CostLineFilter = {
  readonly organisationId: string;
  readonly projectId: string;
  readonly stage?: CostStage;
  readonly accountId?: string;
  readonly productionPhase?: ProductionPhase;
  readonly territory?: string;
  readonly unitId?: string;
  readonly episodeId?: string;
  readonly schemeKey?: string;
  readonly schemeStatus?: CostLineSchemeStatus;
};

/** What `setCostLineScheme` records about one scheme. */
export type CostLineSchemeDecision = {
  readonly status: CostLineSchemeStatus;
  /**
   * The part of the line that qualifies, a decimal string. Only for status
   * `qualifying`, with the sign of the line's `amountProjectCurrency` and no
   * larger in absolute value. Needs `costs:read` as well. Leave out when the
   * amount is not split.
   */
  readonly qualifyingAmount?: string | null;
  /** Why the decision was made. */
  readonly reason?: string | null;
};

/** A stored `cost_line` row, as the read calls return it. */
export type CostLineRow = typeof costLine.$inferSelect;
/** A stored `cost_line_scheme` row, as the read calls return it. */
export type CostLineSchemeRow = typeof costLineScheme.$inferSelect;

/**
 * A cost line as the create, update and removal calls return it. `amount` and
 * `amountProjectCurrency` are present only for a caller holding `costs:read`.
 */
export type CostLineView = Omit<
  CostLineRow,
  'amount' | 'amountProjectCurrency'
> &
  Partial<Pick<CostLineRow, 'amount' | 'amountProjectCurrency'>>;

/**
 * A scheme tag as the tagging calls return it. `qualifyingAmount` is present
 * only for a caller holding `costs:read`.
 */
export type CostLineSchemeView = Omit<CostLineSchemeRow, 'qualifyingAmount'> &
  Partial<Pick<CostLineSchemeRow, 'qualifyingAmount'>>;

/** A cost line with its live scheme tags, by scheme key. Only `costs:read` holders get one. */
export type CostLineWithSchemes = CostLineRow & {
  readonly schemes: CostLineSchemeRow[];
};

/** Up to 15 digits before the point, which is what `numeric(19,4)` holds, and 4 after. */
const AMOUNT_PATTERN = /^-?\d{1,15}(\.\d{1,4})?$/;
/** Up to 9 digits before the point, which is what `numeric(19,10)` holds, and 10 after. */
const FX_RATE_PATTERN = /^\d{1,9}(\.\d{1,10})?$/;

function writeContext(ctx: CostContext): WriteContext {
  return {
    actor: { type: 'user', id: ctx.userId },
    originServer: ctx.originServer,
    clock: ctx.clock,
    requestId: ctx.requestId ?? null,
  };
}

function scopeOf(row: CostLineRow): PermissionScope {
  return { organisationId: row.organisationId, projectId: row.projectId };
}

/**
 * For a project the caller named: the error says it is a project. The project
 * must exist in the named organisation, or the answer is the same as for a
 * forbidden one. `lockProject` is for a call that prices a line against the
 * project's currency, and it takes two locks that hold until the transaction
 * ends, in this order. First the project's change counter
 * (`lockProjectChanges`), which every write through the write helper takes
 * before it locks a record, so a project update, which locks the project row,
 * and this call cannot each wait for what the other holds. Then a share lock on
 * the project row. A change of the project's currency, which the database
 * refuses while live cost lines exist, then waits for the line to commit and
 * sees it, or has committed first and is seen here, so a line is never priced
 * in a currency the project no longer has (`0022_project_currency_locked.sql`).
 * Locks are taken only for a caller who holds the permission.
 */
async function requireInProject(
  tx: Tx,
  ctx: CostContext,
  scope: { organisationId: string; projectId: string },
  key: string,
  lockProject = false,
) {
  const allowed = await hasScopedPermission(tx, ctx.userId, scope, key);
  void lockProject;
  const query = tx
    .select({ id: project.id, currency: project.currency })
    .from(project)
    .where(
      and(
        eq(project.id, scope.projectId),
        eq(project.organisationId, scope.organisationId),
        isNull(project.deletedAt),
      ),
    )
    .limit(1);
  const [found] = allowed ? await query : [];
  if (!found) throw new AccessDeniedError(key, scope);
  return found;
}

/**
 * For a cost line the caller named by id: `scope` is where the line is, and the
 * error does not say so, or an unknown id would answer differently from a
 * forbidden one.
 */
async function requireOnRecord(
  tx: Tx,
  ctx: CostContext,
  scope: PermissionScope,
  key: string,
): Promise<void> {
  if (!(await hasScopedPermission(tx, ctx.userId, scope, key))) {
    throw new AccessDeniedError(key);
  }
}

/** A cost line that is not removed. */
async function findCostLine(tx: Tx, id: string) {
  const [found] = await tx
    .select()
    .from(costLine)
    .where(and(eq(costLine.id, id), isNull(costLine.deletedAt)))
    .limit(1);
  return found;
}

/** The live tags of the given cost lines, by scheme key and then id. */
async function liveSchemesOf(
  tx: Tx,
  costLineIds: readonly string[],
): Promise<CostLineSchemeRow[]> {
  if (costLineIds.length === 0) return [];
  return tx
    .select()
    .from(costLineScheme)
    .where(
      and(
        inArray(costLineScheme.costLineId, [...costLineIds]),
        isNull(costLineScheme.deletedAt),
      ),
    )
    .orderBy(asc(costLineScheme.schemeKey), asc(costLineScheme.id));
}

// The keys are removed, not set to null or 0, so a caller cannot tell a hidden
// amount from an empty one.
function lineView(row: CostLineRow, canRead: boolean): CostLineView {
  if (canRead) return row;
  const copy: Partial<CostLineRow> = { ...row };
  delete copy.amount;
  delete copy.amountProjectCurrency;
  return copy as CostLineView;
}

function schemeView(
  row: CostLineSchemeRow,
  canRead: boolean,
): CostLineSchemeView {
  if (canRead) return row;
  const copy: Partial<CostLineSchemeRow> = { ...row };
  delete copy.qualifyingAmount;
  return copy as CostLineSchemeView;
}

/** The lines with their live tags, in the order of `rows`. */
async function withSchemes(
  tx: Tx,
  rows: readonly CostLineRow[],
): Promise<CostLineWithSchemes[]> {
  const tags = await liveSchemesOf(
    tx,
    rows.map((row) => row.id),
  );
  const byLine = new Map<string, CostLineSchemeRow[]>();
  for (const tag of tags) {
    const group = byLine.get(tag.costLineId);
    if (group) group.push(tag);
    else byLine.set(tag.costLineId, [tag]);
  }
  return rows.map((row) => ({ ...row, schemes: byLine.get(row.id) ?? [] }));
}

function checkAmount(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !AMOUNT_PATTERN.test(value)) {
    throw new CostLineInputError(
      'An amount must be a decimal string with at most 15 digits before the point and 4 after',
    );
  }
}

function checkFxRate(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !FX_RATE_PATTERN.test(value) ||
    !/[1-9]/.test(value)
  ) {
    throw new CostLineInputError(
      'An exchange rate must be a decimal string above zero, with at most 9 digits before the point and 10 after',
    );
  }
}

/** The rows of a raw `execute`, which both drivers return as `{ rows }`. */
function rowsOf<T>(result: unknown): T[] {
  return (result as { rows: T[] }).rows;
}

/**
 * The amount, the rate and the project-currency amount, as the database holds
 * them. The database does the arithmetic, in `numeric`: it never passes through
 * a JavaScript number. `amount` and `fxRate` come back in their stored form, so
 * `12.5` and `12.5000` are the same value and an update that repeats it changes
 * nothing.
 */
async function priceInDatabase(
  tx: Tx,
  input: {
    readonly amount: string;
    readonly fxRate: string | null;
    readonly inProjectCurrency: boolean;
  },
) {
  const [row] = rowsOf<{
    amount: string;
    fx_rate: string | null;
    product: string | null;
  }>(
    await tx.execute(
      sql`select round(${input.amount}::numeric, 4)::text as amount,
                 round(${input.fxRate}::numeric, 10)::text as fx_rate,
                 round(round(${input.amount}::numeric, 4)
                       * round(${input.fxRate}::numeric, 10), 4)::text as product`,
    ),
  );
  return {
    amount: row!.amount,
    fxRate: row!.fx_rate,
    // With no rate there is no product, and the amount is already in the
    // project's currency.
    amountProjectCurrency: input.inProjectCurrency
      ? row!.amount
      : row!.product!,
  };
}

/**
 * Compares a qualifying amount with the line's, in the database. `ok` is true
 * when `qualifying` has the sign of `lineAmount` (or is zero) and is no larger
 * in absolute value. `canonical` is the qualifying amount in its stored form, so
 * `400` and `400.0000` are one value and repeating a decision changes nothing.
 */
async function compareQualifying(
  tx: Tx,
  qualifying: string,
  lineAmount: string,
): Promise<{ ok: boolean; canonical: string }> {
  const [row] = rowsOf<{ ok: boolean; canonical: string }>(
    await tx.execute(
      sql`select round(${qualifying}::numeric, 4)::text as canonical,
                 (sign(${qualifying}::numeric) * sign(${lineAmount}::numeric) >= 0
                  and abs(${qualifying}::numeric) <= abs(${lineAmount}::numeric)) as ok`,
    ),
  );
  return { ok: row!.ok, canonical: row!.canonical };
}

/**
 * The money part of a line: checks the project-currency rule and has the
 * database compute the amounts. `inProjectCurrency` lines take no rate; others
 * need one.
 */
async function priceLine(
  tx: Tx,
  projectCurrency: string,
  input: {
    readonly amount: unknown;
    readonly currency: string;
    readonly fxRate?: string | null;
  },
) {
  checkAmount(input.amount);
  const inProjectCurrency = input.currency === projectCurrency;
  if (inProjectCurrency && input.fxRate != null) {
    throw new CostLineInputError(
      'A line in the project’s currency takes no exchange rate',
    );
  }
  if (!inProjectCurrency && input.fxRate == null) {
    throw new CostLineInputError(
      'A line in another currency than the project’s needs an exchange rate',
    );
  }
  if (input.fxRate != null) checkFxRate(input.fxRate);
  return priceInDatabase(tx, {
    amount: input.amount,
    fxRate: input.fxRate ?? null,
    inProjectCurrency,
  });
}

/**
 * An account takes a cost line only when it is live, postable and in a live
 * chart of the line's own project. The account is read with a share lock, which
 * holds until the transaction ends, so `removeAccount` and `removeChart` (which
 * lock the account before they look for cost lines) cannot remove it between
 * this check and the write. Both sides queue on the project's change counter
 * before they lock the account (`lockProjectChanges`), so neither can wait for
 * what the other holds. One message covers an unknown, removed, foreign and
 * wrong-project account, so a caller learns nothing about accounts it was not
 * given; a postable account is the only reason named on its own, and only once
 * the account is known to be in the project's chart.
 */
async function checkAccount(
  tx: Tx,
  where: { organisationId: string; projectId: string },
  accountId: string,
): Promise<void> {
  const [found] = await tx
    .select({ chartId: account.chartId, isPostable: account.isPostable })
    .from(account)
    .where(
      and(
        eq(account.id, accountId),
        eq(account.organisationId, where.organisationId),
        isNull(account.deletedAt),
      ),
    )
    .limit(1);
  const [chart] = found
    ? await tx
        .select({ id: accountChart.id })
        .from(accountChart)
        .where(
          and(
            eq(accountChart.id, found.chartId),
            eq(accountChart.organisationId, where.organisationId),
            eq(accountChart.projectId, where.projectId),
            isNull(accountChart.deletedAt),
          ),
        )
        .limit(1)
    : [];
  if (!found || !chart) {
    throw new CostLineInputError(
      'The account does not exist, is removed, or is not in a live chart of the project',
    );
  }
  if (!found.isPostable) {
    throw new CostLineInputError('The account is not postable');
  }
}

/** True when a live row with this id exists in the table, in the organisation. */
async function isLive(
  tx: Tx,
  table: typeof person | typeof company,
  organisationId: string,
  id: string,
): Promise<boolean> {
  const [found] = await tx
    .select({ id: table.id })
    .from(table)
    .where(
      and(
        eq(table.id, id),
        eq(table.organisationId, organisationId),
        isNull(table.deletedAt),
      ),
    )
    .limit(1);
  return found !== undefined;
}

/** A cost line has at most one payee. Checked on the payees the line would have. */
function checkOnePayee(
  payeePersonId: string | null | undefined,
  payeeCompanyId: string | null | undefined,
): void {
  if (payeePersonId != null && payeeCompanyId != null) {
    throw new CostLineInputError(
      'A cost line has at most one payee, a person or a company',
    );
  }
}

/**
 * A payee, unit or episode is accepted only when it is live and in the line's
 * organisation, and for a unit or episode in its project too. One message per
 * kind covers every reason. `refs` holds only what the caller sets: a payee,
 * unit or episode already on a line stays when it is removed later, so an
 * unrelated edit never re-checks it.
 */
async function checkReferences(
  tx: Tx,
  where: { organisationId: string; projectId: string },
  refs: {
    readonly payeePersonId?: string | null;
    readonly payeeCompanyId?: string | null;
    readonly unitId?: string | null;
    readonly episodeId?: string | null;
  },
): Promise<void> {
  if (
    refs.payeePersonId != null &&
    !(await isLive(tx, person, where.organisationId, refs.payeePersonId))
  ) {
    throw new CostLineInputError(
      'The payee person does not exist, is removed, or is not in the project’s organisation',
    );
  }
  if (
    refs.payeeCompanyId != null &&
    !(await isLive(tx, company, where.organisationId, refs.payeeCompanyId))
  ) {
    throw new CostLineInputError(
      'The payee company does not exist, is removed, or is not in the project’s organisation',
    );
  }
  for (const [table, id, name] of [
    [unit, refs.unitId, 'unit'],
    [episode, refs.episodeId, 'episode'],
  ] as const) {
    if (id == null) continue;
    const [found] = await tx
      .select({ id: table.id })
      .from(table)
      .where(
        and(
          eq(table.id, id),
          eq(table.organisationId, where.organisationId),
          eq(table.projectId, where.projectId),
          isNull(table.deletedAt),
        ),
      )
      .limit(1);
    if (!found) {
      throw new CostLineInputError(
        `The ${name} does not exist, is removed, or is not in the cost line’s project`,
      );
    }
  }
}

/**
 * Creates a cost line. Needs `costs:edit` on the project. The account must be
 * live, postable and in a live chart of the project; payees, unit and episode
 * must be live and in the project's organisation (and project, for a unit or an
 * episode). Everything is checked before anything is written. The result hides
 * the amounts from a caller without `costs:read`.
 *
 * @throws AccessDeniedError, naming the project because the caller supplied it,
 * when the caller lacks `costs:edit` or the project does not exist in the
 * organisation.
 * @throws CostLineInputError for a bad amount or rate, a currency that breaks
 * the project-currency rule, a refused account, payee, unit or episode.
 * @throws RecordWriteError when the database refuses a value, for example a
 * territory that is not two capital letters, a source type other than `other`
 * with no `sourceId`, or an amount that overflows after conversion.
 */
export async function createCostLine(
  tx: Tx,
  ctx: CostContext,
  values: CreateCostLineValues,
): Promise<CostLineView> {
  const scope = {
    organisationId: values.organisationId,
    projectId: values.projectId,
  };
  const found = await requireInProject(
    tx,
    ctx,
    scope,
    COSTS_EDIT_PERMISSION,
    true,
  );
  await checkAccount(tx, scope, values.accountId);
  checkOnePayee(values.payeePersonId, values.payeeCompanyId);
  await checkReferences(tx, scope, values);
  const priced = await priceLine(tx, found.currency, values);
  const created = await insertRecord(
    tx,
    costLine,
    {
      organisationId: values.organisationId,
      ownerOrgId: values.organisationId,
      projectId: values.projectId,
      stage: values.stage,
      sourceType: values.sourceType,
      sourceId: values.sourceId,
      accountId: values.accountId,
      description: values.description,
      territory: values.territory,
      productionPhase: values.productionPhase,
      payeeCompanyId: values.payeeCompanyId,
      payeePersonId: values.payeePersonId,
      costDate: values.costDate,
      amount: priced.amount,
      currency: values.currency,
      fxRate: priced.fxRate,
      amountProjectCurrency: priced.amountProjectCurrency,
      episodeId: values.episodeId,
      unitId: values.unitId,
    },
    writeContext(ctx),
  );
  const canRead = await hasScopedPermission(
    tx,
    ctx.userId,
    scope,
    COSTS_READ_PERMISSION,
  );
  return lineView(created, canRead);
}

/**
 * Changes fields of a cost line. Needs `costs:edit` on its project. A new
 * account, payee, unit or episode is checked as in `createCostLine`. Naming
 * `amount`, `currency` or `fxRate` makes the database compute
 * `amountProjectCurrency` again in the same write, from these values and the
 * stored ones, under the project-currency rule: moving a line into the
 * project's currency needs `fxRate: null` in the same call. Changes that alter
 * no field write nothing and return the current line (see `updateRecord`). The
 * result hides the amounts from a caller without `costs:read`.
 *
 * @throws AccessDeniedError, with no scope, for a cost line that is unknown,
 * removed or forbidden: all three look the same, so ids cannot be probed.
 * @throws CostLineInputError as `createCostLine`.
 * @throws VersionConflictError for a stale `version`.
 * @throws RecordWriteError as `createCostLine`.
 */
export async function updateCostLine(
  tx: Tx,
  ctx: CostContext,
  id: string,
  version: number,
  changes: CostLineChanges,
): Promise<CostLineView> {
  const found = await findCostLine(tx, id);
  if (!found) throw new AccessDeniedError(COSTS_EDIT_PERMISSION);
  const scope = scopeOf(found);
  await requireOnRecord(tx, ctx, scope, COSTS_EDIT_PERMISSION);
  const where = {
    organisationId: found.organisationId,
    projectId: found.projectId,
  };
  const repricing =
    changes.amount !== undefined ||
    changes.currency !== undefined ||
    changes.fxRate !== undefined;
  // A call that will lock an account or the project queues on the project's
  // change counter first, as `requireInProject` explains, and the permission
  // was checked above.
  if (changes.accountId !== undefined) {
    await checkAccount(tx, where, changes.accountId);
  }
  // The one-payee rule looks at the payees the line would have, so naming one
  // payee while the other is stored is refused with the typed error. Only the
  // payees being set are checked for being live.
  checkOnePayee(
    changes.payeePersonId === undefined
      ? found.payeePersonId
      : changes.payeePersonId,
    changes.payeeCompanyId === undefined
      ? found.payeeCompanyId
      : changes.payeeCompanyId,
  );
  await checkReferences(tx, where, {
    payeePersonId: changes.payeePersonId,
    payeeCompanyId: changes.payeeCompanyId,
    unitId: changes.unitId,
    episodeId: changes.episodeId,
  });
  let priced: Awaited<ReturnType<typeof priceLine>> | undefined;
  if (repricing) {
    // Share-locked, as in `createCostLine`: the line is priced in this currency.
    const [owner] = await tx
      .select({ currency: project.currency })
      .from(project)
      .where(eq(project.id, found.projectId))
      .limit(1);
    priced = await priceLine(tx, owner!.currency, {
      amount: changes.amount ?? found.amount,
      currency: changes.currency ?? found.currency,
      fxRate: changes.fxRate === undefined ? found.fxRate : changes.fxRate,
    });
  }
  // Named fields only: a key the type does not list, such as `projectId`, never
  // reaches the write.
  const patch: UpdatePatch<typeof costLine> = {
    stage: changes.stage,
    sourceType: changes.sourceType,
    sourceId: changes.sourceId,
    accountId: changes.accountId,
    description: changes.description,
    territory: changes.territory,
    productionPhase: changes.productionPhase,
    payeeCompanyId: changes.payeeCompanyId,
    payeePersonId: changes.payeePersonId,
    costDate: changes.costDate,
    amount: priced?.amount,
    currency: changes.currency,
    fxRate: priced === undefined ? undefined : priced.fxRate,
    amountProjectCurrency: priced?.amountProjectCurrency,
    episodeId: changes.episodeId,
    unitId: changes.unitId,
  };
  const updated = await updateRecord(
    tx,
    costLine,
    id,
    version,
    patch,
    writeContext(ctx),
  );
  const canRead = await hasScopedPermission(
    tx,
    ctx.userId,
    scope,
    COSTS_READ_PERMISSION,
  );
  return lineView(updated, canRead);
}

/**
 * Removes a cost line by soft delete, and its live scheme tags with it, in one
 * savepoint: either all of it is removed or none, change events and their
 * sequence numbers included. Needs `costs:edit` on its project. The result hides
 * the amounts from a caller without `costs:read`.
 *
 * @throws AccessDeniedError, with no scope, as `updateCostLine`.
 * @throws VersionConflictError for a stale `version` of the line.
 * @throws RecordWriteError when the database refuses a write.
 */
export async function removeCostLine(
  tx: Tx,
  ctx: CostContext,
  id: string,
  version: number,
): Promise<CostLineView> {
  const found = await findCostLine(tx, id);
  if (!found) throw new AccessDeniedError(COSTS_EDIT_PERMISSION);
  const scope = scopeOf(found);
  await requireOnRecord(tx, ctx, scope, COSTS_EDIT_PERMISSION);
  const removed = await tx.transaction(async (inner) => {
    const write = writeContext(ctx);
    // The line first, so a stale `version` is refused before any tag is touched.
    const line = await softDeleteRecord(inner, costLine, id, version, write);
    for (const tag of await liveSchemesOf(inner, [id])) {
      await softDeleteRecord(inner, costLineScheme, tag.id, tag.version, write);
    }
    return line;
  });
  const canRead = await hasScopedPermission(
    tx,
    ctx.userId,
    scope,
    COSTS_READ_PERMISSION,
  );
  return lineView(removed, canRead);
}

/**
 * Reads one cost line with its live scheme tags. Needs `costs:read` on its
 * project; that permission is what shows amounts and payees.
 *
 * @throws AccessDeniedError, with no scope, as `updateCostLine`.
 */
export async function getCostLine(
  tx: Tx,
  ctx: CostContext,
  id: string,
): Promise<CostLineWithSchemes> {
  const found = await findCostLine(tx, id);
  if (!found) throw new AccessDeniedError(COSTS_READ_PERMISSION);
  await requireOnRecord(tx, ctx, scopeOf(found), COSTS_READ_PERMISSION);
  return (await withSchemes(tx, [found]))[0]!;
}

/**
 * Lists the live cost lines of one project, oldest first, each with its live
 * scheme tags. Needs `costs:read` on the project. See `CostLineFilter` for the
 * ways to narrow the list.
 *
 * @throws AccessDeniedError, naming the project, because the caller supplied it.
 */
export async function listCostLines(
  tx: Tx,
  ctx: CostContext,
  filter: CostLineFilter,
): Promise<CostLineWithSchemes[]> {
  const scope = {
    organisationId: filter.organisationId,
    projectId: filter.projectId,
  };
  await requireInProject(tx, ctx, scope, COSTS_READ_PERMISSION);
  const tagConditions: (SQL | undefined)[] = [
    eq(costLineScheme.costLineId, costLine.id),
    isNull(costLineScheme.deletedAt),
    filter.schemeKey !== undefined
      ? eq(costLineScheme.schemeKey, filter.schemeKey)
      : undefined,
    filter.schemeStatus !== undefined
      ? eq(costLineScheme.status, filter.schemeStatus)
      : undefined,
  ];
  const conditions: (SQL | undefined)[] = [
    eq(costLine.organisationId, scope.organisationId),
    eq(costLine.projectId, scope.projectId),
    isNull(costLine.deletedAt),
    filter.stage !== undefined ? eq(costLine.stage, filter.stage) : undefined,
    filter.accountId !== undefined
      ? eq(costLine.accountId, filter.accountId)
      : undefined,
    filter.productionPhase !== undefined
      ? eq(costLine.productionPhase, filter.productionPhase)
      : undefined,
    filter.territory !== undefined
      ? eq(costLine.territory, filter.territory)
      : undefined,
    filter.unitId !== undefined
      ? eq(costLine.unitId, filter.unitId)
      : undefined,
    filter.episodeId !== undefined
      ? eq(costLine.episodeId, filter.episodeId)
      : undefined,
    filter.schemeKey !== undefined || filter.schemeStatus !== undefined
      ? exists(
          tx
            .select({ one: sql`1` })
            .from(costLineScheme)
            .where(and(...tagConditions)),
        )
      : undefined,
  ];
  const rows = await tx
    .select()
    .from(costLine)
    .where(and(...conditions))
    .orderBy(asc(costLine.createdAt), asc(costLine.id));
  return withSchemes(tx, rows);
}

/**
 * Tags a cost line for one scheme: creates the live tag for `schemeKey`, or
 * replaces the one it has, so `qualifyingAmount` and `reason` left out end up
 * empty. `decided_by` is the acting user and `decided_at` the context's clock.
 * Needs `costs:tag-schemes` on the line's project. Setting a `qualifyingAmount`
 * needs `costs:read` as well, and the status must be `qualifying`; the amount
 * must have the sign of the line's `amountProjectCurrency` (or be zero) and no
 * larger a magnitude, compared by the database. The result hides
 * `qualifyingAmount` from a caller without `costs:read`.
 *
 * @throws AccessDeniedError, with no scope, for a cost line that is unknown,
 * removed or forbidden, and for a `qualifyingAmount` without `costs:read`.
 * @throws CostLineInputError for an amount that is not a decimal, one with a
 * status other than `qualifying`, or one outside the line's amount.
 * @throws RecordWriteError when the database refuses a value, for example a
 * scheme key that is not lower case, digits, dots and hyphens, or an unknown
 * status.
 */
export async function setCostLineScheme(
  tx: Tx,
  ctx: CostContext,
  costLineId: string,
  schemeKey: string,
  decision: CostLineSchemeDecision,
): Promise<CostLineSchemeView> {
  const line = await findCostLine(tx, costLineId);
  if (!line) throw new AccessDeniedError(COSTS_TAG_SCHEMES_PERMISSION);
  const scope = scopeOf(line);
  await requireOnRecord(tx, ctx, scope, COSTS_TAG_SCHEMES_PERMISSION);
  let qualifyingAmount: string | null = null;
  if (decision.qualifyingAmount != null) {
    // The amount is compared with the line's own, so without `costs:read` the
    // refusals would answer "is it larger than X?".
    await requireOnRecord(tx, ctx, scope, COSTS_READ_PERMISSION);
    checkAmount(decision.qualifyingAmount);
    if (decision.status !== 'qualifying') {
      throw new CostLineInputError(
        'Only a qualifying tag can have a qualifying amount',
      );
    }
    const compared = await compareQualifying(
      tx,
      decision.qualifyingAmount,
      line.amountProjectCurrency,
    );
    if (!compared.ok) {
      throw new CostLineInputError(
        'The qualifying amount must have the sign of the line’s amount and be no larger in absolute value',
      );
    }
    qualifyingAmount = compared.canonical;
  }
  const write = writeContext(ctx);
  const decided = {
    status: decision.status,
    qualifyingAmount,
    reason: decision.reason ?? null,
    decidedBy: ctx.userId,
    decidedAt: ctx.clock(),
  };
  const [existing] = await tx
    .select()
    .from(costLineScheme)
    .where(
      and(
        eq(costLineScheme.costLineId, costLineId),
        eq(costLineScheme.schemeKey, schemeKey),
        isNull(costLineScheme.deletedAt),
      ),
    )
    .limit(1);
  const tag = existing
    ? await updateRecord(
        tx,
        costLineScheme,
        existing.id,
        existing.version,
        decided,
        write,
      )
    : await insertRecord(
        tx,
        costLineScheme,
        {
          organisationId: line.organisationId,
          ownerOrgId: line.ownerOrgId,
          costLineId,
          schemeKey,
          ...decided,
        },
        write,
      );
  const canRead = await hasScopedPermission(
    tx,
    ctx.userId,
    scope,
    COSTS_READ_PERMISSION,
  );
  return schemeView(tag, canRead);
}

/**
 * Removes the live tag a cost line has for a scheme, by soft delete. Needs
 * `costs:tag-schemes` on the line's project. The key is free afterwards. The
 * result hides `qualifyingAmount` from a caller without `costs:read`.
 *
 * @throws AccessDeniedError, with no scope, for a cost line that is unknown,
 * removed or forbidden.
 * @throws CostLineInputError when the line has no live tag for the key; it is
 * thrown only after the permission check, so it tells nothing to a caller who
 * may not tag the line.
 * @throws VersionConflictError for a stale `version` of the tag.
 */
export async function removeCostLineScheme(
  tx: Tx,
  ctx: CostContext,
  costLineId: string,
  schemeKey: string,
  version: number,
): Promise<CostLineSchemeView> {
  const line = await findCostLine(tx, costLineId);
  if (!line) throw new AccessDeniedError(COSTS_TAG_SCHEMES_PERMISSION);
  const scope = scopeOf(line);
  await requireOnRecord(tx, ctx, scope, COSTS_TAG_SCHEMES_PERMISSION);
  const [tag] = await tx
    .select()
    .from(costLineScheme)
    .where(
      and(
        eq(costLineScheme.costLineId, costLineId),
        eq(costLineScheme.schemeKey, schemeKey),
        isNull(costLineScheme.deletedAt),
      ),
    )
    .limit(1);
  if (!tag) {
    throw new CostLineInputError(
      'The cost line has no live tag for that scheme',
    );
  }
  const removed = await softDeleteRecord(
    tx,
    costLineScheme,
    tag.id,
    version,
    writeContext(ctx),
  );
  const canRead = await hasScopedPermission(
    tx,
    ctx.userId,
    scope,
    COSTS_READ_PERMISSION,
  );
  return schemeView(removed, canRead);
}
