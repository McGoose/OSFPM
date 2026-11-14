import { and, desc, eq, isNull } from 'drizzle-orm';
import { hasProjectPermission } from '../access/project-permission.js';
import {
  person,
  personSensitive,
  projectPerson,
  type PersonSensitiveLegalBasis,
} from '../db/schema/index.js';
import {
  insertRecord,
  recordAudit,
  RecordNotFoundError,
  restoreRecord,
  softDeleteRecord,
  updateRecord,
  type Tx,
  type WriteContext,
} from '../db/write.js';
import { editPermissionKey, readPermissionKey } from './permissions.js';
import {
  isSensitiveCategory,
  payloadSchemas,
  type SensitiveCategory,
  type SensitivePayload,
} from './schemas.js';

/**
 * The only code that touches the `person_sensitive` table. Reads and writes of
 * crew and cast sensitive data go through here, so access rules and audit live
 * in one place.
 *
 * Access: the person themselves (`person.user_id`), or a user holding
 * `sensitive:read:<category>` / `sensitive:edit:<category>` on a project where
 * the person has a `project_person` row. Org owners and admins get nothing
 * automatically.
 *
 * Audit: every allowed read writes one `sensitive.read` event and every denial
 * one `sensitive.denied` event, with the category and never a value. A denial
 * throws after its event is written, so a caller that rolls its transaction
 * back on the error loses the event: catch the error inside the transaction
 * and let it commit.
 *
 * Nothing here logs, and no error or audit detail carries a payload value.
 */

export type SensitiveContext = {
  /** The user acting. */
  readonly userId: string;
  readonly requestId?: string | null;
  /** The server doing the work. */
  readonly originServer: string;
  readonly clock: () => Date;
  /** Told about staff changes. Defaults to a no-op until the email module exists. */
  readonly notifier?: SensitiveChangeNotifier;
};

/** Tells a person that staff entered, changed or deleted their data. Never gets values. */
export interface SensitiveChangeNotifier {
  notifyPersonOfStaffChange(input: {
    personId: string;
    category: SensitiveCategory;
    changedByUserId: string;
  }): Promise<void>;
}

export const noopSensitiveChangeNotifier: SensitiveChangeNotifier = {
  notifyPersonOfStaffChange: () => Promise.resolve(),
};

type Operation = 'read' | 'write' | 'delete';

/** The caller may not do this. Carries no person id and no values. */
export class SensitiveAccessDeniedError extends Error {
  constructor(
    readonly category: SensitiveCategory,
    readonly operation: Operation,
  ) {
    super(`Access to sensitive ${category} data denied for ${operation}`);
    this.name = 'SensitiveAccessDeniedError';
  }
}

/** The payload does not fit its category. Lists where and why, never what. */
export class SensitivePayloadInvalidError extends Error {
  constructor(
    readonly category: SensitiveCategory,
    readonly issues: readonly { path: string; code: string }[],
  ) {
    super(
      `Invalid ${category} payload` +
        (issues.length > 0
          ? ` at: ${issues.map((i) => i.path || '(root)').join(', ')}`
          : ''),
    );
    this.name = 'SensitivePayloadInvalidError';
  }
}

/** A stored record without its payload. */
export type SensitiveRecordMeta = {
  readonly id: string;
  readonly personId: string;
  readonly category: SensitiveCategory;
  readonly version: number;
  readonly legalBasis: PersonSensitiveLegalBasis;
  readonly consentRecordedAt: Date | null;
  readonly consentTextVersion: string | null;
  readonly enteredByKind: 'self' | 'staff';
  readonly enteredBy: string;
  readonly lastConfirmedAt: Date | null;
  readonly updatedAt: Date;
};

export type SensitiveRecord<C extends SensitiveCategory = SensitiveCategory> =
  SensitiveRecordMeta & { readonly payload: SensitivePayload<C> };

export type WriteSensitiveOptions = {
  readonly legalBasis: PersonSensitiveLegalBasis;
  /** Version of the consent text the person agreed to. Used for self writes on a consent basis. */
  readonly consentTextVersion?: string;
};

const LEGAL_BASES: readonly string[] = [
  'consent',
  'contract',
  'legal-obligation',
  'vital-interest',
];

const RETENTION_CLASS: Record<SensitiveCategory, string> = {
  dietary: 'crew-health',
  medical: 'crew-health',
  accessibility: 'crew-health',
  emergency: 'crew-health',
  identity: 'crew-personal',
  financial: 'crew-personal',
  representation: 'crew-personal',
  compliance: 'financial-record',
};

type PersonRow = typeof person.$inferSelect;

function assertCategory(
  category: unknown,
): asserts category is SensitiveCategory {
  if (!isSensitiveCategory(category)) {
    throw new Error('Unknown sensitive category');
  }
}

function auditBase(ctx: SensitiveContext, personId: string, category: string) {
  return {
    actor: { type: 'user', id: ctx.userId } as const,
    targetType: 'person',
    targetId: personId,
    details: { category },
    requestId: ctx.requestId ?? null,
    occurredAt: ctx.clock(),
  };
}

/**
 * Decides whether the acting user may do `operation` on the person's data in
 * `category`. A denial is audited and thrown. An unknown or deleted person is
 * denied like any other, so ids cannot be probed.
 */
async function authorise(
  tx: Tx,
  ctx: SensitiveContext,
  personId: string,
  category: SensitiveCategory,
  operation: Operation,
): Promise<{ person: PersonRow; via: 'self' | 'staff' }> {
  const [found] = await tx
    .select()
    .from(person)
    .where(and(eq(person.id, personId), isNull(person.deletedAt)))
    .limit(1);

  let via: 'self' | 'staff' | null = null;
  if (found) {
    if (found.userId !== null && found.userId === ctx.userId) {
      via = 'self';
    } else if (
      await holdsOnSharedProject(tx, ctx.userId, found, category, operation)
    ) {
      via = 'staff';
    }
  }

  if (!found || !via) {
    await recordAudit(tx, {
      ...auditBase(ctx, personId, category),
      organisationId: found?.organisationId ?? null,
      category: 'sensitive.denied',
      action: operation,
    });
    throw new SensitiveAccessDeniedError(category, operation);
  }
  return { person: found, via };
}

async function holdsOnSharedProject(
  tx: Tx,
  userId: string,
  subject: PersonRow,
  category: SensitiveCategory,
  operation: Operation,
): Promise<boolean> {
  const key =
    operation === 'read'
      ? readPermissionKey(category)
      : editPermissionKey(category);
  const projects = await tx
    .selectDistinct({ projectId: projectPerson.projectId })
    .from(projectPerson)
    .where(
      and(
        eq(projectPerson.organisationId, subject.organisationId),
        eq(projectPerson.personId, subject.id),
        isNull(projectPerson.deletedAt),
      ),
    );
  for (const { projectId } of projects) {
    if (await hasProjectPermission(tx, userId, projectId, key)) return true;
  }
  return false;
}

function metaOf(row: typeof personSensitive.$inferSelect): SensitiveRecordMeta {
  return {
    id: row.id,
    personId: row.personId,
    category: row.category,
    version: row.version,
    legalBasis: row.legalBasis,
    consentRecordedAt: row.consentRecordedAt,
    consentTextVersion: row.consentTextVersion,
    enteredByKind: row.enteredByKind,
    enteredBy: row.enteredBy,
    lastConfirmedAt: row.lastConfirmedAt,
    updatedAt: row.updatedAt,
  };
}

function writeContext(ctx: SensitiveContext): WriteContext {
  return {
    actor: { type: 'user', id: ctx.userId },
    originServer: ctx.originServer,
    clock: ctx.clock,
    requestId: ctx.requestId ?? null,
  };
}

async function findRow(
  tx: Tx,
  personId: string,
  category: SensitiveCategory,
  options: { includeDeleted: boolean },
) {
  const [row] = await tx
    .select()
    .from(personSensitive)
    .where(
      and(
        eq(personSensitive.personId, personId),
        eq(personSensitive.category, category),
        options.includeDeleted ? undefined : isNull(personSensitive.deletedAt),
      ),
    )
    .orderBy(desc(personSensitive.version))
    .limit(1);
  return row;
}

/**
 * Reads one category of a person's sensitive data, or `null` if there is none.
 * Writes one `sensitive.read` audit event, whether or not data exists.
 * Throws `SensitiveAccessDeniedError` (after auditing it) when not allowed.
 * The stored payload was validated on write and is returned as stored.
 */
export async function readSensitive<C extends SensitiveCategory>(
  tx: Tx,
  ctx: SensitiveContext,
  personId: string,
  category: C,
): Promise<SensitiveRecord<C> | null> {
  assertCategory(category);
  const { person: subject } = await authorise(
    tx,
    ctx,
    personId,
    category,
    'read',
  );
  await recordAudit(tx, {
    ...auditBase(ctx, personId, category),
    organisationId: subject.organisationId,
    category: 'sensitive.read',
    action: 'read',
  });
  const row = await findRow(tx, personId, category, { includeDeleted: false });
  if (!row) return null;
  return { ...metaOf(row), payload: row.payload as SensitivePayload<C> };
}

/**
 * Creates or replaces one category of a person's sensitive data. The payload
 * is checked against the category schema before anything is written.
 *
 * The person themselves writes as `self` (and, on a consent basis, records
 * consent; any self write confirms the data). A user with
 * `sensitive:edit:<category>` writes as `staff`, which calls the notifier. A
 * notifier failure fails the write, so a staff change is never unannounced.
 * Writing over a deleted record restores it.
 */
export async function writeSensitive<C extends SensitiveCategory>(
  tx: Tx,
  ctx: SensitiveContext,
  personId: string,
  category: C,
  payload: unknown,
  options: WriteSensitiveOptions,
): Promise<SensitiveRecordMeta> {
  assertCategory(category);
  const { person: subject, via } = await authorise(
    tx,
    ctx,
    personId,
    category,
    'write',
  );

  const parsed = payloadSchemas[category].safeParse(payload);
  if (!parsed.success) {
    throw new SensitivePayloadInvalidError(
      category,
      parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        code: issue.code,
      })),
    );
  }
  if (!LEGAL_BASES.includes(options.legalBasis)) {
    throw new Error('Unknown legal basis');
  }

  const now = ctx.clock();
  const wc = writeContext(ctx);
  const selfConsent = via === 'self' && options.legalBasis === 'consent';
  const fields = {
    payload: parsed.data as Record<string, unknown>,
    legalBasis: options.legalBasis,
    enteredByKind: via,
    enteredBy: ctx.userId,
    retentionClass: RETENTION_CLASS[category],
    ...(selfConsent
      ? {
          consentRecordedAt: now,
          consentTextVersion: options.consentTextVersion ?? null,
        }
      : {}),
    ...(via === 'self' ? { lastConfirmedAt: now } : {}),
  };

  const saved = await tx.transaction(async (inner) => {
    const existing = await findRow(inner, personId, category, {
      includeDeleted: true,
    });
    if (!existing) {
      return insertRecord(
        inner,
        personSensitive,
        {
          organisationId: subject.organisationId,
          ownerOrgId: subject.ownerOrgId,
          personId,
          category,
          ...fields,
        },
        wc,
      );
    }
    let version = existing.version;
    if (existing.deletedAt !== null) {
      await restoreRecord(inner, personSensitive, existing.id, version, wc);
      version += 1;
    }
    return updateRecord(
      inner,
      personSensitive,
      existing.id,
      version,
      fields,
      wc,
    );
  });

  if (via === 'staff') await notifyStaffChange(ctx, personId, category);
  return metaOf(saved);
}

/**
 * Soft-deletes one category of a person's sensitive data, under the same rule
 * as `writeSensitive`. Throws `RecordNotFoundError` when there is nothing to
 * delete. A staff delete notifies the person.
 */
export async function deleteSensitive(
  tx: Tx,
  ctx: SensitiveContext,
  personId: string,
  category: SensitiveCategory,
): Promise<void> {
  assertCategory(category);
  const { via } = await authorise(tx, ctx, personId, category, 'delete');
  const existing = await findRow(tx, personId, category, {
    includeDeleted: false,
  });
  if (!existing) {
    throw new RecordNotFoundError(
      'person_sensitive',
      `${personId}/${category}`,
    );
  }
  await softDeleteRecord(
    tx,
    personSensitive,
    existing.id,
    existing.version,
    writeContext(ctx),
  );
  if (via === 'staff') await notifyStaffChange(ctx, personId, category);
}

function notifyStaffChange(
  ctx: SensitiveContext,
  personId: string,
  category: SensitiveCategory,
): Promise<void> {
  return (
    ctx.notifier ?? noopSensitiveChangeNotifier
  ).notifyPersonOfStaffChange({
    personId,
    category,
    changedByUserId: ctx.userId,
  });
}
