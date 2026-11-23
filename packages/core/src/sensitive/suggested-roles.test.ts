import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { base, seedOrganisation } from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import { settingValue } from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { ACCESS_GROUPS } from './schemas.js';
import {
  ACCESS_SUGGESTED_ROLES_SETTING,
  parseSuggestedRoles,
  readSuggestedRoles,
  SUGGESTED_ROLE_GROUPS,
} from './suggested-roles.js';

/**
 * The organisation setting behind "share with the usual roles" (decision D-69): a map from
 * a group of adjustments, and medical, to role ids. Empty by default, and a value that is
 * wrong in any way shares nothing.
 */

const A = '0199a3c4-0000-7000-8000-0000000000a1';
const B = '0199a3c4-0000-7000-8000-0000000000b2';

describe('the groups the setting can name', () => {
  it('are the groups of adjustments but notes, and medical', () => {
    expect([...SUGGESTED_ROLE_GROUPS]).toEqual([
      ...ACCESS_GROUPS.filter((group) => group !== 'notes'),
      'medical',
    ]);
    expect(ACCESS_SUGGESTED_ROLES_SETTING).toBe('access.suggested-roles');
  });
});

describe('reading a stored value', () => {
  it('takes each group that has a list of role ids, once each', () => {
    const parsed = parseSuggestedRoles({
      schedule: [A, B, A],
      medical: [B],
    });
    expect([...parsed]).toEqual([
      ['schedule', [A, B]],
      ['medical', [B]],
    ]);
  });

  it('leaves out whatever is wrong, and shares nothing for it', () => {
    for (const value of [
      null,
      undefined,
      'schedule',
      5,
      true,
      [A],
      [],
      {},
      { schedule: A },
      { schedule: [] },
      { schedule: ['not an id'] },
      { schedule: [A, 'not an id'] },
      { schedule: { [A]: true } },
      { schedule: [5] },
    ]) {
      expect([...parseSuggestedRoles(value)], JSON.stringify(value)).toEqual(
        [],
      );
    }
  });

  it('ignores a group it may not name, notes first, and a name inherited from an object', () => {
    const parsed = parseSuggestedRoles({
      notes: [A],
      diagnosis: [A],
      constructor: [A],
      __proto__: { schedule: [A] },
      physical: [B],
    });
    expect([...parsed]).toEqual([['physical', [B]]]);
  });
});

describe.each(testTargets)('the stored setting on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  let organisationId: string;
  let projectId: string;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    ({ organisationId, projectId } = await seedOrganisation(database));
  });
  afterAll(async () => {
    await cleanup();
  });
  afterEach(async () => {
    await database.db.delete(settingValue);
  });

  const put = (over: Partial<typeof settingValue.$inferInsert> = {}) =>
    database.db.insert(settingValue).values({
      ...base(organisationId),
      layer: 'org',
      projectId: null,
      key: ACCESS_SUGGESTED_ROLES_SETTING,
      value: { schedule: [A] },
      ...over,
    });
  const read = async (id = organisationId) => [
    ...(await readSuggestedRoles(database.db, id)),
  ];

  it('is empty when the organisation has no such setting, which is every new organisation', async () => {
    expect(await read()).toEqual([]);
  });

  it('is what the organisation’s own row says', async () => {
    await put({ value: { schedule: [A], medical: [B] } });
    expect(await read()).toEqual([
      ['schedule', [A]],
      ['medical', [B]],
    ]);
  });

  it('is nothing of another organisation’s, a project’s, another key’s, or a deleted row’s', async () => {
    const other = await seedOrganisation(database);
    await database.db.insert(settingValue).values({
      ...base(other.organisationId),
      layer: 'org',
      projectId: null,
      key: ACCESS_SUGGESTED_ROLES_SETTING,
      value: { schedule: [A] },
    });
    await put({ layer: 'project', projectId, value: { schedule: [B] } });
    await put({ key: 'access.something-else', value: { schedule: [B] } });
    expect(await read()).toEqual([]);
    // A row that was deleted is not the setting either.
    await put({ deletedAt: new Date() });
    expect(await read()).toEqual([]);
    expect(await read(other.organisationId)).toEqual([['schedule', [A]]]);
  });

  it('is empty for a value that is not an object, as stored', async () => {
    await put({ value: 'everybody' });
    expect(await read()).toEqual([]);
  });
});
