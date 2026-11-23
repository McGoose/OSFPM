import { describe, expect, it } from 'vitest';
import type { RolePermissionReach } from '../db/schema/index.js';
import { uncoveredPermissions } from './escalation.js';

/** What a person holds in an organisation: each permission with its widest reach. */
const held = (entries: readonly (readonly [string, RolePermissionReach])[]) =>
  new Map<string, RolePermissionReach>(entries);

describe('uncoveredPermissions', () => {
  it('lists nothing when everything wanted is held at the same reach or wider', () => {
    const mine = held([
      ['accounts:read', 'own-scope'],
      ['accounts:edit', 'all-projects'],
    ]);
    expect(
      uncoveredPermissions(mine, [
        { key: 'accounts:read', reach: 'own-scope' },
        { key: 'accounts:edit', reach: 'own-scope' },
        { key: 'accounts:edit', reach: 'all-projects' },
      ]),
    ).toEqual([]);
  });

  it('lists a permission that is not held at all', () => {
    expect(
      uncoveredPermissions(held([['accounts:read', 'own-scope']]), [
        { key: 'accounts:read', reach: 'own-scope' },
        { key: 'costs:read', reach: 'own-scope' },
      ]),
    ).toEqual(['costs:read']);
  });

  it('lists a grant for every project that is held only for the organisation', () => {
    expect(
      uncoveredPermissions(held([['accounts:read', 'own-scope']]), [
        { key: 'accounts:read', reach: 'all-projects' },
      ]),
    ).toEqual(['accounts:read']);
  });

  it('does not list a grant for the organisation that is held for every project', () => {
    expect(
      uncoveredPermissions(held([['accounts:read', 'all-projects']]), [
        { key: 'accounts:read', reach: 'own-scope' },
      ]),
    ).toEqual([]);
  });

  it('lists each key once, sorted, however many grants name it', () => {
    expect(
      uncoveredPermissions(held([]), [
        { key: 'costs:read', reach: 'own-scope' },
        { key: 'accounts:edit', reach: 'all-projects' },
        { key: 'costs:read', reach: 'all-projects' },
        { key: 'accounts:edit', reach: 'own-scope' },
      ]),
    ).toEqual(['accounts:edit', 'costs:read']);
  });

  it('holds nothing against nothing wanted', () => {
    expect(uncoveredPermissions(held([]), [])).toEqual([]);
  });

  it('treats a key that looks like an object property as a key, never as a lookup into one', () => {
    // The map is keyed by what the catalogue holds; a hostile-looking name is
    // simply not in it (CLAUDE.md, Data rules: a caller's string never indexes a
    // plain object).
    expect(
      uncoveredPermissions(held([]), [
        { key: '__proto__', reach: 'own-scope' },
        { key: 'constructor', reach: 'own-scope' },
      ]),
    ).toEqual(['__proto__', 'constructor']);
  });
});
