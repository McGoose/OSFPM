import {
  describePasswordRefusal,
  type PasswordRefusal,
} from './password-policy.js';

/**
 * Why an invite step was refused. The first four say why a token is no good, and
 * are for the audit trail alone: a caller is given one answer for all of them
 * (`InviteInvalidError`), so it learns nothing about which it was. The others are
 * refusals the person is owed.
 */
export const INVITE_REFUSAL_REASONS = [
  'unknown',
  'expired',
  'revoked',
  'used',
  'email-mismatch',
  'already-member',
  'account-exists',
  'password-refused',
] as const;
/** One value of `INVITE_REFUSAL_REASONS`. */
export type InviteRefusalReason = (typeof INVITE_REFUSAL_REASONS)[number];

/**
 * An invite step was refused, and the refusal is one a caller may answer: the
 * invite was not used up, and nothing was written but the audit event. The base of
 * the refusals below. Services audit it and then throw it; the caller catches it
 * inside its transaction, so the audit event is committed, and answers after the
 * commit (CLAUDE.md, Data rules). `reason` is for the audit trail: no message
 * carries a token, an address, a password or an id.
 */
export class InviteRefusedError extends Error {
  constructor(
    readonly reason: InviteRefusalReason,
    message: string,
  ) {
    super(message);
    this.name = 'InviteRefusedError';
  }
}

/**
 * The invite token is no good: unknown, expired, revoked or already used. One
 * error for all four, so a caller, and a response, never says which (SC-10). The
 * `reason` is kept for the audit event only.
 */
export class InviteInvalidError extends InviteRefusedError {
  constructor(reason: 'unknown' | 'expired' | 'revoked' | 'used') {
    // Not the text of the response's `detail`, which a test requires.
    super(reason, 'No live invite matched the request');
    this.name = 'InviteInvalidError';
  }
}

/**
 * The invite names an address and the person accepting has another one. The API
 * answers a 422 `invite-email-mismatch`. The message names neither address.
 */
export class InviteEmailMismatchError extends InviteRefusedError {
  constructor() {
    super('email-mismatch', 'The address does not match the invite');
    this.name = 'InviteEmailMismatchError';
  }
}

/**
 * The signed-in person already has a membership of the organisation. The invite
 * is not used up. The API answers a 409 `already-member`.
 */
export class AlreadyMemberError extends InviteRefusedError {
  constructor() {
    super('already-member', 'The user already belongs to the organisation');
    this.name = 'AlreadyMemberError';
  }
}

/**
 * An account with the address already exists, so a new one cannot be made: the
 * person should sign in and open the link again. The invite is not used up. The
 * API answers a 409 `account-exists`. It tells someone holding a live invite that
 * an account exists for the address, which is an accepted risk (documented in the
 * API README).
 */
export class AccountExistsError extends InviteRefusedError {
  constructor() {
    super('account-exists', 'An account with this address exists');
    this.name = 'AccountExistsError';
  }
}

/**
 * The password given for a new account does not meet the password policy (SC-10;
 * NIST SP 800-63B-4, section 3.1.1.2, which requires the reason to be given).
 * Nothing was made, and the invite is not used up. The API answers a 422
 * `password-refused` with the reason. Its message is fixed text chosen by the
 * reason alone (`describePasswordRefusal`): it carries no part of the password.
 * It is not audited: no secret was guessed.
 */
export class InvitePasswordRefusedError extends InviteRefusedError {
  constructor(readonly refusal: PasswordRefusal) {
    super('password-refused', describePasswordRefusal(refusal));
    this.name = 'InvitePasswordRefusedError';
  }
}

/**
 * The invite would give more than the person making it holds: a role carries a
 * permission they do not have in the organisation, or an `all-projects` grant of
 * one they hold only for the organisation. `permissions` lists the permission keys
 * concerned, sorted, which are not secret and which the person is owed. The API
 * answers a 422 `invite-exceeds-own-access`. Nothing was written. No exception for
 * owners: a tier grants nothing by itself (decision D-51). The message carries no
 * key.
 */
export class InviteExceedsOwnAccessError extends Error {
  constructor(readonly permissions: readonly string[]) {
    super('The invite would give access the person making it does not hold');
    this.name = 'InviteExceedsOwnAccessError';
  }
}
