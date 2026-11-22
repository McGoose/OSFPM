import {
  and,
  eq,
  getTableColumns,
  getTableName,
  isNull,
  sql,
} from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { ActorType } from './columns.js';
import type { SchemaDb } from './client.js';
import { newId } from './ids.js';
import { parentKeysOf, resolveProjectId } from './project-resolver.js';
import {
  auditEvent,
  changeEvent,
  changeSeq,
  organisation,
} from './schema/index.js';
import type { ChangeAction } from './schema/index.js';
import { sensitiveColumns } from './sensitive.js';

/**
 * The only way to write tenant records (CLAUDE.md, Data rules). Every call, in
 * the caller's transaction, writes the row, bumps `version`, checks for
 * conflicts, takes the next `change_seq` number and inserts exactly one
 * `change_event`. The one exception is an update that changes no field: it
 * checks the version, then writes nothing (see `updateRecord`). The helper
 * checks no permission: the calling service must have done that first.
 *
 * Pass the transaction handle, not the bare database: the row and its event
 * must commit or roll back together. Each call also runs in a savepoint, so a
 * failed call leaves no row, no event and no used `seq`, even if the caller
 * catches the error and carries on.
 *
 * A `token` or `email` context without `onBehalfOfUserId` throws
 * `MissingActingUserError` before anything is written.
 *
 * Deleting a deleted record, or restoring one that is not deleted, throws
 * `RecordStateError` and writes nothing. The version is checked first, so a
 * stale `expectedVersion` throws `VersionConflictError` instead.
 *
 * Event content: `create` stores the whole row in `after`; `update`, `delete`
 * and `restore` store only the changed fields in `before` and `after`. Values
 * of sensitive columns (see `markSensitive`) are never stored; their names stay
 * in `changed_fields`. Errors never carry row values.
 */

/** Actors that act for a user: a token for its owner, an email for its approver. */
type ActorForUser = 'token' | 'email';

type ContextBase = {
  readonly requestId?: string | null;
  /** The server doing the write. */
  readonly originServer: string;
  readonly clock: () => Date;
};

/**
 * Who is writing. `actor` is who really made the change and is logged as is on
 * every `change_event`.
 *
 * `onBehalfOfUserId` is the user a `token` or `email` write is made for: the
 * token's owner, or the user who approved the email draft. It fills
 * `created_by`, `updated_by` and `deleted_by`, which reference `user`, and the
 * type requires it for those two actor types and forbids it for the others:
 * for `user` the actor is the user, for `system` and `federation` there is no
 * user, so those columns are the actor's user or NULL.
 */
export type WriteContext = ContextBase &
  (
    | {
        readonly actor: {
          readonly type: ActorForUser;
          readonly id: string | null;
        };
        readonly onBehalfOfUserId: string;
      }
    | {
        readonly actor: {
          readonly type: Exclude<ActorType, ActorForUser>;
          readonly id: string | null;
        };
        readonly onBehalfOfUserId?: never;
      }
  );

/** A transaction handle. Typed as the shared database base so both drivers fit. */
export type Tx = SchemaDb;

/** The standard columns the helper relies on. */
type TenantTable = PgTable & {
  id: AnyPgColumn;
  organisationId: AnyPgColumn;
  version: AnyPgColumn;
};

/** Columns the helper sets itself. Callers cannot pass them. */
type ManagedKeys =
  | 'version'
  | 'createdAt'
  | 'updatedAt'
  | 'createdBy'
  | 'updatedBy'
  | 'deletedAt'
  | 'deletedBy';

/** Columns that cannot change after creation. */
const IMMUTABLE_KEYS = [
  'id',
  'organisationId',
  'projectId',
  'originServer',
] as const;

/**
 * What `insertRecord` accepts: the table's insert columns minus the ones the
 * helper sets (`version`, timestamps, the `*_by` columns). `originServer` is
 * optional and defaults to the context's server.
 */
export type InsertValues<T extends TenantTable> = Omit<
  T['$inferInsert'],
  ManagedKeys | 'originServer'
> & { originServer?: string };

/**
 * What `updateRecord` accepts: any column except the helper-managed and
 * immutable ones. A column the table's project resolver reads is also refused,
 * but only at run time (see `registerProjectResolver`).
 */
export type UpdatePatch<T extends TenantTable> = Partial<
  Omit<T['$inferInsert'], ManagedKeys | (typeof IMMUTABLE_KEYS)[number]>
>;

/**
 * `expectedVersion` did not match the stored version, so nothing was written.
 * Carries the ids and the two versions, never row values.
 */
export class VersionConflictError extends Error {
  constructor(
    readonly entityType: string,
    readonly entityId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `Version conflict on ${entityType} ${entityId}: expected ${expectedVersion}, found ${actualVersion}`,
    );
    this.name = 'VersionConflictError';
  }
}

/** No record with this id exists. Thrown by update, delete and restore. */
export class RecordNotFoundError extends Error {
  constructor(
    readonly entityType: string,
    readonly entityId: string,
  ) {
    super(`No ${entityType} with id ${entityId}`);
    this.name = 'RecordNotFoundError';
  }
}

/**
 * The record is in the wrong state for this operation: it was already deleted,
 * it is not deleted so there is nothing to restore, or (for records that are
 * released rather than deleted, such as legal holds) it was already released.
 * Nothing was written.
 */
export class RecordStateError extends Error {
  constructor(
    readonly entityType: string,
    readonly entityId: string,
    readonly operation: 'delete' | 'restore' | 'release',
  ) {
    super(
      operation === 'delete'
        ? `Cannot delete ${entityType} ${entityId}: it is already deleted`
        : operation === 'release'
          ? `Cannot release ${entityType} ${entityId}: it is already released`
          : `Cannot restore ${entityType} ${entityId}: it is not deleted`,
    );
    this.name = 'RecordStateError';
  }
}

/**
 * A `token` or `email` write came without `onBehalfOfUserId`. The type forbids
 * this, so it only happens when a caller bypasses the types. Nothing was
 * written.
 */
export class MissingActingUserError extends Error {
  constructor(readonly actorType: ActorType) {
    super(`A ${actorType} write needs onBehalfOfUserId`);
    this.name = 'MissingActingUserError';
  }
}

/**
 * A database error with the values stripped. Drivers and Drizzle put query
 * parameters and offending values in messages and `detail`, so the original
 * error is not kept; only the SQLSTATE and constraint name survive (CLAUDE.md,
 * Data rules: sensitive values never appear in error messages). Every database
 * failure inside a write call is turned into this.
 */
export class RecordWriteError extends Error {
  constructor(
    readonly entityType: string,
    readonly operation: string,
    readonly code: string | undefined,
    readonly constraint: string | undefined,
  ) {
    super(
      `Write failed: ${operation} on ${entityType}` +
        (code ? ` (SQLSTATE ${code}` : '') +
        (code && constraint ? `, constraint ${constraint}` : '') +
        (code ? ')' : ''),
    );
    this.name = 'RecordWriteError';
  }
}

type Row = Record<string, unknown>;
type Snapshot = Record<string, unknown>;

function driverError(error: unknown) {
  let current: unknown = error;
  while (current && typeof current === 'object') {
    const candidate = current as { code?: unknown; constraint?: unknown };
    if (typeof candidate.code === 'string') {
      return {
        code: candidate.code,
        constraint:
          typeof candidate.constraint === 'string'
            ? candidate.constraint
            : undefined,
      };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

// Typed errors pass through. Everything else becomes a value-free
// `RecordWriteError`, because driver errors can carry the values written.
async function guarded<R>(
  table: PgTable,
  operation: string,
  action: () => Promise<R>,
): Promise<R> {
  try {
    return await action();
  } catch (error) {
    if (
      error instanceof VersionConflictError ||
      error instanceof RecordNotFoundError ||
      error instanceof RecordStateError ||
      error instanceof MissingActingUserError ||
      error instanceof RecordWriteError
    ) {
      throw error;
    }
    const found = driverError(error);
    throw new RecordWriteError(
      getTableName(table),
      operation,
      found?.code,
      found?.constraint,
    );
  }
}

/** Takes the next number. Holds the counter row until the transaction ends. */
async function nextSeq(
  tx: Tx,
  organisationId: string,
  projectId: string | null,
): Promise<number> {
  const [row] = await tx
    .insert(changeSeq)
    .values({ organisationId, projectId, lastSeq: 1 })
    .onConflictDoUpdate({
      target: [changeSeq.organisationId, changeSeq.projectId],
      set: { lastSeq: sql`change_seq.last_seq + 1` },
    })
    .returning({ lastSeq: changeSeq.lastSeq });
  return row!.lastSeq;
}

/**
 * Takes one change counter row, `projectId` null being the organisation's own,
 * and keeps it until the transaction ends. The one place the lock is taken, so
 * the two public functions below cannot drift apart. It numbers nothing: only
 * `nextSeq` does.
 */
async function lockCounter(
  tx: Tx,
  organisationId: string,
  projectId: string | null,
): Promise<void> {
  await tx
    .select({ lastSeq: changeSeq.lastSeq })
    .from(changeSeq)
    .where(
      and(
        eq(changeSeq.organisationId, organisationId),
        projectId === null
          ? isNull(changeSeq.projectId)
          : eq(changeSeq.projectId, projectId),
      ),
    )
    .for('update');
}

/**
 * Takes the change counter of a project, and keeps it until the transaction
 * ends. Every write through this helper takes that counter before it locks the
 * record it changes (see the comment in `modifyRecord`), so all writers in a
 * project queue on it in the same order. A service that locks a record of the
 * project first and writes afterwards goes in the opposite order, and can
 * deadlock with a writer that goes through the helper: each waits for the lock
 * the other holds. So a service that reads something and then writes on the
 * strength of it, such as a guard that no live cost line points at an account,
 * or a price in the project's currency, calls this first, and takes any record
 * lock (`FOR UPDATE`, `FOR SHARE`) only after it. For a record that belongs to
 * the organisation and not to a project, take `lockOrganisationChanges` instead.
 *
 * Takes the counter row if there is one. A project made through the helper has
 * one from the start; one made by direct inserts, which only tests do, has none
 * until its first write, and then nothing is locked. Checks no permission, and
 * is for services that have already checked it: a caller who holds the counter
 * holds up every writer in the project.
 */
export async function lockProjectChanges(
  tx: Tx,
  organisationId: string,
  projectId: string,
): Promise<void> {
  await lockCounter(tx, organisationId, projectId);
}

/**
 * Takes the change counter of an organisation, the one its organisation-level
 * records are numbered in (`project_id` NULL), and keeps it until the transaction
 * ends. It is `lockProjectChanges` for a record that belongs to the organisation
 * and to no project, such as a membership or a role: every write of such a record
 * through this helper takes that counter before it locks the record, so a service
 * that must lock a row first and write after calls this first, and takes the row
 * lock only after it (CLAUDE.md, Data rules: counter before any row lock). It is
 * a function of its own, not a project id of `null`, because a null that changes
 * what a call means is easy to pass by mistake.
 *
 * The organisation's counter is not a project's: a project's writers do not queue
 * on it, and it does not queue on theirs. Takes the counter row if there is one.
 * An organisation made through the helper has one from the start; one made by
 * direct inserts, which only tests do, has none until its first write, and then
 * nothing is locked. Numbers nothing and writes nothing. Checks no permission,
 * and is for services that have already checked it: a caller who holds the
 * counter holds up every writer of an organisation-level record.
 */
export async function lockOrganisationChanges(
  tx: Tx,
  organisationId: string,
): Promise<void> {
  await lockCounter(tx, organisationId, null);
}

/**
 * Database-column-name view of `row`, limited to `keys`, without sensitive
 * values. This is the one place values are kept out of change events.
 */
function redact(table: PgTable, row: Row, keys?: readonly string[]): Snapshot {
  const sensitive = sensitiveColumns(table);
  const out: Snapshot = {};
  for (const [key, column] of Object.entries(getTableColumns(table))) {
    if (keys && !keys.includes(key)) continue;
    if (sensitive.has(column.name)) continue;
    out[column.name] = row[key] ?? null;
  }
  return out;
}

function columnName(table: PgTable, key: string): string {
  return getTableColumns(table)[key]!.name;
}

// JSON with each object's keys sorted: PostgreSQL returns jsonb keys in its own
// order, so a value a caller wrote in another order is still the same value.
// Array order still counts.
function canonicalJson(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, inner: unknown) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : inner,
  );
}

// Compared as JSON so dates and arrays match by value, and null and undefined
// count as the same.
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

async function logChange(
  tx: Tx,
  table: PgTable,
  ctx: WriteContext,
  event: {
    seq: number;
    projectId: string | null;
    row: Row;
    action: ChangeAction;
    changedKeys: readonly string[];
    before: Row | null;
  },
) {
  const { row, changedKeys } = event;
  await tx.insert(changeEvent).values({
    organisationId: row.organisationId as string,
    projectId: event.projectId,
    seq: event.seq,
    entityType: getTableName(table),
    entityId: row.id as string,
    action: event.action,
    changedFields: changedKeys.map((key) => columnName(table, key)),
    before: event.before ? redact(table, event.before, changedKeys) : null,
    after: redact(table, row, changedKeys),
    entityVersion: row.version as number,
    actorType: ctx.actor.type,
    actorId: ctx.actor.id,
    requestId: ctx.requestId ?? null,
    originServer: ctx.originServer,
    occurredAt: ctx.clock(),
  });
}

/**
 * The user for `created_by` and the like, which reference `user`. A `user`
 * actor is that user; a `token` or `email` actor is covered by whoever it acts
 * on behalf of; `system` and `federation` have no user. The event keeps the
 * exact actor either way.
 */
function attributedUserId(ctx: WriteContext): string | null {
  switch (ctx.actor.type) {
    case 'user':
      return ctx.actor.id;
    case 'token':
    case 'email':
      if (!ctx.onBehalfOfUserId)
        throw new MissingActingUserError(ctx.actor.type);
      return ctx.onBehalfOfUserId;
    case 'system':
    case 'federation':
      return null;
  }
}

async function loadRow(tx: Tx, table: TenantTable, id: string): Promise<Row> {
  const [row] = await tx.select().from(table).where(eq(table.id, id)).limit(1);
  if (!row) throw new RecordNotFoundError(getTableName(table), id);
  return row;
}

/**
 * Inserts a record and logs a `create` event with the whole row in `after`
 * (sensitive values left out). Called by server-side services only, with the
 * transaction handle.
 *
 * It serves four kinds of table: organisation-level records, project-level
 * records, the project table itself and the organisation table itself. For the
 * last two the change counter is taken after the row, because it references the
 * row: a new project gets seq 1 in its own sequence, and a new organisation seq 1
 * in its own (`project_id` NULL). Every other table takes the counter first.
 *
 * @throws MissingActingUserError for a `token` or `email` context without
 * `onBehalfOfUserId`.
 * @throws RecordWriteError when the database refuses the row; it carries the
 * SQLSTATE and constraint name, never values.
 */
export function insertRecord<T extends TenantTable>(
  tx: Tx,
  table: T,
  values: InsertValues<T>,
  ctx: WriteContext,
): Promise<T['$inferSelect']> {
  return guarded(table, 'insert', () =>
    // A savepoint: a failed insert leaves no row, event or used `seq`.
    tx.transaction(async (inner) => {
      attributedUserId(ctx); // refuses a missing acting user before any write
      const now = ctx.clock();
      const full = {
        ...values,
        id: (values as Row).id ?? newId(),
        originServer:
          (values as { originServer?: string }).originServer ??
          ctx.originServer,
        version: 1,
        createdAt: now,
        updatedAt: now,
        createdBy: attributedUserId(ctx),
        updatedBy: attributedUserId(ctx),
        deletedAt: null,
        deletedBy: null,
      } as Row;
      const projectId = await resolveProjectId(inner, table, full);
      // A new project is its own project, and a new organisation is its own
      // tenant with a sequence of its own (`project_id` NULL). `change_seq`
      // references both, so their counter can only be taken once the row exists.
      // Nothing else writes to a project or an organisation that is not
      // committed yet, because no one else can see it, let alone reference it, so
      // the order does not matter for locking: no writer can be waiting on the
      // counter, and the lock order (counter before any row lock, see
      // `lockProjectChanges`) is kept by every writer of a record that exists.
      // An organisation has no project resolver, so nothing is queried or locked
      // before its row is inserted. The insert itself takes only the shared key
      // locks its foreign keys take (on the user and the retention class), which
      // no writer takes exclusively.
      const ownsSequence =
        (projectId !== null && projectId === full.id) ||
        (table as PgTable) === organisation;
      let seq = ownsSequence
        ? 0
        : await nextSeq(inner, full.organisationId as string, projectId);
      const [row] = await inner
        .insert(table)
        .values(full as never)
        .returning();
      if (ownsSequence) {
        seq = await nextSeq(inner, full.organisationId as string, projectId);
      }
      await logChange(inner, table, ctx, {
        seq,
        projectId,
        row: row as Row,
        action: 'create',
        changedKeys: Object.keys(getTableColumns(table)),
        before: null,
      });
      return row as T['$inferSelect'];
    }),
  );
}

/**
 * Shared by update, soft delete and restore: checks the version, takes the
 * sequence number, applies `change` and logs the event. An update whose
 * `change` alters no field returns the current row after the version check and
 * does none of the rest.
 */
function modifyRecord<T extends TenantTable>(
  tx: Tx,
  table: T,
  id: string,
  expectedVersion: number,
  action: Exclude<ChangeAction, 'create'>,
  change: Row,
  ctx: WriteContext,
): Promise<T['$inferSelect']> {
  return guarded(table, action, () =>
    // A savepoint, as in `insertRecord`.
    tx.transaction(async (inner) => {
      attributedUserId(ctx); // refuses a missing acting user before any write
      const before = await loadRow(inner, table, id);
      const entityType = getTableName(table);
      const actual = before.version as number;
      if (actual !== expectedVersion) {
        throw new VersionConflictError(entityType, id, expectedVersion, actual);
      }
      // Checked before the counter is touched, so a refused call uses no seq.
      if (action === 'delete' && before.deletedAt != null) {
        throw new RecordStateError(entityType, id, 'delete');
      }
      if (action === 'restore' && before.deletedAt == null) {
        throw new RecordStateError(entityType, id, 'restore');
      }
      const changedKeys = Object.keys(change).filter(
        (key) => !same(before[key], change[key]),
      );
      // An update that changes nothing writes nothing: no new version, no
      // sequence number, no event. It comes after the version check, so a stale
      // caller still learns it is stale. Only updates qualify: delete and
      // restore always change `deleted_at`.
      if (action === 'update' && changedKeys.length === 0) {
        return before;
      }
      // Seq is taken before the row is locked, so every writer in a project
      // queues on the counter first and multi-record transactions cannot
      // deadlock on each other's rows.
      // The project is resolved once, from the stored row, and used for both
      // the counter and the event so the two always agree.
      const projectId = await resolveProjectId(inner, table, before);
      const seq = await nextSeq(
        inner,
        before.organisationId as string,
        projectId,
      );
      const now = ctx.clock();
      const updated = (await inner
        .update(table)
        .set({
          ...change,
          version: sql`${table.version} + 1`,
          updatedAt: now,
          updatedBy: attributedUserId(ctx),
        } as never)
        .where(and(eq(table.id, id), eq(table.version, expectedVersion)))
        .returning()) as Row[];
      const row = updated[0];
      if (!row) {
        // Another writer got in between the read and the update.
        const current = await loadRow(inner, table, id);
        throw new VersionConflictError(
          entityType,
          id,
          expectedVersion,
          current.version as number,
        );
      }
      await logChange(inner, table, ctx, {
        seq,
        projectId,
        row,
        action,
        changedKeys,
        before,
      });
      return row;
    }),
  );
}

/** Validates `patch` and returns it without undefined values. */
function checkedPatch<T extends TenantTable>(
  table: T,
  patch: UpdatePatch<T>,
): Row {
  const change: Row = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if ((IMMUTABLE_KEYS as readonly string[]).includes(key)) {
      throw new Error(`${key} cannot be changed on ${getTableName(table)}`);
    }
    if (parentKeysOf(table).includes(key)) {
      throw new Error(
        `${key} cannot be changed on ${getTableName(table)}: delete the record and create a new one`,
      );
    }
    // Own keys only: `in` also finds the names every object inherits, such as
    // `constructor` and `toString`, and a patch comes from the caller.
    if (!Object.hasOwn(getTableColumns(table), key)) {
      throw new Error(`Unknown column ${key} on ${getTableName(table)}`);
    }
    change[key] = value;
  }
  return change;
}

/**
 * Updates fields of a record and logs an `update` event naming only the fields
 * that changed. The version is checked first, so a stale `expectedVersion`
 * throws even when the patch matches the stored values. When no field would
 * change, nothing is written: no new version, no new `updated_at`, no sequence
 * number, no event, and the current record is returned. Undefined values are
 * skipped.
 *
 * @throws Error for an immutable column, one the project resolver reads, or an
 * unknown column (nothing is written).
 * @throws VersionConflictError, RecordNotFoundError, MissingActingUserError,
 * RecordWriteError as for the other writes.
 */
export async function updateRecord<T extends TenantTable>(
  tx: Tx,
  table: T,
  id: string,
  expectedVersion: number,
  patch: UpdatePatch<T>,
  ctx: WriteContext,
): Promise<T['$inferSelect']> {
  return modifyRecord(
    tx,
    table,
    id,
    expectedVersion,
    'update',
    checkedPatch(table, patch),
    ctx,
  );
}

/**
 * Marks a record deleted and logs a `delete` event. `alsoSet` changes other
 * fields in the same write, for example to erase values a table must not keep
 * on a deleted row. It follows the rules of an update patch.
 *
 * @throws RecordStateError when the record is already deleted.
 * @throws VersionConflictError, RecordNotFoundError, MissingActingUserError,
 * RecordWriteError, and the `Error` of a refused `alsoSet`, as `updateRecord`.
 */
export async function softDeleteRecord<T extends TenantTable>(
  tx: Tx,
  table: T,
  id: string,
  expectedVersion: number,
  ctx: WriteContext,
  alsoSet: UpdatePatch<T> = {},
): Promise<T['$inferSelect']> {
  return modifyRecord(
    tx,
    table,
    id,
    expectedVersion,
    'delete',
    {
      ...checkedPatch(table, alsoSet),
      deletedAt: ctx.clock(),
      deletedBy: attributedUserId(ctx),
    },
    ctx,
  );
}

/**
 * Clears the deletion mark and logs a `restore` event. `alsoSet` changes other
 * fields in the same write, for example to refill values erased on delete.
 *
 * @throws RecordStateError when the record is not deleted.
 * @throws The same errors as `softDeleteRecord`.
 */
export async function restoreRecord<T extends TenantTable>(
  tx: Tx,
  table: T,
  id: string,
  expectedVersion: number,
  ctx: WriteContext,
  alsoSet: UpdatePatch<T> = {},
): Promise<T['$inferSelect']> {
  return modifyRecord(
    tx,
    table,
    id,
    expectedVersion,
    'restore',
    { ...checkedPatch(table, alsoSet), deletedAt: null, deletedBy: null },
    ctx,
  );
}

/** Input of `recordAudit`. Required: `category`, `action` and `actor`. */
export type AuditInput = {
  readonly organisationId?: string | null;
  readonly projectId?: string | null;
  readonly category: string;
  readonly action: string;
  readonly actor: { readonly type: ActorType; readonly id: string | null };
  readonly targetType?: string | null;
  readonly targetId?: string | null;
  /** Never put sensitive values here. */
  readonly details?: Record<string, unknown> | null;
  readonly ipAddress?: string | null;
  readonly requestId?: string | null;
  /** Defaults to now. */
  readonly occurredAt?: Date;
};

/**
 * Inserts one `audit_event` in the caller's transaction, with no savepoint of
 * its own. Services call it before they throw a typed access error, and the
 * caller commits, so the denial is kept (CLAUDE.md, Data rules). Checks no
 * permission and never inspects `details`: callers keep sensitive values out.
 *
 * @throws RecordWriteError when the database refuses the row.
 */
export function recordAudit(tx: Tx, event: AuditInput) {
  return guarded(auditEvent, 'insert', () => insertAudit(tx, event));
}

async function insertAudit(tx: Tx, event: AuditInput) {
  const [row] = await tx
    .insert(auditEvent)
    .values({
      organisationId: event.organisationId ?? null,
      projectId: event.projectId ?? null,
      category: event.category,
      action: event.action,
      actorType: event.actor.type,
      actorId: event.actor.id,
      targetType: event.targetType ?? null,
      targetId: event.targetId ?? null,
      details: event.details ?? null,
      ipAddress: event.ipAddress ?? null,
      requestId: event.requestId ?? null,
      occurredAt: event.occurredAt ?? new Date(),
    })
    .returning();
  return row!;
}
