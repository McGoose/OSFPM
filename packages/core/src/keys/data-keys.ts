import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { DecryptionError } from './errors.js';

/**
 * The start of every sealed value. A base32 authenticator secret is made of
 * `A-Z` and `2-7`, so it never starts with this, which is how start-up tells a
 * secret that is still plain from one that is sealed.
 */
export const ENCRYPTED_PREFIX = 'v1.';

/** True when `value` is in the sealed form (it starts with `ENCRYPTED_PREFIX`). */
export function isEncryptedValue(value: string): boolean {
  return value.startsWith(ENCRYPTED_PREFIX);
}

/** AES-256 takes a 32-byte key. */
const KEY_BYTES = 32;
/** GCM's recommended nonce, 96 bits, fresh for every sealing. */
const NONCE_BYTES = 12;
/** The full 128-bit GCM tag, appended to the ciphertext. */
const TAG_BYTES = 16;
/** A sealed value is far shorter than this; anything longer is refused unread. */
const MAX_SEALED_LENGTH = 4096;

/**
 * The server's data keys, for encrypting a secret that has to be read back
 * (an authenticator secret: a code cannot be checked against a hash). One key
 * is current and seals everything new; every key in the ring opens what it
 * sealed, so a later rotation can add a current key while older text still
 * opens. The keys are held in private fields, so printing the ring or turning it
 * into JSON shows the id of the current key and nothing else.
 *
 * Built by `loadServerKeys` from the key files (`server-keys.ts`) and passed to
 * the services that need it; nothing reads a global. A value is sealed with
 * AES-256-GCM, from the built-in `node:crypto`, as
 * `v1.<key id>.<nonce>.<ciphertext and tag>` with base64url parts. The
 * additional authenticated data ties the text to its row, so text copied to
 * another row does not open (spec, section Cryptography and keys).
 */
export class DataKeyRing {
  readonly #keys: ReadonlyMap<string, Buffer>;
  /** The id of the key that seals new values. */
  readonly currentKeyId: string;

  /**
   * @throws Error when a key is not 32 bytes or the current key is not in `keys`.
   * A programming error: `loadServerKeys` checks the files before it builds one.
   */
  constructor(keys: ReadonlyMap<string, Buffer>, currentKeyId: string) {
    for (const key of keys.values()) {
      if (key.length !== KEY_BYTES) {
        throw new Error('A data key must be 32 bytes');
      }
    }
    if (!keys.has(currentKeyId)) {
      throw new Error('The current data key is not in the ring');
    }
    // Copied, so a caller that keeps the map cannot change the ring.
    this.#keys = new Map(keys);
    this.currentKeyId = currentKeyId;
  }

  /**
   * Seals `plaintext` with the current key. `aad` is the additional
   * authenticated data, such as `totp_credential:<user id>`: it is not stored
   * and not secret, but the same text must be given to open the value.
   */
  encrypt(plaintext: string, aad: string): string {
    const key = this.#keys.get(this.currentKeyId)!;
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, nonce, {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const body = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return [
      'v1',
      this.currentKeyId,
      nonce.toString('base64url'),
      Buffer.concat([body, tag]).toString('base64url'),
    ].join('.');
  }

  /**
   * Opens a value `encrypt` made, with the key its id names, for the same `aad`.
   *
   * @throws DecryptionError for anything that is not a value this ring made for
   * this `aad`: a wrong form, an unknown key id, a changed text, other additional
   * data. The error carries no detail and no part of the value.
   */
  decrypt(sealed: string, aad: string): string {
    const parts = sealed.length > MAX_SEALED_LENGTH ? [] : sealed.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') throw new DecryptionError();
    // A Map, so a key id from a caller can never reach a property of an object.
    const key = this.#keys.get(parts[1]!);
    const nonce = Buffer.from(parts[2]!, 'base64url');
    const body = Buffer.from(parts[3]!, 'base64url');
    if (
      key === undefined ||
      nonce.length !== NONCE_BYTES ||
      body.length < TAG_BYTES
    ) {
      throw new DecryptionError();
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, nonce, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
      return Buffer.concat([
        decipher.update(body.subarray(0, body.length - TAG_BYTES)),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // The library's message is dropped: it must not become a second answer.
      throw new DecryptionError();
    }
  }
}
