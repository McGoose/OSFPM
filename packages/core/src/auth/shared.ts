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
import {
  AccessResetInvalidError,
  ResetNotAllowedError,
} from './access-reset-errors.js';
import { ApiTokenRefusedError } from './api-token-errors.js';
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
  /**
   * The public key of the server's identity key pair was stored on the
   * installation, the first time the server started with that key (spec, section
   * Cryptography and keys). Holds the algorithm and the key's fingerprint, both
   * public, and never a key file.
   */
  serverKeyBound: 'auth.server-key-bound',
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
  accessResetCreated: 'auth.access-reset-created',
  accessResetRevoked: 'auth.access-reset-revoked',
  accessResetInspectFailed: 'auth.access-reset-inspect-failed',
  accessResetUsed: 'auth.access-reset-used',
  accessResetUseRefused: 'auth.access-reset-use-refused',
  apiTokenCreated: 'auth.api-token-created',
  apiTokenRevoked: 'auth.api-token-revoked',
  /** One of the organisation's two switches for personal API tokens was turned on or off. */
  apiTokenSwitchChanged: 'auth.api-token-switch-changed',
  /** A request carried a token that does not work. Never holds any part of the token. */
  apiTokenAuthFailed: 'auth.api-token-auth-failed',
  /**
   * One outside call made with a personal API token (SC-10, decision D-68: every
   * outside call is written to the audit log). The second category that is not under
   * `auth.`: it is about a request, not about a login.
   */
  apiCall: 'api.call',
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
    /** The request this was done for, when there is one (the outside-call event). */
    requestId?: string | null;
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
    requestId: event.requestId ?? null,
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
 * How hard `lockUser` holds the user row. `no-key-update` is the lock an UPDATE of
 * the row takes: it queues behind and in front of every other `lockUser`, and does
 * not block other tables' foreign keys to the user. `update` is stronger: it also
 * makes a write that inserts a row pointing at the user (a membership, a session)
 * wait, because the foreign key check takes a key-share lock on the user row. A
 * writer whose check must not be overtaken by a new reference to the user takes it:
 * the use of an admin reset link, and the accept of an invite that gives the user a
 * membership, which exclude each other this way. So does every service that ends a
 * user's sessions in bulk (a password change, removing the authenticator app, a
 * recovery-code sign-in, disabling the user, revoking a passkey), so that a token being
 * made, which holds the row `key-share` and reads its session afterwards, waits for it
 * and finds the session ended. `key-share` is the weakest: it
 * conflicts only with `update`, so it queues behind a writer that holds the row
 * `FOR UPDATE` and nothing else, and any number of writers hold it at once. A writer
 * that only has to be ordered after the use of a reset link takes it, as the services
 * that make and revoke personal API tokens do: they take it before any token row, which
 * is the order the reset's own use takes them in, so the two cannot deadlock.
 */
export type UserLockStrength = 'no-key-update' | 'update' | 'key-share';

/**
 * Reads a live user and holds their row until the transaction ends, so a
 * concurrent disable, enable or login of the same user waits. By default the lock
 * is `FOR NO KEY UPDATE`, the one an UPDATE of the row takes, which does not block
 * other tables' foreign keys to the user; `strength: 'update'` takes `FOR UPDATE` and
 * `strength: 'key-share'` takes `FOR KEY SHARE` (see `UserLockStrength`). Every writer
 * that checks a user's state and then writes on the strength of it takes this lock
 * first, and a writer that also holds a change counter or an invite or reset row takes
 * it last, after them, and before that user's token rows (CLAUDE.md, Data rules).
 *
 * @throws AuthStateError `user-not-found` for an unknown or deleted user.
 */
export async function lockUser(
  tx: Tx,
  userId: string,
  options: { readonly strength?: UserLockStrength } = {},
): Promise<{ id: string; status: UserStatus }> {
  // A value that is none of the two stronger ones is the default, as it always was.
  const mode =
    options.strength === 'update'
      ? 'update'
      : options.strength === 'key-share'
        ? 'key share'
        : 'no key update';
  const [row] = await tx
    .select({ id: user.id, status: user.status })
    .from(user)
    .where(and(eq(user.id, userId), isNull(user.deletedAt)))
    .limit(1)
    .for(mode);
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
      // What the invite and reset services throw themselves: they carry no value.
      error instanceof AccessDeniedError ||
      error instanceof RecordNotFoundError ||
      error instanceof InviteRefusedError ||
      error instanceof InviteExceedsOwnAccessError ||
      error instanceof AccessResetInvalidError ||
      error instanceof ResetNotAllowedError ||
      error instanceof ApiTokenRefusedError
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
