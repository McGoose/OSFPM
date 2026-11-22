import { sql } from 'drizzle-orm';
import {
  bigint,
  customType,
  foreignKey,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns, securityTable, timestamptz } from '../columns.js';
import { user } from './user.js';

/**
 * A `bytea` column read as a `Buffer`. PGlite returns bytes as a `Uint8Array`
 * and node-postgres as a `Buffer`, so both are copied into a `Buffer`.
 */
const bytea = customType<{ data: Buffer; driverData: Uint8Array }>({
  dataType: () => 'bytea',
  fromDriver: (value) => Buffer.from(value),
});

/**
 * A WebAuthn passkey of a user. `credential_id` is base64url and unique across
 * the installation, revoked ones included. `public_key` is the credential's
 * public key as the COSE bytes the authenticator made, which is not a secret.
 * `sign_count` is the last counter the authenticator reported. A revoked passkey
 * is kept, with `revoked_at` set, so its credential id stays taken and the trail
 * can still name it.
 *
 * A security table: written only by the auth service (`auth/passkeys.ts`),
 * directly, and each change is audited (CLAUDE.md, Data rules). Its columns hold
 * no secret, but the credential id, the key and the sign count are never
 * returned to a client after registration, logged or put in an audit event.
 */
export const passkeyCredential = securityTable(
  'passkey_credential',
  {
    ...baseColumns(() => user.id),
    userId: uuid('user_id').notNull(),
    credentialId: text('credential_id').notNull(),
    publicKey: bytea('public_key').notNull(),
    signCount: bigint('sign_count', { mode: 'number' }).notNull().default(0),
    transports: text('transports')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    deviceName: text('device_name'),
    lastUsedAt: timestamptz('last_used_at'),
    revokedAt: timestamptz('revoked_at'),
  },
  (t) => [
    foreignKey({
      name: 'passkey_credential_user_fk',
      columns: [t.userId],
      foreignColumns: [user.id],
    }),
    unique('passkey_credential_credential_id_unique').on(t.credentialId),
  ],
);
