import { validate, version } from 'uuid';
import { describe, expect, it } from 'vitest';
import { newId } from './ids.js';

describe('newId', () => {
  it('returns valid UUIDv7 values', () => {
    for (let i = 0; i < 100; i++) {
      const id = newId();
      expect(validate(id)).toBe(true);
      expect(version(id)).toBe(7);
    }
  });

  it('sorts by creation time, including within the same millisecond', () => {
    const ids = Array.from({ length: 1000 }, () => newId());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('sorts across different milliseconds', async () => {
    const first = newId();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = newId();
    expect(first < second).toBe(true);
  });
});
