import { and, eq, isNull, like } from 'drizzle-orm';
import { installation, totpCredential } from '../db/schema/index.js';
import type { Tx } from '../db/write.js';
import { ENCRYPTED_PREFIX } from '../keys/data-keys.js';
import { ServerKeysError } from '../keys/errors.js';
import { loadServerKeys, type ServerKeys } from '../keys/server-keys.js';
import { AuthStateError } from './errors.js';
import { AUTH_AUDIT, guardedAuth, recordAuthAudit } from './shared.js';
import { sealPlainTotpSecrets } from './totp.js';

/** What `bindServerKeys` did. */
export type ServerKeyBinding = {
  /** The loaded keys, for the app to hold and pass to the services that need them. */
  readonly keys: ServerKeys;
  /** True when this call stored the identity public key for the first time. */
  readonly identityBound: boolean;
  /** How many authenticator secrets this call sealed (see `sealPlainTotpSecrets`). */
  readonly secretsSealed: number;
};

/**
 * Loads this server's keys from `keysDir` and binds the identity key to the
 * installation, in the caller's transaction (spec, section Cryptography and
 * keys). The server calls it at start-up, once the `installation` row exists, and
 * passes the result to what needs the keys.
 *
 * It takes the `installation` row `FOR UPDATE` first, the lock start-up already
 * serialises on, so servers that start together take turns: the second finds what
 * the first made. It then reads what the database already says, and lets that
 * decide what a missing file means:
 *
 * - `installation.server_public_key` empty: this is a first start for this
 *   database, so a missing identity file is made, and its public key (the raw 32
 *   bytes, base64url) is stored with one `auth.server-key-bound` event.
 * - It is set: the identity file must exist and must be the same key. A missing
 *   file, or another key, is a `ServerKeysError` and the stored key is never
 *   replaced. A swapped or empty volume must not quietly change the server's
 *   identity.
 * - A sealed authenticator secret exists: the data keys must exist. Their folder
 *   missing is a refusal. With no sealed secret, missing data keys are made.
 * - Authenticator secrets still stored as plain base32 (an install made before
 *   they were sealed) are sealed in place with the current data key, and one
 *   `auth.totp-secrets-encrypted` event carries the count (`sealPlainTotpSecrets`).
 *
 * Only server start-up calls this, before any request is served, so it checks no
 * permission. The audit event holds the algorithm and the public key's
 * fingerprint, never a key file or a path.
 *
 * @throws AuthStateError `installation-missing` when there is no installation row.
 * @throws ServerKeysError `identity-missing`, `identity-mismatch` or
 * `data-keys-missing` when the key directory is not this database's, and
 * `permissions`, `unreadable` or `invalid` for a key file that cannot be used.
 * @throws RecordWriteError when the database refuses a write; it carries the
 * SQLSTATE and constraint name only.
 */
export async function bindServerKeys(
  tx: Tx,
  input: { keysDir: string; now: Date },
): Promise<ServerKeyBinding> {
  const { now } = input;
  const facts = await guardedAuth('installation', 'lock', async () => {
    const [row] = await tx
      .select({
        id: installation.id,
        serverPublicKey: installation.serverPublicKey,
      })
      .from(installation)
      .limit(1)
      .for('update');
    if (row === undefined) throw new AuthStateError('installation-missing');
    const [sealed] = await tx
      .select({ id: totpCredential.id })
      .from(totpCredential)
      .where(like(totpCredential.secret, `${ENCRYPTED_PREFIX}%`))
      .limit(1);
    return {
      installationId: row.id,
      storedPublicKey: row.serverPublicKey,
      hasSealedSecrets: sealed !== undefined,
    };
  });

  // Outside `guardedAuth`: a key refusal is its own typed error, and its message
  // is for the operator.
  const keys = loadServerKeys(input.keysDir, {
    identity: facts.storedPublicKey === null,
    dataKeys: !facts.hasSealedSecrets,
  });
  if (facts.storedPublicKey !== null && facts.storedPublicKey === '') {
    throw new ServerKeysError('identity-mismatch');
  }
  const identityBound = facts.storedPublicKey === null;
  if (identityBound) await storeIdentity(tx, facts.installationId, keys, now);
  const secretsSealed = await sealPlainTotpSecrets(tx, {
    dataKeys: keys.dataKeys,
    now,
  });
  return { keys, identityBound, secretsSealed };
}

/**
 * Stores the public key of `keys` on the installation row, which the caller holds,
 * and writes the audit event. Only while the column is empty.
 *
 * @throws ServerKeysError `identity-mismatch` when a key is stored already.
 */
async function storeIdentity(
  tx: Tx,
  installationId: string,
  keys: ServerKeys,
  now: Date,
): Promise<void> {
  const stored = await guardedAuth('installation', 'update', () =>
    // A savepoint: a failure leaves neither the key nor the event.
    tx.transaction(async (inner) => {
      const [bound] = await inner
        .update(installation)
        .set({ serverPublicKey: keys.identity.publicKey })
        .where(
          and(
            eq(installation.id, installationId),
            isNull(installation.serverPublicKey),
          ),
        )
        .returning({ id: installation.id });
      // The row is held, so this cannot happen; if it does, another key was
      // stored first and ours must not replace it.
      if (bound === undefined) return false;
      await recordAuthAudit(inner, {
        category: AUTH_AUDIT.serverKeyBound,
        action: 'bind',
        actor: { type: 'system', id: null },
        targetType: 'installation',
        targetId: installationId,
        details: {
          algorithm: 'Ed25519',
          fingerprint: keys.identity.fingerprint,
        },
        occurredAt: now,
      });
      return true;
    }),
  );
  // Outside `guardedAuth`, which would turn this error into a database error.
  if (!stored) throw new ServerKeysError('identity-mismatch');
}
