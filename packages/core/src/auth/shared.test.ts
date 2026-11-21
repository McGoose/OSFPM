import { describe, expect, it } from 'vitest';
import { RecordWriteError } from '../db/write.js';
import { AuthInputError, AuthStateError } from './errors.js';
import { guardedAuth, isOneOf } from './shared.js';

const SECRET = 'secret-marker-9d2e';

describe('guardedAuth', () => {
  it('turns a database error into one with the SQLSTATE and constraint, and no value', async () => {
    const driver = Object.assign(
      new Error(`insert into session values ('${SECRET}') failed`),
      { code: '23505', constraint: 'session_token_hash_unique' },
    );
    // Drizzle wraps the driver error, with the query and its parameters.
    const wrapped = new Error(`Failed query: params: ${SECRET}`, {
      cause: driver,
    });
    const error = await guardedAuth('session', 'insert', () =>
      Promise.reject(wrapped),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RecordWriteError);
    expect(error).toMatchObject({
      entityType: 'session',
      operation: 'insert',
      code: '23505',
      constraint: 'session_token_hash_unique',
    });
    expect(String((error as Error).message)).not.toContain(SECRET);
    expect(JSON.stringify(error)).not.toContain(SECRET);
    // The original error, with its parameters, is not kept.
    expect((error as Error).cause).toBeUndefined();
  });

  it('turns an error with no driver code, or a thrown string, into a value-free one', async () => {
    for (const thrown of [new Error(SECRET), SECRET, null]) {
      const error = await guardedAuth('session', 'select', () =>
        // Rejected with whatever it is; the cast only satisfies the linter,
        // and the point is that a string or null can be thrown at run time.
        Promise.reject(thrown as Error),
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RecordWriteError);
      expect(JSON.stringify(error)).not.toContain(SECRET);
      expect((error as Error).message).not.toContain(SECRET);
    }
  });

  it('lets the typed errors through unchanged', async () => {
    for (const typed of [
      new AuthInputError('method'),
      new AuthStateError('user-disabled'),
      new RecordWriteError('session', 'insert', '23505', 'x'),
    ]) {
      await expect(
        guardedAuth('session', 'insert', () => Promise.reject(typed)),
      ).rejects.toBe(typed);
    }
  });

  it('returns what the action returns', async () => {
    expect(
      await guardedAuth('session', 'select', () => Promise.resolve(42)),
    ).toBe(42);
  });
});

describe('the auth errors', () => {
  it('name the field or the reason, never a value', () => {
    expect(new AuthInputError('method').message).toBe('Invalid method');
    expect(new AuthInputError('method').field).toBe('method');
    expect(new AuthStateError('setup-complete').message).toContain(
      'setup-complete',
    );
  });
});

describe('isOneOf', () => {
  const list = ['a', 'b'] as const;

  it('is true only for a member of the list', () => {
    expect(isOneOf(list, 'a')).toBe(true);
    expect(isOneOf(list, 'c')).toBe(false);
  });

  it('is false for the names every object inherits, and for non-strings', () => {
    for (const value of ['__proto__', 'constructor', 'toString', 'length']) {
      expect(isOneOf(list, value), value).toBe(false);
    }
    for (const value of [undefined, null, 1, ['a'], { toString: () => 'a' }]) {
      expect(isOneOf(list, value)).toBe(false);
    }
  });
});
