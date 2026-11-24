import { and, eq } from 'drizzle-orm';
import { installation } from '../db/schema/index.js';
import type { Tx } from '../db/write.js';
import { ServerKeysError } from '../keys/errors.js';
import { publicKeyFingerprint } from '../keys/identity.js';
import {
  addDataKey,
  inspectKeyDirectory,
  prepareReplacementIdentity,
  readDataKeyRing,
} from '../keys/server-keys.js';
import { recordAdminCommandRun } from './admin-report.js';
import { AUTH_AUDIT, guardedAuth, recordAuthAudit } from './shared.js';
import { countTotpSecrets, resealTotpSecrets } from './totp.js';

/**
 * The admin commands that change the server's keys (P-09a1, decision D-64), and the
 * database work each of them does. The key files are read and made only by
 * `keys/server-keys.ts`; the API's `admin/` folder parses arguments, takes the
 * in-use marker and prints.
 *
 * **They run only while no server uses the database** (CLAUDE.md, Data rules): a
 * running server holds the data keys and the identity key in memory, so a command
 * that changes what is on disk would leave it out of step. The admin command line
 * takes the in-use marker (`db/in-use.ts`) exclusively before it calls any of
 * these, and each takes the `installation` row `FOR UPDATE` first, inside the
 * caller's transaction, as start-up's key step does (`bindServerKeys`), so two
 * commands, or a command and a server that slipped past the marker, take turns.
 *
 * Each writes exactly one audit event, actor `system`, in that transaction: its own
 * event when it changed something, and `admin.command-run` when it found nothing to
 * do or was refused. No key, key id, secret or address is in any event or result:
 * only counts, ids of the installation and fingerprints.
 */

/** Why a key command did nothing at all, for the refusals that are about the installation. */
export type KeyCommandRefusal = 'installation-missing';

/**
 * Takes the `installation` row `FOR UPDATE` and answers its id and stored identity
 * public key, or null when there is no row yet (the server has never started on this
 * database). The caller holds it until its transaction ends.
 */
async function lockInstallation(
  tx: Tx,
): Promise<{ id: string; serverPublicKey: string | null } | null> {
  return guardedAuth('installation', 'lock', async () => {
    const [row] = await tx
      .select({
        id: installation.id,
        serverPublicKey: installation.serverPublicKey,
      })
      .from(installation)
      .limit(1)
      .for('update');
    return row ?? null;
  });
}

/** What `rotateDataKey` did. */
export type RotateDataKeyResult =
  | {
      readonly ok: true;
      /** The authenticator secrets re-sealed under the new key. */
      readonly resealed: number;
      /** The sealed secrets that no key in the directory opens, left as they are. */
      readonly unopenable: number;
    }
  | { readonly ok: false; readonly reason: KeyCommandRefusal };

/**
 * Rotates the data key: adds a new data key to `keysDir` and makes it the current one
 * (the files come first, and the old key files are never deleted: an older backup of
 * the database still needs them), then re-seals every authenticator secret that an
 * older key sealed and the ring still opens, under the new key, all in the caller's
 * transaction. A secret that cannot be opened is left as it is and counted. Writes
 * `auth.data-key-rotated` with the two counts.
 *
 * If the transaction fails after the key files were written, `current` already names
 * the new key. That is harmless: the ring the server builds from the directory still
 * holds every old key, so every secret still opens, and running the command again
 * adds one more key and re-seals the rest. Nothing is half done in the database.
 *
 * With no `installation` row the command is refused (a `admin.command-run` event
 * records it, with no target) and writes nothing to the key directory.
 *
 * Only the admin command line calls it, with every server stopped; it checks no
 * permission (CLAUDE.md, Data rules).
 *
 * @throws ServerKeysError for a key file that cannot be used, before anything is
 * written; the message names a path and nothing from a file.
 * @throws RecordWriteError when the database refuses a write; it carries the
 * SQLSTATE and constraint name only.
 */
export async function rotateDataKey(
  tx: Tx,
  input: { keysDir: string; now: Date },
): Promise<RotateDataKeyResult> {
  const { keysDir, now } = input;
  const row = await lockInstallation(tx);
  if (row === null) {
    await recordAdminCommandRun(tx, {
      command: 'rotate-data-key',
      outcome: 'refused',
      installationId: null,
      details: { reason: 'installation-missing' },
      now,
    });
    return { ok: false, reason: 'installation-missing' };
  }
  // Outside `guardedAuth`: a key refusal is its own typed error, for the operator.
  const ring = addDataKey(keysDir);
  const { resealed, unopenable } = await resealTotpSecrets(tx, {
    dataKeys: ring,
    now,
  });
  if (resealed >= 0) return { ok: true, resealed, unopenable };
  await recordAuthAudit(tx, {
    category: AUTH_AUDIT.dataKeyRotated,
    action: 'rotate',
    actor: { type: 'system', id: null },
    targetType: 'installation',
    targetId: row.id,
    details: { resealed, unopenable },
    occurredAt: now,
  });
  return { ok: true, resealed, unopenable };
}

/** What `acceptDataKeyLoss` did. */
export type AcceptDataKeyLossResult =
  | {
      readonly ok: true;
      /** True when it made a fresh data key; false when a usable current key was there and nothing changed. */
      readonly accepted: boolean;
      /** The sealed authenticator secrets that no key in the directory opens (after a fresh key was made, if one was). */
      readonly unopenable: number;
    }
  | { readonly ok: false; readonly reason: KeyCommandRefusal };

/**
 * Accepts the loss of the data keys: for an install whose data keys are gone, which
 * start-up refuses with `data-keys-missing`. When `keysDir` has no usable current key
 * it makes a fresh data key and makes it current (`addDataKey`; any older key file
 * that is still there is kept and still opens what it sealed), touches no row, and
 * writes `auth.data-key-loss-accepted` with the count of sealed secrets that no key
 * opens. Those people sign in with a passkey, a recovery code or a reset link and set
 * up their authenticator app again (`enrolTotp` replaces a secret that cannot be
 * opened). When a usable current key is there already it changes nothing, counts the
 * secrets that cannot be opened, and writes `admin.command-run` with the outcome
 * `nothing-to-do`.
 *
 * It never reads, makes or changes the identity file: a directory that lost both
 * parts needs this command and `new-identity`, in either order. With no `installation`
 * row it is refused, as `rotateDataKey` is.
 *
 * Only the admin command line calls it, with every server stopped; it checks no
 * permission (CLAUDE.md, Data rules).
 *
 * @throws ServerKeysError for a data key file or a `current` that cannot be used
 * (not a missing one: that is what this accepts); the message names a path and
 * nothing from a file.
 * @throws RecordWriteError when the database refuses a write.
 */
export async function acceptDataKeyLoss(
  tx: Tx,
  input: { keysDir: string; now: Date },
): Promise<AcceptDataKeyLossResult> {
  const { keysDir, now } = input;
  const row = await lockInstallation(tx);
  if (row === null) {
    await recordAdminCommandRun(tx, {
      command: 'accept-data-key-loss',
      outcome: 'refused',
      installationId: null,
      details: { reason: 'installation-missing' },
      now,
    });
    return { ok: false, reason: 'installation-missing' };
  }
  const usable = readDataKeyRing(keysDir);
  if (usable !== null) {
    const { unopenable } = await countTotpSecrets(tx, usable);
    await recordAdminCommandRun(tx, {
      command: 'accept-data-key-loss',
      outcome: 'nothing-to-do',
      installationId: row.id,
      details: { unopenable },
      now,
    });
    return { ok: true, accepted: false, unopenable };
  }
  const ring = addDataKey(keysDir);
  const { unopenable } = await countTotpSecrets(tx, ring);
  await recordAuthAudit(tx, {
    category: AUTH_AUDIT.dataKeyLossAccepted,
    action: 'accept',
    actor: { type: 'system', id: null },
    targetType: 'installation',
    targetId: row.id,
    details: { unopenable },
    occurredAt: now,
  });
  return { ok: true, accepted: true, unopenable };
}

/** What `replaceServerIdentity` did. */
export type ReplaceIdentityResult =
  | {
      readonly ok: true;
      /** The fingerprint of the public key the installation had stored. Public. */
      readonly oldFingerprint: string;
      /** The fingerprint of the new identity key. Public. */
      readonly newFingerprint: string;
    }
  | {
      readonly ok: false;
      readonly reason:
        | KeyCommandRefusal
        /** The installation has stored no identity key: start-up binds the first one, so there is nothing to replace. */
        | 'no-stored-identity'
        /** Something is at the path of the identity file: a wrong volume or a file that can be restored, never replaced here. */
        | 'identity-file-exists';
    };

/**
 * Replaces the server's identity for an install whose identity key file is lost and
 * cannot be restored from a backup: start-up refuses it with `identity-missing`, and
 * restoring the file is always better, because the identity is what other systems
 * will come to recognise the server by. It makes a new Ed25519 key pair, stores its
 * public key on the `installation` row in place of the old one, writes
 * `auth.server-identity-replaced` with the old and the new fingerprint, and then,
 * last, writes the private key to `keysDir` as a new file. The database comes first,
 * so a failure to write the file takes the update and the event back with the caller's
 * transaction, and nothing is left behind.
 *
 * It refuses, writes no key and changes no row, and records `admin.command-run` with
 * the outcome `refused`, when:
 *
 * - **an identity file exists** at the path, whether it matches the stored key or not.
 *   A file that does not match is a wrong volume, and this command never deletes or
 *   overwrites a key file: an operator who is sure moves the file away themselves;
 * - **no key is stored yet**, because start-up binds the first one;
 * - **there is no installation row**, because the server has never started.
 *
 * `announce` is called, with the old fingerprint, after every check has passed and
 * before anything changes: the command line prints its warning there, so a refusal
 * never prints a warning for a change that did not happen.
 *
 * Only the admin command line calls it, with every server stopped and the operator's
 * explicit confirmation; it checks no permission (CLAUDE.md, Data rules). The
 * private key never leaves `keys/`: this returns fingerprints, which are public.
 *
 * @throws ServerKeysError `unreadable` when the key file cannot be made (the directory
 * cannot be written, or something appeared at the path meanwhile): the database change
 * is taken back by the caller's transaction.
 * @throws RecordWriteError when the database refuses a write.
 */
export async function replaceServerIdentity(
  tx: Tx,
  input: {
    keysDir: string;
    now: Date;
    announce?: (about: { oldFingerprint: string }) => void;
  },
): Promise<ReplaceIdentityResult> {
  const { keysDir, now } = input;
  const row = await lockInstallation(tx);
  const refuse = async (
    reason: Extract<ReplaceIdentityResult, { ok: false }>['reason'],
  ): Promise<ReplaceIdentityResult> => {
    await recordAdminCommandRun(tx, {
      command: 'new-identity',
      outcome: 'refused',
      installationId: row?.id ?? null,
      details: { reason },
      now,
    });
    return { ok: false, reason };
  };
  if (row === null) return refuse('installation-missing');
  if (row.serverPublicKey === null) return refuse('no-stored-identity');
  if (inspectKeyDirectory(keysDir).identityFile) {
    return refuse('identity-file-exists');
  }

  const oldFingerprint = publicKeyFingerprint(row.serverPublicKey);
  input.announce?.({ oldFingerprint });
  const pending = prepareReplacementIdentity();
  const newFingerprint = pending.identity.fingerprint;
  const changed = await guardedAuth('installation', 'update', async () => {
    const [done] = await tx
      .update(installation)
      .set({ serverPublicKey: pending.identity.publicKey })
      .where(
        and(
          eq(installation.id, row.id),
          // The row is held, so it still holds the key that was read; the condition
          // is what makes sure a different key is never replaced by mistake.
          eq(installation.serverPublicKey, row.serverPublicKey!),
        ),
      )
      .returning({ id: installation.id });
    return done !== undefined;
  });
  // Outside `guardedAuth`, which would turn this typed error into a database error.
  if (!changed) throw new ServerKeysError('identity-mismatch');
  await recordAuthAudit(tx, {
    category: AUTH_AUDIT.serverIdentityReplaced,
    action: 'replace',
    actor: { type: 'system', id: null },
    targetType: 'installation',
    targetId: row.id,
    details: { oldFingerprint, newFingerprint },
    occurredAt: now,
  });
  // Last: a failure here takes the update and the event back with the transaction.
  pending.write(keysDir);
  return { ok: true, oldFingerprint, newFingerprint };
}
