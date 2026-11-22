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
 */
export const SECURITY_TABLES = [
  loginChallenge,
  passkeyCredential,
  passwordCredential,
  recoveryCode,
  session,
  setupCode,
  totpCredential,
] as const;
