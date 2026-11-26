import { RecordStateError } from '../db/write.js';

/**
 * Why a reset link step was refused. The first four say why a token is no good; the
 * rest are the rules for who may reset whom (SC-10, decision D-57), checked again
 * when the link is used, and the last is a rule only a link the system issued has
 * (P-09a2, decision D-81). All of them are for the audit trail alone: a caller is
 * given one answer for every one of them (`AccessResetInvalidError`), so it learns
 * nothing about which it was, and nothing about the person the link is for.
 */
export const ACCESS_RESET_REFUSAL_REASONS = [
  'unknown',
  'expired',
  'revoked',
  'used',
  /**
   * The person who made the link no longer holds `members:reset-access`, or can no
   * longer sign in. A link the system issued has no creator and never gives this.
   */
  'creator-not-allowed',
  /** The person is no longer a member of the organisation. */
  'target-not-member',
  /** The person is the one who made the link, which the table forbids. */
  'target-is-creator',
  /** The person now belongs to another organisation too. */
  'target-in-other-organisations',
  /** The person is an owner and the creator is not. */
  'target-is-owner',
  /** The person now holds access the creator does not. */
  'target-exceeds-creator',
  /** The person's account is no longer active. */
  'target-not-active',
  /** The person's membership of the organisation was removed, or is still only an invitation. */
  'target-membership-not-active',
  /**
   * A link the system issued, for a person who is no longer an owner of the
   * organisation and no longer holds its managed Administrator role (decision D-81, E2).
   */
  'not-an-administrator',
] as const;
/** One value of `ACCESS_RESET_REFUSAL_REASONS`. */
export type AccessResetRefusalReason =
  (typeof ACCESS_RESET_REFUSAL_REASONS)[number];

/**
 * The reset link does not work: unknown, expired, revoked, already used, or refused
 * when it was used because a rule for who may reset whom no longer holds. One
 * error for all of them, so a caller, and a response, never says which (SC-10), and
 * never anything about the person the link is for. The `reason` is kept for the
 * audit event only, which the service writes before it throws this: the caller
 * catches it inside its transaction and commits, so the event survives (CLAUDE.md,
 * Data rules). Nothing but the audit event was written. The API answers a 401
 * `reset-link-invalid`. The message carries no token, id or reason.
 */
export class AccessResetInvalidError extends Error {
  constructor(readonly reason: AccessResetRefusalReason) {
    // Not the text of the response's `detail`, which a test requires.
    super('No live reset link matched the request');
    this.name = 'AccessResetInvalidError';
  }
}

/**
 * The base of the refusals of `createAccessReset` that say which rule for who may
 * reset whom the person making the link broke. Nothing was written. Each answers a
 * 422 in the API with a code of its own. The messages name no person and no
 * permission, so none of them can leak one.
 */
export class ResetNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResetNotAllowedError';
  }
}

/**
 * The person making the link is the person it is for. People reset themselves with
 * their recovery codes (SC-10). The API answers a 422 `cannot-reset-self`.
 */
export class CannotResetSelfError extends ResetNotAllowedError {
  constructor() {
    super('A link cannot be made for the person asking for it');
    this.name = 'CannotResetSelfError';
  }
}

/**
 * The person belongs to another organisation too, in any status: an administrator
 * of one organisation must not take over an account that also belongs to another.
 * Such a person recovers with their own recovery codes, or through the server's
 * own administration. The API answers a 422 `user-in-other-organisations`.
 */
export class UserInOtherOrganisationsError extends ResetNotAllowedError {
  constructor() {
    super('The person has memberships outside this organisation');
    this.name = 'UserInOtherOrganisationsError';
  }
}

/**
 * The person is an owner and the person making the link is not. The API answers a
 * 422 `owner-reset-needs-owner`.
 */
export class OwnerResetNeedsOwnerError extends ResetNotAllowedError {
  constructor() {
    super('Only an owner may make a link for an owner');
    this.name = 'OwnerResetNeedsOwnerError';
  }
}

/**
 * The person holds permissions the person making the link does not hold in the
 * organisation, or holds only for the organisation where the person holds them for
 * every project. `permissions` lists the keys concerned, sorted, which are
 * catalogue names and not secret, and which the person making the link is owed.
 * No exception for owners: a tier grants nothing by itself (decision D-51). The API
 * answers a 422 `reset-exceeds-own-access`. The message carries no key.
 */
export class ResetExceedsOwnAccessError extends ResetNotAllowedError {
  constructor(readonly permissions: readonly string[]) {
    super('The person holds access the person making the link does not');
    this.name = 'ResetExceedsOwnAccessError';
  }
}

/**
 * The person's account is not active: it is disabled, still only invited, or
 * deleted. The API answers a 422 `user-not-active`.
 */
export class UserNotActiveError extends ResetNotAllowedError {
  constructor() {
    super('The person’s account is not in use');
    this.name = 'UserNotActiveError';
  }
}

/**
 * The person's membership of the organisation is not active: it was removed, or is
 * still only an invitation. A reset link is for someone who belongs to the
 * organisation now, so it is refused whatever the person holds, which for a member
 * who is not active is nothing. The API answers a 422 `membership-not-active`.
 */
export class MembershipNotActiveError extends ResetNotAllowedError {
  constructor() {
    super('The person does not belong to this organisation at present');
    this.name = 'MembershipNotActiveError';
  }
}

/**
 * A reset link cannot be made for the person at this moment: another request is
 * using or revoking their earlier link, holds it and has not changed it yet, so it
 * cannot be replaced, and the database refuses a second live link
 * (`access_reset_live_unique`). Nothing was written, and making the link again
 * works; there is no retry in the service. It is a `RecordStateError`, as
 * `AccountInUseError` is, with its own message and its own row in the API's table:
 * a 409 `reset-link-busy`. `operation` reads `release`, the nearest of its three
 * values (the earlier link is being released, by a use or a revoke), and
 * `entityId` is the person's id, because the link in the way was never read. The
 * message names no id.
 */
export class ResetLinkBusyError extends RecordStateError {
  constructor(userId: string) {
    super('access_reset', userId, 'release');
    this.message =
      'An earlier reset link of the person is being used or revoked';
    this.name = 'ResetLinkBusyError';
  }
}
