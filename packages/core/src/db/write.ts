import { and, eq, getTableColumns, getTableName, sql } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { ActorType } from './columns.js';
import type { SchemaDb } from './client.js';
import { newId } from './ids.js';
import { parentKeysOf, resolveProjectId } from './project-resolver.js';
import { auditEvent, changeEvent, changeSeq } from './schema/index.js';
import type { ChangeAction } from './schema/index.js';
import { sensitiveColumns } from './sensitive.js';

/**
 * The only way to write tenant records. Every call, in the caller's
 * transaction, writes the row, bumps `version`, checks for conflicts, takes the
 * next `change_seq` number and inserts exactly one `change_event`.
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

export type InsertValues<T extends TenantTable> = Omit<
  T['$inferInsert'],
  ManagedKeys | 'originServer'
> & { originServer?: string };

export type UpdatePatch<T extends TenantTable> = Partial<
  Omit<T['$inferInsert'], ManagedKeys | (typeof IMMUTABLE_KEYS)[number]>
>;

/** `expectedVersion` did not match the stored version, so nothing was written. */
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

/** No record with this id exists. */
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
 * or it is not deleted so there is nothing to restore. Nothing was written.
 */
export class RecordStateError extends Error {
  constructor(
    readonly entityType: string,
    readonly entityId: string,
    readonly operation: 'delete' | 'restore',
  ) {
    super(
      operation === 'delete'
        ? `Cannot delete ${entityType} ${entityId}: it is already deleted`
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
 * error is not kept; only the SQLSTATE and constraint name survive.
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

/** Database-column-name view of `row`, limited to `keys`, without sensitive values. */
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

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

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

/** Inserts a record and logs a `create` event. */
export function insertRecord<T extends TenantTable>(
  tx: Tx,
  table: T,
  values: InsertValues<T>,
  ctx: WriteContext,
): Promise<T['$inferSelect']> {
  return guarded(table, 'insert', () =>
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
      // A new project is its own project, and `change_seq` references it, so
      // its counter can only be taken once the row exists. Nothing else
      // writes to a project that is not committed yet, so the order does not
      // matter for locking.
      const ownsSequence = projectId !== null && projectId === full.id;
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
 * sequence number, applies `change` and logs the event.
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
    if (!(key in getTableColumns(table))) {
      throw new Error(`Unknown column ${key} on ${getTableName(table)}`);
    }
    change[key] = value;
  }
  return change;
}

/** Updates fields of a record and logs an `update` event. */
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

/** Inserts one `audit_event`. */
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
