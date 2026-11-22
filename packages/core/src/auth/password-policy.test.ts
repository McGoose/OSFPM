import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { COMMON_PASSWORDS } from './password-blocklist.js';
import { hashPassword, verifyPassword } from './password.js';
import {
  checkPassword,
  describePasswordRefusal,
  normalisePassword,
  PASSWORD_POLICY,
  PASSWORD_REFUSALS,
} from './password-policy.js';

// Invented person from the demo production; not a real address.
const CONTEXT = { email: 'dana.whitlock@demopictures.example' };

// A passphrase that no rule of the policy matches, 27 code points long.
const PASSPHRASE = 'harbour crane lantern quiet';

/** `length` code points that repeat no unit and form no run, and so match no pattern rule. */
function unpredictable(length: number): string {
  let text = '';
  for (let round = 0; text.length < length; round += 1) {
    text += createHash('sha256').update(`round-${round}`).digest('hex');
  }
  return text.slice(0, length);
}

const codePoints = (text: string) => [...text].length;

describe('PASSWORD_POLICY', () => {
  it('holds NIST SP 800-63B-4 lengths, in one constant marked as not yet verified', () => {
    expect(PASSWORD_POLICY.minLength).toBe(15);
    expect(PASSWORD_POLICY.maxLength).toBe(256);
    expect(PASSWORD_POLICY.verified).toBe(false);
  });
});

describe('normalisePassword', () => {
  it('applies Unicode NFKC', () => {
    // Full-width letters and an ideographic space fold to ASCII under NFKC.
    expect(normalisePassword('ｈａｒｂｏｕｒ　ｃｒａｎｅ')).toBe(
      'harbour crane',
    );
    // A letter and a combining accent become the one composed letter.
    expect(normalisePassword('é')).toBe('é');
  });

  it('makes equivalent spellings hash and verify the same', async () => {
    const typedFullWidth = 'ｈａｒｂｏｕｒ　ｃｒａｎｅ　ｌａｎｔｅｒｎ';
    const typedPlain = 'harbour crane lantern';
    const stored = await hashPassword(normalisePassword(typedFullWidth));
    const result = await verifyPassword(normalisePassword(typedPlain), stored);
    expect(result.ok).toBe(true);
  });
});

describe('checkPassword: length', () => {
  it('refuses 14 code points and accepts 15', () => {
    const fourteen = PASSPHRASE.slice(0, 14);
    const fifteen = PASSPHRASE.slice(0, 15);
    expect(checkPassword(fourteen, CONTEXT)).toEqual({
      ok: false,
      reason: 'too-short',
    });
    expect(checkPassword(fifteen, CONTEXT)).toEqual({
      ok: true,
      password: fifteen,
    });
  });

  it('counts code points, not UTF-16 units', () => {
    const emoji = [
      '😀',
      '😃',
      '😄',
      '😁',
      '😆',
      '😅',
      '🤣',
      '😂',
      '🙂',
      '🙃',
      '😉',
      '😊',
      '😇',
      '🥰',
      '😍',
    ];
    const fourteen = emoji.slice(0, 14).join('');
    expect(fourteen.length).toBe(28);
    expect(checkPassword(fourteen, CONTEXT)).toMatchObject({
      ok: false,
      reason: 'too-short',
    });
    expect(checkPassword(emoji.join(''), CONTEXT)).toMatchObject({ ok: true });
  });

  it('counts after normalisation: a composed accent is one code point', () => {
    const composed14 = 'élève à la crè';
    expect(codePoints(composed14)).toBe(14);
    const decomposed = composed14.normalize('NFD');
    // Longer as typed, but 14 once normalised.
    expect(codePoints(decomposed)).toBeGreaterThan(15);
    expect(checkPassword(decomposed, CONTEXT)).toMatchObject({
      ok: false,
      reason: 'too-short',
    });
    const composed16 = 'élève à la crème';
    const result = checkPassword(composed16.normalize('NFD'), CONTEXT);
    expect(result).toEqual({ ok: true, password: composed16 });
  });

  it('accepts 256 code points and refuses 257', () => {
    expect(checkPassword(unpredictable(256), CONTEXT)).toMatchObject({
      ok: true,
    });
    expect(checkPassword(unpredictable(257), CONTEXT)).toEqual({
      ok: false,
      reason: 'too-long',
    });
  });

  it('counts after normalisation at the top too: one character can expand', () => {
    // U+FDFA is 18 code points under NFKC, so 15 of them are 270.
    const expanding = 'ﷺ'.repeat(15);
    expect(codePoints(expanding)).toBe(15);
    expect(checkPassword(expanding, CONTEXT)).toEqual({
      ok: false,
      reason: 'too-long',
    });
  });

  it('returns the normalised password to hash', () => {
    const result = checkPassword(
      'ｈａｒｂｏｕｒ　ｃｒａｎｅ　ｌａｎｔｅｒｎ',
      CONTEXT,
    );
    expect(result).toEqual({ ok: true, password: 'harbour crane lantern' });
  });
});

describe('checkPassword: no composition rules', () => {
  it.each([
    ['letters only, all lower case', 'plumbtreeclockwise'],
    ['digits only', '493817260594813'],
    ['words with spaces', 'harbour crane lantern quiet'],
    ['no digit, no capital, no symbol', 'moonlightoverthewarehouse'],
  ])('accepts %s', (_name, password) => {
    expect(checkPassword(password, CONTEXT)).toMatchObject({ ok: true });
  });

  it('accepts a long passphrase that repeats once it is long enough to stand alone', () => {
    // The unit is itself acceptable, so repeating it is not refused.
    const unit = 'harbour crane lantern';
    expect(checkPassword(unit + unit, CONTEXT)).toMatchObject({ ok: true });
  });
});

describe('checkPassword: blocklist', () => {
  it('refuses every entry of the list', () => {
    for (const entry of COMMON_PASSWORDS) {
      expect(checkPassword(entry, CONTEXT), entry).toEqual({
        ok: false,
        reason: 'too-common',
      });
    }
  });

  it('keeps every entry in the form the policy compares: normalised, lower case, no separators, long enough', () => {
    expect(COMMON_PASSWORDS.size).toBeGreaterThan(100);
    for (const entry of COMMON_PASSWORDS) {
      expect(entry, entry).toBe(entry.normalize('NFKC').toLowerCase());
      expect(entry, entry).not.toMatch(/[\s\-_.]/);
      expect(codePoints(entry), entry).toBeGreaterThanOrEqual(
        PASSWORD_POLICY.minLength,
      );
    }
  });

  it('compares without regard to case, spelling form or separators', () => {
    const entry = 'correcthorsebatterystaple';
    expect(COMMON_PASSWORDS.has(entry)).toBe(true);
    for (const typed of [
      'CorrectHorseBatteryStaple',
      'correct horse battery staple',
      'Correct-Horse_Battery.Staple',
      'ｃｏｒｒｅｃｔｈｏｒｓｅｂａｔｔｅｒｙｓｔａｐｌｅ',
    ]) {
      expect(checkPassword(typed, CONTEXT), typed).toEqual({
        ok: false,
        reason: 'too-common',
      });
    }
  });

  it('compares the whole password, not a part of it', () => {
    const result = checkPassword(
      'correcthorsebatterystaple-and-a-lantern',
      CONTEXT,
    );
    expect(result).toMatchObject({ ok: true });
  });
});

describe('checkPassword: patterns', () => {
  it.each([
    ['one character repeated', 'aaaaaaaaaaaaaaaa'],
    ['one digit repeated', '1111111111111111'],
    ['a word repeated', 'passwordpassword'],
    ['a short unit repeated', 'abcabcabcabcabcabc'],
    ['digits counting up', '1234567890123456'],
    ['digits counting down', '9876543210987654'],
    ['letters in order', 'abcdefghijklmnop'],
    ['letters in reverse', 'zyxwvutsrqponmlk'],
    ['a keyboard row', 'qwertyuiopasdfgh'],
  ])('refuses %s', (_name, password) => {
    expect(checkPassword(password, CONTEXT)).toEqual({
      ok: false,
      reason: 'too-predictable',
    });
  });

  it('does not refuse a run broken by one character', () => {
    expect(checkPassword('abcdefghijklmnoq7', CONTEXT)).toMatchObject({
      ok: true,
    });
  });
});

describe('checkPassword: context words', () => {
  it.each([
    ['the local part of the email', 'my-Dana.Whitlock-secret-door'],
    ['the local part without its dot', 'danawhitlock-on-the-quay'],
    ['a word of the local part', 'whitlock was here at the harbour'],
    ['the domain', 'login at demopictures.example today'],
    ['a label of the domain', 'riverside-DEMOPICTURES-fan-club'],
    [
      'the local part in full-width letters',
      'ｄａｎａ.ｗｈｉｔｌｏｃｋ and more words',
    ],
  ])('refuses a password that contains %s', (_name, password) => {
    expect(checkPassword(password, CONTEXT)).toEqual({
      ok: false,
      reason: 'contains-email',
    });
  });

  it.each([
    ['in lower case', 'we love osfpm so very much'],
    ['in capitals', 'WE LOVE OSFPM SO VERY MUCH'],
  ])('refuses the product name %s', (_name, password) => {
    expect(checkPassword(password, CONTEXT)).toEqual({
      ok: false,
      reason: 'contains-product-name',
    });
  });

  it('ignores a part of the email too short to mean anything', () => {
    // "al" and "x" would otherwise sit inside almost any password.
    const result = checkPassword(PASSPHRASE, { email: 'al@x.test' });
    expect(result).toMatchObject({ ok: true });
  });

  it('uses the address given, not a fixed one', () => {
    const other = { email: 'quentin.arden@moonlit.example' };
    expect(checkPassword('quentin.arden-and-friends', CONTEXT)).toMatchObject({
      ok: true,
    });
    expect(checkPassword('quentin.arden-and-friends', other)).toEqual({
      ok: false,
      reason: 'contains-email',
    });
  });
});

describe('refusal reasons', () => {
  it('lists the reasons, each with a message written for the person setting the password', () => {
    expect([...PASSWORD_REFUSALS].sort()).toEqual([
      'contains-email',
      'contains-product-name',
      'too-common',
      'too-long',
      'too-predictable',
      'too-short',
    ]);
    for (const reason of PASSWORD_REFUSALS) {
      expect(describePasswordRefusal(reason).length, reason).toBeGreaterThan(
        20,
      );
    }
  });

  it('states the limits from the policy constant, so they are not repeated elsewhere', () => {
    expect(describePasswordRefusal('too-short')).toContain(
      String(PASSWORD_POLICY.minLength),
    );
    expect(describePasswordRefusal('too-long')).toContain(
      String(PASSWORD_POLICY.maxLength),
    );
  });
});
