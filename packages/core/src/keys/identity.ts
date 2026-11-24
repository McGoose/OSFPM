import { createHash, createPublicKey, sign, type KeyObject } from 'node:crypto';

/**
 * The SHA-256 of a raw public key, in lower-case hex, in groups of four
 * separated by a space (sixteen groups), as it is shown to people who compare
 * keys. `publicKey` is the 32 raw bytes in base64url.
 */
export function publicKeyFingerprint(publicKey: string): string {
  const digest = createHash('sha256')
    .update(Buffer.from(publicKey, 'base64url'))
    .digest('hex');
  return digest.match(/.{4}/g)!.join(' ');
}

/**
 * This server's identity: an Ed25519 key pair whose public half is published
 * (`/.well-known/osfpm/server-key`) and bound to the installation. The private
 * key lives in a field no other code can read, and only leaves it as a
 * signature, so printing or logging the object shows the public values alone.
 * Made by `loadServerKeys`. The key pair, signing and verification are the
 * built-in `node:crypto`; nothing here is a primitive of our own.
 */
export class ServerIdentity {
  readonly #privateKey: KeyObject;
  /** The raw 32-byte Ed25519 public key, in base64url. Public. */
  readonly publicKey: string;
  /** `publicKeyFingerprint` of `publicKey`. Public. */
  readonly fingerprint: string;

  /**
   * @throws Error when `privateKey` is not an Ed25519 key. A programming error:
   * `loadServerKeys` has checked the file before it builds one.
   */
  constructor(privateKey: KeyObject) {
    if (
      privateKey.type !== 'private' ||
      privateKey.asymmetricKeyType !== 'ed25519'
    ) {
      throw new Error('The server identity must be an Ed25519 private key');
    }
    this.#privateKey = privateKey;
    const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
    this.publicKey = jwk.x!;
    this.fingerprint = publicKeyFingerprint(this.publicKey);
  }

  /**
   * An Ed25519 signature of `message`, checkable with `publicKey`. Nothing calls
   * it yet: federation and document signing come later, and this is the one door
   * to the private key when they do.
   */
  sign(message: Uint8Array): Buffer {
    return sign(null, message, this.#privateKey);
  }
}
