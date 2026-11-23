import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { AccessDeniedError } from '../access/access-denied-error.js';
import {
  hasOrganisationPermission,
  organisationPermissionReaches,
} from '../access/organisation-permission.js';
import {
  accessReset,
  orgMembership,
  passkeyCredential,
  passwordCredential,
  recoveryCode,
  totpCredential,
  user,
} from '../db/schema/index.js';
import { RecordNotFoundError, type Tx } from '../db/write.js';
import { MEMBERS_RESET_ACCESS_PERMISSION } from '../members/permissions.js';
import {
  AccessResetInvalidError,
  CannotResetSelfError,
  OwnerResetNeedsOwnerError,
  ResetExceedsOwnAccessError,
  UserInOtherOrganisationsError,
  UserNotActiveError,
  type AccessResetRefusalReason,
} from './access-reset-errors.js';
import { AuthInputError, AuthStateError } from './errors.js';
import { grantsOfMember, uncoveredPermissions } from './escalation.js';
import {
  revokeUserSessions,
  SESSION_USER_COLUMNS,
  type SessionUser,
} from './sessions.js';
import {
  AUTH_AUDIT,
  guardedAuth,
  lockUser,
  recordAuthAudit,
  serverId,
} from './shared.js';
import { generateToken, hashToken } from './tokens.js';

/**
 * Admin reset links (SC-10, decision D-57, which closes O-14). An administrator
 * makes a one-time link for a member who is locked out (a forgotten password, a
 * lost authenticator device, a lost passkey), shows it once and passes it on by any
 * channel. Whoever opens it signs in with a recovery-scope session and must set a
 * new password or add a passkey. OSFPM sends nothing: the link is shown once, in the
 * response that makes it. The token is the same kind as a session token
 * (`generateToken`), only its SHA-256 hash is stored, and it is never logged,
 * audited or returned again. `access_reset` is a security table: only this service
 * writes it, directly, and every change is audited instead of change-logged. The
 * write helper refuses it (`SecurityTableWriteError`).
 *
 * Pass the transaction handle and the time as `now`. The services that decide for a
 * signed-in person (`createAccessReset`, `revokeAccessReset`) check
 * `members:reset-access` themselves; the two that take a token (`inspectAccessReset`,
 * `useAccessReset`) check no permission, because the token is the capability, and
 * `useAccessReset` instead checks again that the person who made the link could
 * still make it.
 *
 * Who may reset whom (`checkRules`), checked when the link is made and again when it
 * is used, with the creator as the actor:
 * 1. the actor holds `members:reset-access` in the organisation (and can sign in);
 * 2. the person is not the actor: people reset themselves with their recovery codes;
 * 3. every membership the person has, in any status, is in this organisation, so an
 *    administrator of one company cannot take over an account that also belongs to
 *    another (such a person recovers with their own recovery codes, or through the
 *    server's own administration);
 * 4. an owner can only be reset by an owner;
 * 5. no escalation: the actor holds every permission the person holds in the
 *    organisation, at the same reach or wider (`escalation.ts`, the rule invites use);
 * 6. the person's account is active.
 *
 * Lock order (CLAUDE.md, Data rules). Making and revoking a link take no change
 * counter and no user lock, only the rows of the links they replace, and no writer
 * that holds a counter ever waits for such a row. A use takes the link row first
 * (`FOR UPDATE`) and the person's user row last (`FOR UPDATE`, `lockUser` with
 * `strength: 'update'`), and nothing in between: that row is also what an
 * `acceptInvite` for the same person takes last. Whichever of the two gets the user
 * row first, the other waits; the use then re-reads the person's memberships under
 * the lock, so it either finishes before a second membership exists or sees it and
 * is refused. `FOR UPDATE` also holds off every other insert that points at the
 * user, which a foreign key check blocks, so the exclusion does not rest on one
 * writer. The permission, tier and role checks read without a lock: the roles of
 * the people involved changing a moment later is not what they guard.
 */

/**
 * How long a reset link works, in hours: a day unless the caller asks for another
 * number between `minHours` and `maxHours`. Not a legal or financial number.
 */
export const ACCESS_RESET_LIFETIME = {
  defaultHours: 24,
  minHours: 1,
  maxHours: 72,
} as const;

const HOUR_MS = 60 * 60 * 1000;

/** A real token is 43 characters; anything this long is not one and is not hashed. */
const MAX_TOKEN_LENGTH = 256;

/** What a UUID looks like, so a value that is not one never reaches a `uuid` column. */
const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The person making, revoking or (at use) standing behind a link. */
export type AccessResetActor = {
  /** The signed-in user. The permission is checked for them, in the organisation. */
  readonly userId: string;
};

/** What `createAccessReset` is given. */
export type CreateAccessResetInput = {
  /** `ACCESS_RESET_LIFETIME.defaultHours` when left out. */
  readonly expiresInHours?: number;
  /** Whether using the link also revokes every passkey of the person. False when left out. */
  readonly removePasskeys?: boolean;
};

/** A link as the services show it: never the token or its hash. */
export type AccessResetView = {
  readonly id: string;
  readonly organisationId: string;
  /** The person the link is for. */
  readonly userId: string;
  readonly removePasskeys: boolean;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly createdBy: string | null;
};

/**
 * What `inspectAccessReset` tells someone who holds a live token: when it ends and
 * nothing else. Not the person's name or address, nor the organisation's: anyone
 * who holds the link could read them.
 */
export type AccessResetInspection = {
  readonly expiresAt: Date;
};

/** What `useAccessReset` answers: who is back in, for the session the caller makes. */
export type UsedAccessReset = {
  /** The person the link was for. */
  readonly user: SessionUser;
  /** The organisation that issued the link. */
  readonly organisationId: string;
};

/** The columns of an `AccessResetView`, without the token hash. */
const viewColumns = {
  id: accessReset.id,
  organisationId: accessReset.organisationId,
  userId: accessReset.userId,
  removePasskeys: accessReset.removePasskeys,
  expiresAt: accessReset.expiresAt,
  createdAt: accessReset.createdAt,
  createdBy: accessReset.createdBy,
};

type CheckedCreate = {
  readonly hours: number;
  readonly removePasskeys: boolean;
};

/**
 * Checks the shape of what `createAccessReset` was given, before anything is looked
 * up. Each refusal names the field and never the value.
 */
function checkedCreate(input: CreateAccessResetInput): CheckedCreate {
  const hours = input.expiresInHours ?? ACCESS_RESET_LIFETIME.defaultHours;
  if (
    typeof hours !== 'number' ||
    !Number.isInteger(hours) ||
    hours < ACCESS_RESET_LIFETIME.minHours ||
    hours > ACCESS_RESET_LIFETIME.maxHours
  ) {
    throw new AuthInputError('expiresInHours');
  }
  const removePasskeys =
    input.removePasskeys === undefined ? false : input.removePasskeys;
  if (typeof removePasskeys !== 'boolean') {
    throw new AuthInputError('removePasskeys');
  }
  return { hours, removePasskeys };
}

/** The hash a token is stored under, or null for a value that cannot be a token. */
function hashOf(token: unknown): string | null {
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    token.length > MAX_TOKEN_LENGTH
  ) {
    return null;
  }
  return hashToken(token);
}

/** Why a link is, or is not, usable at `now`. */
type LinkState = 'live' | 'unknown' | 'used' | 'revoked' | 'expired';

/**
 * Whether the row is usable at `now`. Used first, then revoked, then expired, which
 * only decides what the audit event says: a caller is told one thing for all three.
 * `expires_at <= now` counts as expired, as `cleanupAccessResets` counts it.
 */
function stateOf(
  row:
    | {
        readonly usedAt: Date | null;
        readonly revokedAt: Date | null;
        readonly expiresAt: Date;
      }
    | undefined,
  now: Date,
): LinkState {
  if (row === undefined) return 'unknown';
  if (row.usedAt !== null) return 'used';
  if (row.revokedAt !== null) return 'revoked';
  if (row.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'live';
}

/** The first rule for who may reset whom that does not hold, or none. */
type RuleFailure =
  | { readonly rule: 'creator-not-allowed' }
  | { readonly rule: 'target-not-member' }
  | { readonly rule: 'self' }
  | { readonly rule: 'other-organisations' }
  | { readonly rule: 'owner' }
  | { readonly rule: 'exceeds'; readonly permissions: readonly string[] }
  | { readonly rule: 'not-active' };

/**
 * Checks the rules for who may reset whom (see the header), in order, and answers
 * the first that does not hold, or `null`. Used when a link is made, with the person
 * asking as `creatorId`, and again when it is used, with the person who made it. It
 * reads without a lock; `useAccessReset` holds the person's user row, which is what
 * keeps a second membership from appearing while it decides.
 *
 * The person's memberships are read in every organisation, in every status, a
 * deleted row too: a row that was ever made counts as a membership, as it does when
 * an invite finds that someone already belongs. Only an undeleted row in this
 * organisation makes the person a member of it.
 */
async function checkRules(
  tx: Tx,
  creatorId: string,
  organisationId: string,
  personId: string,
): Promise<RuleFailure | null> {
  // Rule 1. A creator who can no longer sign in (disabled or deleted) is no longer
  // one who may make a link, however they are still listed.
  const [creator] = await tx
    .select({ status: user.status, deletedAt: user.deletedAt })
    .from(user)
    .where(eq(user.id, creatorId))
    .limit(1);
  if (
    creator === undefined ||
    creator.deletedAt !== null ||
    creator.status === 'disabled' ||
    !(await hasOrganisationPermission(
      tx,
      creatorId,
      organisationId,
      MEMBERS_RESET_ACCESS_PERMISSION,
    ))
  ) {
    return { rule: 'creator-not-allowed' };
  }

  const memberships = await tx
    .select({
      organisationId: orgMembership.organisationId,
      tier: orgMembership.orgRole,
      deletedAt: orgMembership.deletedAt,
    })
    .from(orgMembership)
    .where(eq(orgMembership.userId, personId));
  const here = memberships.find(
    (found) =>
      found.organisationId === organisationId && found.deletedAt === null,
  );
  if (here === undefined) return { rule: 'target-not-member' };

  // Rule 2.
  if (personId === creatorId) return { rule: 'self' };

  // Rule 3.
  if (memberships.some((found) => found.organisationId !== organisationId)) {
    return { rule: 'other-organisations' };
  }

  // Rule 4. The creator holds the permission, so their membership is active.
  if (here.tier === 'owner') {
    const [mine] = await tx
      .select({ tier: orgMembership.orgRole })
      .from(orgMembership)
      .where(
        and(
          eq(orgMembership.organisationId, organisationId),
          eq(orgMembership.userId, creatorId),
          eq(orgMembership.status, 'active'),
          isNull(orgMembership.deletedAt),
        ),
      )
      .limit(1);
    if (mine?.tier !== 'owner') return { rule: 'owner' };
  }

  // Rule 5.
  const missing = uncoveredPermissions(
    await organisationPermissionReaches(tx, creatorId, organisationId),
    await grantsOfMember(tx, organisationId, personId),
  );
  if (missing.length > 0) return { rule: 'exceeds', permissions: missing };

  // Rule 6.
  const [person] = await tx
    .select({ status: user.status, deletedAt: user.deletedAt })
    .from(user)
    .where(eq(user.id, personId))
    .limit(1);
  if (
    person === undefined ||
    person.deletedAt !== null ||
    person.status !== 'active'
  ) {
    return { rule: 'not-active' };
  }
  return null;
}

/**
 * The error a failed rule becomes when a link is made. A creator without the
 * permission and a person who is not a member of the organisation are the same
 * refusal, with no scope, as for an organisation named by id elsewhere: it never
 * says whether the person, or the organisation, exists (CLAUDE.md, Code rules).
 */
function creationError(failure: RuleFailure): Error {
  switch (failure.rule) {
    case 'creator-not-allowed':
    case 'target-not-member':
      return new AccessDeniedError(MEMBERS_RESET_ACCESS_PERMISSION);
    case 'self':
      return new CannotResetSelfError();
    case 'other-organisations':
      return new UserInOtherOrganisationsError();
    case 'owner':
      return new OwnerResetNeedsOwnerError();
    case 'exceeds':
      return new ResetExceedsOwnAccessError(failure.permissions);
    case 'not-active':
      return new UserNotActiveError();
  }
}

/** The reason a failed rule is given in the audit event when a link is used. */
function useRefusalReason(failure: RuleFailure): AccessResetRefusalReason {
  switch (failure.rule) {
    case 'creator-not-allowed':
      return 'creator-not-allowed';
    case 'target-not-member':
      return 'target-not-member';
    case 'self':
      return 'target-is-creator';
    case 'other-organisations':
      return 'target-in-other-organisations';
    case 'owner':
      return 'target-is-owner';
    case 'exceeds':
      return 'target-exceeds-creator';
    case 'not-active':
      return 'target-not-active';
  }
}

/**
 * Refuses unless `userId` holds `members:reset-access` in `organisationId`. The
 * organisation was named by id, so the refusal carries no scope and is the same for
 * an organisation that does not exist, one the user is not in, and one they are in
 * without the permission. Not audited: only sensitive data and legal holds audit a
 * denial.
 */
async function requireResetPermission(
  tx: Tx,
  userId: string,
  organisationId: string,
): Promise<void> {
  if (
    !UUID_SHAPE.test(userId) ||
    !UUID_SHAPE.test(organisationId) ||
    !(await hasOrganisationPermission(
      tx,
      userId,
      organisationId,
      MEMBERS_RESET_ACCESS_PERMISSION,
    ))
  ) {
    throw new AccessDeniedError(MEMBERS_RESET_ACCESS_PERMISSION);
  }
}

/**
 * Locks the live links of one person in one organisation (`FOR UPDATE`, in id
 * order) and revokes them, audited one by one with `reason`. Returns how many it
 * revoked. Takes the rows it replaces and nothing else, so it cannot form a cycle
 * with a use, which takes the link row before the user row.
 */
async function revokeLiveLinks(
  tx: Tx,
  actorId: string,
  organisationId: string,
  userId: string,
  reason: 'manual' | 'superseded',
  now: Date,
): Promise<number> {
  const live = await tx
    .select({ id: accessReset.id })
    .from(accessReset)
    .where(
      and(
        eq(accessReset.organisationId, organisationId),
        eq(accessReset.userId, userId),
        isNull(accessReset.usedAt),
        isNull(accessReset.revokedAt),
        gt(accessReset.expiresAt, now),
      ),
    )
    .orderBy(asc(accessReset.id))
    .for('update');
  for (const found of live) {
    await tx
      .update(accessReset)
      .set({
        revokedAt: now,
        revokedBy: actorId,
        updatedAt: now,
        updatedBy: actorId,
        version: sql`${accessReset.version} + 1`,
      })
      .where(eq(accessReset.id, found.id));
    await recordAuthAudit(tx, {
      category: AUTH_AUDIT.accessResetRevoked,
      action: 'revoke',
      actor: { type: 'user', id: actorId },
      targetType: 'access_reset',
      targetId: found.id,
      organisationId,
      details: { userId, reason },
      occurredAt: now,
    });
  }
  return live.length;
}

/**
 * Makes a reset link for a member and returns it with its token, which exists
 * nowhere else: the caller builds the link from it and shows it once. Needs
 * `members:reset-access` in the organisation, and the rules for who may reset whom
 * (see the header) must hold: the person is a member of the organisation, is not the
 * actor, belongs to no other organisation, is not an owner unless the actor is one,
 * holds nothing the actor does not hold, and has an active account. The link lasts
 * `expiresInHours` (1 to 72, 24 when left out) from `now`, and `removePasskeys` says
 * whether using it also revokes the person's passkeys.
 *
 * Any earlier live link for the same person in the organisation is revoked first,
 * audited as revoked with the reason `superseded`; links that were used, revoked or
 * have expired are left as they are. Audited as `auth.access-reset-created` with the
 * link id, the organisation, the person, the expiry and `removePasskeys`, and never
 * the token or an address. Takes no change counter and no user lock, so it cannot
 * deadlock with a use or an accept. Two links made for one person at the very same
 * moment can both stay live; each works until it is used or ends.
 *
 * @throws AccessDeniedError, with no scope, without the permission, and for a
 * person who is not a member of the organisation or is not a user: the same answer
 * for all, so ids cannot be probed.
 * @throws CannotResetSelfError, UserInOtherOrganisationsError,
 * OwnerResetNeedsOwnerError, ResetExceedsOwnAccessError (its `permissions` lists the
 * keys) and UserNotActiveError, for rules 2 to 6, in that order. Nothing is written.
 * @throws AuthInputError `expiresInHours` or `removePasskeys` for a value that is
 * not acceptable. It names the field and never the value.
 * @throws AuthStateError `installation-missing` before the installation row exists.
 * @throws RecordWriteError when the database refuses a write; it carries the
 * SQLSTATE and constraint name only, never the token, its hash or an address.
 */
export async function createAccessReset(
  tx: Tx,
  actor: AccessResetActor,
  organisationId: string,
  userId: string,
  input: CreateAccessResetInput,
  now: Date,
): Promise<{ reset: AccessResetView; token: string }> {
  const checked = checkedCreate(input);
  return guardedAuth('access_reset', 'insert', () =>
    // A savepoint: a failure leaves no link, no revocation and no event.
    tx.transaction(async (inner) => {
      // An id that is not shaped like one is nobody's: the same denial.
      if (
        !UUID_SHAPE.test(actor.userId) ||
        !UUID_SHAPE.test(organisationId) ||
        !UUID_SHAPE.test(userId)
      ) {
        throw new AccessDeniedError(MEMBERS_RESET_ACCESS_PERMISSION);
      }
      const failure = await checkRules(
        inner,
        actor.userId,
        organisationId,
        userId,
      );
      if (failure !== null) throw creationError(failure);

      await revokeLiveLinks(
        inner,
        actor.userId,
        organisationId,
        userId,
        'superseded',
        now,
      );

      const origin = await serverId(inner);
      const token = generateToken();
      const expiresAt = new Date(now.getTime() + checked.hours * HOUR_MS);
      const [row] = await inner
        .insert(accessReset)
        .values({
          originServer: origin,
          organisationId,
          userId,
          tokenHash: hashToken(token),
          removePasskeys: checked.removePasskeys,
          expiresAt,
          createdAt: now,
          updatedAt: now,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        })
        .returning(viewColumns);
      await recordAuthAudit(inner, {
        category: AUTH_AUDIT.accessResetCreated,
        action: 'create',
        actor: { type: 'user', id: actor.userId },
        targetType: 'access_reset',
        targetId: row!.id,
        organisationId,
        details: {
          userId,
          expiresAt: expiresAt.toISOString(),
          removePasskeys: checked.removePasskeys,
        },
        occurredAt: now,
      });
      return { reset: row!, token };
    }),
  );
}

/**
 * Revokes the live link of a person, so it stops working. Needs
 * `members:reset-access` in the organisation, and only that: it takes the link away
 * and gives nobody anything, so it does not ask the rules for who may reset whom.
 * It takes the row locks of the live links (`FOR UPDATE`) and looks again under
 * them, so a revoke that runs at the same moment as a use of the same link either
 * goes first, and the use is refused, or waits for the use and finds no live link:
 * never both. It takes no change counter and no user lock, so it cannot form a cycle
 * with a use or an accept.
 *
 * Audited as `auth.access-reset-revoked` with the reason `manual`, no token.
 *
 * @throws AccessDeniedError, with no scope, without the permission.
 * @throws RecordNotFoundError when the person has no live link in this organisation:
 * none was made, it was used, revoked or has expired, or the person is not a member
 * or not a user. The same answer for all, so ids cannot be probed.
 * @throws RecordWriteError when the database refuses a write; it carries the
 * SQLSTATE only.
 */
export function revokeAccessReset(
  tx: Tx,
  actor: AccessResetActor,
  organisationId: string,
  userId: string,
  now: Date,
): Promise<void> {
  return guardedAuth('access_reset', 'update', () =>
    tx.transaction(async (inner) => {
      await requireResetPermission(inner, actor.userId, organisationId);
      if (!UUID_SHAPE.test(userId)) {
        throw new RecordNotFoundError('access_reset', userId);
      }
      const revoked = await revokeLiveLinks(
        inner,
        actor.userId,
        organisationId,
        userId,
        'manual',
        now,
      );
      if (revoked === 0) throw new RecordNotFoundError('access_reset', userId);
    }),
  );
}

/**
 * What the holder of a live token may be told about it: when it ends, and nothing
 * else. Not the person's name or address, not the organisation's name: anyone who
 * holds the link could read them. Checks no permission: the token is the capability,
 * and a web page calls this to show the person that the link is good before they
 * use it. Writes nothing for a live token. It also checks the rules for who may
 * reset whom, as a use does, but without the locks a use takes, and refuses a link
 * a use would refuse, so a page does not show a link as good that then fails. It is
 * only a look: `useAccessReset` checks again under the locks.
 *
 * Every failure is the same `AccessResetInvalidError`, whether the token is unknown,
 * expired, revoked or used, or a rule no longer holds, so a caller learns nothing
 * about which. The cause goes into the audit event
 * `auth.access-reset-inspect-failed` (from the system, the link id when there is
 * one, and never the token or its hash), which is written before the error is
 * thrown: the caller catches the error inside its transaction and commits, so the
 * event survives (CLAUDE.md, Data rules).
 *
 * @throws AccessResetInvalidError for a token that is no good.
 * @throws RecordWriteError when the database fails; it carries the SQLSTATE only,
 * never the token or its hash.
 */
export async function inspectAccessReset(
  tx: Tx,
  token: string,
  now: Date,
): Promise<AccessResetInspection> {
  const hash = hashOf(token);
  const found =
    hash === null
      ? undefined
      : await guardedAuth('access_reset', 'select', async () => {
          const [row] = await tx
            .select({
              id: accessReset.id,
              organisationId: accessReset.organisationId,
              userId: accessReset.userId,
              createdBy: accessReset.createdBy,
              expiresAt: accessReset.expiresAt,
              usedAt: accessReset.usedAt,
              revokedAt: accessReset.revokedAt,
            })
            .from(accessReset)
            .where(eq(accessReset.tokenHash, hash))
            .limit(1);
          return row;
        });
  const state = stateOf(found, now);
  let reason: AccessResetRefusalReason;
  if (state === 'live') {
    const link = found!;
    const failure = await guardedAuth('access_reset', 'select', () =>
      link.createdBy === null
        ? Promise.resolve<RuleFailure>({ rule: 'creator-not-allowed' })
        : checkRules(tx, link.createdBy, link.organisationId, link.userId),
    );
    if (failure === null) return { expiresAt: link.expiresAt };
    reason = useRefusalReason(failure);
  } else {
    reason = state;
  }
  await guardedAuth('audit_event', 'insert', () =>
    recordAuthAudit(tx, {
      category: AUTH_AUDIT.accessResetInspectFailed,
      action: 'inspect',
      actor: { type: 'system', id: null },
      targetType: found === undefined ? null : 'access_reset',
      targetId: found?.id ?? null,
      organisationId: found?.organisationId ?? null,
      details: { reason },
      occurredAt: now,
    }),
  );
  throw new AccessResetInvalidError(reason);
}

/** A refusal found inside the use, returned so the savepoint can be undone before it is audited. */
type UseRefusal = {
  readonly ok: false;
  readonly reason: AccessResetRefusalReason;
  readonly link: {
    readonly id: string;
    readonly organisationId: string;
  } | null;
};

/** Thrown inside the savepoint to undo every step so far, and carried out to answer a refusal. */
class UseRolledBack extends Error {
  constructor(readonly refusal: UseRefusal) {
    super('The reset link was not used');
    this.name = 'UseRolledBack';
  }
}

/**
 * The steps of a use, in the caller's savepoint. A refusal is returned and the
 * caller undoes the savepoint; anything the database refuses is thrown.
 *
 * The order is the rule of CLAUDE.md (Data rules), and nothing sits between the two
 * locks: the link row is locked and judged (`FOR UPDATE`, found by the hash of the
 * token), then the person's user row (`FOR UPDATE`, last), then the rules for who
 * may reset whom are checked again with the creator as the actor, and only then does
 * anything change: every session of the person is revoked, the password, the
 * authenticator and the recovery codes are deleted, the passkeys are revoked when
 * the link says so, and the link is marked used.
 *
 * The passkeys are revoked, not deleted, as `revokePasskey` does it: a session may
 * point at the passkey that opened it, the credential id must stay taken, and the
 * trail must still be able to name it.
 */
async function runUse(
  tx: Tx,
  hash: string | null,
  now: Date,
): Promise<UseRefusal | { readonly ok: true; readonly used: UsedAccessReset }> {
  const refuse = (
    reason: AccessResetRefusalReason,
    link: UseRefusal['link'],
  ): UseRefusal => ({ ok: false, reason, link });
  if (hash === null) return refuse('unknown', null);

  const [locked] = await tx
    .select({
      id: accessReset.id,
      organisationId: accessReset.organisationId,
      userId: accessReset.userId,
      createdBy: accessReset.createdBy,
      removePasskeys: accessReset.removePasskeys,
      expiresAt: accessReset.expiresAt,
      usedAt: accessReset.usedAt,
      revokedAt: accessReset.revokedAt,
    })
    .from(accessReset)
    .where(eq(accessReset.tokenHash, hash))
    .limit(1)
    .for('update');
  const state = stateOf(locked, now);
  if (state !== 'live') {
    return refuse(
      state,
      locked === undefined
        ? null
        : { id: locked.id, organisationId: locked.organisationId },
    );
  }
  const found = locked!;
  const known = { id: found.id, organisationId: found.organisationId };

  // The person's row, last. A person who was deleted since is not there to lock.
  try {
    await lockUser(tx, found.userId, { strength: 'update' });
  } catch (error) {
    if (error instanceof AuthStateError) {
      return refuse('target-not-active', known);
    }
    throw error;
  }
  if (found.createdBy === null) return refuse('creator-not-allowed', known);
  const failure = await checkRules(
    tx,
    found.createdBy,
    found.organisationId,
    found.userId,
  );
  if (failure !== null) return refuse(useRefusalReason(failure), known);

  const sessionsRevoked = await revokeUserSessions(tx, found.userId, {
    reason: 'access-reset',
    now,
  });
  const passwordCleared =
    (
      await tx
        .delete(passwordCredential)
        .where(eq(passwordCredential.userId, found.userId))
        .returning({ id: passwordCredential.id })
    ).length > 0;
  const totpRemoved =
    (
      await tx
        .delete(totpCredential)
        .where(eq(totpCredential.userId, found.userId))
        .returning({ id: totpCredential.id })
    ).length > 0;
  const recoveryCodesRemoved = (
    await tx
      .delete(recoveryCode)
      .where(eq(recoveryCode.userId, found.userId))
      .returning({ id: recoveryCode.id })
  ).length;
  const passkeysRemoved = found.removePasskeys
    ? (
        await tx
          .update(passkeyCredential)
          .set({
            revokedAt: now,
            version: sql`${passkeyCredential.version} + 1`,
            updatedAt: now,
            updatedBy: null,
          })
          .where(
            and(
              eq(passkeyCredential.userId, found.userId),
              isNull(passkeyCredential.revokedAt),
            ),
          )
          .returning({ id: passkeyCredential.id })
      ).length
    : 0;

  await tx
    .update(accessReset)
    .set({
      usedAt: now,
      updatedAt: now,
      updatedBy: found.userId,
      version: sql`${accessReset.version} + 1`,
    })
    .where(eq(accessReset.id, found.id));
  await recordAuthAudit(tx, {
    category: AUTH_AUDIT.accessResetUsed,
    action: 'use',
    actor: { type: 'user', id: found.userId },
    targetType: 'access_reset',
    targetId: found.id,
    organisationId: found.organisationId,
    details: {
      userId: found.userId,
      sessionsRevoked,
      passwordCleared,
      totpRemoved,
      recoveryCodesRemoved,
      passkeysRemoved,
    },
    occurredAt: now,
  });

  const [person] = await tx
    .select(SESSION_USER_COLUMNS)
    .from(user)
    .where(eq(user.id, found.userId))
    .limit(1);
  return {
    ok: true,
    used: { user: person!, organisationId: found.organisationId },
  };
}

/**
 * Uses a reset link, in one savepoint, so a failure at any step leaves nothing and
 * the link stays usable: locks the link and checks that it is live, locks the
 * person's user row, checks the rules for who may reset whom again (with the person
 * who made the link as the actor), revokes every session of the person, deletes
 * their password, their authenticator secret and every recovery code, revokes every
 * passkey when the link says so, and marks the link used. Checks no permission: the
 * token is the capability. The caller then makes the session, with method `reset`,
 * which `createSession` always gives the `recovery` scope: the person may only set a
 * new password or add a passkey. The caller makes it in the same transaction, while
 * the user row is still held, and must ignore any session cookie the request came
 * with.
 *
 * Two uses of one token at once use it once: the second waits for the row, then finds
 * it used. A use and a revoke at once end with the link used or revoked, never both.
 * A use and an accept of an invite for the same person, which gives them a second
 * membership, never both go through: either the use finishes first and the accept
 * follows, or the use is refused (see the header).
 *
 * Every refusal is the same `AccessResetInvalidError`, whatever the cause: a token
 * that is unknown, expired, revoked or used, and a rule that no longer holds (the
 * person joined another organisation, the creator lost the permission or can no
 * longer sign in, the person became an owner and the creator is not one, holds more
 * than the creator, is not active or no longer a member). The cause goes into the
 * audit event `auth.access-reset-use-refused` (from the system, the link id when
 * there is one, a reason code and never the token), which is written after the
 * savepoint is undone and before the error is thrown: the caller catches it inside
 * its transaction and commits, so the event survives. Success is
 * `auth.access-reset-used` with the person's id, the number of sessions revoked,
 * whether a password was cleared and an authenticator removed, the number of
 * recovery codes and of passkeys removed. Never the token, a hash, a password or an
 * address.
 *
 * @throws AccessResetInvalidError for a token that is no good or a rule that no
 * longer holds: one error for all, whatever the cause.
 * @throws RecordWriteError when the database refuses a write; it carries the
 * SQLSTATE and constraint name only, never the token or its hash.
 */
export async function useAccessReset(
  tx: Tx,
  token: string,
  now: Date,
): Promise<UsedAccessReset> {
  const hash = hashOf(token);
  try {
    return await tx.transaction(async (inner) => {
      const outcome = await guardedAuth('access_reset', 'update', () =>
        runUse(inner, hash, now),
      );
      // Thrown here, outside `guardedAuth`, so the savepoint is rolled back with
      // the sessions, the credentials and the used mark in it.
      if (!outcome.ok) throw new UseRolledBack(outcome);
      return outcome.used;
    });
  } catch (error) {
    if (!(error instanceof UseRolledBack)) throw error;
    const { refusal } = error;
    // After the rollback, so the event is not undone with the rest.
    await guardedAuth('audit_event', 'insert', () =>
      recordAuthAudit(tx, {
        category: AUTH_AUDIT.accessResetUseRefused,
        action: 'use',
        actor: { type: 'system', id: null },
        targetType: refusal.link === null ? null : 'access_reset',
        targetId: refusal.link?.id ?? null,
        organisationId: refusal.link?.organisationId ?? null,
        details: { reason: refusal.reason },
        occurredAt: now,
      }),
    );
    throw new AccessResetInvalidError(refusal.reason);
  }
}
