import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rowsOf } from '../auth/test-support.js';
import type { Database } from '../db/client.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { PERMISSION_LISTS } from './permission-lists.js';
import { permissionAccess } from './permission-access.js';
import { syncPermissions } from './permission-sync.js';

describe('permissionAccess', () => {
  it('answers the class each definition gives its key', () => {
    for (const entry of PERMISSION_LISTS.flat()) {
      expect(permissionAccess(entry.key), entry.key).toBe(entry.access);
    }
    expect(permissionAccess('members:read')).toBe('read');
    expect(permissionAccess('members:invite')).toBe('write');
    expect(permissionAccess('sensitive:read:medical')).toBe('read');
    expect(permissionAccess('sensitive:edit:medical')).toBe('write');
  });

  it('answers write for a key no list declares, so a read token fails closed', () => {
    expect(permissionAccess('budget:read')).toBe('write');
    expect(permissionAccess('')).toBe('write');
  });

  // A key comes from a caller or from a token's scope, so it never indexes a plain
  // object (CLAUDE.md, Data rules): the names every object inherits are no keys.
  it('does not take the names every object inherits for declared keys', () => {
    for (const key of [
      '__proto__',
      'constructor',
      'toString',
      'hasOwnProperty',
    ]) {
      expect(permissionAccess(key), key).toBe('write');
    }
  });
});

// The class lives in code only (maintainer decision, P-03b5): it is not a column of
// the catalogue, so the sync does not store it and nothing the database serves says it.
describe.each(testTargets)('the permission catalogue on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    for (const list of PERMISSION_LISTS)
      await syncPermissions(database.db, list);
  });
  afterAll(async () => {
    await cleanup();
  });

  it('has no column for the class, and the sync stores none', async () => {
    const columns = await rowsOf(
      database,
      sql`select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'permission'
          order by column_name`,
    );
    expect(columns.map((column) => column.column_name)).toEqual([
      'description',
      'grants_sensitive',
      'key',
      'module',
    ]);
    const stored = await rowsOf(
      database,
      sql`select * from permission where key = 'members:read'`,
    );
    expect(stored).toHaveLength(1);
    expect(Object.keys(stored[0]!).sort()).toEqual([
      'description',
      'grants_sensitive',
      'key',
      'module',
    ]);
  });
});
