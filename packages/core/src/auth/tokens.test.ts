import { describe, expect, it } from 'vitest';
import {
  generateHumanCode,
  generateToken,
  HUMAN_CODE_ALPHABET,
  HUMAN_CODE_BITS,
  HUMAN_CODE_LENGTH,
  hashHumanCode,
  hashToken,
  normaliseHumanCode,
} from './tokens.js';

describe('generateToken', () => {
  it('is 32 random bytes as 43 base64url characters', () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('never repeats', () => {
    const tokens = new Set(Array.from({ length: 1000 }, generateToken));
    expect(tokens.size).toBe(1000);
  });
});

describe('hashToken', () => {
  it('is the SHA-256 as 64 lower-case hex characters', () => {
    // The published SHA-256 of "abc".
    expect(hashToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('is the same for the same value and differs for another', () => {
    const token = generateToken();
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toBe(hashToken(generateToken()));
  });

  it('does not contain the token', () => {
    const token = generateToken();
    expect(hashToken(token)).not.toContain(token);
  });
});

describe('human-typeable codes', () => {
  it('carry at least 80 bits of randomness', () => {
    expect(HUMAN_CODE_ALPHABET).toHaveLength(32);
    expect(new Set(HUMAN_CODE_ALPHABET).size).toBe(32);
    expect(HUMAN_CODE_BITS).toBeGreaterThanOrEqual(80);
  });

  it('leave out the characters that are easy to misread', () => {
    for (const ambiguous of ['I', 'L', 'O', 'U']) {
      expect(HUMAN_CODE_ALPHABET).not.toContain(ambiguous);
    }
  });

  it('are 16 characters shown in four groups of four', () => {
    const code = generateHumanCode();
    expect(code).toMatch(
      /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/,
    );
    expect(code.replaceAll('-', '')).toHaveLength(HUMAN_CODE_LENGTH);
  });

  it('never repeat, and use every character of the alphabet', () => {
    const codes = Array.from({ length: 2000 }, generateHumanCode);
    expect(new Set(codes).size).toBe(2000);
    const seen = new Set(codes.join('').replaceAll('-', ''));
    expect([...seen].sort().join('')).toBe(HUMAN_CODE_ALPHABET);
  });

  describe('normaliseHumanCode', () => {
    const code = 'ABCD-EFGH-JKMN-PQRS';

    it('accepts the shown form, lower case, and spaces instead of hyphens', () => {
      expect(normaliseHumanCode(code)).toBe('ABCDEFGHJKMNPQRS');
      expect(normaliseHumanCode(code.toLowerCase())).toBe('ABCDEFGHJKMNPQRS');
      expect(normaliseHumanCode(' abcd efgh jkmn pqrs ')).toBe(
        'ABCDEFGHJKMNPQRS',
      );
      expect(normaliseHumanCode('ABCDEFGHJKMNPQRS')).toBe('ABCDEFGHJKMNPQRS');
    });

    it('reads O as 0 and I and L as 1, as Crockford base32 does', () => {
      expect(normaliseHumanCode('0000-1111-1111-0000')).toBe(
        normaliseHumanCode('OOOO-IIII-LLLL-oooo'),
      );
    });

    it('refuses anything that cannot be a code', () => {
      for (const input of [
        '',
        'ABCD',
        `${code}X`,
        'ABCD-EFGH-JKMN-PQRU', // U is not in the alphabet
        'ABCD-EFGH-JKMN-PQR!',
        'x'.repeat(1000),
        '__proto__',
        'constructor',
        'toString',
        null,
        undefined,
        42,
        { code },
      ]) {
        expect(
          normaliseHumanCode(input),
          String(JSON.stringify(input)).slice(0, 30),
        ).toBeNull();
      }
    });
  });

  describe('hashHumanCode', () => {
    it('gives one hash for every spelling of a code', () => {
      const code = generateHumanCode();
      expect(hashHumanCode(code)).toBe(hashHumanCode(code.toLowerCase()));
      expect(hashHumanCode(code)).toBe(
        hashHumanCode(code.replaceAll('-', ' ')),
      );
      expect(hashHumanCode(code)).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is null for input that cannot be a code, and never contains the code', () => {
      expect(hashHumanCode('nope')).toBeNull();
      const code = generateHumanCode();
      expect(hashHumanCode(code)).not.toContain(code.replaceAll('-', ''));
    });
  });
});
