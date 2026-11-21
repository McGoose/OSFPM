import { createHash, randomBytes } from 'node:crypto';

/**
 * Secret values (session tokens, recovery and setup codes, later invite and API
 * tokens) are random, shown to the caller once, and stored only as a SHA-256
 * hash (SC-10). SHA-256 is enough because the values carry at least 80 bits of
 * randomness: there is nothing to guess, so no slow hash or salt is needed, and
 * the hash can be looked up directly. A raw value is never stored or logged.
 */

/**
 * A new secret token: 32 random bytes from `node:crypto`, base64url (43
 * characters, 256 bits). Used for session tokens and, later, invite and API
 * tokens. Show it to the caller once and keep only `hashToken(token)`.
 */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The SHA-256 of a secret, as 64 lower-case hex characters. This is the only
 * form of a token or code that is stored. The same input always gives the same
 * hash, so a lookup by hash finds the row.
 */
export function hashToken(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * The characters of a human-typeable code: Crockford base32, which leaves out
 * I, L, O and U so a code read aloud or copied by hand is not misread. 32
 * characters, so each one carries exactly 5 bits.
 */
export const HUMAN_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Characters in a human-typeable code, not counting the hyphens. */
export const HUMAN_CODE_LENGTH = 16;

/**
 * Bits of randomness in a human-typeable code: 16 characters of 5 bits each, 80
 * bits, the least SC-10 allows for a code that is not a full token.
 */
export const HUMAN_CODE_BITS =
  HUMAN_CODE_LENGTH * Math.log2(HUMAN_CODE_ALPHABET.length);

/** Characters per group when a code is shown, as in `ABCD-EFGH-JKMN-PQRS`. */
const HUMAN_CODE_GROUP = 4;

const humanCodeCharacters: ReadonlySet<string> = new Set(HUMAN_CODE_ALPHABET);

/**
 * A new human-typeable code for recovery and setup codes: 16 characters of
 * `HUMAN_CODE_ALPHABET` from `node:crypto`, shown in groups of four. The
 * alphabet has 32 characters, so taking 5 bits of each random byte is unbiased.
 * Show it once and keep only `hashHumanCode(code)`.
 */
export function generateHumanCode(): string {
  const bytes = randomBytes(HUMAN_CODE_LENGTH);
  const characters = Array.from(
    bytes,
    (byte) => HUMAN_CODE_ALPHABET[byte & 0b11111]!,
  );
  const groups: string[] = [];
  for (let i = 0; i < characters.length; i += HUMAN_CODE_GROUP) {
    groups.push(characters.slice(i, i + HUMAN_CODE_GROUP).join(''));
  }
  return groups.join('-');
}

/**
 * The canonical form of a typed human code, or `null` when the input cannot be
 * one. Case, spaces and hyphens do not matter, and O, I and L are read as 0, 1
 * and 1, as in Crockford base32. Every character is checked against the
 * alphabet and the length against `HUMAN_CODE_LENGTH`, so nothing a caller
 * types is looked up as a key.
 */
export function normaliseHumanCode(input: unknown): string | null {
  // A bound first: nothing legitimate is anywhere near this long.
  if (typeof input !== 'string' || input.length > 64) return null;
  const canonical = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (canonical.length !== HUMAN_CODE_LENGTH) return null;
  for (const character of canonical) {
    if (!humanCodeCharacters.has(character)) return null;
  }
  return canonical;
}

/**
 * The stored hash of a typed human code, or `null` when the input cannot be a
 * code (see `normaliseHumanCode`). Two spellings of one code give one hash.
 */
export function hashHumanCode(input: unknown): string | null {
  const canonical = normaliseHumanCode(input);
  return canonical === null ? null : hashToken(canonical);
}
