import { eq } from 'drizzle-orm';
import { permission, type ApiTokenAccess } from '../db/schema/index.js';
import type { Tx } from '../db/write.js';
import { readApiTokenSwitches } from './api-token-switches.js';
import { permissionAccess } from './permission-access.js';

/**
 * What a request came in with, for the checks of what it may do (SC-10, decisions D-17
 * and D-68). A person signed in with a browser session acts with everything their roles
 * give them. A personal API token acts as its owner too, but narrowed by what the token
 * says, so it never exceeds its owner's access.
 *
 * The narrowing itself is `credentialPermits`. The permission checks
 * (`hasOrganisationPermission`, `hasProjectPermission`, `hasScopedPermission`) apply it
 * when they are given a credential as their last argument: a check that is given none is
 * not narrowed, as for a session. So a service that a token can reach must be given the
 * credential by its caller and pass it on to every check it makes (`MemberActor` and
 * `SensitiveContext` carry it); the routes that accept tokens are the API's `tokenAccess`
 * routes, and a route may declare it only when the service it calls does.
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

/** Where a check is made: in the organisation (`projectId` null) or on one of its projects. */
export type CredentialScope = {
  readonly organisationId: string;
  readonly projectId: string | null;
};

/**
 * Whether a permission is flagged `grants_sensitive` in the catalogue. A key the
 * catalogue does not know is treated as sensitive: the answer fails closed, so a token
 * is never passed a permission nobody has described.
 */
async function isSensitive(tx: Tx, key: string): Promise<boolean> {
  const [found] = await tx
    .select({ grantsSensitive: permission.grantsSensitive })
    .from(permission)
    .where(eq(permission.key, key))
    .limit(1);
  return found === undefined || found.grantsSensitive;
}

/**
 * Whether a credential may even ask for `key` in `scope`: the narrowing of a token, which
 * the permission checks apply before they look at what the owner holds. It answers `true`
 * for no credential and for a session, which are not narrowed. For a token, all of these
 * must hold, and the first that does not is a refusal:
 *
 * 1. The token works in its own organisation only (`scope.organisationId` is its own).
 * 2. A token for one project passes checks on that project, and none at organisation
 *    level (`scope.projectId` is its own project; an organisation check has none).
 * 3. A `read` token never passes a permission classed `write` (`permissionAccess`, which
 *    answers `write` for a key no list declares).
 * 4. A sensitive permission, one flagged `grants_sensitive` (an unknown key counts as one),
 *    is passed only if its key is in the token's sensitive scope and the organisation's
 *    sensitive switch is on at this moment (decision D-68). The switch is read here, so a
 *    token whose organisation turned it off is refused at once, whatever the credential
 *    in hand says. The owner holding the permission is the check the caller makes next.
 *
 * It only narrows: a `true` is never an allowance. Reads without a lock, and checks no
 * permission of its own.
 */
export async function credentialPermits(
  tx: Tx,
  credential: AccessCredential | undefined,
  scope: CredentialScope,
  key: string,
): Promise<boolean> {
  if (credential === undefined || credential.kind !== 'token') return true;
  if (credential.organisationId !== scope.organisationId) return false;
  if (
    credential.projectId !== null &&
    credential.projectId !== scope.projectId
  ) {
    return false;
  }
  if (credential.access === 'read' && permissionAccess(key) === 'write') {
    return false;
  }
  if (await isSensitive(tx, key)) {
    if (!credential.sensitivePermissions.includes(key)) return false;
    return (await readApiTokenSwitches(tx, credential.organisationId))
      .sensitive;
  }
  return true;
}
