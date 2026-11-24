import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { newId } from '../db/ids.js';
import {
  DataKeyRing,
  ENCRYPTED_PREFIX,
  isEncryptedValue,
} from './data-keys.js';
import { DecryptionError } from './errors.js';

/** A ring of fresh random keys, the last one current. */
function ringOf(count: number): { ring: DataKeyRing; ids: string[] } {
  const keys = new Map<string, Buffer>();
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = newId();
    ids.push(id);
    keys.set(id, randomBytes(32));
  }
  return { ring: new DataKeyRing(keys, ids[ids.length - 1]!), ids };
}

const AAD = 'totp_credential:018f0000-0000-7000-8000-000000000001';
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

describe('DataKeyRing', () => {
  it('seals to v1.<key id>.<nonce>.<ciphertext and tag> and opens it again', () => {
    const { ring } = ringOf(1);
    const sealed = ring.encrypt(SECRET, AAD);
    const parts = sealed.split('.');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
    expect(parts[1]).toBe(ring.currentKeyId);
    // A 12-byte nonce, and the ciphertext is the 32 characters plus a 16-byte tag.
    expect(Buffer.from(parts[2]!, 'base64url')).toHaveLength(12);
    expect(Buffer.from(parts[3]!, 'base64url')).toHaveLength(
      Buffer.byteLength(SECRET) + 16,
    );
    expect(ring.decrypt(sealed, AAD)).toBe(SECRET);
  });

  it('is recognised by its prefix, and a base32 secret never has it', () => {
    const { ring } = ringOf(1);
    expect(isEncryptedValue(ring.encrypt(SECRET, AAD))).toBe(true);
    expect(ENCRYPTED_PREFIX).toBe('v1.');
    expect(isEncryptedValue(SECRET)).toBe(false);
    expect(isEncryptedValue('')).toBe(false);
  });

  it('does not contain the plaintext, or the secret in any base encoding', () => {
    const { ring } = ringOf(1);
    const sealed = ring.encrypt(SECRET, AAD);
    expect(sealed).not.toContain(SECRET);
    expect(sealed).not.toContain(Buffer.from(SECRET).toString('base64url'));
    expect(sealed).not.toContain(Buffer.from(SECRET).toString('hex'));
  });

  it('uses a new random nonce for every encryption', () => {
    const { ring } = ringOf(1);
    const first = ring.encrypt(SECRET, AAD);
    const second = ring.encrypt(SECRET, AAD);
    expect(first).not.toBe(second);
    expect(first.split('.')[2]).not.toBe(second.split('.')[2]);
  });

  it('refuses a ciphertext opened with other additional data', () => {
    const { ring } = ringOf(1);
    const sealed = ring.encrypt(SECRET, AAD);
    expect(() =>
      ring.decrypt(
        sealed,
        'totp_credential:018f0000-0000-7000-8000-000000000002',
      ),
    ).toThrow(DecryptionError);
  });

  it('refuses a ciphertext that was changed in any part', () => {
    const { ring } = ringOf(1);
    const [version, keyId, nonce, body] = ring.encrypt(SECRET, AAD).split('.');
    const flip = (text: string) =>
      (text[0] === 'A' ? 'B' : 'A') + text.slice(1);
    for (const tampered of [
      [version, keyId, flip(nonce!), body],
      [version, keyId, nonce, flip(body!)],
      [version, keyId, nonce, body!.slice(0, -4)],
      ['v2', keyId, nonce, body],
    ]) {
      expect(() => ring.decrypt(tampered.join('.'), AAD)).toThrow(
        DecryptionError,
      );
    }
  });

  it('refuses a ciphertext made with a key the ring does not hold', () => {
    const sealed = ringOf(1).ring.encrypt(SECRET, AAD);
    expect(() => ringOf(1).ring.decrypt(sealed, AAD)).toThrow(DecryptionError);
  });

  it('refuses text that is not a ciphertext, with no detail in the error', () => {
    const { ring } = ringOf(1);
    for (const text of [
      '',
      SECRET,
      'v1.',
      'v1...',
      'v1.a.b.c.d',
      `v1.${ring.currentKeyId}.${'A'.repeat(16)}.${'A'.repeat(200_000)}`,
      '__proto__.constructor.toString.x',
    ]) {
      const error = (() => {
        try {
          ring.decrypt(text, AAD);
        } catch (caught) {
          return caught;
        }
        return undefined;
      })();
      expect(error).toBeInstanceOf(DecryptionError);
      const message = (error as DecryptionError).message;
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain(ring.currentKeyId);
    }
  });

  it('encrypts with the current key and still opens what an older key sealed', () => {
    const oldId = newId();
    const oldKey = randomBytes(32);
    const newKeyId = newId();
    const before = new DataKeyRing(new Map([[oldId, oldKey]]), oldId);
    const after = new DataKeyRing(
      new Map([
        [oldId, oldKey],
        [newKeyId, randomBytes(32)],
      ]),
      newKeyId,
    );
    const sealedBefore = before.encrypt(SECRET, AAD);
    const sealedAfter = after.encrypt(SECRET, AAD);

    expect(sealedAfter.split('.')[1]).toBe(newKeyId);
    expect(after.decrypt(sealedBefore, AAD)).toBe(SECRET);
    expect(after.decrypt(sealedAfter, AAD)).toBe(SECRET);
    // The ring that does not hold the new key cannot open its text.
    expect(() => before.decrypt(sealedAfter, AAD)).toThrow(DecryptionError);
  });

  it('does not show its keys when it is printed or turned into JSON', () => {
    const key = Buffer.alloc(32, 0x41);
    const id = newId();
    const ring = new DataKeyRing(new Map([[id, key]]), id);
    const text = `${JSON.stringify(ring)} ${inspect(ring, { depth: 5 })}`;
    expect(text).not.toContain(key.toString('base64'));
    expect(text).not.toContain(key.toString('hex'));
    expect(Object.values(ring)).not.toContain(key);
  });

  it('refuses to be made with a key of the wrong length or without its current key', () => {
    const id = newId();
    expect(
      () => new DataKeyRing(new Map([[id, randomBytes(16)]]), id),
    ).toThrow();
    expect(() => new DataKeyRing(new Map(), id)).toThrow();
    expect(
      () => new DataKeyRing(new Map([[id, randomBytes(32)]]), newId()),
    ).toThrow();
  });
});
