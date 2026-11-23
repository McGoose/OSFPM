/**
 * Why a personal API token was refused. All of them are for the audit trail alone: a
 * caller is given one answer for every one of them (`ApiTokenInvalidError`), so it
 * learns nothing about which it was, and nothing about the token or its owner
 * (SC-10, decision D-68).
 */
export const API_TOKEN_FAILURE_REASONS = [
  /** No token has this hash, or the value is not shaped like a token. */
  'unknown',
  /** The token's end has passed. */
  'expired',
  /** The token was revoked. */
  'revoked',
  /** The organisation's switch for personal API tokens is off. */
  'switch-off',
  /** The token has a sensitive scope and the organisation's sensitive switch is off. */
  'sensitive-switch-off',
  /** The owner's account is disabled, only invited, or deleted. */
  'user-not-active',
  /** The owner's membership of the organisation is not active. */
  'membership-not-active',
] as const;
/** One value of `API_TOKEN_FAILURE_REASONS`. */
export type ApiTokenFailureReason = (typeof API_TOKEN_FAILURE_REASONS)[number];

/**
 * The base of the refusals of the personal API token services: a token that does not
 * work, a switch that is off, a sensitive scope that is not allowed. Never thrown
 * itself: every refusal the API answers is one of its subclasses, which have rows of
 * their own. The auth services pass them through unchanged (`guardedAuth`).
 */
export class ApiTokenRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiTokenRefusedError';
  }
}

/**
 * The token does not work: unknown, expired, revoked, refused because a switch is off,
 * or its owner's account or membership is not active. One error for all of them, so a
 * caller, and a response, never says which (SC-10), and never anything about the token
 * or its owner. The `reason` is kept for the audit event only, which the service writes
 * before it throws this: the caller catches it inside its transaction and commits, so
 * the event survives (CLAUDE.md, Data rules). Nothing but the audit event was written.
 * The API answers a 401 `invalid-token`. The message carries no token, id or reason.
 */
export class ApiTokenInvalidError extends ApiTokenRefusedError {
  constructor(readonly reason: ApiTokenFailureReason) {
    // Not the text of the response's `detail`, which a test requires.
    super('No live API token matched the request');
    this.name = 'ApiTokenInvalidError';
  }
}

/**
 * The organisation's switch for personal API tokens is off, which is how every
 * organisation starts, so no token can be made. Nothing was written. The API answers a
 * 422 `api-tokens-disabled`.
 */
export class ApiTokensDisabledError extends ApiTokenRefusedError {
  constructor() {
    super('Personal API tokens are not allowed in this organisation');
    this.name = 'ApiTokensDisabledError';
  }
}

/**
 * The token asks for a sensitive scope and the organisation's switch for sensitive
 * tokens is off, which is how every organisation starts. Nothing was written. The API
 * answers a 422 `api-sensitive-tokens-disabled`.
 */
export class ApiSensitiveTokensDisabledError extends ApiTokenRefusedError {
  constructor() {
    super('Sensitive scopes on personal API tokens are not allowed here');
    this.name = 'ApiSensitiveTokensDisabledError';
  }
}

/**
 * A key in the token's sensitive scope is not the key of a permission flagged
 * `grants_sensitive`: it is an ordinary permission, or no permission at all. `indexes`
 * says where in the list the keys are, and never what they are, because a key is a value
 * the caller sent. Nothing was written. The API answers a 422 `not-a-sensitive-permission`.
 */
export class NotASensitivePermissionError extends ApiTokenRefusedError {
  constructor(readonly indexes: readonly number[]) {
    super('A key in the sensitive scope is not a sensitive permission');
    this.name = 'NotASensitivePermissionError';
  }
}

/**
 * The token's sensitive scope names permissions its owner does not hold where the token
 * works: in the organisation for a token of the whole organisation, on the project for a
 * project token. A token never exceeds its owner's access. `permissions` lists the keys
 * concerned, sorted, which are catalogue names and not secret. Nothing was written. The
 * API answers a 422 `token-exceeds-own-access`. The message carries no key.
 */
export class TokenExceedsOwnAccessError extends ApiTokenRefusedError {
  constructor(readonly permissions: readonly string[]) {
    super('The token would hold access its owner does not');
    this.name = 'TokenExceedsOwnAccessError';
  }
}
