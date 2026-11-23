import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AccessDeniedError } from '@osfpm/core/src/access/access-denied-error.js';
import { ManagedRoleError } from '@osfpm/core/src/access/managed-role.js';
import { PermissionSyncError } from '@osfpm/core/src/access/permission-sync.js';
import { AccountInputError } from '@osfpm/core/src/accounts/service.js';
import {
  AccessResetInvalidError,
  CannotResetSelfError,
  OwnerResetNeedsOwnerError,
  ResetExceedsOwnAccessError,
  ResetNotAllowedError,
  UserInOtherOrganisationsError,
  UserNotActiveError,
} from '@osfpm/core/src/auth/access-reset-errors.js';
import { AuthInputError, AuthStateError } from '@osfpm/core/src/auth/errors.js';
import {
  AccountExistsError,
  AlreadyMemberError,
  InviteEmailMismatchError,
  InviteExceedsOwnAccessError,
  InviteInvalidError,
  InvitePasswordRefusedError,
  InviteRefusedError,
} from '@osfpm/core/src/auth/invite-errors.js';
import {
  describePasswordRefusal,
  type PasswordRefusal,
} from '@osfpm/core/src/auth/password-policy.js';
import { ContractInputError } from '@osfpm/core/src/contracts/service.js';
import { CostLineInputError } from '@osfpm/core/src/costs/service.js';
import {
  MissingActingUserError,
  RecordNotFoundError,
  RecordStateError,
  RecordWriteError,
  SecurityTableWriteError,
  VersionConflictError,
} from '@osfpm/core/src/db/write.js';
import { InstallationMissingError } from '@osfpm/core/src/installation/server-id.js';
import { LegalHoldInputError } from '@osfpm/core/src/legal-hold/service.js';
import {
  ComplianceReportDeniedError,
  SensitiveAccessDeniedError,
  SensitivePayloadInvalidError,
} from '@osfpm/core/src/sensitive/service.js';
import type { App } from './app.js';

/** An error class, abstract or not, as `instanceof` takes it. */
type ErrorClass = abstract new (...args: never[]) => Error;

/**
 * The service cannot answer right now, for example because the database does
 * not. Maps to a 503. Routes throw it with a message for the log; the response
 * carries fixed text.
 */
export class ServiceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceUnavailableError';
  }
}

/**
 * The server is listening but has not finished starting: the migrations and the
 * permission sync are still to do, or the database cannot be reached yet. Maps
 * to a 503 problem `starting` for every route but the two health routes. The
 * message and the response say nothing about why.
 */
export class StartingError extends Error {
  constructor() {
    super('The server has not finished starting');
    this.name = 'StartingError';
  }
}

/**
 * First-run setup is not complete: the first administrator does not exist yet,
 * so every route but the health routes, `/meta`, the OpenAPI document and the
 * setup routes is closed (SC-10, decision D-56, Q1). Maps to a 503 problem
 * `setup-required`. The message and the response say only that setup is needed:
 * they carry no value.
 */
export class SetupRequiredError extends Error {
  constructor() {
    super('First-run setup is not complete');
    this.name = 'SetupRequiredError';
  }
}

/**
 * The setup code given to first-run setup was no good: unknown, expired,
 * replaced by a newer one, already used, not shaped like a code, or setup is
 * already complete (SC-10). Maps to a 401 `setup-code-invalid` with one fixed body
 * for every cause, so a response never says which. The message and the response
 * name no cause and hold no code.
 */
export class SetupCodeInvalidError extends Error {
  constructor() {
    // Not the text of the response's `detail`, which a test requires.
    super('No live setup code matched the request');
    this.name = 'SetupCodeInvalidError';
  }
}

/**
 * The password given to first-run setup does not meet the password policy (SC-10;
 * NIST SP 800-63B-4, section 3.1.1.2, which requires the reason to be given). Maps
 * to a 422 `password-refused`, as `PasswordRefusedError` does for every other
 * password the policy refuses, with the reason as the `errors` entry at
 * `admin.password` and in the `detail`. Its message is fixed text chosen by the
 * reason alone (`describePasswordRefusal`): it carries no part of the password or
 * of the address, never what was typed.
 */
export class SetupPasswordRefusedError extends Error {
  constructor(readonly reason: PasswordRefusal) {
    super(describePasswordRefusal(reason));
    this.name = 'SetupPasswordRefusedError';
  }
}

/**
 * The route is closed for good: it answers while first-run setup is still to do,
 * and not after (the setup routes). Maps to the same 404 as a path that is no
 * route, code `route-not-found`, so a finished install shows no sign that the
 * route ever existed. The message and the response carry no value.
 */
export class RouteNotFoundError extends Error {
  constructor() {
    super('There is no such route');
    this.name = 'RouteNotFoundError';
  }
}

/**
 * The route needs a signed-in user and the request has none. Maps to a 401.
 * The message is the same whatever the reason (no cookie, an unknown token, an
 * expired or revoked session, a disabled user), so a caller learns nothing
 * about which it was.
 */
export class AuthenticationRequiredError extends Error {
  constructor() {
    super('The request has no valid session');
    this.name = 'AuthenticationRequiredError';
  }
}

/**
 * A request that changes data did not come from this server's own origin
 * (cross-site request forgery defence): it has a session cookie, or is to a route
 * that makes a session (`config.requireOrigin`), and its `Origin` is missing or
 * is another. Maps to a 403. The message names neither the expected origin nor
 * the one that was sent.
 */
export class OriginMismatchError extends Error {
  constructor() {
    super('The Origin header is not the public origin');
    this.name = 'OriginMismatchError';
  }
}

/**
 * The caller has used up the requests the auth routes allow from one address
 * (see `AUTH_RATE_LIMIT`). Maps to a 429. The message and the response name
 * neither the address nor the limit; the route sets `Retry-After` itself.
 */
export class RateLimitedError extends Error {
  constructor() {
    super('The auth rate limit was exceeded');
    this.name = 'RateLimitedError';
  }
}

/**
 * A step of signing in failed: an address no one has, an account with no
 * password, a wrong password, authenticator code or recovery code, a challenge
 * that is unknown, used or over, a disabled user, or an account the throttle
 * has closed. Maps to a 401 `sign-in-failed` with one fixed body for every
 * cause (SC-10), so a response never says which part failed. The message and
 * the response name no cause; the cause is in the audit trail alone.
 */
export class SignInFailedError extends Error {
  constructor() {
    super('The sign-in was not accepted');
    this.name = 'SignInFailedError';
  }
}

/**
 * The session is one a recovery code opened (scope `recovery`), and the route is
 * not one it may call. Maps to a 403 `account-recovery-required`: the user has
 * signed in, but must first set a new password or confirm an authenticator app.
 * The message and the response name no route and no user.
 */
export class RecoveryRequiredError extends Error {
  constructor() {
    super('The session is a recovery session');
    this.name = 'RecoveryRequiredError';
  }
}

/**
 * A signed-in user asked for a change that needs their current password, and it
 * was not given, was wrong, or the account is closed for a while after too many
 * wrong guesses. Maps to a 403 `current-password-incorrect`. One answer for all
 * three, so it tells a guesser nothing. Not a sign-in failure: the user is
 * signed in, so it is not a 401.
 */
export class CurrentPasswordRejectedError extends Error {
  constructor() {
    super('The current password was not accepted');
    this.name = 'CurrentPasswordRejectedError';
  }
}

/**
 * The new password does not meet the password policy (SC-10; NIST SP 800-63B-4,
 * section 3.1.1.2, which requires the reason to be given). Maps to a 422
 * `password-refused` with the reason as the `errors` entry and in the `detail`.
 * Its message is fixed text chosen by the reason alone (`describePasswordRefusal`):
 * it carries no part of the password or of the user's address, never what was typed.
 */
export class PasswordRefusedError extends Error {
  constructor(readonly reason: PasswordRefusal) {
    super(describePasswordRefusal(reason));
    this.name = 'PasswordRefusedError';
  }
}

/**
 * The user already has a confirmed authenticator app. Maps to a 409
 * `totp-already-enrolled`. Setting up another means removing this one first,
 * which asks for the password.
 */
export class TotpAlreadyEnrolledError extends Error {
  constructor() {
    super('A confirmed authenticator already exists');
    this.name = 'TotpAlreadyEnrolledError';
  }
}

/**
 * The user has no authenticator app, or none being set up, to confirm or
 * remove. Maps to a 409 `totp-not-set-up`.
 */
export class TotpNotSetUpError extends Error {
  constructor() {
    super('No authenticator app is set up');
    this.name = 'TotpNotSetUpError';
  }
}

/**
 * The code given to confirm an authenticator app was wrong or not six digits.
 * Maps to a 422 `totp-code-incorrect`. The code is never in the message.
 */
export class TotpCodeIncorrectError extends Error {
  constructor() {
    super('The authenticator code was not correct');
    this.name = 'TotpCodeIncorrectError';
  }
}

/**
 * A passkey could not be added: the challenge was unknown, used, expired or made
 * for another user, the browser's response did not verify (a wrong origin,
 * relying party, challenge or key type, or no user verification), or the
 * credential is already registered. Maps to a 422 `passkey-registration-failed`
 * with one fixed body for every cause. The user is signed in, so it is not a 401.
 * The message and the response name no cause and no value: the library's own
 * messages quote the challenge.
 */
export class PasskeyRegistrationRefusedError extends Error {
  constructor() {
    // Not the text of the response's `detail`, which a test requires.
    super('Passkey registration refused');
    this.name = 'PasskeyRegistrationRefusedError';
  }
}

/**
 * The passkey is the user's only way to sign in: they have no password and no
 * other live passkey, so removing it would lock them out (SC-10, decision D-56).
 * Maps to a 409 `last-sign-in-method`. The message names no user and no passkey.
 */
export class LastSignInMethodError extends Error {
  constructor() {
    super('The passkey is the last way to sign in');
    this.name = 'LastSignInMethodError';
  }
}

/**
 * What a client reads when it has no usable session. One text for every cause,
 * so the response never says whether the cookie was missing, unknown, expired,
 * revoked or the user disabled.
 */
const AUTHENTICATION_REQUIRED_DETAIL = 'Sign in to use this.';

/**
 * What a path that is no route answers, and what a route closed for good answers
 * (`RouteNotFoundError`): one text, so the two cannot be told apart.
 */
const ROUTE_NOT_FOUND = {
  status: 404,
  code: 'route-not-found',
  title: 'Route not found',
  detail: 'There is no endpoint at this path and method.',
} as const;

/** One row of `PROBLEM_TABLE`. */
export type ProblemRule = {
  /** Matched with `instanceof`, so a subclass takes its parent's row. */
  readonly errorClass: ErrorClass;
  readonly status: number;
  /** Stable machine-readable code. It is the last part of the problem `type` URI. */
  readonly code: string;
  readonly title: string;
  /**
   * The `detail` of the response. `null` passes on the error's own message,
   * and only a class whose documentation says its message carries no ids and
   * no values may use it. Every other row states its text here, so what a
   * client reads never depends on what a service put in a message.
   */
  readonly detail: string | null;
  /**
   * The `errors` of the response, for a row whose answer says which field was
   * wrong and why. Field paths and fixed reason codes only, never a value.
   */
  readonly errors?: (error: never) => Problem['errors'];
};

/**
 * Every core error the API tells the caller about, and what it becomes
 * (RFC 9457 problem details). One row per class: the first row an error is an
 * `instanceof` wins. A new module adds one line.
 *
 * A row that does not pass on the error's message states its own `detail`,
 * which never names an id, a permission or a value: a caller who may not see a
 * record learns nothing from the refusal (see `AccessDeniedError`).
 */
export const PROBLEM_TABLE: readonly ProblemRule[] = [
  {
    // The one answer to every failed sign-in step, whatever failed.
    errorClass: SignInFailedError,
    status: 401,
    code: 'sign-in-failed',
    title: 'Sign-in failed',
    detail: 'The sign-in details were not accepted.',
  },
  {
    // The one answer to every setup code that does not work, whatever is wrong.
    errorClass: SetupCodeInvalidError,
    status: 401,
    code: 'setup-code-invalid',
    title: 'Setup code not accepted',
    detail:
      'The setup code was not accepted. Use the code the server printed when it started.',
  },
  {
    // The one answer to every invite token that does not work: unknown, expired,
    // revoked or already used. The cause is in the audit trail alone.
    errorClass: InviteInvalidError,
    status: 401,
    code: 'invite-invalid',
    title: 'Invite not valid',
    detail:
      'This invite link does not work. Ask the person who sent it for a new one.',
  },
  {
    // The one answer to every reset link that does not work: unknown, expired,
    // revoked, already used, or refused when it was used because a rule for who
    // may reset whom no longer holds. The cause is in the audit trail alone.
    errorClass: AccessResetInvalidError,
    status: 401,
    code: 'reset-link-invalid',
    title: 'Reset link not valid',
    detail:
      'This reset link does not work. Ask the administrator who sent it for a new one.',
  },
  {
    errorClass: AuthenticationRequiredError,
    status: 401,
    code: 'authentication-required',
    title: 'Authentication required',
    detail: AUTHENTICATION_REQUIRED_DETAIL,
  },
  {
    // Thrown by the auth services for a state the caller cannot fix, such as a
    // disabled user or a user who is not there. Every reason is the same answer:
    // the reason is for the audit trail, and a client must not be able to tell
    // an account that exists from one that does not.
    errorClass: AuthStateError,
    status: 401,
    code: 'authentication-required',
    title: 'Authentication required',
    detail: AUTHENTICATION_REQUIRED_DETAIL,
  },
  {
    // A value the server chose, such as a session method or a revoke reason,
    // that the auth services refuse. Its message names the field, so the
    // response has fixed text.
    errorClass: AuthInputError,
    status: 400,
    code: 'bad-request',
    title: 'Bad request',
    detail: 'A value in the request is not accepted.',
  },
  {
    errorClass: OriginMismatchError,
    status: 403,
    code: 'origin-mismatch',
    title: 'Origin mismatch',
    detail:
      'This request did not come from the address this server is used at.',
  },
  {
    errorClass: RecoveryRequiredError,
    status: 403,
    code: 'account-recovery-required',
    title: 'Account recovery required',
    detail:
      'This session came from a recovery code. Set a new password or an authenticator app first.',
  },
  {
    errorClass: CurrentPasswordRejectedError,
    status: 403,
    code: 'current-password-incorrect',
    title: 'Current password not accepted',
    detail: 'The current password is missing or was not accepted.',
  },
  {
    errorClass: PasswordRefusedError,
    status: 422,
    code: 'password-refused',
    title: 'Password refused',
    // The reason, written for the person setting the password.
    detail: null,
    errors: (error: PasswordRefusedError) => [
      { in: 'body', path: 'newPassword', code: error.reason },
    ],
  },
  {
    // The person setting the first password is owed the reason, as at any other
    // password change, and gets the same status: the policy answers 422
    // everywhere. Only the field differs, `admin.password` for the setup body.
    errorClass: SetupPasswordRefusedError,
    status: 422,
    code: 'password-refused',
    title: 'Password refused',
    detail: null,
    errors: (error: SetupPasswordRefusedError) => [
      { in: 'body', path: 'admin.password', code: error.reason },
    ],
  },
  {
    // The person opening an invite for a new account is owed the reason, as at any
    // other password: only the field differs, `account.password` for this body.
    errorClass: InvitePasswordRefusedError,
    status: 422,
    code: 'password-refused',
    title: 'Password refused',
    detail: null,
    errors: (error: InvitePasswordRefusedError) => [
      { in: 'body', path: 'account.password', code: error.refusal },
    ],
  },
  {
    // The invite names an address and the person has another. Neither is named.
    errorClass: InviteEmailMismatchError,
    status: 422,
    code: 'invite-email-mismatch',
    title: 'Invite is for another address',
    detail:
      'This invite is for a different email address. Use the address it was sent to.',
  },
  {
    // The roles of an invite hold more than its maker holds. The keys are fixed
    // catalogue names, not values a caller sent, so they are listed.
    errorClass: InviteExceedsOwnAccessError,
    status: 422,
    code: 'invite-exceeds-own-access',
    title: 'Invite gives more than you hold',
    detail:
      'The roles of this invite hold permissions you do not hold in this organisation, or hold only for the organisation and not for every project. The permissions are listed.',
    errors: (error: InviteExceedsOwnAccessError) =>
      error.permissions.map((key) => ({
        in: 'body',
        path: 'roleIds',
        code: key,
      })),
  },
  {
    // People reset themselves with their recovery codes (SC-10).
    errorClass: CannotResetSelfError,
    status: 422,
    code: 'cannot-reset-self',
    title: 'You cannot reset your own access',
    detail:
      'People reset their own access with their recovery codes. Ask another administrator to make a reset link for you.',
  },
  {
    // An administrator of one organisation must not take over an account that
    // also belongs to another (SC-10, decision D-57).
    errorClass: UserInOtherOrganisationsError,
    status: 422,
    code: 'user-in-other-organisations',
    title: 'Person belongs to other organisations',
    detail:
      'This person also belongs to another organisation, so an administrator of this one cannot reset their access. They can use their own recovery codes, or ask whoever runs this server.',
  },
  {
    errorClass: OwnerResetNeedsOwnerError,
    status: 422,
    code: 'owner-reset-needs-owner',
    title: 'Only an owner can reset an owner',
    detail:
      'This person is an owner of the organisation. Only an owner can make a reset link for an owner.',
  },
  {
    // The person holds more than the creator does. The keys are fixed catalogue
    // names, not values a caller sent, so they are listed.
    errorClass: ResetExceedsOwnAccessError,
    status: 422,
    code: 'reset-exceeds-own-access',
    title: 'Person holds more than you do',
    detail:
      'This person holds permissions you do not hold in this organisation, or hold only for the organisation and not for every project. The permissions are listed.',
    errors: (error: ResetExceedsOwnAccessError) =>
      error.permissions.map((key) => ({
        in: 'params',
        path: 'userId',
        code: key,
      })),
  },
  {
    errorClass: UserNotActiveError,
    status: 422,
    code: 'user-not-active',
    title: 'Account not active',
    detail:
      'This person’s account is not active, so a reset link cannot be made for it.',
  },
  {
    errorClass: RouteNotFoundError,
    ...ROUTE_NOT_FOUND,
  },
  {
    errorClass: AlreadyMemberError,
    status: 409,
    code: 'already-member',
    title: 'Already a member',
    detail: 'You already belong to this organisation. The invite was not used.',
  },
  {
    // Tells someone holding a live invite that an account exists for the address:
    // an accepted risk, documented in the API README.
    errorClass: AccountExistsError,
    status: 409,
    code: 'account-exists',
    title: 'Account exists',
    detail:
      'An account with this email address already exists. Sign in, then open the invite link again.',
  },
  {
    errorClass: TotpAlreadyEnrolledError,
    status: 409,
    code: 'totp-already-enrolled',
    title: 'Authenticator app already set up',
    detail:
      'An authenticator app is already set up. Remove it first to set up another.',
  },
  {
    errorClass: TotpNotSetUpError,
    status: 409,
    code: 'totp-not-set-up',
    title: 'No authenticator app set up',
    detail:
      'There is no authenticator app, or none being set up, to do this to.',
  },
  {
    errorClass: TotpCodeIncorrectError,
    status: 422,
    code: 'totp-code-incorrect',
    title: 'Authenticator code incorrect',
    detail: 'The code was not correct. Check the app and try again.',
  },
  {
    errorClass: PasskeyRegistrationRefusedError,
    status: 422,
    code: 'passkey-registration-failed',
    title: 'Passkey registration failed',
    detail: 'The passkey could not be registered. Start again.',
  },
  {
    errorClass: LastSignInMethodError,
    status: 409,
    code: 'last-sign-in-method',
    title: 'Last way to sign in',
    detail:
      'This passkey is the only way to sign in. Set a password or add another passkey first.',
  },
  {
    errorClass: RateLimitedError,
    status: 429,
    code: 'rate-limited',
    title: 'Too many requests',
    detail: 'Too many requests. Wait a little, then try again.',
  },
  {
    errorClass: AccessDeniedError,
    status: 403,
    code: 'access-denied',
    title: 'Access denied',
    detail: 'You do not have access to this.',
  },
  {
    errorClass: SensitiveAccessDeniedError,
    status: 403,
    code: 'access-denied',
    title: 'Access denied',
    detail: 'You do not have access to this.',
  },
  {
    errorClass: ComplianceReportDeniedError,
    status: 403,
    code: 'access-denied',
    title: 'Access denied',
    detail: 'You do not have access to this.',
  },
  {
    errorClass: RecordNotFoundError,
    status: 404,
    code: 'not-found',
    title: 'Not found',
    detail: 'The record was not found.',
  },
  {
    errorClass: VersionConflictError,
    status: 409,
    code: 'version-conflict',
    title: 'Version conflict',
    detail: 'The record has changed since you read it. Read it again.',
  },
  {
    // Also takes AccountHasChildrenError and AccountInUseError.
    errorClass: RecordStateError,
    status: 409,
    code: 'record-state',
    title: 'Record in the wrong state',
    detail: 'The record is in the wrong state for this operation.',
  },
  {
    // The Administrator role is the server's own: nobody edits or deletes it or
    // its permissions, whatever they hold, so the answer is about the role and not
    // about the caller (not a 403). Fixed text, so it names no role.
    errorClass: ManagedRoleError,
    status: 409,
    code: 'role-managed',
    title: 'Role is managed',
    detail:
      'This role is kept by the server. It and its permissions cannot be edited or deleted.',
  },
  // The three input errors below document that they carry no ids and no
  // values, so their own message is safe to show. A test checks that every row
  // with `detail: null` is such a class.
  {
    errorClass: ContractInputError,
    status: 422,
    code: 'invalid-input',
    title: 'Invalid input',
    detail: null,
  },
  {
    errorClass: AccountInputError,
    status: 422,
    code: 'invalid-input',
    title: 'Invalid input',
    detail: null,
  },
  {
    errorClass: CostLineInputError,
    status: 422,
    code: 'invalid-input',
    title: 'Invalid input',
    detail: null,
  },
  {
    // Its JSDoc does not say its message is free of ids and values, so the
    // response has fixed text. The class says: a reason is missing, or a scope
    // is half set.
    errorClass: LegalHoldInputError,
    status: 422,
    code: 'invalid-input',
    title: 'Invalid input',
    detail: 'The legal hold needs a reason, and its scope must be complete.',
  },
  {
    // Its message lists where the payload is wrong and never what is in it.
    errorClass: SensitivePayloadInvalidError,
    status: 422,
    code: 'invalid-input',
    title: 'Invalid input',
    detail: null,
  },
  {
    errorClass: StartingError,
    status: 503,
    code: 'starting',
    title: 'Starting',
    detail: 'The server is starting. Try again shortly.',
  },
  {
    errorClass: SetupRequiredError,
    status: 503,
    code: 'setup-required',
    title: 'Setup required',
    detail:
      'This server has not been set up yet. Enter the setup code to create the first administrator.',
  },
  {
    errorClass: ServiceUnavailableError,
    status: 503,
    code: 'service-unavailable',
    title: 'Service unavailable',
    detail: 'The service is not ready. Try again shortly.',
  },
];

/**
 * Core errors that are deliberately left to become a generic 500, each with
 * the reason. A test requires every error class the core exports to be in
 * `PROBLEM_TABLE` (or a subclass of a row there) or in this list, so a new
 * class cannot be forgotten.
 */
export const INTERNAL_ERRORS: readonly {
  readonly errorClass: ErrorClass;
  readonly reason: string;
}[] = [
  {
    errorClass: RecordWriteError,
    reason:
      'Carries a SQLSTATE and a constraint name, which a caller must not see. A service checks what a caller can get wrong before it writes.',
  },
  {
    errorClass: MissingActingUserError,
    reason:
      'The types forbid it, so it is a bug in the server, not the request.',
  },
  {
    errorClass: InviteRefusedError,
    reason:
      'The base of the invite refusals, never thrown itself: every refusal the API answers is one of its subclasses, which have rows of their own above.',
  },
  {
    errorClass: ResetNotAllowedError,
    reason:
      'The base of the reset link rule refusals, never thrown itself: every refusal the API answers is one of its subclasses, which have rows of their own above.',
  },
  {
    errorClass: SecurityTableWriteError,
    reason:
      'A service handed the write helper a security table, which only the auth service writes. A bug in the server, not the request; the message names the table and no row value.',
  },
  {
    errorClass: PermissionSyncError,
    reason: 'Raised when the server starts, never while it serves a request.',
  },
  {
    errorClass: InstallationMissingError,
    reason:
      'A request with a valid session has an installation behind it, because sessions are only made after setup has created the row. If it is missing, the database is damaged: a bug or a fault, not something the caller did.',
  },
];

/** The shape of every error response (RFC 9457), as `application/problem+json`. */
export const problemSchema = z.object({
  type: z.string().describe('A URI reference that names the kind of problem.'),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().describe('Safe text. It never holds a submitted value.'),
  instance: z.string().describe('The path of the request, without its query.'),
  requestId: z.string().describe('The value of the X-Request-Id header.'),
  code: z.string().describe('Stable machine-readable code.'),
  errors: z
    .array(
      z.object({
        in: z
          .string()
          .describe(
            'Which part of the request: body, querystring, params or headers.',
          ),
        path: z.string().describe('The field, with dots between levels.'),
        code: z.string().describe('The kind of failure, such as too_small.'),
      }),
    )
    .optional()
    .describe(
      'The failing fields of a validation error. Paths only, never values.',
    ),
});

/** A problem response body. */
export type Problem = z.infer<typeof problemSchema>;

/**
 * The OpenAPI entry for a response that is a problem (`application/problem+json`
 * with `problemSchema`), for a route's `response` map, next to its Zod success
 * schema. It only documents the answer: the error handler sends it.
 */
export function problemResponse(description: string) {
  return {
    description,
    content: { 'application/problem+json': { schema: problemSchema } },
  };
}

/** The media type of every error response. */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json; charset=utf-8';

type ProblemParts = {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail: string;
  readonly errors?: Problem['errors'];
};

/** What Fastify's own client errors become, by status. Anything else is `request-error`. */
const CLIENT_ERRORS: ReadonlyMap<
  number,
  Omit<ProblemParts, 'status'>
> = new Map([
  [
    400,
    {
      code: 'bad-request',
      title: 'Bad request',
      detail: 'The request could not be understood.',
    },
  ],
  [
    413,
    {
      code: 'payload-too-large',
      title: 'Payload too large',
      detail: 'The request body is larger than the server accepts.',
    },
  ],
  [
    415,
    {
      code: 'unsupported-media-type',
      title: 'Unsupported media type',
      detail: 'The content type of the request is not supported.',
    },
  ],
]);

const INTERNAL: ProblemParts = {
  status: 500,
  code: 'internal-error',
  title: 'Internal server error',
  detail:
    'An unexpected error occurred. Quote the request ID when you report it.',
};

/** The path of the request without its query string, which may hold a token. */
function pathOf(request: FastifyRequest): string {
  return request.url.split('?', 1)[0] ?? '';
}

/** Sends `parts` as the problem response for `request`. */
function sendProblem(
  request: FastifyRequest,
  reply: FastifyReply,
  parts: ProblemParts,
): FastifyReply {
  const problem: Problem = {
    type: `/problems/${parts.code}`,
    title: parts.title,
    status: parts.status,
    detail: parts.detail,
    instance: pathOf(request),
    requestId: request.id,
    code: parts.code,
    ...(parts.errors ? { errors: parts.errors } : {}),
  };
  return reply
    .code(parts.status)
    .header('x-request-id', request.id)
    .type(PROBLEM_CONTENT_TYPE)
    .send(problem);
}

/** The problem for something thrown while handling a request. Never throws. */
function problemFor(error: unknown): ProblemParts {
  if (hasZodFastifySchemaValidationErrors(error)) {
    // Which part of the request failed: body, querystring, params or headers.
    const context = (error as { validationContext?: unknown })
      .validationContext;
    const part = typeof context === 'string' ? context : 'request';
    return {
      status: 400,
      code: 'validation-failed',
      title: 'Validation failed',
      detail:
        'The request did not match what the endpoint accepts. The fields that failed are listed in errors.',
      // The field paths and the kind of failure only. Zod's message can quote
      // what was submitted, so it is not passed on.
      errors: error.validation.map((issue) => ({
        in: part,
        path: issue.instancePath.replace(/^\//, '').split('/').join('.'),
        code: issue.keyword,
      })),
    };
  }
  for (const rule of PROBLEM_TABLE) {
    if (error instanceof rule.errorClass) {
      const errors = rule.errors?.(error as never);
      return {
        status: rule.status,
        code: rule.code,
        title: rule.title,
        detail: rule.detail ?? error.message,
        ...(errors ? { errors } : {}),
      };
    }
  }
  // Fastify's own refusals of a malformed request: bad JSON, a body over the
  // limit, a media type it cannot read. Their messages can quote the body
  // (Node's JSON error does), so only the status is used.
  const { statusCode, code } = (error ?? {}) as {
    statusCode?: unknown;
    code?: unknown;
  };
  if (
    typeof statusCode === 'number' &&
    statusCode >= 400 &&
    statusCode < 500 &&
    typeof code === 'string' &&
    code.startsWith('FST_ERR_')
  ) {
    const known = CLIENT_ERRORS.get(statusCode);
    return {
      status: statusCode,
      ...(known ?? {
        code: 'request-error',
        title: 'Request error',
        detail: 'The request could not be processed.',
      }),
    };
  }
  return INTERNAL;
}

/**
 * Answers `error` with its problem response and logs it: a warning with the
 * class name for a client error, an error for a 500. Only the class name and
 * the request ID are logged, never the message or the stack, which can quote
 * SQL parameters (CLAUDE.md, Data rules).
 */
export function handleError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  const parts = problemFor(error);
  if (parts.status >= 500) {
    request.log.error({ err: error }, 'request failed');
  } else {
    request.log.warn({ err: error }, 'request refused');
  }
  return sendProblem(request, reply, parts);
}

/**
 * Fastify's `frameworkErrors` hook: errors raised before a route is found,
 * such as a malformed URL, go through the same mapping.
 */
export function handleFrameworkError(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  void handleError(error, request, reply);
}

/**
 * Makes `app` answer every error, and every unknown route, with a problem
 * response (RFC 9457, `application/problem+json`): `type`, `title`, `status`,
 * `detail`, `instance`, `requestId` and `code`.
 *
 * Mapping is by class through `PROBLEM_TABLE`. A validation failure is a 400
 * that lists field paths and no values. Anything not in the table, including
 * `RecordWriteError`, is a 500 with fixed text and the request ID, so no
 * message, stack or SQL reaches the caller. Routes never return core errors
 * themselves: they throw them and this handler maps them.
 */
export function registerErrorHandling(app: App): void {
  app.setErrorHandler((error, request, reply) =>
    handleError(error, request, reply),
  );
  app.setNotFoundHandler((request, reply) =>
    sendProblem(request, reply, ROUTE_NOT_FOUND),
  );
}
