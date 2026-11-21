import { argon2Sync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  hashPassword,
  PASSWORD_HASH_PARAMS,
  verifyPassword,
} from './password.js';

// An invented password; not a real credential.
const PASSWORD = 'harbour-warehouse-night-shoot';

const PHC =
  /^\$argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

/** A PHC string made straight from `node:crypto`, to stand for a hash made elsewhere or earlier. */
function phcWith(
  password: string,
  settings: {
    memoryKiB: number;
    passes: number;
    parallelism: number;
    saltBytes: number;
    hashBytes: number;
    version?: number;
  },
) {
  const salt = randomBytes(settings.saltBytes);
  const hash = argon2Sync('argon2id', {
    message: password,
    nonce: salt,
    memory: settings.memoryKiB,
    passes: settings.passes,
    parallelism: settings.parallelism,
    tagLength: settings.hashBytes,
  });
  const b64 = (bytes: Buffer) => bytes.toString('base64').replace(/=+$/, '');
  return `$argon2id$v=${settings.version ?? 19}$m=${settings.memoryKiB},t=${settings.passes},p=${settings.parallelism}$${b64(salt)}$${b64(hash)}`;
}

describe('password hashing parameters', () => {
  it('are at least the OWASP minimum for Argon2id', () => {
    expect(PASSWORD_HASH_PARAMS.memoryKiB).toBeGreaterThanOrEqual(19 * 1024);
    expect(PASSWORD_HASH_PARAMS.passes).toBeGreaterThanOrEqual(2);
    expect(PASSWORD_HASH_PARAMS.parallelism).toBeGreaterThanOrEqual(1);
  });
});

describe('hashPassword', () => {
  it('returns a PHC string with the current parameters', async () => {
    const stored = await hashPassword(PASSWORD);
    const match = PHC.exec(stored);
    expect(match, stored).not.toBeNull();
    expect(match!.slice(1, 5).map(Number)).toEqual([
      PASSWORD_HASH_PARAMS.version,
      PASSWORD_HASH_PARAMS.memoryKiB,
      PASSWORD_HASH_PARAMS.passes,
      PASSWORD_HASH_PARAMS.parallelism,
    ]);
    expect(Buffer.from(match![5]!, 'base64')).toHaveLength(
      PASSWORD_HASH_PARAMS.saltBytes,
    );
    expect(Buffer.from(match![6]!, 'base64')).toHaveLength(
      PASSWORD_HASH_PARAMS.hashBytes,
    );
  });

  it('holds the Argon2id hash of the password, as node:crypto computes it independently', async () => {
    const stored = await hashPassword(PASSWORD);
    // Groups: the full match, version, memory, passes, parallelism, salt, hash.
    const [, , memory, passes, parallelism, salt, hash] = PHC.exec(stored)!;
    const expected = argon2Sync('argon2id', {
      message: PASSWORD,
      nonce: Buffer.from(salt!, 'base64'),
      memory: Number(memory),
      passes: Number(passes),
      parallelism: Number(parallelism),
      tagLength: PASSWORD_HASH_PARAMS.hashBytes,
    });
    expect(Buffer.from(hash!, 'base64')).toEqual(expected);
  });

  it('uses a different salt, and so a different string, each time', async () => {
    const [first, second] = await Promise.all([
      hashPassword(PASSWORD),
      hashPassword(PASSWORD),
    ]);
    expect(first).not.toBe(second);
    expect(PHC.exec(first)![5]).not.toBe(PHC.exec(second)![5]);
    expect((await verifyPassword(PASSWORD, first)).ok).toBe(true);
    expect((await verifyPassword(PASSWORD, second)).ok).toBe(true);
  });

  it('does not contain the password', async () => {
    expect(await hashPassword(PASSWORD)).not.toContain(PASSWORD);
  });

  it('hashes an empty or non-ASCII password; the policy is elsewhere', async () => {
    for (const password of ['', 'pässwörd-日本語-🎬']) {
      const stored = await hashPassword(password);
      expect((await verifyPassword(password, stored)).ok).toBe(true);
    }
  });
});

describe('verifyPassword', () => {
  it('accepts the right password, with no rehash for a current hash', async () => {
    const stored = await hashPassword(PASSWORD);
    expect(await verifyPassword(PASSWORD, stored)).toEqual({
      ok: true,
      needsRehash: false,
    });
  });

  it('rejects a wrong password, close misses included', async () => {
    const stored = await hashPassword(PASSWORD);
    for (const wrong of [
      'wrong',
      '',
      PASSWORD.toUpperCase(),
      `${PASSWORD} `,
      PASSWORD.slice(1),
    ]) {
      expect(await verifyPassword(wrong, stored), wrong).toEqual({
        ok: false,
        needsRehash: false,
      });
    }
  });

  describe('needsRehash', () => {
    const current = {
      memoryKiB: PASSWORD_HASH_PARAMS.memoryKiB,
      passes: PASSWORD_HASH_PARAMS.passes,
      parallelism: PASSWORD_HASH_PARAMS.parallelism,
      saltBytes: PASSWORD_HASH_PARAMS.saltBytes,
      hashBytes: PASSWORD_HASH_PARAMS.hashBytes,
    };

    it('is false for a hash made elsewhere with the current parameters', async () => {
      expect(
        await verifyPassword(PASSWORD, phcWith(PASSWORD, current)),
      ).toEqual({ ok: true, needsRehash: false });
    });

    it.each([
      ['less memory', { memoryKiB: 8192 }],
      ['more memory', { memoryKiB: 32768 }],
      ['fewer passes', { passes: 1 }],
      ['more passes', { passes: 3 }],
      ['more parallelism', { parallelism: 2 }],
      ['a shorter salt', { saltBytes: 8 }],
      ['a longer hash', { hashBytes: 64 }],
    ])('is true when the stored hash has %s', async (_label, change) => {
      const stored = phcWith(PASSWORD, { ...current, ...change });
      expect(await verifyPassword(PASSWORD, stored)).toEqual({
        ok: true,
        needsRehash: true,
      });
    });

    it('is false for a wrong password even when the parameters are old', async () => {
      const stored = phcWith(PASSWORD, { ...current, passes: 1 });
      expect(await verifyPassword('wrong', stored)).toEqual({
        ok: false,
        needsRehash: false,
      });
    });
  });

  it('refuses a malformed hash without throwing', async () => {
    const good = await hashPassword(PASSWORD);
    for (const bad of [
      '',
      PASSWORD,
      'plain-text',
      good.replace('argon2id', 'argon2i'),
      good.replace('$v=19$', '$v=16$'),
      good.replace(/\$[^$]+$/, '$'),
      good.slice(0, -4),
      `${good}$extra`,
      // Implausible work: refused before any memory is allocated.
      good.replace(/m=\d+/, 'm=4294967295'),
      good.replace(/t=\d+/, 't=4294967295'),
      good.replace(/p=\d+/, 'p=0'),
      null as unknown as string,
      undefined as unknown as string,
      42 as unknown as string,
    ]) {
      expect(await verifyPassword(PASSWORD, bad), String(bad)).toEqual({
        ok: false,
        needsRehash: false,
      });
    }
  });

  it('does not accept a non-string password', async () => {
    const stored = await hashPassword(PASSWORD);
    expect(await verifyPassword(null as unknown as string, stored)).toEqual({
      ok: false,
      needsRehash: false,
    });
  });
});
