import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { AccessDeniedError } from '../access/access-denied-error.js';
import {
  hasOrganisationPermission,
  organisationPermissionReaches,
} from '../access/organisation-permission.js';
import {
  INVITE_TIERS,
  invite,
  inviteRole,
  orgMembership,
  orgMembershipRole,
  organisation,
  role,
  rolePermission,
  user,
  type InviteTier,
} from '../db/schema/index.js';
import {
  insertRecord,
  lockOrganisationChanges,
  RecordNotFoundError,
  RecordWriteError,
  type Tx,
  type WriteContext,
} from '../db/write.js';
import { MEMBERS_INVITE_PERMISSION } from '../members/permissions.js';
import { AuthInputError, AuthStateError } from './errors.js';
import {
  AccountExistsError,
  AlreadyMemberError,
  InviteEmailMismatchError,
  InviteExceedsOwnAccessError,
  InviteInvalidError,
  InvitePasswordRefusedError,
  type InviteRefusedError,
} from './invite-errors.js';
import { normaliseEmail } from './login-user.js';
import { PASSWORD_REFUSALS } from './password-policy.js';
import { setPassword } from './password-service.js';
import { SESSION_USER_COLUMNS, type SessionUser } from './sessions.js';
import {
  AUTH_AUDIT,
  guardedAuth,
  isOneOf,
  lockUser,
  recordAuthAudit,
  serverId,
  type AuthActor,
} from './shared.js';
import { generateToken, hashToken } from './tokens.js';
import { createUser, isEmailShaped } from './users.js';

/**
 * Invite links (SC-10, decision D-57). An administrator makes a one-time link,
 * passes it on by any channel, and whoever opens it joins the organisation with the
 * tier and roles the invite names. OSFPM sends nothing: the link is shown once, in
 * the response that makes it. The token is the same kind as a session token
 * (`generateToken`), only its SHA-256 hash is stored, and it is never logged,
 * audited or returned again. `invite` and `invite_role` are security tables: only
 * this service writes them, directly, and every change is audited instead of
 * change-logged. The write helper refuses them (`SecurityTableWriteError`).
 *
 * Pass the transaction handle and the time as `now`. The services that make a
 * decision for a signed-in person (`createInvite`, `listInvites`, `revokeInvite`)
 * check `members:invite` themselves; the two that take a token (`inspectInvite`,
 * `acceptInvite`) check no permission, because the token is the capability.
 *
 * Lock order. Revoking and creating take no change counter, only the invite row,
 * and no writer that holds an organisation's change counter ever waits for an
 * invite row, so they cannot form a cycle with an accept. An accept follows the
 * rule of CLAUDE.md (Data rules): the organisation's change counter first
 * (`lockOrganisationChanges`), then the invite row, then the user row.
 */

/**
 * How long an invite works, in days: seven unless the caller asks for another
 * number between `minDays` and `maxDays`. Not a legal or financial number.
 */
export const INVITE_LIFETIME = {
  defaultDays: 7,
  minDays: 1,
  maxDays: 30,
} as const;

/** The most roles one invite may carry, so a body is never a reason to do a lot of work. */
export const INVITE_MAX_ROLES = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A real token is 43 characters; anything this long is not one and is not hashed. */
const MAX_TOKEN_LENGTH = 256;

/** The longest display name a new account takes, as `createUser` has it. */
const MAX_DISPLAY_NAME_LENGTH = 200;

/** What a UUID looks like, so a value that is not one never reaches a `uuid` column. */
const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The person making, listing or revoking invites. */
export type InviteActor = {
  /** The signed-in user. The permission is checked for them, in the organisation. */
  readonly userId: string;
};

/** What `createInvite` is given. */
export type CreateInviteInput = {
  /** The address that may accept it. Left out, anyone with the link may. Normalised like `user.email`. */
  readonly email?: string;
  /** The membership tier the person gets. Never `owner`. */
  readonly tier: InviteTier;
  /** The organisation roles the person gets. Each must be a live organisation role of this organisation. */
  readonly roleIds: readonly string[];
  /** `INVITE_LIFETIME.defaultDays` when left out. */
  readonly expiresInDays?: number;
};

/** An invite as the services show it: never the token or its hash. */
export type InviteView = {
  readonly id: string;
  readonly organisationId: string;
  /** The address it is for, or null. Shown to the people who may make invites, never audited or logged. */
  readonly email: string | null;
  readonly tier: InviteTier;
  readonly roleIds: readonly string[];
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly createdBy: string | null;
};

/** What `inspectInvite` tells someone who holds a live token. */
export type InviteInspection = {
  readonly organisationName: string;
  readonly expiresAt: Date;
  /** True when the invite names an address: the person must use that one. The address itself is not shown. */
  readonly emailRequired: boolean;
};

/** Who accepts an invite: a signed-in user, or someone who needs a new account. */
export type InviteAcceptor =
  | {
      readonly kind: 'signed-in';
      /** The user of a full-scope session. */
      readonly userId: string;
    }
  | {
      readonly kind: 'new-account';
      readonly account: {
        readonly email: string;
        readonly displayName: string;
        /** Left out, the account has no way to sign in yet and `mustSecureAccount` is true. */
        readonly password?: string;
      };
    };

/** What `acceptInvite` answers. */
export type AcceptedInvite = {
  /** The user who joined: the signed-in one, or the one just made. */
  readonly user: SessionUser;
  readonly organisation: { readonly id: string; readonly name: string };
  /** True when the account was made by this accept. */
  readonly newUser: boolean;
  /** True when a new account has no password: its first session may only secure it. */
  readonly mustSecureAccount: boolean;
};

type CheckedCreate = {
  readonly email: string | null;
  readonly tier: InviteTier;
  readonly roleIds: readonly string[];
  readonly days: number;
};

/**
 * Checks the shape of what `createInvite` was given, before anything is looked up,
 * and puts it in the form it is stored in. Each refusal names the field and never
 * the value.
 */
function checkedCreate(input: CreateInviteInput): CheckedCreate {
  if (!isOneOf(INVITE_TIERS, input.tier)) throw new AuthInputError('tier');
  const days = input.expiresInDays ?? INVITE_LIFETIME.defaultDays;
  if (
    typeof days !== 'number' ||
    !Number.isInteger(days) ||
    days < INVITE_LIFETIME.minDays ||
    days > INVITE_LIFETIME.maxDays
  ) {
    throw new AuthInputError('expiresInDays');
  }
  let email: string | null = null;
  if (input.email !== undefined) {
    email = typeof input.email === 'string' ? normaliseEmail(input.email) : '';
    if (!isEmailShaped(email)) throw new AuthInputError('email');
  }
  if (
    !Array.isArray(input.roleIds) ||
    input.roleIds.length > INVITE_MAX_ROLES ||
    !input.roleIds.every(
      (id): id is string => typeof id === 'string' && UUID_SHAPE.test(id),
    )
  ) {
    throw new AuthInputError('roleIds');
  }
  return {
    email,
    tier: input.tier,
    roleIds: [...new Set(input.roleIds.map((id) => id.toLowerCase()))],
    days,
  };
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

/** Why an invite is, or is not, usable at `now`. */
type InviteState = 'live' | 'unknown' | 'used' | 'revoked' | 'expired';

/**
 * Whether the row is usable at `now`. Used first, then revoked, then expired,
 * which only decides what the audit event says: a caller is told one thing for
 * all three. `expires_at <= now` counts as expired, as `cleanupInvites` counts it.
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
): InviteState {
  if (row === undefined) return 'unknown';
  if (row.usedAt !== null) return 'used';
  if (row.revokedAt !== null) return 'revoked';
  if (row.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'live';
}

/**
 * Refuses unless `userId` holds `members:invite` in `organisationId`. The
 * organisation was named by id, so the refusal carries no scope and is the same
 * for an organisation that does not exist, one the user is not in, and one they
 * are in without the permission (CLAUDE.md, Code rules: 404 or 403 where
 * existence must not leak). Not audited: only sensitive data and legal holds audit
 * a denial.
 */
async function requireInvitePermission(
  tx: Tx,
  userId: string,
  organisationId: string,
): Promise<void> {
  if (
    !(await hasOrganisationPermission(
      tx,
      userId,
      organisationId,
      MEMBERS_INVITE_PERMISSION,
    ))
  ) {
    throw new AccessDeniedError(MEMBERS_INVITE_PERMISSION);
  }
}

/**
 * Refuses when a role of `roleIds` holds a permission the person making the invite
 * does not hold in the organisation, or an `all-projects` grant of one they hold
 * only for the organisation. Every grant on every role counts, a department-scoped
 * one too (it needs the permission, at any reach). There is no exception for
 * owners: a tier carries no permission (decision D-51). It reads without a lock:
 * the roles of the person making the invite changing a moment later is not what
 * this guards.
 */
async function refuseEscalation(
  tx: Tx,
  userId: string,
  organisationId: string,
  roleIds: readonly string[],
): Promise<void> {
  if (roleIds.length === 0) return;
  const held = await organisationPermissionReaches(tx, userId, organisationId);
  const wanted = await tx
    .select({
      key: rolePermission.permissionKey,
      reach: rolePermission.reach,
    })
    .from(rolePermission)
    .where(
      and(
        eq(rolePermission.organisationId, organisationId),
        inArray(rolePermission.roleId, [...roleIds]),
        isNull(rolePermission.deletedAt),
      ),
    );
  const missing = new Set<string>();
  for (const grant of wanted) {
    const reach = held.get(grant.key);
    if (
      reach === undefined ||
      (grant.reach === 'all-projects' && reach !== 'all-projects')
    ) {
      missing.add(grant.key);
    }
  }
  if (missing.size > 0) {
    throw new InviteExceedsOwnAccessError([...missing].sort());
  }
}

/** The columns of an `InviteView`, without the token hash. */
const viewColumns = {
  id: invite.id,
  organisationId: invite.organisationId,
  email: invite.email,
  tier: invite.tier,
  expiresAt: invite.expiresAt,
  createdAt: invite.createdAt,
  createdBy: invite.createdBy,
};

/**
 * Makes an invite and returns it with its token, which exists nowhere else: the
 * caller builds the link from it and shows it once. Needs `members:invite` in the
 * organisation. The invite lasts `expiresInDays` (1 to 30, 7 when left out) from
 * `now`. Every role must be a live organisation role of this organisation, and the
 * person making the invite must hold every permission those roles grant, in the
 * organisation, at the same reach or wider: an `all-projects` grant needs an
 * `all-projects` grant. That is the rule against escalation, with no exception for
 * owners, because a tier grants nothing (decision D-51).
 *
 * Audited as `auth.invite-created` with the invite id, the organisation, the tier,
 * the role ids, the expiry and whether an address is set, and never the address or
 * the token. Takes no change counter and locks no row, so it cannot deadlock with
 * an accept.
 *
 * @throws AccessDeniedError, with no scope, without the permission.
 * @throws AuthInputError `tier`, `expiresInDays`, `email` or `roleIds` for a value
 * that is not acceptable, including a role that is not a live organisation role of
 * this organisation. It names the field and never the value.
 * @throws InviteExceedsOwnAccessError (nothing written) when it would give more
 * than the person holds; `permissions` lists the keys.
 * @throws AuthStateError `installation-missing` before the installation row exists.
 * @throws RecordWriteError when the database refuses a write; it carries the
 * SQLSTATE and constraint name only, never the token, its hash or the address.
 */
export async function createInvite(
  tx: Tx,
  actor: InviteActor,
  organisationId: string,
  input: CreateInviteInput,
  now: Date,
): Promise<{ invite: InviteView; token: string }> {
  const checked = checkedCreate(input);
  return guardedAuth('invite', 'insert', () =>
    // A savepoint: a failure leaves no invite, no link and no event.
    tx.transaction(async (inner) => {
      await requireInvitePermission(inner, actor.userId, organisationId);
      if (checked.roleIds.length > 0) {
        const roles = await inner
          .select({ id: role.id })
          .from(role)
          .where(
            and(
              eq(role.organisationId, organisationId),
              inArray(role.id, [...checked.roleIds]),
              isNull(role.projectId),
              isNull(role.deletedAt),
            ),
          );
        // A role of another organisation, a project role, a deleted one and one
        // that is not there are all the same refusal.
        if (roles.length !== checked.roleIds.length) {
          throw new AuthInputError('roleIds');
        }
      }
      await refuseEscalation(
        inner,
        actor.userId,
        organisationId,
        checked.roleIds,
      );

      const origin = await serverId(inner);
      const token = generateToken();
      const expiresAt = new Date(now.getTime() + checked.days * DAY_MS);
      const [row] = await inner
        .insert(invite)
        .values({
          originServer: origin,
          organisationId,
          tokenHash: hashToken(token),
          email: checked.email,
          tier: checked.tier,
          expiresAt,
          createdAt: now,
          updatedAt: now,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        })
        .returning(viewColumns);
      if (checked.roleIds.length > 0) {
        await inner.insert(inviteRole).values(
          checked.roleIds.map((roleId) => ({
            organisationId,
            inviteId: row!.id,
            roleId,
          })),
        );
      }
      await recordAuthAudit(inner, {
        category: AUTH_AUDIT.inviteCreated,
        action: 'create',
        actor: { type: 'user', id: actor.userId },
        targetType: 'invite',
        targetId: row!.id,
        organisationId,
        details: {
          tier: checked.tier,
          roleIds: [...checked.roleIds].sort().join(','),
          expiresAt: expiresAt.toISOString(),
          hasEmail: checked.email !== null,
        },
        occurredAt: now,
      });
      return {
        invite: { ...row!, roleIds: [...checked.roleIds].sort() },
        token,
      };
    }),
  );
}

/**
 * The invites of the organisation that can still be used: not used, not revoked,
 * not expired at `now`, newest first. Needs `members:invite`. Never a token or a
 * hash (only the hash is stored, and it is not selected). Not audited: it changes
 * nothing.
 *
 * @throws AccessDeniedError, with no scope, without the permission.
 * @throws RecordWriteError when the database fails; it carries the SQLSTATE only.
 */
export function listInvites(
  tx: Tx,
  actor: InviteActor,
  organisationId: string,
  now: Date,
): Promise<InviteView[]> {
  return guardedAuth('invite', 'select', async () => {
    await requireInvitePermission(tx, actor.userId, organisationId);
    const rows = await tx
      .select(viewColumns)
      .from(invite)
      .where(
        and(
          eq(invite.organisationId, organisationId),
          isNull(invite.usedAt),
          isNull(invite.revokedAt),
          gt(invite.expiresAt, now),
        ),
      )
      .orderBy(desc(invite.createdAt), asc(invite.id));
    if (rows.length === 0) return [];
    const links = await tx
      .select({ inviteId: inviteRole.inviteId, roleId: inviteRole.roleId })
      .from(inviteRole)
      .where(
        and(
          eq(inviteRole.organisationId, organisationId),
          inArray(
            inviteRole.inviteId,
            rows.map((row) => row.id),
          ),
        ),
      );
    // A Map, because the ids come from the database and a plain object is no place
    // for a key a caller could name.
    const byInvite = new Map<string, string[]>();
    for (const link of links) {
      byInvite.set(link.inviteId, [
        ...(byInvite.get(link.inviteId) ?? []),
        link.roleId,
      ]);
    }
    return rows.map((row) => ({
      ...row,
      roleIds: (byInvite.get(row.id) ?? []).sort(),
    }));
  });
}

/**
 * Revokes an invite that can still be used, so its link stops working. Needs
 * `members:invite`. It takes the invite row lock (`FOR UPDATE`) and looks again
 * under it, so a revoke that runs at the same moment as an accept of the same
 * invite either goes first, and the accept is refused, or waits for the accept and
 * finds the invite used: never both. It takes no change counter, so it cannot form
 * a cycle with an accept, which takes the counter before the row.
 *
 * Audited as `auth.invite-revoked`, with no address and no token.
 *
 * @throws AccessDeniedError, with no scope, without the permission.
 * @throws RecordNotFoundError when no invite of this organisation with this id can
 * still be used: unknown, another organisation's, used, revoked or expired. The
 * same answer for all, so ids cannot be probed.
 * @throws RecordWriteError when the database refuses a write; it carries the
 * SQLSTATE only.
 */
export function revokeInvite(
  tx: Tx,
  actor: InviteActor,
  organisationId: string,
  inviteId: string,
  now: Date,
): Promise<void> {
  return guardedAuth('invite', 'update', () =>
    tx.transaction(async (inner) => {
      await requireInvitePermission(inner, actor.userId, organisationId);
      if (!UUID_SHAPE.test(inviteId)) {
        throw new RecordNotFoundError('invite', inviteId);
      }
      const [row] = await inner
        .select({
          id: invite.id,
          usedAt: invite.usedAt,
          revokedAt: invite.revokedAt,
          expiresAt: invite.expiresAt,
        })
        .from(invite)
        .where(
          and(
            eq(invite.id, inviteId),
            eq(invite.organisationId, organisationId),
          ),
        )
        .limit(1)
        .for('update');
      if (stateOf(row, now) !== 'live') {
        throw new RecordNotFoundError('invite', inviteId);
      }
      await inner
        .update(invite)
        .set({
          revokedAt: now,
          revokedBy: actor.userId,
          updatedAt: now,
          updatedBy: actor.userId,
          version: sql`${invite.version} + 1`,
        })
        .where(eq(invite.id, inviteId));
      await recordAuthAudit(inner, {
        category: AUTH_AUDIT.inviteRevoked,
        action: 'revoke',
        actor: { type: 'user', id: actor.userId },
        targetType: 'invite',
        targetId: inviteId,
        organisationId,
        occurredAt: now,
      });
    }),
  );
}

/**
 * What the holder of a live token may be told about it: the organisation's name,
 * when the invite ends and whether it names an address (not which one). Checks no
 * permission: the token is the capability, and a web page calls this to show the
 * person what they are joining before they accept. Writes nothing for a live token.
 *
 * Every failure is the same `InviteInvalidError`, whether the token is unknown,
 * expired, revoked or used, so a caller learns nothing about which. The cause goes
 * into the audit event `auth.invite-inspect-failed` (from the system, the invite id
 * when there is one, and never the token or its hash), which is written before the
 * error is thrown: the caller catches the error inside its transaction and commits,
 * so the event survives (CLAUDE.md, Data rules).
 *
 * @throws InviteInvalidError for a token that is no good.
 * @throws RecordWriteError when the database fails; it carries the SQLSTATE only,
 * never the token or its hash.
 */
export async function inspectInvite(
  tx: Tx,
  token: string,
  now: Date,
): Promise<InviteInspection> {
  const hash = hashOf(token);
  const found =
    hash === null
      ? undefined
      : await guardedAuth('invite', 'select', async () => {
          const [row] = await tx
            .select({
              id: invite.id,
              organisationId: invite.organisationId,
              email: invite.email,
              expiresAt: invite.expiresAt,
              usedAt: invite.usedAt,
              revokedAt: invite.revokedAt,
              organisationName: organisation.name,
            })
            .from(invite)
            .innerJoin(organisation, eq(organisation.id, invite.organisationId))
            .where(eq(invite.tokenHash, hash))
            .limit(1);
          return row;
        });
  const state = stateOf(found, now);
  if (state === 'live') {
    return {
      organisationName: found!.organisationName,
      expiresAt: found!.expiresAt,
      emailRequired: found!.email !== null,
    };
  }
  await guardedAuth('audit_event', 'insert', () =>
    recordAuthAudit(tx, {
      category: AUTH_AUDIT.inviteInspectFailed,
      action: 'inspect',
      actor: { type: 'system', id: null },
      targetType: found === undefined ? null : 'invite',
      targetId: found?.id ?? null,
      organisationId: found?.organisationId ?? null,
      details: { reason: state },
      occurredAt: now,
    }),
  );
  throw new InviteInvalidError(state);
}

/** The input of an accept, checked and put in the form it is used in. */
type CheckedAcceptor =
  | { readonly kind: 'signed-in'; readonly userId: string }
  | {
      readonly kind: 'new-account';
      readonly email: string;
      readonly displayName: string;
      readonly password: string | undefined;
    };

/** Checks the shape of the acceptor, before the token is looked at. Each refusal names the field. */
function checkedAcceptor(acceptor: InviteAcceptor): CheckedAcceptor {
  if (acceptor.kind === 'signed-in') {
    if (
      typeof acceptor.userId !== 'string' ||
      !UUID_SHAPE.test(acceptor.userId)
    ) {
      throw new AuthInputError('userId');
    }
    return { kind: 'signed-in', userId: acceptor.userId };
  }
  const { account } = acceptor;
  const email =
    typeof account.email === 'string' ? normaliseEmail(account.email) : '';
  if (!isEmailShaped(email)) throw new AuthInputError('account.email');
  const displayName =
    typeof account.displayName === 'string' ? account.displayName.trim() : '';
  if (displayName === '' || displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new AuthInputError('account.displayName');
  }
  if (account.password !== undefined && typeof account.password !== 'string') {
    throw new AuthInputError('account.password');
  }
  return {
    kind: 'new-account',
    email,
    displayName,
    password: account.password,
  };
}

/** A refusal found inside the accept, returned so the savepoint can be undone before it is audited. */
type AcceptRefusal = {
  readonly ok: false;
  readonly error: InviteRefusedError;
  readonly invite: {
    readonly id: string;
    readonly organisationId: string;
  } | null;
  readonly actor: AuthActor;
};

/** Thrown inside the savepoint to undo every step so far, and carried out to answer a refusal. */
class AcceptRolledBack extends Error {
  constructor(readonly refusal: AcceptRefusal) {
    super('The invite was not accepted');
    this.name = 'AcceptRolledBack';
  }
}

/**
 * The steps of an accept, in the caller's savepoint. A refusal is returned and the
 * caller undoes the savepoint; anything the database refuses is thrown.
 *
 * The order is the rule of CLAUDE.md (Data rules): the invite is read without a
 * lock, then the organisation's change counter is taken (`lockOrganisationChanges`),
 * then the invite row (`FOR UPDATE`) and judged again under it, then the user row,
 * and only then does the write helper write the membership, which needs the same
 * counter. Two accepts of one token take the counter in turn and the second finds
 * the invite used; an accept and a revoke of one invite meet on the row, which
 * revoke takes without a counter.
 */
async function runAccept(
  tx: Tx,
  hash: string | null,
  who: CheckedAcceptor,
  now: Date,
): Promise<
  AcceptRefusal | { readonly ok: true; readonly accepted: AcceptedInvite }
> {
  const system: AuthActor = { type: 'system', id: null };
  const acting: AuthActor =
    who.kind === 'signed-in' ? { type: 'user', id: who.userId } : system;
  const refuse = (
    error: InviteRefusedError,
    row: { id: string; organisationId: string } | null,
  ): AcceptRefusal => ({
    ok: false,
    error,
    invite: row,
    actor: acting,
  });
  if (hash === null) return refuse(new InviteInvalidError('unknown'), null);

  const [seen] = await tx
    .select({
      id: invite.id,
      organisationId: invite.organisationId,
      usedAt: invite.usedAt,
      revokedAt: invite.revokedAt,
      expiresAt: invite.expiresAt,
    })
    .from(invite)
    .where(eq(invite.tokenHash, hash))
    .limit(1);
  const early = stateOf(seen, now);
  if (early !== 'live') {
    return refuse(
      new InviteInvalidError(early),
      seen === undefined ? null : seen,
    );
  }
  const known = { id: seen!.id, organisationId: seen!.organisationId };

  await lockOrganisationChanges(tx, known.organisationId);
  const [locked] = await tx
    .select({
      id: invite.id,
      organisationId: invite.organisationId,
      email: invite.email,
      tier: invite.tier,
      usedAt: invite.usedAt,
      revokedAt: invite.revokedAt,
      expiresAt: invite.expiresAt,
    })
    .from(invite)
    .where(eq(invite.id, known.id))
    .limit(1)
    .for('update');
  // Judged again under the lock: a revoke or another accept may have got there
  // between the read above and the lock.
  const late = stateOf(locked, now);
  if (late !== 'live') {
    return refuse(new InviteInvalidError(late), known);
  }
  const found = locked!;

  const [org] = await tx
    .select({
      id: organisation.id,
      name: organisation.name,
      locale: organisation.defaultLocale,
      timezone: organisation.defaultTimezone,
    })
    .from(organisation)
    .where(eq(organisation.id, found.organisationId))
    .limit(1);
  const origin = await serverId(tx);

  let joined: SessionUser;
  let newUser = false;
  if (who.kind === 'signed-in') {
    const locks = await lockUser(tx, who.userId);
    // A user who is not active has no business joining anything; a disabled one
    // cannot have a session at all.
    if (locks.status !== 'active') throw new AuthStateError('user-disabled');
    const [self] = await tx
      .select(SESSION_USER_COLUMNS)
      .from(user)
      .where(eq(user.id, who.userId))
      .limit(1);
    joined = self!;
    if (found.email !== null && normaliseEmail(joined.email) !== found.email) {
      return refuse(new InviteEmailMismatchError(), known);
    }
    // Any row counts, a removed one too: the unique key does not tell them apart.
    // Looked up after the counter lock, so a membership another accept just made
    // is seen.
    const [existing] = await tx
      .select({ id: orgMembership.id })
      .from(orgMembership)
      .where(
        and(
          eq(orgMembership.organisationId, found.organisationId),
          eq(orgMembership.userId, who.userId),
        ),
      )
      .limit(1);
    if (existing !== undefined) return refuse(new AlreadyMemberError(), known);
  } else {
    if (found.email !== null && who.email !== found.email) {
      return refuse(new InviteEmailMismatchError(), known);
    }
    const [taken] = await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, who.email))
      .limit(1);
    if (taken !== undefined) return refuse(new AccountExistsError(), known);
    try {
      joined = await createUser(tx, {
        email: who.email,
        displayName: who.displayName,
        locale: org!.locale,
        timezone: org!.timezone,
        status: 'active',
        now,
      });
    } catch (error) {
      // Two accepts for one new address at once: the other got the address first.
      if (
        error instanceof RecordWriteError &&
        error.code === '23505' &&
        error.constraint === 'user_email_unique'
      ) {
        return refuse(new AccountExistsError(), known);
      }
      throw error;
    }
    newUser = true;
    if (who.password !== undefined) {
      const set = await setPassword(tx, {
        userId: joined.id,
        newPassword: who.password,
        now,
      });
      if (!set.ok) {
        if (isOneOf(PASSWORD_REFUSALS, set.reason)) {
          return refuse(new InvitePasswordRefusedError(set.reason), known);
        }
        // A new account has no password to change and no session, so the policy
        // is the only refusal there can be.
        throw new Error('A new account cannot owe a current password');
      }
    }
  }

  await tx
    .update(invite)
    .set({
      usedAt: now,
      usedBy: joined.id,
      updatedAt: now,
      updatedBy: joined.id,
      version: sql`${invite.version} + 1`,
    })
    .where(eq(invite.id, found.id));

  // The same way `completeFirstRunSetup` makes the first membership: through the
  // write helper, with the person who joined as the acting user.
  const ctx: WriteContext = {
    originServer: origin,
    clock: () => now,
    actor: { type: 'user', id: joined.id },
  };
  const membership = await insertRecord(
    tx,
    orgMembership,
    {
      organisationId: found.organisationId,
      ownerOrgId: found.organisationId,
      userId: joined.id,
      orgRole: found.tier,
      status: 'active',
    },
    ctx,
  );
  // A role that was deleted, or is not an organisation role, since the invite was
  // made is left out, as the database would refuse to link it.
  const links = await tx
    .select({ roleId: inviteRole.roleId })
    .from(inviteRole)
    .innerJoin(
      role,
      and(
        eq(role.organisationId, inviteRole.organisationId),
        eq(role.id, inviteRole.roleId),
        isNull(role.projectId),
        isNull(role.deletedAt),
      ),
    )
    .where(
      and(
        eq(inviteRole.inviteId, found.id),
        eq(inviteRole.organisationId, found.organisationId),
      ),
    )
    .orderBy(asc(inviteRole.roleId));
  for (const link of links) {
    await insertRecord(
      tx,
      orgMembershipRole,
      {
        organisationId: found.organisationId,
        ownerOrgId: found.organisationId,
        membershipId: membership.id,
        roleId: link.roleId,
      },
      ctx,
    );
  }
  await recordAuthAudit(tx, {
    category: AUTH_AUDIT.inviteAccepted,
    action: 'accept',
    actor: { type: 'user', id: joined.id },
    targetType: 'invite',
    targetId: found.id,
    organisationId: found.organisationId,
    details: { userId: joined.id, newUser },
    occurredAt: now,
  });
  return {
    ok: true,
    accepted: {
      user: joined,
      organisation: { id: org!.id, name: org!.name },
      newUser,
      mustSecureAccount:
        newUser && who.kind === 'new-account' && who.password === undefined,
    },
  };
}

/**
 * Accepts an invite for a person: marks it used, makes their membership (active,
 * with the invite's tier) and links its roles, the same way first-run setup does,
 * all in one savepoint, so a failure at any step leaves nothing, the invite
 * unused. Checks no permission: the token is the capability.
 *
 * A signed-in person (`kind: 'signed-in'`, a full-scope session's user, who must be
 * active) is refused when the invite names another address (`InviteEmailMismatchError`)
 * or they already belong to the organisation (`AlreadyMemberError`, the invite not
 * used up). A new account (`kind: 'new-account'`) is refused when the invite names
 * another address, or an account with the address exists (`AccountExistsError`:
 * sign in, then open the link again), and the password, when given, must meet the
 * password policy (`InvitePasswordRefusedError`). The account is made with
 * `createUser` and the organisation's locale and time zone. An account with no
 * password has `mustSecureAccount` true: the caller makes a recovery-scope session.
 * The caller makes the session; this does not.
 *
 * Two accepts of one token at once make one membership: the second finds the invite
 * used and gets `InviteInvalidError`. An accept and a revoke at once end with the
 * invite used or revoked, never both, and no membership without a used invite.
 *
 * Every refusal but the password is audited, from the person if signed in and the
 * system otherwise, as `auth.invite-accept-refused` with a reason code, never the
 * token, an address or a password; success is `auth.invite-accepted` with the
 * invite id, the user id and whether the account is new. The refusal is audited
 * after the savepoint is undone and before the error is thrown: the caller catches
 * it inside its transaction and commits, so the event survives.
 *
 * @throws InviteInvalidError for a token that is unknown, expired, revoked or used:
 * one error for all, whatever the cause.
 * @throws InviteEmailMismatchError, AlreadyMemberError, AccountExistsError and
 * InvitePasswordRefusedError, as above. Every one extends `InviteRefusedError`.
 * @throws AuthInputError `userId`, `account.email`, `account.displayName` or
 * `account.password` for a value that is not acceptable, before anything is read.
 * @throws AuthStateError `user-not-found` for an unknown or deleted user,
 * `user-disabled` for a user who is not active, `installation-missing` before the
 * installation row exists.
 * @throws RecordWriteError when the database refuses a write; it carries the
 * SQLSTATE and constraint name only, never the token, its hash, an address or a
 * password.
 */
export async function acceptInvite(
  tx: Tx,
  token: string,
  acceptor: InviteAcceptor,
  now: Date,
): Promise<AcceptedInvite> {
  const who = checkedAcceptor(acceptor);
  const hash = hashOf(token);
  try {
    return await tx.transaction(async (inner) => {
      const outcome = await guardedAuth('invite', 'update', () =>
        runAccept(inner, hash, who, now),
      );
      // Thrown here, outside `guardedAuth`, so the savepoint is rolled back with
      // the user, the membership and the used mark in it.
      if (!outcome.ok) throw new AcceptRolledBack(outcome);
      return outcome.accepted;
    });
  } catch (error) {
    if (!(error instanceof AcceptRolledBack)) throw error;
    const { refusal } = error;
    // After the rollback, so the event is not undone with the rest. A password the
    // policy refused guessed no secret, so it is not audited (as in first-run setup).
    if (refusal.error.reason !== 'password-refused') {
      await guardedAuth('audit_event', 'insert', () =>
        recordAuthAudit(tx, {
          category: AUTH_AUDIT.inviteAcceptRefused,
          action: 'accept',
          actor: refusal.actor,
          targetType: refusal.invite === null ? null : 'invite',
          targetId: refusal.invite?.id ?? null,
          organisationId: refusal.invite?.organisationId ?? null,
          details: { reason: refusal.error.reason },
          occurredAt: now,
        }),
      );
    }
    throw refusal.error;
  }
}
