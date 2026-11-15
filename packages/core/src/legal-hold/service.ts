import { and, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import { hasOrganisationPermission } from '../access/organisation-permission.js';
import { hasProjectPermission } from '../access/project-permission.js';
import { legalHold } from '../db/schema/index.js';
import {
  insertRecord,
  recordAudit,
  RecordStateError,
  updateRecord,
  type Tx,
  type WriteContext,
} from '../db/write.js';
import { LEGAL_HOLD_MANAGE_PERMISSION } from './permissions.js';

/**
 * Legal holds: while a hold is unreleased, the records it covers must not be
 * purged or erased. This module places, releases and checks holds. Nothing
 * here purges or erases anything, and nothing calls `isUnderLegalHold` yet.
 *
 * Permission: `legal-hold:manage`. A hold with a project is checked on that
 * project (`hasProjectPermission`); a hold without one, that is a
 * whole-organisation hold or a record hold with no project, is checked in the
 * organisation (`hasOrganisationPermission`).
 *
 * Audit: place and release each write one `audit_event` in the same savepoint
 * as the hold row and its change event, so the three succeed or fail together.
 * A denial writes one `legal-hold.denied` event and then throws. It is written
 * outside that savepoint, so a caller that catches the error inside the
 * transaction and commits keeps it.
 *
 * Reasons are free text. Audit events never copy them, and callers must not put
 * sensitive values in them.
 */

export type LegalHoldContext = {
  /** The user acting. */
  readonly userId: string;
  readonly requestId?: string | null;
  /** The server doing the work. */
  readonly originServer: string;
  readonly clock: () => Date;
};

export type PlaceLegalHoldValues = {
  readonly organisationId: string;
  /** Leave out for a whole-organisation hold, or for a record hold with no project. */
  readonly projectId?: string | null;
  /** Table name of the held record. Set together with `entityId`. */
  readonly entityType?: string | null;
  readonly entityId?: string | null;
  readonly reason: string;
};

type Operation = 'place' | 'release';

/** The caller may not manage this hold. Carries no ids and no reasons. */
export class LegalHoldAccessDeniedError extends Error {
  constructor(readonly operation: Operation) {
    super(`Managing legal holds denied for ${operation}`);
    this.name = 'LegalHoldAccessDeniedError';
  }
}

/** A reason is missing, or a scope is half set. */
export class LegalHoldInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegalHoldInputError';
  }
}

function writeContext(ctx: LegalHoldContext): WriteContext {
  return {
    actor: { type: 'user', id: ctx.userId },
    originServer: ctx.originServer,
    clock: ctx.clock,
    requestId: ctx.requestId ?? null,
  };
}

function scopeOf(hold: {
  projectId: string | null;
  entityId: string | null;
}): 'organisation' | 'project' | 'record' {
  if (hold.entityId !== null) return 'record';
  return hold.projectId !== null ? 'project' : 'organisation';
}

function auditFor(
  ctx: LegalHoldContext,
  hold: {
    organisationId: string;
    projectId: string | null;
    entityType: string | null;
    entityId: string | null;
  },
) {
  return {
    actor: { type: 'user', id: ctx.userId } as const,
    organisationId: hold.organisationId,
    projectId: hold.projectId,
    targetType: 'legal_hold',
    requestId: ctx.requestId ?? null,
    occurredAt: ctx.clock(),
    // Scope only: no reason and no record id.
    details: { scope: scopeOf(hold), entityType: hold.entityType },
  };
}

async function mayManage(
  tx: Tx,
  ctx: LegalHoldContext,
  hold: { organisationId: string; projectId: string | null },
): Promise<boolean> {
  return hold.projectId !== null
    ? hasProjectPermission(
        tx,
        ctx.userId,
        hold.projectId,
        LEGAL_HOLD_MANAGE_PERMISSION,
      )
    : hasOrganisationPermission(
        tx,
        ctx.userId,
        hold.organisationId,
        LEGAL_HOLD_MANAGE_PERMISSION,
      );
}

function requireReason(reason: string, what: string): void {
  if (reason.trim() === '') {
    throw new LegalHoldInputError(`A ${what} is required`);
  }
}

/**
 * Places a hold. Throws `LegalHoldAccessDeniedError` (after auditing it) when
 * the user may not manage holds in that scope, `LegalHoldInputError` for an
 * empty reason or a half-set record, and `RecordWriteError` when the database
 * refuses the row, for example a project of another organisation.
 */
export async function placeLegalHold(
  tx: Tx,
  ctx: LegalHoldContext,
  values: PlaceLegalHoldValues,
) {
  requireReason(values.reason, 'reason');
  const entityType = values.entityType ?? null;
  const entityId = values.entityId ?? null;
  if ((entityType === null) !== (entityId === null)) {
    throw new LegalHoldInputError(
      'A record hold needs both an entity type and an entity id',
    );
  }
  const scope = {
    organisationId: values.organisationId,
    projectId: values.projectId ?? null,
    entityType,
    entityId,
  };
  if (!(await mayManage(tx, ctx, scope))) {
    await recordAudit(tx, {
      ...auditFor(ctx, scope),
      category: 'legal-hold.denied',
      action: 'place',
    });
    throw new LegalHoldAccessDeniedError('place');
  }
  return tx.transaction(async (inner) => {
    const now = ctx.clock();
    const hold = await insertRecord(
      inner,
      legalHold,
      {
        ...scope,
        ownerOrgId: values.organisationId,
        retentionClass: 'standard',
        reason: values.reason,
        placedAt: now,
      },
      writeContext(ctx),
    );
    await recordAudit(inner, {
      ...auditFor(ctx, hold),
      category: 'legal-hold.placed',
      action: 'place',
      targetId: hold.id,
    });
    return hold;
  });
}

/**
 * Releases a hold. Same permission rule as `placeLegalHold`, checked on the
 * hold's own scope. An unknown hold is refused like any other denial, so ids
 * cannot be probed. Releasing a released hold throws `RecordStateError` and
 * writes nothing.
 */
export async function releaseLegalHold(
  tx: Tx,
  ctx: LegalHoldContext,
  holdId: string,
  releaseReason: string,
) {
  requireReason(releaseReason, 'release reason');
  const [found] = await tx
    .select()
    .from(legalHold)
    .where(eq(legalHold.id, holdId))
    .limit(1);
  if (!found || !(await mayManage(tx, ctx, found))) {
    await recordAudit(tx, {
      ...(found
        ? { ...auditFor(ctx, found), targetId: holdId }
        : {
            actor: { type: 'user', id: ctx.userId } as const,
            targetType: 'legal_hold',
            requestId: ctx.requestId ?? null,
            occurredAt: ctx.clock(),
          }),
      category: 'legal-hold.denied',
      action: 'release',
    });
    throw new LegalHoldAccessDeniedError('release');
  }
  if (found.releasedAt !== null) {
    throw new RecordStateError('legal_hold', holdId, 'release');
  }
  return tx.transaction(async (inner) => {
    const now = ctx.clock();
    const released = await updateRecord(
      inner,
      legalHold,
      holdId,
      found.version,
      { releasedAt: now, releasedBy: ctx.userId, releaseReason },
      writeContext(ctx),
    );
    await recordAudit(inner, {
      ...auditFor(ctx, released),
      category: 'legal-hold.released',
      action: 'release',
      targetId: holdId,
    });
    return released;
  });
}

export type LegalHoldTarget = {
  readonly projectId?: string | null;
  /** Table name of the record. Set together with `entityId`. */
  readonly entityType?: string | null;
  readonly entityId?: string | null;
};

/**
 * True when any unreleased hold covers the organisation, the project or the
 * record. A whole-organisation hold covers everything in the organisation; a
 * project hold covers the project and what is in it, so pass `projectId` along
 * with the record; a record hold covers that record, with or without a
 * project. A record hold does not cover its project.
 */
export async function isUnderLegalHold(
  tx: Tx,
  organisationId: string,
  target: LegalHoldTarget = {},
): Promise<boolean> {
  const projectId = target.projectId ?? null;
  const entityType = target.entityType ?? null;
  const entityId = target.entityId ?? null;
  if ((entityType === null) !== (entityId === null)) {
    throw new LegalHoldInputError(
      'A record needs both an entity type and an entity id',
    );
  }
  const covers: SQL[] = [
    and(isNull(legalHold.projectId), isNull(legalHold.entityId)) as SQL,
  ];
  if (projectId !== null) {
    covers.push(
      and(
        eq(legalHold.projectId, projectId),
        isNull(legalHold.entityId),
      ) as SQL,
    );
  }
  if (entityType !== null && entityId !== null) {
    covers.push(
      and(
        eq(legalHold.entityType, entityType),
        eq(legalHold.entityId, entityId),
      ) as SQL,
    );
  }
  const [found] = await tx
    .select({ one: sql<number>`1` })
    .from(legalHold)
    .where(
      and(
        eq(legalHold.organisationId, organisationId),
        isNull(legalHold.releasedAt),
        or(...covers),
      ),
    )
    .limit(1);
  return found !== undefined;
}
