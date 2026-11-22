/**
 * The caller passed a value the auth service refuses, such as a session method
 * or revoke reason that is not on its list. Names the field only, never the
 * value, so a secret passed by mistake cannot reach a log or a response.
 * Nothing was written.
 */
export class AuthInputError extends Error {
  constructor(readonly field: string) {
    super(`Invalid ${field}`);
    this.name = 'AuthInputError';
  }
}

/** Why the auth service refused an operation on the current state. */
export type AuthStateReason =
  /** No live user has this id. */
  | 'user-not-found'
  /** The user is disabled, so no session can be created for them. */
  | 'user-disabled'
  /** There is no `installation` row yet, so this server has no id to stamp on rows. */
  | 'installation-missing'
  /** Setup is complete, so no setup code can be issued. */
  | 'setup-complete'
  /**
   * The passkey is the user's last way to sign in: they have no password and no
   * other live passkey, so revoking it would lock them out (SC-10, decision D-56).
   */
  | 'last-sign-in-method';

/**
 * The operation cannot run in the current state (see `AuthStateReason`).
 * Carries the reason only: no id, no secret. Nothing was written.
 */
export class AuthStateError extends Error {
  constructor(readonly reason: AuthStateReason) {
    super(`Auth operation refused: ${reason}`);
    this.name = 'AuthStateError';
  }
}
