import type { DataKeyRing } from '@osfpm/core/src/keys/data-keys.js';
import {
  ServerKeysError,
  type ServerKeysRefusal,
} from '@osfpm/core/src/keys/errors.js';
import {
  readDataKeyRing,
  readServerIdentity,
} from '@osfpm/core/src/keys/server-keys.js';

/**
 * What the key directory says, in the words `info` and `doctor` print. Reads the
 * key files through the core and answers states, never a key, a key id or a file's
 * content (CLAUDE.md, Data rules). Nothing here makes or changes a file.
 */

/** How the identity key file compares with the public key the installation stored. */
export type IdentityFileState =
  /** The file's public key is the stored one. */
  | 'matches'
  /** The file holds another key than the stored one. */
  | 'does-not-match'
  /** The installation stored a key, and there is no file. */
  | 'missing'
  /** The installation has stored no key yet, so there is nothing to compare with. */
  | 'not-stored'
  /** The file cannot be used: see `problem`. */
  | 'unusable';

/** The state of the identity key file, with the refusal that made it unusable. */
export type IdentityFileReport = {
  readonly state: IdentityFileState;
  /** For `unusable`: why, in the fixed words of `ServerKeysError`. Otherwise null. */
  readonly problem: ServerKeysRefusal | null;
};

/**
 * Compares the identity key file in `keysDir` with `storedPublicKey`, the public key
 * the installation stored (null when it has stored none). Only the public halves are
 * compared.
 */
export function checkIdentityFile(
  keysDir: string,
  storedPublicKey: string | null,
): IdentityFileReport {
  try {
    const identity = readServerIdentity(keysDir);
    if (storedPublicKey === null) return { state: 'not-stored', problem: null };
    if (identity === null) return { state: 'missing', problem: null };
    return {
      state:
        identity.publicKey === storedPublicKey ? 'matches' : 'does-not-match',
      problem: null,
    };
  } catch (error) {
    if (error instanceof ServerKeysError) {
      return { state: 'unusable', problem: error.reason };
    }
    throw error;
  }
}

/** The data keys of the key directory, if there is a usable ring, and why not if there is not. */
export type DataKeyState = {
  /** The ring, or null when there is no usable current key. It is never printed. */
  readonly ring: DataKeyRing | null;
  /** Why the ring could not be built from key files that are there: a fixed word, or null. */
  readonly problem: ServerKeysRefusal | null;
};

/**
 * Reads the data keys of `keysDir` without making any. A directory with no usable
 * current key answers no ring and no problem (the keys are simply not there); a key
 * file that cannot be used answers no ring and the reason.
 */
export function readDataKeyState(keysDir: string): DataKeyState {
  try {
    return { ring: readDataKeyRing(keysDir), problem: null };
  } catch (error) {
    if (error instanceof ServerKeysError) {
      return { ring: null, problem: error.reason };
    }
    throw error;
  }
}
