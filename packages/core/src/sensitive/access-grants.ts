import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { hasProjectPermission } from '../access/project-permission.js';
import {
  ACCESS_CONSENT_METHODS,
  ACCESS_CONSENT_NOTE_MAX_LENGTH,
  ACCESS_GRANT_CATEGORIES,
  ACCESS_GRANT_LIVE_INDEX,
  accessGrant,
  person,
  project,
  projectPerson,
  role,
  type AccessConsentMethod,
  type AccessGrantCategory,
} from '../db/schema/index.js';
import { recordAudit, RecordNotFoundError, type Tx } from '../db/write.js';
import { holdAccount } from './account-lock.js';
import { ACCESS_AUDIT, auditActor, tokenMark } from './audit.js';
import {
  AccessGrantBusyError,
  AccessGrantRefusedError,
  AccountDeletedError,
  RoleNotAvailableError,
  SensitiveAccessDeniedError,
  type AccessRefusalReason,
  type SensitiveOperation,
} from './errors.js';
import { driverErrorOf, guardedSensitive, isUuid } from './guard.js';
import { LIVE_ENGAGEMENT_STATUSES, projectIsOpen } from './liveness.js';
import { editPermissionKey } from './permissions.js';
import { loadGovernedSource, type PersonRow } from './records.js';
import {
  ACCESS_FIELDS,
  isSensitiveCategory,
  MEDICAL_FIELDS,
  type AccessGroup,
} from './schemas.js';
import type { SensitiveContext } from './service.js';
import {
  readSuggestedRoles,
  SUGGESTED_ROLE_GROUPS,
  type SuggestedRoleGroup,
} from './suggested-roles.js';

/**
 * Access grants (decision D-69): a person decides, field by field and role by role, who of
 * a production sees their access needs or their medical data, and it ends when the
 * production wraps while they keep their data. This and `deleteAccessProfile`, which ends
 * a person's accessibility grants when they delete their profile, are the only code that
 * writes `access_grant`.
 *
 * Who may make one: the person themselves when they have an account; for a person without
 * one, a user holding `sensitive:edit:<category>` on the project, who records how and
 * when the person agreed. Who may revoke one: the person, or a holder of that permission
 * for a grant that was recorded on someone's behalf. A personal API token never takes the
 * person's own way in, so it can only act as the holder of the permission, through its
 * sensitive scope.
 *
 * A grant is derived from the account of the person who makes it, so a call that writes one
 * for a person with an account holds that account's user row `FOR KEY SHARE`
 * (`holdAccount`) before it writes, and a deleted account is refused
 * (`AccountDeletedError`), for the shortcut too. The deletion of an account takes the same
 * row `FOR UPDATE` and ends the account's grants, so a grant is either made before it and
 * ended by it, or refused after it, and the lock order is the user row, then the profile
 * row, then the grants (CLAUDE.md, Data rules).
 *
 * A denial is audited as `sensitive.denied` and thrown; a rule that refuses a call is
 * audited as `access.refused` with a reason code from a closed list and thrown; both are
 * written before the error is thrown, so a caller catches the error inside its transaction
 * and commits (CLAUDE.md, Data rules). A change is audited as `access.grant-created` and
 * `access.grant-revoked`, and the shortcut as `access.shortcut-used`. No event holds a
 * field name, a value or a consent note, only ids, counts and codes (CLAUDE.md, Privacy
 * rule), and nothing here logs.
 */

/** How a person without an account agreed to share, as staff recorded it. */
export type AccessConsent = {
  /** How the person told staff. */
  readonly method: AccessConsentMethod;
  /** When they said so. Not in the future. */
  readonly at: Date;
  /** Optional, 1 to 200 characters, and no health details. Never returned to a reader. */
  readonly note?: string;
};

/** Which grant: a grant is one per project, person, category and role while it is live. */
export type AccessGrantKey = {
  readonly projectId: string;
  readonly personId: string;
  readonly category: AccessGrantCategory;
  readonly roleId: string;
};

/** What `createAccessGrant` takes: the key, the fields to open, and, for a person without an account, the consent. */
export type AccessGrantInput = AccessGrantKey & {
  /** Keys of the accessibility payload or of the medical payload, each once. */
  readonly fields: readonly string[];
  /** Required when staff record it for a person without an account, and not allowed otherwise. */
  readonly consent?: AccessConsent;
};

/** What `createAccessGrant` made. */
export type AccessGrantMade = AccessGrantKey & {
  readonly id: string;
  readonly fields: readonly string[];
  /** Staff recorded it for a person without an account. */
  readonly onBehalf: boolean;
  /** An earlier live grant of the same role was revoked to make this one. */
  readonly replaced: boolean;
};

type ProjectRow = typeof project.$inferSelect;

/** Who is acting on a grant: the person themselves, or a holder of the edit permission. */
type Standing = 'self' | 'editor';

type Subject = {
  readonly person: PersonRow;
  readonly project: ProjectRow;
  readonly standing: Standing;
};

const ACCESSIBILITY_KEYS: ReadonlySet<string> = new Set(
  ACCESS_FIELDS.map((entry) => entry.key),
);
const MEDICAL_KEYS: ReadonlySet<string> = new Set(MEDICAL_FIELDS);

/** The keys of the payload a grant of `category` may name. */
function grantableFields(category: AccessGrantCategory): ReadonlySet<string> {
  return category === 'accessibility' ? ACCESSIBILITY_KEYS : MEDICAL_KEYS;
}

function isGrantableCategory(value: unknown): value is AccessGrantCategory {
  return (ACCESS_GRANT_CATEGORIES as readonly unknown[]).includes(value);
}

/**
 * Writes the audit event of a refusal and throws it. The reason is a code from a closed
 * list; the event names the person and the project when they are known, never a field,
 * a value or a note.
 */
async function refuse(
  tx: Tx,
  ctx: SensitiveContext,
  where: {
    readonly person?: PersonRow | undefined;
    readonly project?: ProjectRow | undefined;
  },
  category: string,
  reason: Exclude<AccessRefusalReason, 'use-access-profile'>,
): Promise<never> {
  await recordAudit(tx, {
    actor: auditActor(ctx),
    organisationId: where.person?.organisationId ?? null,
    projectId: where.project?.id ?? null,
    category: ACCESS_AUDIT.refused,
    action: reason,
    targetType: where.person === undefined ? null : 'person',
    targetId: where.person?.id ?? null,
    details: { reason, category, ...tokenMark(ctx) },
    requestId: ctx.requestId ?? null,
    occurredAt: ctx.clock(),
  });
  // The reasons that have an error class of their own, then the rest.
  if (reason === 'role-not-available') throw new RoleNotAvailableError();
  if (reason === 'account-deleted') throw new AccountDeletedError();
  throw new AccessGrantRefusedError(reason);
}

/**
 * Finds the person and the project and decides whether the caller may make or revoke a
 * grant for them. A denial is audited, and is the same for a person or project that does
 * not exist, is deleted or belongs to another organisation, so ids cannot be probed.
 */
async function authorise(
  tx: Tx,
  ctx: SensitiveContext,
  key: { readonly projectId: string; readonly personId: string },
  category: AccessGrantCategory,
  operation: Extract<SensitiveOperation, 'grant' | 'revoke'>,
): Promise<Subject> {
  const [found] = isUuid(key.personId)
    ? await tx
        .select()
        .from(person)
        .where(and(eq(person.id, key.personId), isNull(person.deletedAt)))
        .limit(1)
    : [];
  const [inProject] =
    found !== undefined && isUuid(key.projectId)
      ? await tx
          .select()
          .from(project)
          .where(
            and(
              eq(project.id, key.projectId),
              eq(project.organisationId, found.organisationId),
              isNull(project.deletedAt),
            ),
          )
          .limit(1)
      : [];

  let standing: Standing | null = null;
  if (found !== undefined && inProject !== undefined) {
    if (
      found.userId !== null &&
      found.userId === ctx.userId &&
      // A token never takes the person's own way in (decision D-68).
      ctx.credential?.kind !== 'token'
    ) {
      standing = 'self';
    } else if (
      // For a person with an account only the person makes a grant; an editor can still
      // end one that was recorded on their behalf before they had an account.
      (operation === 'revoke' || found.userId === null) &&
      (await hasProjectPermission(
        tx,
        ctx.userId,
        inProject.id,
        editPermissionKey(category),
        ctx.credential,
      ))
    ) {
      standing = 'editor';
    }
  }
  if (found === undefined || inProject === undefined || standing === null) {
    await recordAudit(tx, {
      actor: auditActor(ctx),
      organisationId: found?.organisationId ?? null,
      category: 'sensitive.denied',
      action: operation,
      targetType: found === undefined ? null : 'person',
      targetId: found?.id ?? null,
      details: { category, ...tokenMark(ctx) },
      requestId: ctx.requestId ?? null,
      occurredAt: ctx.clock(),
    });
    throw new SensitiveAccessDeniedError(category, operation);
  }
  return { person: found, project: inProject, standing };
}

/** What the consent columns of a grant hold. */
type ConsentColumns = {
  readonly onBehalf: boolean;
  readonly method: AccessConsentMethod | null;
  readonly at: Date | null;
  readonly note: string | null;
};

/**
 * The consent columns for a grant, or a refusal. The person themselves gives none (the
 * grant is theirs); staff recording it for someone without an account must say how and
 * when that person agreed.
 */
async function consentColumns(
  tx: Tx,
  ctx: SensitiveContext,
  subject: Subject,
  category: AccessGrantCategory,
  consent: AccessConsent | undefined,
  now: Date,
): Promise<ConsentColumns> {
  const where = { person: subject.person, project: subject.project };
  if (subject.standing === 'self') {
    if (consent !== undefined) {
      return refuse(tx, ctx, where, category, 'consent-not-allowed');
    }
    return { onBehalf: false, method: null, at: null, note: null };
  }
  if (consent === undefined || consent === null) {
    return refuse(tx, ctx, where, category, 'consent-required');
  }
  const method: unknown = consent.method;
  const at: unknown = consent.at;
  const note: unknown = consent.note;
  const methodOk =
    typeof method === 'string' &&
    (ACCESS_CONSENT_METHODS as readonly string[]).includes(method);
  const atOk =
    at instanceof Date &&
    !Number.isNaN(at.getTime()) &&
    at.getTime() <= now.getTime();
  const noteOk =
    note === undefined ||
    (typeof note === 'string' &&
      note.length >= 1 &&
      note.length <= ACCESS_CONSENT_NOTE_MAX_LENGTH);
  if (!methodOk || !atOk || !noteOk) {
    return refuse(tx, ctx, where, category, 'consent-invalid');
  }
  return {
    onBehalf: true,
    method: method as AccessConsentMethod,
    at: at,
    note: typeof note === 'string' ? note : null,
  };
}

/**
 * Whether `roleId` is a role the project can give its members in this organisation: a
 * role of the organisation that is not deleted and is either an organisation template or
 * belongs to this project. A value that is not an id, a role that does not exist and a
 * role of another organisation or project are the same answer.
 */
async function roleIsAvailable(
  tx: Tx,
  organisationId: string,
  projectId: string,
  roleId: string,
): Promise<boolean> {
  if (!isUuid(roleId)) return false;
  const [found] = await tx
    .select({ id: role.id })
    .from(role)
    .where(
      and(
        eq(role.id, roleId),
        eq(role.organisationId, organisationId),
        isNull(role.deletedAt),
        or(isNull(role.projectId), eq(role.projectId, projectId)),
      ),
    )
    .limit(1);
  return found !== undefined;
}

/** Whether the person is still on the project: a live `project_person` row that is proposed or confirmed. */
async function isEngaged(tx: Tx, subject: Subject): Promise<boolean> {
  const [found] = await tx
    .select({ id: projectPerson.id })
    .from(projectPerson)
    .where(
      and(
        eq(projectPerson.organisationId, subject.person.organisationId),
        eq(projectPerson.projectId, subject.project.id),
        eq(projectPerson.personId, subject.person.id),
        inArray(projectPerson.status, [...LIVE_ENGAGEMENT_STATUSES]),
        isNull(projectPerson.deletedAt),
      ),
    )
    .limit(1);
  return found !== undefined;
}

/**
 * Refuses a grant on a project that is wrapped or closed, and for a person who is not on
 * it: the grant would be dead from the start, and a person is told so rather than left to
 * think they shared something.
 */
async function requireLiveProject(
  tx: Tx,
  ctx: SensitiveContext,
  subject: Subject,
  category: AccessGrantCategory,
  now: Date,
): Promise<void> {
  const where = { person: subject.person, project: subject.project };
  if (!projectIsOpen(subject.project, now)) {
    await refuse(tx, ctx, where, category, 'project-closed');
  }
  if (!(await isEngaged(tx, subject))) {
    await refuse(tx, ctx, where, category, 'person-not-on-project');
  }
}

/**
 * For a person with an account, holds the account's user row `FOR KEY SHARE` until the
 * transaction ends (`holdAccount`) and refuses a grant when the account is deleted: it
 * would be live for an account whose sharing the deletion has ended, and for a medical
 * grant it would open the organisation's record, which the deletion leaves in place. Both
 * callers, `createAccessGrant` and `shareWithSuggestedRoles`, run it after their other
 * refusals and before anything else of the person's is read or locked, so a call that waits
 * on a deletion in progress holds no other lock and cannot deadlock with it. A person
 * without an account has no row to hold.
 */
async function requireLiveAccount(
  tx: Tx,
  ctx: SensitiveContext,
  subject: Subject,
  category: AccessGrantCategory,
): Promise<void> {
  if (subject.person.userId === null) return;
  if (!(await holdAccount(tx, subject.person.userId))) {
    await refuse(
      tx,
      ctx,
      { person: subject.person, project: subject.project },
      category,
      'account-deleted',
    );
  }
}

/** The `category` of a call, checked against the constant lists. A category that is not one is a bug in the caller, not a request. */
async function grantableCategory(
  tx: Tx,
  ctx: SensitiveContext,
  category: unknown,
): Promise<AccessGrantCategory> {
  if (!isSensitiveCategory(category)) {
    throw new Error('Unknown sensitive category');
  }
  if (!isGrantableCategory(category)) {
    return refuse(tx, ctx, {}, category, 'category-not-grantable');
  }
  return category;
}

/** One live grant of a role, written in the transaction it is handed. */
type GrantToWrite = {
  readonly subject: Subject;
  readonly category: AccessGrantCategory;
  readonly roleId: string;
  readonly fields: readonly string[];
  readonly consent: ConsentColumns;
};

/**
 * Writes one grant: revokes the live grant of the same role, if there is one, and makes
 * the new one, in one savepoint, so a failure leaves the old one as it was. The partial
 * unique index (`access_grant_live_unique`) is what guarantees a role never has two live
 * grants: a change that would make a second one loses to the index and is
 * `AccessGrantBusyError`, whatever else happens. The `FOR UPDATE` on the earlier grant
 * only orders the work, so that two changes of one role queue behind each other instead
 * of racing to the index. Grants are not written through the write helper, so no change
 * counter is taken, and the rows a call locks before this one are the person's user row
 * (`FOR KEY SHARE`, for an account holder: `createAccessGrant` and a confirmed
 * `shareWithSuggestedRoles`) and, for the share, then the profile row (`FOR SHARE`), so the
 * order is user row, then profile row, then grants (CLAUDE.md, Data rules).
 */
async function writeGrant(
  tx: Tx,
  ctx: SensitiveContext,
  grant: GrantToWrite,
  now: Date,
): Promise<AccessGrantMade> {
  const { subject, category, roleId, consent } = grant;
  const key = {
    projectId: subject.project.id,
    personId: subject.person.id,
    category,
    roleId,
  };
  return guardedSensitive('access_grant', 'insert', () =>
    tx.transaction(async (inner) => {
      // The earlier live grant of this role, locked `FOR UPDATE` so that two changes of
      // one role queue behind each other. The lock only orders the work. What guarantees
      // one live grant per role is the partial unique index (`access_grant_live_unique`):
      // a change that would make a second one loses to it (`AccessGrantBusyError`, below).
      const [earlier] = await inner
        .select({ id: accessGrant.id, onBehalf: accessGrant.onBehalf })
        .from(accessGrant)
        .where(
          and(
            eq(accessGrant.projectId, key.projectId),
            eq(accessGrant.personId, key.personId),
            eq(accessGrant.category, category),
            eq(accessGrant.roleId, roleId),
            isNull(accessGrant.revokedAt),
          ),
        )
        .limit(1)
        .for('update');
      const base = {
        actor: auditActor(ctx),
        organisationId: subject.person.organisationId,
        projectId: subject.project.id,
        requestId: ctx.requestId ?? null,
        occurredAt: now,
      };
      if (earlier !== undefined) {
        await inner
          .update(accessGrant)
          .set({
            revokedAt: now,
            revokedBy: ctx.userId,
            version: sql`${accessGrant.version} + 1`,
            updatedAt: now,
            updatedBy: ctx.userId,
          })
          .where(eq(accessGrant.id, earlier.id));
        await recordAudit(inner, {
          ...base,
          category: ACCESS_AUDIT.grantRevoked,
          action: 'replace',
          targetType: 'access_grant',
          targetId: earlier.id,
          details: {
            personId: key.personId,
            category,
            roleId,
            onBehalf: earlier.onBehalf,
            reason: 'replaced',
            ...tokenMark(ctx),
          },
        });
      }
      let made: typeof accessGrant.$inferSelect | undefined;
      try {
        [made] = await inner
          .insert(accessGrant)
          .values({
            originServer: ctx.originServer,
            organisationId: subject.person.organisationId,
            projectId: key.projectId,
            personId: key.personId,
            category,
            roleId,
            fields: [...grant.fields],
            grantedBy: ctx.userId,
            grantedAt: now,
            onBehalf: consent.onBehalf,
            consentMethod: consent.method,
            consentAt: consent.at,
            consentNote: consent.note,
            createdAt: now,
            updatedAt: now,
            createdBy: ctx.userId,
            updatedBy: ctx.userId,
          })
          .returning();
      } catch (error) {
        const found = driverErrorOf(error);
        if (
          found?.code === '23505' &&
          found.constraint === ACCESS_GRANT_LIVE_INDEX
        ) {
          throw new AccessGrantBusyError();
        }
        throw error;
      }
      await recordAudit(inner, {
        ...base,
        category: ACCESS_AUDIT.grantCreated,
        action: 'create',
        targetType: 'access_grant',
        targetId: made!.id,
        details: {
          personId: key.personId,
          category,
          roleId,
          fieldCount: grant.fields.length,
          onBehalf: consent.onBehalf,
          ...tokenMark(ctx),
        },
      });
      return {
        ...key,
        id: made!.id,
        fields: [...grant.fields],
        onBehalf: consent.onBehalf,
        replaced: earlier !== undefined,
      };
    }),
  );
}

/**
 * Makes a person's grant of some of their access needs, or of their medical data, to one
 * role of one project, or replaces the live grant of that role with this one, in one step.
 * The grant is default deny: nothing is open until a grant says so, field by field.
 *
 * Who may: the person themselves when they have an account (no consent is recorded; it is
 * their own act); a holder of `sensitive:edit:<category>` on the project for a person
 * without an account, who must give the consent, how and when the person agreed and
 * optionally a note with no health details. A holder of that permission can not grant for
 * someone with an account, an organisation owner or administrator gets nothing by their
 * tier, and a personal API token only acts as the holder of the permission, through its
 * sensitive scope with the organisation's switch on.
 *
 * The role must be one the project can give its members: a role of this organisation that
 * is not deleted and is an organisation template or belongs to this project. Every field
 * must be a key of the category's payload, each once. The person must be on the project
 * (a live proposed or confirmed engagement), and the project must not be wrapped or
 * closed.
 *
 * For a person with an account it then holds the account's user row `FOR KEY SHARE` until
 * the transaction ends and refuses an account that is deleted (`holdAccount`). Deleting the
 * account takes that row `FOR UPDATE` and then ends every grant of the account, so a grant
 * made first is ended by the deletion and one that meets it waits, finds the account
 * deleted and writes nothing; and it takes the user row before the earlier grant it
 * replaces, so the two cannot wait for each other (CLAUDE.md, Data rules: lock order).
 *
 * @throws SensitiveAccessDeniedError (after auditing it) when the caller may not; the same
 * for a person or project that does not exist or is another organisation's.
 * @throws RoleNotAvailableError, one error for a role that is missing, deleted or foreign.
 * @throws AccountDeletedError (after auditing the refusal) when the person's account is
 * deleted. Only the holder of the account reaches this, since nobody else grants for them.
 * @throws AccessGrantRefusedError for a field that is not one a grant can name, a consent
 * record that is missing, not allowed or not valid, a person who is not on the project and
 * a project that is wrapped or closed. It carries a reason code only.
 * @throws AccessGrantBusyError when another change to the same grant won at that moment.
 * @throws RecordWriteError when the database refuses a write; it carries the SQLSTATE and
 * constraint name only.
 */
export async function createAccessGrant(
  tx: Tx,
  ctx: SensitiveContext,
  input: AccessGrantInput,
): Promise<AccessGrantMade> {
  const category = await grantableCategory(tx, ctx, input.category);
  const subject = await authorise(tx, ctx, input, category, 'grant');
  const now = ctx.clock();
  const where = { person: subject.person, project: subject.project };

  const consent = await consentColumns(
    tx,
    ctx,
    subject,
    category,
    input.consent,
    now,
  );
  const allowed = grantableFields(category);
  const fields: unknown = input.fields;
  if (
    !Array.isArray(fields) ||
    fields.length === 0 ||
    !fields.every(
      (field): field is string =>
        typeof field === 'string' && allowed.has(field),
    ) ||
    new Set(fields).size !== fields.length
  ) {
    return refuse(tx, ctx, where, category, 'invalid-fields');
  }
  if (
    !(await roleIsAvailable(
      tx,
      subject.person.organisationId,
      subject.project.id,
      input.roleId,
    ))
  ) {
    return refuse(tx, ctx, where, category, 'role-not-available');
  }
  await requireLiveProject(tx, ctx, subject, category, now);
  await requireLiveAccount(tx, ctx, subject, category);
  return writeGrant(
    tx,
    ctx,
    { subject, category, roleId: input.roleId, fields, consent },
    now,
  );
}

/**
 * Revokes the live grant of one role for a person on a project, at once: it opens nothing
 * from the moment this commits. The person themselves may revoke any of theirs; a holder
 * of `sensitive:edit:<category>` on the project may revoke one that was recorded on a
 * person's behalf, and for a grant the person made themselves it is the same not found as
 * for a grant that does not exist, so the answer says nothing about whether one exists.
 * Audited as `access.grant-revoked`.
 *
 * @throws SensitiveAccessDeniedError (after auditing it) when the caller has no standing
 * on this person and project: neither the person nor a holder of the permission.
 * @throws RecordNotFoundError when there is no live grant the caller may revoke.
 * @throws RecordWriteError when the database refuses the write.
 */
export async function revokeAccessGrant(
  tx: Tx,
  ctx: SensitiveContext,
  key: AccessGrantKey,
): Promise<void> {
  const category = await grantableCategory(tx, ctx, key.category);
  const subject = await authorise(tx, ctx, key, category, 'revoke');
  const now = ctx.clock();
  const missing = () =>
    new RecordNotFoundError('access_grant', `${subject.person.id}/${category}`);
  if (!isUuid(key.roleId)) throw missing();
  await guardedSensitive('access_grant', 'update', () =>
    tx.transaction(async (inner) => {
      const lockLive = async () =>
        (
          await inner
            .select({ id: accessGrant.id, onBehalf: accessGrant.onBehalf })
            .from(accessGrant)
            .where(
              and(
                eq(accessGrant.projectId, subject.project.id),
                eq(accessGrant.personId, subject.person.id),
                eq(accessGrant.category, category),
                eq(accessGrant.roleId, key.roleId),
                isNull(accessGrant.revokedAt),
              ),
            )
            .limit(1)
            .for('update')
        )[0];
      let live = await lockLive();
      // A change that held the live grant while this waited for it has revoked it and made
      // a new one, which the waiting statement cannot see. Looking once more, with a new
      // snapshot, finds the new one, so a revoke that raced a replacement ends the grant
      // and is not told it was already gone.
      if (live === undefined) live = await lockLive();
      if (live === undefined) throw missing();
      // An editor ends only what staff recorded; the person's own grants are theirs.
      if (subject.standing === 'editor' && !live.onBehalf) throw missing();
      await inner
        .update(accessGrant)
        .set({
          revokedAt: now,
          revokedBy: ctx.userId,
          version: sql`${accessGrant.version} + 1`,
          updatedAt: now,
          updatedBy: ctx.userId,
        })
        .where(eq(accessGrant.id, live.id));
      await recordAudit(inner, {
        actor: auditActor(ctx),
        organisationId: subject.person.organisationId,
        projectId: subject.project.id,
        category: ACCESS_AUDIT.grantRevoked,
        action: 'revoke',
        targetType: 'access_grant',
        targetId: live.id,
        details: {
          personId: subject.person.id,
          category,
          roleId: key.roleId,
          onBehalf: live.onBehalf,
          reason: 'revoked',
          ...tokenMark(ctx),
        },
        requestId: ctx.requestId ?? null,
        occurredAt: now,
      });
    }),
  );
}

/** What `shareWithSuggestedRoles` takes besides who and what. */
export type ShareOptions = {
  /**
   * The groups to share, among the groups of adjustments for `accessibility` (never
   * `notes`) and `medical` for `medical`. All of them when left out.
   */
  readonly groups?: readonly string[];
  /** Only work out who would see what, and write nothing. */
  readonly preview?: boolean;
  /** For staff recording it for a person without an account, as for `createAccessGrant`. Not needed for a preview. */
  readonly consent?: AccessConsent;
};

/** One role the shortcut shares with, and the fields it would open to it. */
export type ShareItem = {
  readonly roleId: string;
  readonly fields: readonly string[];
};

/**
 * Why `shareWithSuggestedRoles` answered an empty preview to a call that was not asked to
 * preview: `no-suggested-roles`, the organisation suggests no role for the groups asked
 * about, so there is nobody to share with.
 */
export type ShareReason = 'no-suggested-roles';

/** What `shareWithSuggestedRoles` worked out, or did. */
export type ShareResult = {
  /** True when nothing was written. */
  readonly preview: boolean;
  /** Who will see what, a role at a time, in the order of the role ids. */
  readonly shares: readonly ShareItem[];
  /** How many grants were made: none for a preview. */
  readonly granted: number;
  /**
   * Set when the answer is an empty preview because no role is suggested, which a client
   * tells the person (the organisation has not chosen the usual roles) instead of showing
   * a share that reached nobody. It is there whether or not the call asked for a preview;
   * absent otherwise.
   */
  readonly reason?: ShareReason;
};

/** The groups of adjustments the shortcut may share: all of them but `notes`. */
const SHAREABLE_ACCESS_GROUPS: readonly AccessGroup[] = [
  'schedule',
  'physical',
  'transport',
  'communication',
  'environment',
  'support',
];

/** The keys of the stored data that the person has filled in, in a group, without `notes`. */
function filledKeys(
  category: AccessGrantCategory,
  group: string,
  payload: Record<string, unknown>,
): string[] {
  const keys =
    category === 'accessibility'
      ? ACCESS_FIELDS.filter((entry) => entry.group === group).map(
          (entry) => entry.key as string,
        )
      : [...MEDICAL_FIELDS];
  // Free text is never shared by the shortcut, only by an explicit grant.
  return keys.filter(
    (key) =>
      key !== 'notes' &&
      Object.hasOwn(payload, key) &&
      payload[key] !== undefined,
  );
}

/**
 * Shares a person's access needs, or their medical data, with the roles their
 * organisation usually shares each group with (the setting `access.suggested-roles`): one
 * grant for each suggested role, covering the fields the person has filled in the groups
 * that suggest it, in one step. A group the person has left empty is skipped, a suggested
 * role that is not available to this project is skipped, and `notes` is never included,
 * in either category: free text goes only by an explicit grant (`createAccessGrant`).
 *
 * When the organisation suggests no role for any group asked about (it has no such setting,
 * or its setting holds nothing usable for those groups) there is nobody to share with, and
 * the answer is an empty preview with `reason: 'no-suggested-roles'`, whether or not the
 * call asked for a preview. It reads none of the person's data and writes nothing, not even
 * the `access.shortcut-used` event, and a client tells the person that the usual roles have
 * not been chosen. The refusals below still come first, a deleted account's among them.
 *
 * With `preview: true` it writes nothing and says who would see what, so a client can show
 * the person before they confirm. What a confirmed call makes is what the preview said at
 * that moment. It replaces the live grant of a role it covers, as `createAccessGrant`
 * does, and audits the whole as `access.shortcut-used` with the number of grants, besides
 * the event of each grant. Reading the person's data to find what they filled in is a read
 * like any other and writes a `sensitive.read` event.
 *
 * The same people may use it as may use `createAccessGrant`, and the same refusals apply,
 * with `invalid-groups` for a group the category does not have. A call that is not a
 * preview by staff for a person without an account needs the consent.
 *
 * For a person with an account it holds the account's user row `FOR KEY SHARE`
 * (`holdAccount`) once its other checks have passed, a preview too, and refuses an account
 * that is deleted, whichever category. A call that writes then holds the person's access
 * profile `FOR SHARE` from the moment it reads it, until the transaction ends. Deleting the
 * account takes the user row `FOR UPDATE` and then the profile row, and deleting the profile
 * ends the person's accessibility grants, so neither may commit between this read and the
 * writes it leads to. Both go user row first, so they queue and cannot deadlock: a deletion
 * waits for a call that has started and then ends the grants it made, and a call that meets
 * a deletion in progress waits for it, finds the account deleted and is refused (CLAUDE.md,
 * Data rules: lock order).
 *
 * @throws SensitiveAccessDeniedError, AccessGrantRefusedError, AccessGrantBusyError and
 * RecordWriteError, as for `createAccessGrant`. Nothing is written when one is thrown.
 * @throws AccountDeletedError (after auditing the refusal) when the person's account is
 * deleted, for a preview as for a confirmed call, and before any answer that no role is
 * suggested. Only the holder of the account reaches this, since nobody else shares for them.
 */
export async function shareWithSuggestedRoles(
  tx: Tx,
  ctx: SensitiveContext,
  projectId: string,
  personId: string,
  category: AccessGrantCategory,
  options: ShareOptions = {},
): Promise<ShareResult> {
  const checkedCategory = await grantableCategory(tx, ctx, category);
  const subject = await authorise(
    tx,
    ctx,
    { projectId, personId },
    checkedCategory,
    'grant',
  );
  const now = ctx.clock();
  const where = { person: subject.person, project: subject.project };
  const preview = options.preview === true;

  const offered: readonly string[] =
    checkedCategory === 'accessibility' ? SHAREABLE_ACCESS_GROUPS : ['medical'];
  const asked: unknown = options.groups;
  const groups =
    asked === undefined
      ? [...offered]
      : Array.isArray(asked) &&
          asked.length > 0 &&
          asked.every(
            (group): group is string =>
              typeof group === 'string' && offered.includes(group),
          )
        ? [...new Set(asked)]
        : null;
  if (groups === null) {
    return refuse(tx, ctx, where, checkedCategory, 'invalid-groups');
  }
  const consent = preview
    ? null
    : await consentColumns(
        tx,
        ctx,
        subject,
        checkedCategory,
        options.consent,
        now,
      );
  await requireLiveProject(tx, ctx, subject, checkedCategory, now);
  // The last refusal, and the first hold on the person's rows, before anything else of
  // theirs is read or locked (CLAUDE.md, Data rules: lock order). The deletion of the account
  // takes the user row `FOR UPDATE` and then the profile row, so both go user row first, and
  // a call that waits here holds nothing on the profile and cannot deadlock with it. A
  // preview is refused and holds the same row, so a client is never shown a share that a
  // confirmed call would refuse; the hold is the weakest row lock, and only the deletion of
  // the account waits for it.
  await requireLiveAccount(tx, ctx, subject, checkedCategory);

  // When the organisation suggests no role for the groups asked about, there is nobody to
  // share with: say so, as an empty preview, and neither read the person's data nor write
  // anything. The refusals above come first, so a bad request is still refused. The
  // setting is read once, and what is shared below is what this read says.
  const suggested = await readSuggestedRoles(tx, subject.person.organisationId);
  if (
    !SUGGESTED_ROLE_GROUPS.some(
      (group) => groups.includes(group) && suggested.has(group),
    )
  ) {
    return {
      preview: true,
      shares: [],
      granted: 0,
      reason: 'no-suggested-roles',
    };
  }

  // The caller is allowed to see all of it: the person, or staff who edit it. A call that
  // will write holds the profile `FOR SHARE` from this read to its commit: deleting the
  // profile ends the person's accessibility grants, and without the lock it could commit
  // between this read and the writes below, leaving grants of a profile that is gone.
  const source = await loadGovernedSource(tx, subject.person, checkedCategory, {
    lockProfile: !preview,
  });
  const payload = source?.payload ?? {};
  await recordAudit(tx, {
    actor: auditActor(ctx),
    organisationId: subject.person.organisationId,
    category: 'sensitive.read',
    action: 'read',
    targetType: 'person',
    targetId: subject.person.id,
    details: {
      category: checkedCategory,
      fieldCount: Object.keys(payload).length,
      ...tokenMark(ctx),
    },
    requestId: ctx.requestId ?? null,
    occurredAt: now,
  });

  const byRole = new Map<string, Set<string>>();
  for (const group of groups) {
    const filled = filledKeys(checkedCategory, group, payload);
    if (filled.length === 0) continue;
    // The setting's own list names the group, so a group it does not know shares nothing.
    const settingKey: SuggestedRoleGroup | undefined =
      SUGGESTED_ROLE_GROUPS.find((candidate) => candidate === group);
    if (settingKey === undefined) continue;
    for (const roleId of suggested.get(settingKey) ?? []) {
      const fields = byRole.get(roleId) ?? new Set<string>();
      for (const key of filled) fields.add(key);
      byRole.set(roleId, fields);
    }
  }
  const order = new Map(
    (checkedCategory === 'accessibility'
      ? ACCESS_FIELDS.map((entry) => entry.key as string)
      : [...MEDICAL_FIELDS]
    ).map((key, index) => [key, index]),
  );
  const shares: ShareItem[] = [];
  for (const roleId of [...byRole.keys()].sort()) {
    if (
      !(await roleIsAvailable(
        tx,
        subject.person.organisationId,
        subject.project.id,
        roleId,
      ))
    ) {
      continue;
    }
    shares.push({
      roleId,
      fields: [...byRole.get(roleId)!].sort(
        (a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0),
      ),
    });
  }
  if (preview || consent === null) {
    return { preview: true, shares, granted: 0 };
  }

  await guardedSensitive('access_grant', 'insert', () =>
    tx.transaction(async (inner) => {
      for (const share of shares) {
        await writeGrant(
          inner,
          ctx,
          {
            subject,
            category: checkedCategory,
            roleId: share.roleId,
            fields: share.fields,
            consent,
          },
          now,
        );
      }
      await recordAudit(inner, {
        actor: auditActor(ctx),
        organisationId: subject.person.organisationId,
        projectId: subject.project.id,
        category: ACCESS_AUDIT.shortcutUsed,
        action: 'share',
        targetType: 'person',
        targetId: subject.person.id,
        details: {
          category: checkedCategory,
          count: shares.length,
          onBehalf: consent.onBehalf,
          ...tokenMark(ctx),
        },
        requestId: ctx.requestId ?? null,
        occurredAt: now,
      });
    }),
  );
  return { preview: false, shares, granted: shares.length };
}
