import { invite, inviteRole } from './invite.js';
import { loginChallenge } from './login-challenge.js';
import { passkeyCredential } from './passkey-credential.js';
import { passwordCredential } from './password-credential.js';
import { recoveryCode } from './recovery-code.js';
import { session } from './session.js';
import { setupCode } from './setup-code.js';
import { totpCredential } from './totp-credential.js';

/**
 * Every security table: login state that is not production data. Sessions
 * change on every request and must not flood the change log or be federated,
 * so these tables are written only by the auth service (`src/auth/`), never
 * through the write helper. Their changes are audited, not change-logged
 * (CLAUDE.md, Data rules). Each is defined with `securityTable`, and a schema
 * test requires this list to match the tables that were.
 *
 * `invite` is the one that carries `organisation_id`, by declaration
 * (`organisationScoped`, see `securityTable`): its role links must stay inside its
 * organisation. The write helper refuses it all the same.
 */
export const SECURITY_TABLES = [
  invite,
  loginChallenge,
  passkeyCredential,
  passwordCredential,
  recoveryCode,
  session,
  setupCode,
  totpCredential,
] as const;

/**
 * The child tables of the security tables, defined with `securityChildTable`: rows
 * that belong to one row of a security table and are deleted with it, so they have
 * no standard columns and no retention class of their own (the parent's cleanup
 * covers both). Like the security tables they are written only by the auth
 * service, directly, never through the write helper, and their changes are
 * audited with the parent's. A schema test requires this list to match the tables
 * that were defined as such.
 */
export const SECURITY_CHILD_TABLES = [inviteRole] as const;
