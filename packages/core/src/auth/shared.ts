import { and, eq, isNull } from 'drizzle-orm';
import { AccessDeniedError } from '../access/access-denied-error.js';
import type { ActorType } from '../db/columns.js';
import { user, type UserStatus } from '../db/schema/index.js';
import {
  RecordNotFoundError,
  RecordWriteError,
  recordAudit,
  type Tx,
} from '../db/write.js';
import {
  getServerId,
  InstallationMissingError,
} from '../installation/server-id.js';
import { AuthInputError, AuthStateError } from './errors.js';
import {
  InviteExceedsOwnAccessError,
  InviteRefusedError,
} from './invite-errors.js';

/**
 * Pieces the auth services share. Only the auth services use them; the
 * routes call the services, not these.
 */

/**
 * Who did something, for an audit event: a user, or `system` when nobody is
 * signed in (issuing a setup code, using one). `id` is a user id or null.
 */
export type AuthActor = {
  readonly type: ActorType;
  readonly id: string | null;
};

/**
 * Audit categories the auth services write. Each is one security-relevant
 * change; the action is the verb. `audit_event.details` never holds a token,
 * code, hash or password (CLAUDE.md, Privacy rule).
 */
export const AUTH_AUDIT = {
  sessionCreated: 'auth.session-created',
  sessionRevoked: 'auth.session-revoked',
  sessionsRevoked: 'auth.sessions-revoked',
  sessionPromoted: 'auth.session-promoted',
  userDisabled: 'auth.user-disabled',
  userEnabled: 'auth.user-enabled',
  recoveryCodesGenerated: 'auth.recovery-codes-generated',
  recoveryCodeUsed: 'auth.recovery-code-used',
  setupCodeIssued: 'auth.setup-code-issued',
  setupCodeUsed: 'auth.setup-code-used',
  loginStepPassed: 'auth.login-step-passed',
  loginStepFailed: 'auth.login-step-failed',
  passwordSet: 'auth.password-set',
  passwordRehashed: 'auth.password-rehashed',
  totpEnrolled: 'auth.totp-enrolled',
  totpConfirmed: 'auth.totp-confirmed',
  totpRemoved: 'auth.totp-removed',
  passkeyRegistrationStarted: 'auth.passkey-registration-started',
  passkeyRegistered: 'auth.passkey-registered',
  passkeyRenamed: 'auth.passkey-renamed',
  passkeyRevoked: 'auth.passkey-revoked',
  installationCreated: 'auth.installation-created',
  setupCheckFailed: 'auth.setup-check-failed',
  setupCompleted: 'auth.setup-completed',
  userCreated: 'auth.user-created',
  organisationCreated: 'auth.organisation-created',
  roleCreated: 'auth.role-created',
  membershipCreated: 'auth.membership-created',
  administratorRoleToppedUp: 'auth.administrator-role-topped-up',
  /**
   * A grant of a managed role was narrowed from `all-projects` to `own-scope`
   * because a release flagged its permission sensitive. The one category here that
   * is not under `auth.`: the event is about a role (SC-10, decision D-56).
   */
  grantReachReduced: 'role.grant-reach-reduced',
  inviteCreated: 'auth.invite-created',
  inviteInspectFailed: 'auth.invite-inspect-failed',
  inviteAccepted: 'auth.invite-accepted',
  inviteAcceptRefused: 'auth.invite-accept-refused',
  inviteRevoked: 'auth.invite-revoked',
} as const;

/** Details of an auth audit event: scalar values only, so nothing nested can hide a secret. */
export type AuthAuditDetails = Record<string, string | number | boolean | null>;

/**
 * Records one auth audit event in the caller's transaction (CLAUDE.md, Data
 * rules: security tables are audited, not change-logged). The event is install
 * level, with no organisation, unless `organisationId` is given: first-run setup
 * writes about the organisation it made, and the organisation must exist by then.
 * Callers keep every secret, and every address, out of `details`.
 */
export function recordAuthAudit(
  tx: Tx,
  event: {
    category: (typeof AUTH_AUDIT)[keyof typeof AUTH_AUDIT];
    action: string;
    actor: AuthActor;
    targetType: string | null;
    targetId: string | null;
    organisationId?: string | null;
    details?: AuthAuditDetails;
    occurredAt: Date;
  },
) {
  return recordAudit(tx, {
    category: event.category,
    action: event.action,
    actor: event.actor,
    targetType: event.targetType,
    targetId: event.targetId,
    organisationId: event.organisationId ?? null,
    details: event.details ?? null,
    occurredAt: event.occurredAt,
  });
}

/**
 * The id of this server, from `getServerId` (`installation/server-id.ts`), the
 * one reader of the single `installation` row. Rows the auth services write
 * carry it as `origin_server`; a session or a code belongs to this server and is
 * never federated. With `lock` the row is held until the transaction ends, which
 * serialises the setup-code operations. This is `getServerId` with the auth
 * services' own error; other code, such as the API, calls `getServerId`.
 *
 * @throws AuthStateError `installation-missing` when there is no row yet.
 */
export async function serverId(
  tx: Tx,
  options: { lock?: boolean } = {},
): Promise<string> {
  try {
    return await getServerId(tx, options);
  } catch (error) {
    // The auth services answer in their own terms.
    if (error instanceof InstallationMissingError) {
      throw new AuthStateError('installation-missing');
    }
    throw error;
  }
}

/**
 * Reads a live user and holds their row until the transaction ends, so a
 * concurrent disable, enable or login of the same user waits. `no key update`
 * is the lock an UPDATE of the row takes; it does not block other tables'
 * foreign keys to the user. Every writer that checks a user's state and then
 * writes on the strength of it takes this lock first (CLAUDE.md, Data rules).
 *
 * @throws AuthStateError `user-not-found` for an unknown or deleted user.
 */
export async function lockUser(
  tx: Tx,
  userId: string,
): Promise<{ id: string; status: UserStatus }> {
  const [row] = await tx
    .select({ id: user.id, status: user.status })
    .from(user)
    .where(and(eq(user.id, userId), isNull(user.deletedAt)))
    .limit(1)
    .for('no key update');
  if (!row) throw new AuthStateError('user-not-found');
  return row;
}

/** The SQLSTATE code and constraint name in a database error's cause chain. */
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

/**
 * Runs an auth query or write and turns any database failure into a
 * `RecordWriteError` that carries the SQLSTATE and constraint name only. Drivers
 * and Drizzle put the query parameters in their messages, and here those are
 * token and code hashes, which must never reach a log or an error (CLAUDE.md,
 * Privacy rule). Typed auth errors pass through unchanged.
 */
export async function guardedAuth<R>(
  entityType: string,
  operation: string,
  action: () => Promise<R>,
): Promise<R> {
  try {
    return await action();
  } catch (error) {
    if (
      error instanceof AuthInputError ||
      error instanceof AuthStateError ||
      error instanceof RecordWriteError ||
      // What the invite services throw themselves: they carry no value.
      error instanceof AccessDeniedError ||
      error instanceof RecordNotFoundError ||
      error instanceof InviteRefusedError ||
      error instanceof InviteExceedsOwnAccessError
    ) {
      throw error;
    }
    const found = driverError(error);
    throw new RecordWriteError(
      entityType,
      operation,
      found?.code,
      found?.constraint,
    );
  }
}

/** True when `value` is one of the strings in `list`. Checked against the constant list, never used as a key. */
export function isOneOf<T extends string>(
  list: readonly T[],
  value: unknown,
): value is T {
  return (
    typeof value === 'string' && (list as readonly string[]).includes(value)
  );
}
