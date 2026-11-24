import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { AccessCredential } from '../access/credential.js';
import { hasProjectPermission } from '../access/project-permission.js';
import {
  ACCESS_GRANT_CATEGORIES,
  department,
  PERSON_SENSITIVE_LEGAL_BASES,
  person,
  personSensitive,
  project,
  projectPerson,
  type AccessGrantCategory,
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
import { ACCESS_AUDIT, auditActor, tokenMark } from './audit.js';
import {
  SensitiveAccessDeniedError,
  UseAccessProfileError,
  type SensitiveOperation,
} from './errors.js';
import { grantedFieldsFor } from './grant-reads.js';
import { parsePayload } from './payload.js';
import {
  COMPLIANCE_REPORT_PERMISSION,
  editPermissionKey,
  readPermissionKey,
} from './permissions.js';
import {
  findRow,
  loadGovernedSource,
  metaOf,
  PERSON_COLUMNS,
  pickFields,
  type PersonRow,
  type SensitiveRecordMeta,
} from './records.js';
import {
  isSensitiveCategory,
  payloadSchemas,
  type SensitiveCategory,
  type SensitivePayload,
} from './schemas.js';

export {
  SensitiveAccessDeniedError,
  SensitivePayloadInvalidError,
} from './errors.js';
export type { SensitiveRecordMeta } from './records.js';

/**
 * The only code that touches the `person_sensitive` table (CLAUDE.md, Data
 * rules). Reads and writes of crew and cast sensitive data go through here, so
 * access rules and audit live in one place.
 *
 * Access: the person themselves (`person.user_id`), or a user holding
 * `sensitive:read:<category>` / `sensitive:edit:<category>` on a project where
 * the person has a confirmed or released `project_person` engagement. Org
 * owners and admins get nothing automatically.
 *
 * Two categories go further (decision D-69). A person's `accessibility` and `medical`
 * data is read only through live, person-approved grants (`access-grants.ts`): the
 * person themselves, and a holder of `sensitive:edit:<category>` for a person without an
 * account (whose production record they enter and need to edit), read all of it, and
 * everyone else holding `sensitive:read:<category>` reads only the fields that live
 * grants to a role they hold on the project cover, and is denied when there are none: the
 * permission alone is never enough. The adjustments of a person with an account live in
 * their access profile (`access-profile.ts`), not in `person_sensitive`, so writing
 * their `accessibility` row is refused with `UseAccessProfileError`. The audit event of a
 * read of either category carries the number of fields returned, never their names.
 *
 * A personal API token (SC-10, decision D-68) reaches the same data only through its
 * explicit sensitive scope: the token must list the permission's key, the organisation's
 * sensitive switch must be on, and the token's owner must hold the permission on a shared
 * project at that moment (`SensitiveContext.credential`, which `hasProjectPermission`
 * narrows by). A token never takes the person's own way in: the owner of the account
 * the data is about reads it by signing in, not through a token.
 *
 * Audit: every allowed read writes one `sensitive.read` event and every denial
 * one `sensitive.denied` event, with the category and never a value. A request made
 * with a token is marked with the token's id: the event's actor is the token, and its
 * details carry the token's id and its owner's. A denial
 * throws after its event is written, so a caller that rolls its transaction
 * back on the error loses the event: catch the error inside the transaction
 * and let it commit (CLAUDE.md, Data rules).
 *
 * Nothing here logs, and no error or audit detail carries a payload value
 * (CLAUDE.md, Privacy rule).
 */

/** Who is acting, with the server, clock and notifier. Always a user. */
export type SensitiveContext = {
  /** The user acting. */
  readonly userId: string;
  readonly requestId?: string | null;
  /** The server doing the work. */
  readonly originServer: string;
  readonly clock: () => Date;
  /** Queues notices of staff changes. Defaults to a no-op until the email module exists. */
  readonly notifier?: SensitiveChangeNotifier;
  /**
   * How the request was authenticated. A personal API token narrows every check by its
   * scope and marks every audit event and change event with its id; left out, or a
   * session's, nothing is narrowed or marked.
   */
  readonly credential?: AccessCredential;
};

/**
 * Queues a notice that staff entered, changed or deleted a person's data. The
 * service calls it inside the write's own savepoint and hands over that
 * savepoint's transaction `tx`. An implementation only enqueues, for example by
 * inserting an outbox row through `tx`, and sends nothing: the notice then
 * commits or rolls back with the write, and a throw undoes the write. Never
 * gets values.
 */
export interface SensitiveChangeNotifier {
  queueStaffChangeNotice(
    tx: Tx,
    input: {
      personId: string;
      category: SensitiveCategory;
      changedByUserId: string;
    },
  ): Promise<void>;
}

/** The default notifier: it queues nothing. Used when a context sets none. */
export const noopSensitiveChangeNotifier: SensitiveChangeNotifier = {
  queueStaffChangeNotice: () => Promise.resolve(),
};

/**
 * A stored record with its payload. Only `readSensitive` returns one, after an
 * access check and an audit event. For `accessibility` and `medical` the payload holds
 * only the fields the reader may see: all of them for the person themselves and for staff
 * who edit the record of a person without an account, and the granted ones for everyone
 * else.
 */
export type SensitiveRecord<C extends SensitiveCategory = SensitiveCategory> =
  SensitiveRecordMeta & { readonly payload: SensitivePayload<C> };

/** The legal basis of a write, and the consent text the person agreed to. */
export type WriteSensitiveOptions = {
  readonly legalBasis: PersonSensitiveLegalBasis;
  /** Version of the consent text the person agreed to. Used for self writes on a consent basis. */
  readonly consentTextVersion?: string;
};

// A run-time guard for callers that bypass the types. It is the table's own
// list, `PERSON_SENSITIVE_LEGAL_BASES`, so the service and the CHECK cannot
// disagree.
const LEGAL_BASES: readonly string[] = PERSON_SENSITIVE_LEGAL_BASES;

// The retention class each category's row gets. The periods that go with the
// classes live in `retention/defaults.ts`, not here.
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

/** Engagement statuses that count as having worked on the production. They are what grants access
 * to a person's sensitive data and what the compliance report counts. */
const ENGAGED_STATUSES = ['confirmed', 'released'] as const;

function assertCategory(
  category: unknown,
): asserts category is SensitiveCategory {
  if (!isSensitiveCategory(category)) {
    throw new Error('Unknown sensitive category');
  }
}

/**
 * True for the two categories whose reads follow the grants (decision D-69): `accessibility`
 * and `medical`. Checked against the constant list, never used as a key.
 */
function isGrantGoverned(
  category: SensitiveCategory,
): category is AccessGrantCategory {
  return (ACCESS_GRANT_CATEGORIES as readonly string[]).includes(category);
}

function auditBase(ctx: SensitiveContext, personId: string, category: string) {
  return {
    actor: auditActor(ctx),
    targetType: 'person',
    targetId: personId,
    details: { category, ...tokenMark(ctx) },
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
  operation: Extract<SensitiveOperation, 'read' | 'write' | 'delete'>,
): Promise<{ person: PersonRow; via: 'self' | 'staff' }> {
  const [found] = await tx
    .select(PERSON_COLUMNS)
    .from(person)
    .where(and(eq(person.id, personId), isNull(person.deletedAt)))
    .limit(1);

  let via: 'self' | 'staff' | null = null;
  if (found) {
    // A token never takes the person's own way in: it has no permission to name,
    // and sensitive data goes through an explicit scope or not at all (decision D-68).
    if (
      found.userId !== null &&
      found.userId === ctx.userId &&
      ctx.credential?.kind !== 'token'
    ) {
      via = 'self';
    } else if (
      await holdsOnSharedProject(tx, ctx, found, category, operation)
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

/**
 * True when the user holds the category's read or edit permission on any
 * project where the person is engaged (status `confirmed` or `released`). A personal API
 * token in `ctx.credential` narrows the check on each project.
 */
async function holdsOnSharedProject(
  tx: Tx,
  ctx: SensitiveContext,
  subject: PersonRow,
  category: SensitiveCategory,
  operation: Extract<SensitiveOperation, 'read' | 'write' | 'delete'>,
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
        inArray(projectPerson.status, [...ENGAGED_STATUSES]),
        isNull(projectPerson.deletedAt),
      ),
    );
  for (const { projectId } of projects) {
    if (
      await hasProjectPermission(tx, ctx.userId, projectId, key, ctx.credential)
    ) {
      return true;
    }
  }
  return false;
}

function writeContext(ctx: SensitiveContext): WriteContext {
  const shared = {
    originServer: ctx.originServer,
    clock: ctx.clock,
    requestId: ctx.requestId ?? null,
  };
  // A token's write is the token's in the change log, made for its owner.
  return ctx.credential?.kind === 'token'
    ? {
        ...shared,
        actor: { type: 'token', id: ctx.credential.tokenId },
        onBehalfOfUserId: ctx.userId,
      }
    : { ...shared, actor: { type: 'user', id: ctx.userId } };
}

/** What a reader may see of a person's `accessibility` or `medical` data: everything, the fields some live grants cover, or nothing. */
type GovernedAccess =
  | { readonly kind: 'all' }
  | { readonly kind: 'fields'; readonly fields: ReadonlySet<string> }
  | { readonly kind: 'none' };

/**
 * Reads a person's `accessibility` or `medical` data by the rules of decision D-69, and
 * writes the audit event of the read or of the denial. Three ways in, in this order:
 *
 * 1. The person themselves, signed in (a token never takes this way in), reads all of it:
 *    their access profile for `accessibility` if they have an account, the production
 *    record otherwise, and the `medical` record.
 * 2. For a person without an account, a holder of `sensitive:edit:<category>` on a project
 *    where the person is engaged reads the whole production record, which they need to
 *    edit it.
 * 3. Anyone else who holds `sensitive:read:<category>` reads only the fields that live
 *    grants cover (`grantedFieldsFor`): grants to a role they hold in an active
 *    membership of a project where they hold the permission, and the person is still on.
 *
 * With none of the three the read is denied: default deny, the permission alone is never
 * enough. A denial is audited before it is thrown, the same for a person who does not
 * exist. The `sensitive.read` event carries the category and the number of fields returned,
 * never their names.
 */
async function readGoverned<C extends AccessGrantCategory>(
  tx: Tx,
  ctx: SensitiveContext,
  personId: string,
  category: C,
): Promise<SensitiveRecord<C> | null> {
  const [subject] = await tx
    .select()
    .from(person)
    .where(and(eq(person.id, personId), isNull(person.deletedAt)))
    .limit(1);

  // What the reader may see: all of it, the fields some grants cover, or nothing.
  let access: GovernedAccess = { kind: 'none' };
  if (subject !== undefined) {
    if (
      subject.userId !== null &&
      subject.userId === ctx.userId &&
      // A token never takes the person's own way in (decision D-68).
      ctx.credential?.kind !== 'token'
    ) {
      access = { kind: 'all' };
    } else if (
      subject.userId === null &&
      (await holdsOnSharedProject(tx, ctx, subject, category, 'write'))
    ) {
      access = { kind: 'all' };
    } else {
      const fields = await grantedFieldsFor(
        tx,
        ctx,
        subject,
        category,
        ctx.clock(),
      );
      if (fields.size > 0) access = { kind: 'fields', fields };
    }
  }
  if (subject === undefined || access.kind === 'none') {
    await recordAudit(tx, {
      ...auditBase(ctx, personId, category),
      organisationId: subject?.organisationId ?? null,
      category: 'sensitive.denied',
      action: 'read',
    });
    throw new SensitiveAccessDeniedError(category, 'read');
  }

  const stored = await loadGovernedSource(tx, subject, category);
  const payload =
    stored === null
      ? null
      : access.kind === 'all'
        ? stored.payload
        : pickFields(stored.payload, access.fields);
  const fieldCount = payload === null ? 0 : Object.keys(payload).length;
  await recordAudit(tx, {
    actor: auditActor(ctx),
    targetType: 'person',
    targetId: personId,
    details: { category, fieldCount, ...tokenMark(ctx) },
    requestId: ctx.requestId ?? null,
    occurredAt: ctx.clock(),
    organisationId: subject.organisationId,
    category: 'sensitive.read',
    action: 'read',
  });
  if (stored === null || payload === null || fieldCount === 0) return null;
  return { ...stored.meta, payload: payload };
}

/**
 * Reads one category of a person's sensitive data, or `null` if there is none.
 * Writes one `sensitive.read` audit event, whether or not data exists.
 * Throws `SensitiveAccessDeniedError` (after auditing it) when not allowed.
 * The stored payload was validated on write and is returned as stored.
 *
 * `accessibility` and `medical` follow the grants (decision D-69): the person themselves
 * and staff who edit the record of a person without an account read all of it, and
 * everyone else reads only the fields that live grants to a role they hold cover, or is
 * denied when there are none, whatever permission they hold. The audit event of those two
 * carries the number of fields returned, never their names. The adjustments of a person
 * with an account come from their access profile.
 */
export async function readSensitive<C extends SensitiveCategory>(
  tx: Tx,
  ctx: SensitiveContext,
  personId: string,
  category: C,
): Promise<SensitiveRecord<C> | null> {
  assertCategory(category);
  if (isGrantGoverned(category)) {
    return readGoverned(tx, ctx, personId, category);
  }
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
  if (!row || row.payload === null) return null;
  return { ...metaOf(row), payload: row.payload as SensitivePayload<C> };
}

/**
 * Creates or replaces one category of a person's sensitive data. The payload
 * is checked against the category schema before anything is written.
 *
 * The person themselves writes as `self` (and, on a consent basis, records
 * consent; any self write confirms the data). A user with
 * `sensitive:edit:<category>` writes as `staff`, which queues a notice through
 * the notifier. The write and the notice share one savepoint: if the notifier
 * throws, the row, its change event and the notice are all rolled back, even
 * when the caller catches the error and commits. Writing over a deleted record
 * restores it. A write that changes no stored field, such as the same staff
 * writing the same payload again, writes nothing (see `updateRecord`) and
 * queues no notice: there is nothing to announce.
 *
 * @throws SensitiveAccessDeniedError (after auditing it) when not allowed.
 * @throws SensitivePayloadInvalidError for a payload that breaks its category
 * schema; it lists paths and codes, never values.
 * @throws Error for an unknown category or legal basis, and
 * `RecordWriteError` when the database refuses the row.
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
  // The adjustments of a person with an account live in their access profile (decision
  // D-69), which only they write. Refused after the permission is checked, so the answer
  // is for someone allowed to know, and audited before it is thrown.
  if (category === 'accessibility' && subject.userId !== null) {
    await recordAudit(tx, {
      ...auditBase(ctx, personId, category),
      organisationId: subject.organisationId,
      category: ACCESS_AUDIT.refused,
      action: 'write',
      details: {
        reason: 'use-access-profile',
        category,
        ...tokenMark(ctx),
      },
    });
    throw new UseAccessProfileError();
  }

  const parsedPayload = parsePayload(category, payload);
  if (!LEGAL_BASES.includes(options.legalBasis)) {
    throw new Error('Unknown legal basis');
  }

  const now = ctx.clock();
  const wc = writeContext(ctx);
  const selfConsent = via === 'self' && options.legalBasis === 'consent';
  const fields = {
    payload: parsedPayload as Record<string, unknown>,
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

  // One savepoint holds the write and the notice, so they succeed or fail
  // together even when the caller catches the error and commits.
  const saved = await tx.transaction(async (inner) => {
    const existing = await findRow(inner, personId, category, {
      includeDeleted: true,
    });
    let row: typeof personSensitive.$inferSelect;
    let changed = true;
    if (!existing) {
      row = await insertRecord(
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
    } else if (existing.deletedAt !== null) {
      // One write: a deleted row has no payload, so restore and refill together.
      row = await restoreRecord(
        inner,
        personSensitive,
        existing.id,
        existing.version,
        wc,
        fields,
      );
    } else {
      row = await updateRecord(
        inner,
        personSensitive,
        existing.id,
        existing.version,
        fields,
        wc,
      );
      // `updateRecord` hands back the stored row untouched, at the same
      // version, when nothing would change. Then there is nothing to announce.
      changed = row.version !== existing.version;
    }
    if (via === 'staff' && changed) {
      await queueStaffNotice(inner, ctx, personId, category);
    }
    return row;
  });

  return metaOf(saved);
}

/**
 * Deletes one category of a person's sensitive data (soft delete that also erases the payload), under the same rule
 * as `writeSensitive`. A staff delete queues a notice in the same savepoint,
 * so a notifier failure leaves the record undeleted.
 *
 * @throws SensitiveAccessDeniedError (after auditing it) when not allowed.
 * @throws RecordNotFoundError when there is nothing to delete.
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
  // The delete and the notice share one savepoint, as in `writeSensitive`.
  await tx.transaction(async (inner) => {
    await softDeleteRecord(
      inner,
      personSensitive,
      existing.id,
      existing.version,
      writeContext(ctx),
      { payload: null }, // erased in the same write; the table CHECK requires it
    );
    if (via === 'staff') await queueStaffNotice(inner, ctx, personId, category);
  });
}

function queueStaffNotice(
  tx: Tx,
  ctx: SensitiveContext,
  personId: string,
  category: SensitiveCategory,
): Promise<void> {
  return (ctx.notifier ?? noopSensitiveChangeNotifier).queueStaffChangeNotice(
    tx,
    {
      personId,
      category,
      changedByUserId: ctx.userId,
    },
  );
}

/** The caller may not see the compliance report. Carries no values. */
export class ComplianceReportDeniedError extends Error {
  constructor() {
    super('Access to the compliance report denied');
    this.name = 'ComplianceReportDeniedError';
  }
}

/** Country code (or `unknown`) to a number of people. */
export type ComplianceCounts = Record<string, number>;

/** Counts for one department's engaged people (or none). No person ids. */
export type ComplianceDepartmentReport = {
  /** `null` for people engaged with no department. */
  readonly departmentId: string | null;
  readonly departmentName: string | null;
  /** Confirmed or released people in this department, each counted once. */
  readonly engagedPeople: number;
  /** One count per tax-residency country, plus `unknown`. */
  readonly taxResidency: ComplianceCounts;
  /**
   * One count per citizenship country, plus `unknown` for people with none on
   * record. A person with two citizenships counts under both, so these counts
   * can add up to more than `engagedPeople`.
   */
  readonly citizenship: ComplianceCounts;
};

/** The result of `complianceReport`: counts per department only. */
export type ComplianceReport = {
  readonly projectId: string;
  readonly departments: readonly ComplianceDepartmentReport[];
};

const UNKNOWN = 'unknown';

// Safe on a plain object: every key is a two-letter code that
// `payloadSchemas.compliance` already checked, or `unknown`. None can be an
// inherited name such as `constructor`.
function increment(counts: ComplianceCounts, key: string) {
  counts[key] = (counts[key] ?? 0) + 1;
}

/**
 * Counts, per department, how many engaged people have each tax-residency and
 * citizenship country on record, and how many have none. The result holds
 * counts only: no person ids, no names, no payloads. Only people whose
 * engagement is `confirmed` or `released` count, that is, people who worked on
 * the production; `proposed` ones do not.
 *
 * Needs `compliance:report` on the project. A denial is audited as
 * `sensitive.denied` and throws `ComplianceReportDeniedError`; an allowed
 * report writes one `compliance.report` audit event.
 */
export async function complianceReport(
  tx: Tx,
  ctx: SensitiveContext,
  projectId: string,
): Promise<ComplianceReport> {
  const [found] = await tx
    .select({ organisationId: project.organisationId })
    .from(project)
    .where(and(eq(project.id, projectId), isNull(project.deletedAt)))
    .limit(1);
  const allowed =
    found !== undefined &&
    (await hasProjectPermission(
      tx,
      ctx.userId,
      projectId,
      COMPLIANCE_REPORT_PERMISSION,
      ctx.credential,
    ));
  const audit = {
    actor: auditActor(ctx),
    organisationId: found?.organisationId ?? null,
    projectId: found ? projectId : null,
    targetType: 'project',
    targetId: projectId,
    details: { report: 'compliance', ...tokenMark(ctx) },
    requestId: ctx.requestId ?? null,
    occurredAt: ctx.clock(),
  };
  if (!found || !allowed) {
    await recordAudit(tx, {
      ...audit,
      category: 'sensitive.denied',
      action: 'report',
    });
    throw new ComplianceReportDeniedError();
  }
  await recordAudit(tx, {
    ...audit,
    category: 'compliance.report',
    action: 'read',
  });

  const engaged = await tx
    .selectDistinct({
      personId: projectPerson.personId,
      departmentId: projectPerson.departmentId,
    })
    .from(projectPerson)
    .innerJoin(
      person,
      and(
        eq(person.organisationId, projectPerson.organisationId),
        eq(person.id, projectPerson.personId),
        isNull(person.deletedAt),
      ),
    )
    .where(
      and(
        eq(projectPerson.organisationId, found.organisationId),
        eq(projectPerson.projectId, projectId),
        inArray(projectPerson.status, [...ENGAGED_STATUSES]),
        isNull(projectPerson.deletedAt),
      ),
    );
  if (engaged.length === 0) return { projectId, departments: [] };

  const records = await tx
    .select({
      personId: personSensitive.personId,
      payload: personSensitive.payload,
    })
    .from(personSensitive)
    .where(
      and(
        eq(personSensitive.organisationId, found.organisationId),
        eq(personSensitive.category, 'compliance'),
        isNull(personSensitive.deletedAt),
        inArray(personSensitive.personId, [
          ...new Set(engaged.map((e) => e.personId)),
        ]),
      ),
    );
  const onRecord = new Map<
    string,
    { residency: string | null; citizenships: Set<string> }
  >();
  for (const record of records) {
    const parsed = payloadSchemas.compliance.safeParse(record.payload);
    if (!parsed.success) continue;
    onRecord.set(record.personId, {
      residency: parsed.data.taxResidency ?? null,
      citizenships: new Set(parsed.data.citizenships),
    });
  }

  const groups = new Map<string | null, Set<string>>();
  for (const { personId, departmentId } of engaged) {
    const people = groups.get(departmentId) ?? new Set<string>();
    people.add(personId);
    groups.set(departmentId, people);
  }
  const departmentIds = [...groups.keys()].filter(
    (id): id is string => id !== null,
  );
  const named =
    departmentIds.length === 0
      ? []
      : await tx
          .select({ id: department.id, name: department.name })
          .from(department)
          .where(
            and(
              eq(department.organisationId, found.organisationId),
              inArray(department.id, departmentIds),
            ),
          );
  const nameOf = new Map(named.map((d) => [d.id, d.name]));

  const departments: ComplianceDepartmentReport[] = [...groups].map(
    ([departmentId, people]) => {
      const taxResidency: ComplianceCounts = {};
      const citizenship: ComplianceCounts = {};
      for (const personId of people) {
        const info = onRecord.get(personId);
        increment(taxResidency, info?.residency ?? UNKNOWN);
        if (!info || info.citizenships.size === 0) {
          increment(citizenship, UNKNOWN);
        } else {
          for (const country of info.citizenships)
            increment(citizenship, country);
        }
      }
      return {
        departmentId,
        departmentName:
          departmentId === null ? null : (nameOf.get(departmentId) ?? null),
        engagedPeople: people.size,
        taxResidency,
        citizenship,
      };
    },
  );
  departments.sort((a, b) => {
    if ((a.departmentId === null) !== (b.departmentId === null)) {
      return a.departmentId === null ? 1 : -1;
    }
    return (a.departmentName ?? '').localeCompare(b.departmentName ?? '');
  });
  return { projectId, departments };
}
