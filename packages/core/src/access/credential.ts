import type { ApiTokenAccess } from '../db/schema/index.js';

/**
 * What a request came in with, for the checks of what it may do (SC-10, decisions D-17
 * and D-68). A person signed in with a browser session acts with everything their roles
 * give them. A personal API token acts as its owner too, but narrowed by what the token
 * says, so it never exceeds its owner's access.
 *
 * This is the shape only. The narrowing itself (`credentialPermits`) is applied by the
 * permission checks, `hasOrganisationPermission` and `hasProjectPermission`, when a
 * credential is passed to them.
 */

/** A browser session, or no credential at all: the owner's own access, not narrowed. */
export type SessionCredential = { readonly kind: 'session' };

/**
 * A personal API token. Every field comes from the token's row when it was
 * authenticated (`authenticateApiToken`); none of it is the token or its hash.
 */
export type TokenCredential = {
  readonly kind: 'token';
  /** The token's row id. It marks what the token did in the audit trail. */
  readonly tokenId: string;
  /** The only organisation the token works in. */
  readonly organisationId: string;
  /** The only project the token works in, or `null` for the whole organisation. */
  readonly projectId: string | null;
  /** `read` passes only permissions classed `read` (`permissionAccess`). */
  readonly access: ApiTokenAccess;
  /**
   * The sensitive permissions the token may pass, by key: its explicit sensitive scope.
   * Empty for most tokens. A sensitive permission outside this list is never passed.
   */
  readonly sensitivePermissions: readonly string[];
};

/** A session or a token. A check that is given none is not narrowed, as for a session. */
export type AccessCredential = SessionCredential | TokenCredential;

/** The credential of a browser session, for the code that has to say so. */
export const SESSION_CREDENTIAL: SessionCredential = Object.freeze({
  kind: 'session',
});
