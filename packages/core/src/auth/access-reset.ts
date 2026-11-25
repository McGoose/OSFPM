import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { AccessDeniedError } from '../access/access-denied-error.js';
import {
  hasOrganisationPermission,
  organisationPermissionReaches,
} from '../access/organisation-permission.js';
import {
  ACCESS_RESET_LIVE_INDEX,
  accessReset,
  orgMembership,
  orgMembershipRole,
  passkeyCredential,
  passwordCredential,
  recoveryCode,
  role,
  totpCredential,
  user,
} from '../db/schema/index.js';
import { RecordNotFoundError, RecordWriteError, type Tx } from '../db/write.js';
import { MEMBERS_RESET_ACCESS_PERMISSION } from '../members/permissions.js';
import {
  AccessResetInvalidError,
  CannotResetSelfError,
  MembershipNotActiveError,
  OwnerResetNeedsOwnerError,
  ResetExceedsOwnAccessError,
  ResetLinkBusyError,
  UserInOtherOrganisationsError,
  UserNotActiveError,
  type AccessResetRefusalReason,
} from './access-reset-errors.js';
import { ADMINISTRATOR_ROLE_KEY } from './administrator-role.js';
import { revokeApiTokensOfUser } from './api-tokens.js';
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
  type AuthActor,
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
 * 6. the person's account is active;
 * 7. the person's membership of the organisation is active: not removed, and not
 *    still only an invitation. It is checked last, so that an account that is
 *    disabled, or a membership elsewhere, is the answer first.
 *
 * Links the system issues (P-09a2, decision D-81). The admin command line has no
 * signed-in person to act as, and an organisation whose sole administrator has lost
 * every way to sign in has no one to ask, so `createSystemAccessReset` makes a link
 * with no creator (`issued_by_system`). It goes through the same code as
 * `createAccessReset`: the same locks in the same order, the same single live link
 * per person, and the same use. What differs is the rule set (`checkSystemRules`),
 * checked when the link is made, when it is inspected and again when it is used:
 * the person's account is active (rule 6); the person's membership of the
 * organisation is active (rule 7, and "not a member"); and the person is an owner of
 * the organisation or holds its managed Administrator role through
 * `org_membership_role` (`not-an-administrator`). Everyone else is helped by their
 * own administrator, with a link of the first kind. Rules 1, 2, 4 and 5 do not apply,
 * because there is no creator. Rule 3 does not apply either: shell access to the
 * server is install-wide, so the organisations a person belongs to do not decide
 * whether they may be helped. A person demoted between making the link and using it
 * is refused at use like any bad link (the one answer), and the refusal is audited
 * with its reason. Earlier links are superseded as the system (`revoked_by_system`).
 *
 * Lock order (CLAUDE.md, Data rules). None of the three takes a change counter, and
 * no writer that holds a counter ever waits for a link row. A use takes the link row
 * first (`FOR UPDATE`) and the person's user row last (`FOR UPDATE`, `lockUser` with
 * `strength: 'update'`), and nothing in between: that row is also what an
 * `acceptInvite` for the same person takes last. Whichever of the two gets the user
 * row first, the other waits; the use then re-reads the person's memberships under
 * the lock, so it either finishes before a second membership exists or sees it and
 * is refused. `FOR UPDATE` also holds off every other insert that points at the
 * user, which a foreign key check blocks, so the exclusion does not rest on one
 * writer. After the user row a use revokes the person's sessions and their personal API
 * tokens (the token rows, in id order); the writers of tokens (`api-tokens.ts`) take the
 * acting person's row `FOR KEY SHARE` before any token row, in that same order, so they
 * cannot deadlock with a use, and a token is never made by a session the use ended. A
 * revoke takes only the link rows.
 *
 * Making a link takes the person's user row `FOR UPDATE` too: what it decides
 * depends on rows that point at the person (their memberships), and two links made
 * for one person at the same moment queue on that row instead of colliding on the
 * index. Holding it, a create reads the person's earlier links with `SKIP LOCKED` and
 * never waits for one: a use holds its link row while it waits for the person's row,
 * so a create that waited for that link would deadlock with it. A link a create
 * skips is one a use or a revoke is working on at that moment. If that transaction
 * has already changed it the index lets the new link through once it ends; if it has
 * not, the index refuses the new link, nothing is written, and the caller is given a
 * `ResetLinkBusyError` (an unlikely race: making the link again works, and the
 * service does not retry). The permission, tier and
 * role checks read without a lock: the roles of the people involved changing a
 * moment later is not what they guard.
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
  /** The person who made the link; null for a link the system issued. */
  readonly createdBy: string | null;
  /** True for a link the system issued (the admin command `emergency-access`), which has no creator. */
  readonly issuedBySystem: boolean;
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
  issuedBySystem: accessReset.issuedBySystem,
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

/**
 * The first rule for who may reset whom that does not hold, or none. The last is
 * only the system's (`checkSystemRules`): a person's link has no such rule.
 */
type RuleFailure =
  | { readonly rule: 'creator-not-allowed' }
  | { readonly rule: 'target-not-member' }
  | { readonly rule: 'self' }
  | { readonly rule: 'other-organisations' }
  | { readonly rule: 'owner' }
  | { readonly rule: 'exceeds'; readonly permissions: readonly string[] }
  | { readonly rule: 'not-active' }
  | { readonly rule: 'membership-not-active' }
  | { readonly rule: 'not-administrator' };

/**
 * Who makes a link, or revokes one: a signed-in person, or the system (the admin
 * command line, decision D-64). The two differ in which rules apply, in whom the row
 * and the audit event name, and in nothing else.
 */
type Issuer =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'system' };

/** The actor an audit event names for `who`. */
function actorOf(who: Issuer): AuthActor {
  return who.kind === 'user'
    ? { type: 'user', id: who.userId }
    : { type: 'system', id: null };
}

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
      status: orgMembership.status,
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

  // Rule 7. Last, so that the answers about the account and about who holds what
  // come first; a member who is not active holds nothing, so rules 4 and 5 are
  // silent about one.
  if (here.status !== 'active') return { rule: 'membership-not-active' };
  return null;
}

/**
 * Whether the membership holds the organisation's managed Administrator role: a live
 * link to a live role that has the key `administrator`, is managed and belongs to no
 * project. A role an organisation made itself never counts, whatever it holds: the
 * tier of a membership grants nothing by itself (decision D-51), and an emergency
 * link signs someone in as an administrator, so it is the one role the server keeps
 * (`administrator-role.ts`) that decides.
 */
async function holdsAdministratorRole(
  tx: Tx,
  organisationId: string,
  membershipId: string,
): Promise<boolean> {
  const [found] = await tx
    .select({ id: orgMembershipRole.id })
    .from(orgMembershipRole)
    .innerJoin(
      role,
      and(
        eq(role.organisationId, orgMembershipRole.organisationId),
        eq(role.id, orgMembershipRole.roleId),
      ),
    )
    .where(
      and(
        eq(orgMembershipRole.organisationId, organisationId),
        eq(orgMembershipRole.membershipId, membershipId),
        isNull(orgMembershipRole.deletedAt),
        eq(role.key, ADMINISTRATOR_ROLE_KEY),
        eq(role.managed, true),
        isNull(role.projectId),
        isNull(role.deletedAt),
      ),
    )
    .limit(1);
  return found !== undefined;
}

/**
 * Checks the rules for a link the system issues (see the header), in order, and
 * answers the first that does not hold, or `null`. There is no creator, so rules 1,
 * 2, 4 and 5 have nothing to say; rule 3 (a membership in another organisation) is
 * not asked either, because the command that issues these links is run with shell
 * access, which is install-wide and has no organisation of its own (decision D-81).
 * What is asked:
 * 1. the person has a live membership of the organisation (`target-not-member`);
 * 2. the person's account is active: not disabled, not only invited, not deleted
 *    (`not-active`, today's rule 6);
 * 3. the membership is active: not removed, not still an invitation
 *    (`membership-not-active`, today's rule 7), checked after the account so that a
 *    disabled account is the answer first, as for a person's link;
 * 4. the person is an owner of the organisation, or holds its managed Administrator
 *    role (`not-administrator`, decision D-81, E2).
 * Reads without a lock; the callers hold the person's user row where it matters
 * (`makeLink`, `runUse`). Checks no permission, which is the point: it is the rule set
 * of a caller that has none.
 */
async function checkSystemRules(
  tx: Tx,
  organisationId: string,
  personId: string,
): Promise<RuleFailure | null> {
  // A deleted row counts as no membership at all.
  const [here] = await tx
    .select({
      id: orgMembership.id,
      tier: orgMembership.orgRole,
      status: orgMembership.status,
    })
    .from(orgMembership)
    .where(
      and(
        eq(orgMembership.organisationId, organisationId),
        eq(orgMembership.userId, personId),
        isNull(orgMembership.deletedAt),
      ),
    )
    .limit(1);
  if (here === undefined) return { rule: 'target-not-member' };

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
  if (here.status !== 'active') return { rule: 'membership-not-active' };

  if (
    here.tier !== 'owner' &&
    !(await holdsAdministratorRole(tx, organisationId, here.id))
  ) {
    return { rule: 'not-administrator' };
  }
  return null;
}

/**
 * Judges a link that exists by the rules of whoever issued it: the system's
 * (`checkSystemRules`) or, for a person's link, the person's (`checkRules`, with the
 * person who made it as the actor). What `inspectAccessReset` and the use of a link
 * ask. Reads without a lock.
 */
function judgeLink(
  tx: Tx,
  link: {
    readonly issuedBySystem: boolean;
    readonly createdBy: string | null;
    readonly organisationId: string;
    readonly userId: string;
  },
): Promise<RuleFailure | null> {
  if (link.issuedBySystem) {
    return checkSystemRules(tx, link.organisationId, link.userId);
  }
  // A person's link names who made it (`access_reset_issuer_check`), so a row with
  // no creator and no system flag cannot exist; were one made by hand, nobody could
  // use it.
  if (link.createdBy === null) {
    return Promise.resolve({ rule: 'creator-not-allowed' });
  }
  return checkRules(tx, link.createdBy, link.organisationId, link.userId);
}

/**
 * The error a failed rule becomes when a link is made. A creator without the
 * permission and a person who is not a member of the organisation are the same
 * refusal, with no scope, as for an organisation named by id elsewhere: it never
 * says whether the person, or the organisation, exists (CLAUDE.md, Code rules).
 */
function creationError(failure: RuleFailure): Error {
  switch (failure.rule) {
    // `not-administrator` is only the system's rule, which never asks this function;
    // were it asked, the refusal for a person that a caller cannot explain is the one
    // for a person who is not theirs to help.
    case 'creator-not-allowed':
    case 'target-not-member':
    case 'not-administrator':
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
    case 'membership-not-active':
      return new MembershipNotActiveError();
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
    case 'membership-not-active':
      return 'target-membership-not-active';
    case 'not-administrator':
      return 'not-an-administrator';
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
 * Revokes the links `ids` of one person, which the caller holds locked, and audits
 * each as revoked with `reason`. The revoker is `who`: a person (`revoked_by`) or
 * the system (`revoked_by_system`), exactly one, as the table requires. Takes no
 * lock of its own.
 */
async function revokeLinks(
  tx: Tx,
  who: Issuer,
  organisationId: string,
  userId: string,
  ids: readonly string[],
  reason: 'manual' | 'superseded',
  now: Date,
): Promise<void> {
  const person = who.kind === 'user' ? who.userId : null;
  for (const id of ids) {
    await tx
      .update(accessReset)
      .set({
        revokedAt: now,
        revokedBy: person,
        revokedBySystem: who.kind === 'system',
        updatedAt: now,
        updatedBy: person,
        version: sql`${accessReset.version} + 1`,
      })
      .where(eq(accessReset.id, id));
    await recordAuthAudit(tx, {
      category: AUTH_AUDIT.accessResetRevoked,
      action: 'revoke',
      actor: actorOf(who),
      targetType: 'access_reset',
      targetId: id,
      organisationId,
      details: { userId, reason },
      occurredAt: now,
    });
  }
}

/**
 * Revokes every earlier link of one person in one organisation that was neither
 * used nor revoked, expired ones included, audited as revoked with the reason
 * `superseded`: the table keeps one such link per person (`access_reset_live_unique`)
 * and `now()` cannot be in that index, so a link past its end still holds the place.
 * The caller holds the person's user row. The links are read `FOR UPDATE SKIP
 * LOCKED`, in id order, so this never waits for a link row: a use holds its link row
 * while it waits for the person's row, so waiting here would be a deadlock (see the
 * lock order in the header). A link another transaction holds is left to it, and the
 * unique index decides what happens to the link made next. `who` is the revoker, as
 * in `revokeLinks`: the person making the next link, or the system.
 */
async function supersedeEarlierLinks(
  tx: Tx,
  who: Issuer,
  organisationId: string,
  userId: string,
  now: Date,
): Promise<void> {
  const earlier = await tx
    .select({ id: accessReset.id })
    .from(accessReset)
    .where(
      and(
        eq(accessReset.organisationId, organisationId),
        eq(accessReset.userId, userId),
        isNull(accessReset.usedAt),
        isNull(accessReset.revokedAt),
      ),
    )
    .orderBy(asc(accessReset.id))
    .for('update', { skipLocked: true });
  await revokeLinks(
    tx,
    who,
    organisationId,
    userId,
    earlier.map((found) => found.id),
    'superseded',
    now,
  );
}

/**
 * Makes a reset link for a member and returns it with its token, which exists
 * nowhere else: the caller builds the link from it and shows it once. Needs
 * `members:reset-access` in the organisation, and the rules for who may reset whom
 * (see the header) must hold: the person is a member of the organisation, is not the
 * actor, belongs to no other organisation, is not an owner unless the actor is one,
 * holds nothing the actor does not hold, has an active account, and has an active
 * membership of this organisation (not removed, not still an invitation). The link lasts
 * `expiresInHours` (1 to 72, 24 when left out) from `now`, and `removePasskeys` says
 * whether using it also revokes the person's passkeys.
 *
 * Any earlier link for the same person in the organisation that was neither used nor
 * revoked is revoked first, expired ones too, audited as revoked with the reason
 * `superseded`: a person has one live link (`access_reset_live_unique`). Links that
 * were used or revoked are left as they are. Audited as `auth.access-reset-created`
 * with the link id, the organisation, the person, the expiry and `removePasskeys`,
 * and never the token or an address. The rules are judged once without a lock, so a
 * caller who may not make this link never takes the person's row, and again after
 * the person's user row is taken `FOR UPDATE` (the lock order is in the header), which
 * is the check that counts. No change counter is taken. Two links made for one
 * person at the same moment queue on that row: both are made, and the later one is
 * the live one.
 *
 * @throws AccessDeniedError, with no scope, without the permission, and for a
 * person who is not a member of the organisation or is not a user: the same answer
 * for all, so ids cannot be probed.
 * @throws CannotResetSelfError, UserInOtherOrganisationsError,
 * OwnerResetNeedsOwnerError, ResetExceedsOwnAccessError (its `permissions` lists the
 * keys), UserNotActiveError and MembershipNotActiveError, for rules 2 to 7, in that
 * order, also when the rule only stops holding while this waits for the person's
 * row (the person was deleted, or lost the membership, a moment ago). Nothing is
 * written.
 * @throws AuthInputError `expiresInHours` or `removePasskeys` for a value that is
 * not acceptable. It names the field and never the value.
 * @throws AuthStateError `installation-missing` before the installation row exists.
 * @throws ResetLinkBusyError, a `RecordStateError`, when the unique index on live
 * links refuses the new link: a use or a revoke held the earlier link at that moment
 * and had not changed it yet, so it could not be superseded. Nothing is written, and
 * making the link again works. The API answers a 409 `reset-link-busy`.
 * @throws RecordWriteError when the database refuses a write in any other way; it
 * carries the SQLSTATE and constraint name only, never the token, its hash or an
 * address.
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
    makeLink(
      tx,
      { kind: 'user', userId: actor.userId },
      organisationId,
      userId,
      checked,
      now,
      creationError,
    ),
  ).catch(busyWhenIndexRefuses(userId));
}

/**
 * Makes a link, and the earlier link of the person superseded, for `issuer`: the code
 * `createAccessReset` and `createSystemAccessReset` share, so that the lock order, the
 * single live link per person and the audit event cannot drift apart. The rules that
 * apply are the issuer's own (`checkRules`, with the person as the actor, or
 * `checkSystemRules`). A rule that does not hold throws what `refusal` makes of it,
 * inside the savepoint, so a refusal leaves no link, no revocation and no event: a
 * person's caller gets the typed error of `creationError`, the system's gets a value
 * it turns into a result. Everything else is as `createAccessReset` documents it.
 */
function makeLink(
  tx: Tx,
  issuer: Issuer,
  organisationId: string,
  userId: string,
  checked: CheckedCreate,
  now: Date,
  refusal: (failure: RuleFailure) => Error,
): Promise<{ reset: AccessResetView; token: string }> {
  const judge = (handle: Tx) =>
    issuer.kind === 'user'
      ? checkRules(handle, issuer.userId, organisationId, userId)
      : checkSystemRules(handle, organisationId, userId).then((failure) =>
          failure?.rule === 'not-administrator' ? null : failure,
        );
  // A savepoint: a failure leaves no link, no revocation and no event.
  return tx.transaction(async (inner) => {
    // An id that is not shaped like one is nobody's: the same denial.
    if (
      (issuer.kind === 'user' && !UUID_SHAPE.test(issuer.userId)) ||
      !UUID_SHAPE.test(organisationId) ||
      !UUID_SHAPE.test(userId)
    ) {
      throw refusal({ rule: 'target-not-member' });
    }
    // Without a lock first: a caller who may not make this link, or a person
    // outside the organisation, is refused here and never takes anyone's row.
    const early = await judge(inner);
    if (early !== null) throw refusal(early);

    // The person's row, `FOR UPDATE` (CLAUDE.md, Data rules): the rules depend on
    // rows that point at the person, and only this strength holds off the insert of
    // one. Two creates for the same person queue here.
    try {
      await lockUser(inner, userId, { strength: 'update' });
    } catch (error) {
      // Deleted since the first look: a person who is not in use.
      if (error instanceof AuthStateError)
        throw refusal({ rule: 'not-active' });
      throw error;
    }
    const failure = await judge(inner);
    if (failure !== null) throw refusal(failure);

    await supersedeEarlierLinks(inner, issuer, organisationId, userId, now);

    const origin = await serverId(inner);
    const token = generateToken();
    const expiresAt = new Date(now.getTime() + checked.hours * HOUR_MS);
    const creator = issuer.kind === 'user' ? issuer.userId : null;
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
        createdBy: creator,
        updatedBy: creator,
        issuedBySystem: issuer.kind === 'system',
      })
      .returning(viewColumns);
    await recordAuthAudit(inner, {
      category: AUTH_AUDIT.accessResetCreated,
      action: 'create',
      actor: actorOf(issuer),
      targetType: 'access_reset',
      targetId: row!.id,
      organisationId,
      details: {
        userId,
        expiresAt: expiresAt.toISOString(),
        removePasskeys: checked.removePasskeys,
        // Said only for the system's links, so a person's link is audited as it always was.
        ...(issuer.kind === 'system' ? { issuedBySystem: true } : {}),
      },
      occurredAt: now,
    });
    return { reset: row!, token };
  });
}

/**
 * What a link made while another request holds the person's earlier one turns into:
 * the unique index on live links refused the new link (see `createAccessReset`), so
 * the error becomes a `ResetLinkBusyError`. Anything else is rethrown as it is.
 */
function busyWhenIndexRefuses(userId: string): (error: unknown) => never {
  return (error) => {
    // The index refused the new link: another request holds the person's earlier one
    // (a use or a revoke that has not changed it yet), so it could not be replaced.
    if (
      error instanceof RecordWriteError &&
      error.code === '23505' &&
      error.constraint === ACCESS_RESET_LIVE_INDEX
    ) {
      throw new ResetLinkBusyError(userId);
    }
    throw error;
  };
}

/**
 * Why `createSystemAccessReset` refused, in the words the audit trail uses for a link
 * that is refused when it is used: the person is not a member of the organisation, the
 * account is not active, the membership is not active, or the person is neither an
 * owner nor an Administrator (decision D-81, E2).
 */
export type SystemResetRefusal = Extract<
  AccessResetRefusalReason,
  | 'target-not-member'
  | 'target-not-active'
  | 'target-membership-not-active'
  | 'not-an-administrator'
>;

/**
 * What `createSystemAccessReset` answers: the link and its token, which exists
 * nowhere else, or the reason it was refused. A refusal is a returned value so that
 * the caller's transaction commits and the audit event the caller writes for it
 * survives (CLAUDE.md, Data rules).
 */
export type SystemAccessResetResult =
  | {
      readonly ok: true;
      readonly reset: AccessResetView;
      readonly token: string;
    }
  | { readonly ok: false; readonly reason: SystemResetRefusal };

/** Carries a failed system rule out of the savepoint of `makeLink`; never leaves this file. */
class SystemRefusal extends Error {
  constructor(readonly failure: RuleFailure) {
    super('The system may not issue this link');
    this.name = 'SystemRefusal';
  }
}

/**
 * Makes a reset link for a person as the system, for the admin command
 * `emergency-access` (P-09a2, decision D-81): the one way back in for an organisation
 * whose sole administrator has lost every way to sign in. It checks no permission and
 * has no creator (`issued_by_system`); the person must be an active user with an
 * active membership of the organisation who is an owner of it or holds its managed
 * Administrator role (`checkSystemRules`, in the header). It is the same code as
 * `createAccessReset` from there on: the person's user row `FOR UPDATE`, the rules
 * judged again under it, every earlier link of the person that was neither used nor
 * revoked superseded (as the system: `revoked_by_system`, audited `superseded`), one
 * link and one event, `auth.access-reset-created`, from the system and saying
 * `issuedBySystem`. Using the link does exactly what using any reset link does, and
 * judges the person by the same rules again.
 *
 * Only the admin command line calls it, with shell access to the server as the
 * authority (decision D-64), so the caller must be that. The token is returned once
 * and never logged or audited.
 *
 * A refusal is a returned value, and writes nothing: no link, no revocation of an
 * earlier link, no event. `expiresInHours` and `removePasskeys` are as for
 * `createAccessReset`.
 *
 * @throws AuthInputError `expiresInHours` or `removePasskeys` for a value that is
 * not acceptable. It names the field and never the value.
 * @throws AuthStateError `installation-missing` before the installation row exists.
 * @throws ResetLinkBusyError, a `RecordStateError`, as `createAccessReset` does, when
 * the unique index on live links refuses the new link because a use or a revoke holds
 * the earlier one. Nothing is written, and making the link again works.
 * @throws RecordWriteError when the database refuses a write in any other way; it
 * carries the SQLSTATE and constraint name only, never the token, its hash or an
 * address.
 */
export async function createSystemAccessReset(
  tx: Tx,
  organisationId: string,
  userId: string,
  input: CreateAccessResetInput,
  now: Date,
): Promise<SystemAccessResetResult> {
  const checked = checkedCreate(input);
  return guardedAuth(
    'access_reset',
    'insert',
    async (): Promise<SystemAccessResetResult> => {
      try {
        const made = await makeLink(
          tx,
          { kind: 'system' },
          organisationId,
          userId,
          checked,
          now,
          (failure) => new SystemRefusal(failure),
        );
        return { ok: true, ...made };
      } catch (error) {
        if (error instanceof SystemRefusal) {
          const reason = useRefusalReason(error.failure);
          if (isSystemResetRefusal(reason)) return { ok: false, reason };
          // `checkSystemRules` answers no other rule: a person's rule reached here.
          throw new Error(
            'A rule that is not the system’s refused the system',
            {
              cause: error,
            },
          );
        }
        throw error;
      }
    },
  ).catch(busyWhenIndexRefuses(userId));
}

/** True for the four reasons `createSystemAccessReset` gives. */
function isSystemResetRefusal(
  reason: AccessResetRefusalReason,
): reason is SystemResetRefusal {
  return (
    reason === 'target-not-member' ||
    reason === 'target-not-active' ||
    reason === 'target-membership-not-active' ||
    reason === 'not-an-administrator'
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
      // The link that still works, locked. One at most, since the table keeps one
      // link per person that is neither used nor revoked; an expired one is not
      // "live" here, and making the next link is what revokes it.
      const live = await inner
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
      if (live.length === 0)
        throw new RecordNotFoundError('access_reset', userId);
      await revokeLinks(
        inner,
        { kind: 'user', userId: actor.userId },
        organisationId,
        userId,
        live.map((found) => found.id),
        'manual',
        now,
      );
    }),
  );
}

/**
 * What the holder of a live token may be told about it: when it ends, and nothing
 * else. Not the person's name or address, not the organisation's name: anyone who
 * holds the link could read them. Checks no permission: the token is the capability,
 * and a web page calls this to show the person that the link is good before they
 * use it. Writes nothing for a live token. It also checks the rules for who may
 * reset whom, as a use does (the system's rules for a link the system issued), but
 * without the locks a use takes, and refuses a link a use would refuse, so a page
 * does not show a link as good that then fails. It is only a look:
 * `useAccessReset` checks again under the locks.
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
              issuedBySystem: accessReset.issuedBySystem,
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
      judgeLink(tx, link),
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
 * may reset whom are checked again (with the creator as the actor, or by the
 * system's rules for a link the system issued), and only then does
 * anything change: every session of the person is revoked, every live personal API
 * token of the person is revoked (reason `access-reset`, with the rows locked in id order
 * so it cannot deadlock with a switch being turned off), the password, the authenticator
 * and the recovery codes are deleted, the passkeys are revoked when the link says so, and
 * the link is marked used.
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
      issuedBySystem: accessReset.issuedBySystem,
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
  // By the rules of whoever issued the link: a person's (with the creator as the
  // actor) or the system's. A link nobody issued is refused.
  const failure = await judgeLink(tx, found);
  if (failure !== null) return refuse(useRefusalReason(failure), known);

  const sessionsRevoked = await revokeUserSessions(tx, found.userId, {
    reason: 'access-reset',
    now,
  });
  // A person whose access was reset must not keep a script that still works: every
  // live personal API token of theirs ends with their sessions (SC-10, decision D-68).
  const tokensRevoked = await revokeApiTokensOfUser(
    tx,
    found.userId,
    'access-reset',
    now,
  );
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
      tokensRevoked,
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
 * who made the link as the actor, or by the system's rules for a link the system
 * issued), revokes every session of the person, deletes
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
 * `auth.access-reset-used` with the person's id, the number of sessions revoked, the
 * number of personal API tokens revoked, whether a password was cleared and an
 * authenticator removed, the number of recovery codes and of passkeys removed. Never the
 * token, a hash, a password or an address.
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
