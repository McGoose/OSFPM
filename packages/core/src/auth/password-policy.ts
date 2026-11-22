import { COMMON_PASSWORDS } from './password-blocklist.js';

/**
 * The password policy (SC-10, decision D-56), from NIST SP 800-63B-4, section
 * 3.1.1: a password that may be the only factor is at least 15 characters
 * long, a verifier should allow at least 64, no composition rules are imposed,
 * and a prospective password is compared with a blocklist of commonly used,
 * expected or compromised values, with the reason given to the person who
 * chose it (section 3.1.1.2).
 *
 * This is the policy for setting a password. It is never applied to a login
 * attempt, and its refusal reasons are for the person setting the password,
 * never for sign-in (the login routes answer every failure alike).
 *
 * Normalisation is Unicode NFC, which SP 800-63B-4 (section 3.1.1.2) says a
 * verifier should apply to a password before it hashes it. It makes a letter
 * and its combining accent one code point, and leaves compatibility forms
 * alone: a full-width or ligature spelling is a different password, as it is to
 * the person who typed it. It happens here, in one place, before both the length
 * check and the hash, and again before a password is checked at login, so the
 * set and the check cannot disagree. `hashPassword` and `verifyPassword` hash
 * exactly the string they are given.
 *
 * The comparison with the blocklist and with the user's address is looser on
 * purpose: it also folds compatibility forms (NFKC) and case, so a full-width
 * spelling of a listed password is still refused. That fold is for the
 * comparison only; what is hashed is the NFC text.
 */

/**
 * The numbers of the password policy, in one constant until the rule-pack
 * engine takes over (CLAUDE.md, shipped defaults). `verified: false` says
 * nobody has yet checked them against the source named in the file header;
 * they are copied from SP 800-63B-4 and the P-03b3a design. Never repeat them
 * elsewhere: the refusal messages and the routes read them from here.
 */
export const PASSWORD_POLICY = {
  verified: false,
  /** Fewest code points, after normalisation. A password may be the only factor, because TOTP is optional. */
  minLength: 15,
  /** Most code points, after normalisation. Caps the input Argon2 is given. */
  maxLength: 256,
  /**
   * The shortest part of an email address that counts as a context word. A
   * shorter one, such as `al` in `al@x.test`, sits inside almost any password.
   */
  minContextWordLength: 4,
  /** The name of this service, a context word of every password (SP 800-63B-4, section 3.1.1.2). */
  productName: 'osfpm',
} as const;

/**
 * Why a password was refused, a fixed list. `too-predictable` is a whole
 * password that repeats a short unit or counts along a keyboard row or the
 * alphabet; `contains-email` is part of the user's own address.
 */
export const PASSWORD_REFUSALS = [
  'too-short',
  'too-long',
  'too-common',
  'too-predictable',
  'contains-email',
  'contains-product-name',
] as const;
/** One value of `PASSWORD_REFUSALS`. */
export type PasswordRefusal = (typeof PASSWORD_REFUSALS)[number];

/**
 * The result of `checkPassword`. When it is accepted, `password` is the
 * normalised string to hash and to store, never the string as typed.
 */
export type PasswordCheck =
  | { readonly ok: true; readonly password: string }
  | { readonly ok: false; readonly reason: PasswordRefusal };

/** Runs of characters a whole password is refused for following, forwards or backwards, wrapping at the end. */
const RUN_REFERENCES = [
  '0123456789',
  'abcdefghijklmnopqrstuvwxyz',
  'qwertyuiopasdfghjklzxcvbnm',
] as const;

/** What a passphrase may use between its words without changing which words they are. */
const SEPARATORS = /[\s\-_.]+/g;

const codePointLength = (text: string) => Array.from(text).length;

/**
 * The form a password is compared with the blocklist and with an address in:
 * compatibility forms folded (NFKC), then lower case. Looser than what is
 * hashed (`normalisePassword`), so a spelling that only differs in form from a
 * listed password is refused too. Never used for what is stored or checked.
 */
const fold = (text: string) => text.normalize('NFKC').toLowerCase();

/**
 * The password as it is hashed and checked: Unicode NFC (SP 800-63B-4, section
 * 3.1.1.2). Call it on every password, whether it is being set or checked at
 * login, so both sides of the comparison are the same string. Compatibility
 * forms such as full-width letters are left as they are. Anyone may call it; it
 * reads no database.
 */
export function normalisePassword(password: string): string {
  return password.normalize('NFC');
}

/** True when the whole password repeats a unit shorter than the minimum length. */
function isRepetition(characters: readonly string[]): boolean {
  const count = characters.length;
  for (
    let unit = 1;
    unit <= count / 2 && unit < PASSWORD_POLICY.minLength;
    unit += 1
  ) {
    if (count % unit !== 0) continue;
    if (characters.every((one, i) => one === characters[i % unit])) return true;
  }
  return false;
}

/** True when the whole password is a stretch of a run in `RUN_REFERENCES`. */
function isRun(text: string): boolean {
  return RUN_REFERENCES.some((reference) => {
    const forwards = reference.repeat(
      Math.ceil(text.length / reference.length) + 1,
    );
    const backwards = Array.from(forwards).reverse().join('');
    return forwards.includes(text) || backwards.includes(text);
  });
}

/**
 * The words of an email address a password may not contain: the local part
 * whole, without its separators and word by word, and the domain whole and
 * label by label. Parts shorter than `minContextWordLength` are left out.
 */
function emailWords(email: string): string[] {
  const at = email.lastIndexOf('@');
  const local = fold(at < 0 ? email : email.slice(0, at));
  const domain = fold(at < 0 ? '' : email.slice(at + 1));
  const words = new Set<string>();
  const add = (word: string) => {
    if (codePointLength(word) >= PASSWORD_POLICY.minContextWordLength) {
      words.add(word);
    }
  };
  add(local);
  add(local.replace(SEPARATORS, ''));
  for (const word of local.split(/[^\p{L}\p{N}]+/u)) add(word);
  add(domain);
  for (const label of domain.split('.')) add(label);
  return [...words];
}

/**
 * Checks a prospective password against the policy: length in code points
 * after NFC (15 to 256), then the blocklist of common passwords, then the
 * words of the user's own address and the name of this service, then a whole
 * password that is a repeated unit or a run. There are no composition rules.
 * Comparison is case-insensitive, folds compatibility forms (see `fold`) and
 * ignores spaces, hyphens, underscores and
 * dots in the list lookup. A list entry must match the whole password; a
 * context word may sit inside it, because the reason given is "contains your
 * email".
 *
 * `context.email` is the account's stored, normalised address. Returns the
 * normalised password to hash when it is accepted, or the first reason it is
 * refused for. For the person setting the password only: a login attempt never
 * goes through this. Anyone may call it; it reads no database, and neither
 * the password nor the address is logged or put in the result on refusal.
 */
export function checkPassword(
  password: string,
  context: { readonly email: string },
): PasswordCheck {
  const normalised = normalisePassword(password);
  const length = codePointLength(normalised);
  if (length > PASSWORD_POLICY.maxLength) {
    return { ok: false, reason: 'too-long' };
  }
  if (length < PASSWORD_POLICY.minLength) {
    return { ok: false, reason: 'too-short' };
  }
  const folded = fold(normalised);
  if (
    COMMON_PASSWORDS.has(folded) ||
    COMMON_PASSWORDS.has(folded.replace(SEPARATORS, ''))
  ) {
    return { ok: false, reason: 'too-common' };
  }
  if (emailWords(context.email).some((word) => folded.includes(word))) {
    return { ok: false, reason: 'contains-email' };
  }
  if (folded.includes(PASSWORD_POLICY.productName)) {
    return { ok: false, reason: 'contains-product-name' };
  }
  if (isRepetition(Array.from(folded)) || isRun(folded)) {
    return { ok: false, reason: 'too-predictable' };
  }
  return { ok: true, password: normalised };
}

/**
 * The message for the person who chose a refused password, with guidance on
 * what to do instead (SP 800-63B-4, section 3.1.1.2, requires the reason and
 * advice). A fixed sentence for each reason: it takes no password and never
 * repeats one. The limits come from `PASSWORD_POLICY`. Fit to show to the user
 * setting the password, and to no one signing in.
 */
export function describePasswordRefusal(reason: PasswordRefusal): string {
  switch (reason) {
    case 'too-short':
      return `The password is too short. Use at least ${PASSWORD_POLICY.minLength} characters; a few unrelated words make a good passphrase.`;
    case 'too-long':
      return `The password is too long. Use at most ${PASSWORD_POLICY.maxLength} characters.`;
    case 'too-common':
      return 'The password is on the list of common passwords. Choose one that is not, such as a few unrelated words.';
    case 'too-predictable':
      return 'The password repeats itself or counts along the keyboard or the alphabet. Choose one that does not, such as a few unrelated words.';
    case 'contains-email':
      return 'The password contains part of your email address. Choose one that does not.';
    case 'contains-product-name':
      return 'The password contains the name of this service. Choose one that does not.';
  }
}
