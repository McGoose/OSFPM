import { getTableName, sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedUser } from '../access/test-fixtures.js';
import { rowsOf } from '../auth/test-support.js';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import { tableWriters, tenantTableNames } from '../db/columns.js';
import { person, userPreferences } from '../db/schema/index.js';
import {
  createMigratedDatabase,
  failureOf,
  SQLSTATE,
  testTargets,
} from '../db/test-support.js';

/**
 * The tables of delivery preferences (decision D-69, P-02l2): `user_preferences`, one row per
 * account, service-written by the preferences folder, in the account-lifetime class and with
 * no organisation; and the nullable `communication_preferences` of `person`.
 */

describe('how user_preferences is declared', () => {
  it('is an install-level table the preferences service writes, with a reason in one line', () => {
    expect(getTableName(userPreferences)).toBe('user_preferences');
    const writer = tableWriters().get('user_preferences');
    expect(writer).toMatchObject({
      kind: 'service-written',
      service: 'preferences',
    });
    expect(writer?.reason ?? '').toMatch(/\S/);
    expect(writer?.reason).not.toMatch(/[\r\n]/);
    // Not a tenant table: no organisation to number a change in, so it is audited and not change-logged.
    expect(tenantTableNames().has('user_preferences')).toBe(false);
    expect(
      getTableConfig(userPreferences).columns.map((column) => column.name),
    ).not.toContain('organisation_id');
  });

  it('holds the payload and the account, beside the standard columns, and nothing sensitive', () => {
    const columns = getTableConfig(userPreferences).columns;
    expect(columns.map((column) => column.name).sort()).toEqual(
      [
        'id',
        'origin_server',
        'version',
        'created_at',
        'updated_at',
        'created_by',
        'updated_by',
        'deleted_at',
        'deleted_by',
        'retention_class',
        'user_id',
        'payload',
      ].sort(),
    );
  });
});

describe.each(testTargets)('delivery preferences tables on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  const origin = newId();

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
  });
  afterAll(async () => {
    await cleanup();
  });

  const db = () => database.db;
  const insertPreferences = (userId: string, payload = '{}') =>
    db().execute(
      sql`insert into user_preferences (id, origin_server, user_id, payload)
          values (${newId()}, ${origin}, ${userId}, ${payload}::jsonb)`,
    );

  it('starts a row in the account-lifetime class, which no period ends', async () => {
    const userId = await seedUser(database);
    await insertPreferences(userId, '{"textSize": "large"}');
    expect(
      await rowsOf(
        database,
        sql`select retention_class, version from user_preferences where user_id = ${userId}`,
      ),
    ).toEqual([{ retention_class: 'account-lifetime', version: 1 }]);
  });

  it('holds one row for each account', async () => {
    const userId = await seedUser(database);
    await insertPreferences(userId);
    expect(await failureOf(() => insertPreferences(userId))).toEqual({
      code: SQLSTATE.uniqueViolation,
      constraint: 'user_preferences_user_unique',
    });
  });

  it('needs an account that exists, and a payload', async () => {
    expect(await failureOf(() => insertPreferences(newId()))).toEqual({
      code: SQLSTATE.foreignKeyViolation,
      constraint: 'user_preferences_user_fk',
    });
    const userId = await seedUser(database);
    expect(
      await failureOf(() =>
        db().execute(
          sql`insert into user_preferences (id, origin_server, user_id, payload)
              values (${newId()}, ${origin}, ${userId}, null)`,
        ),
      ),
    ).toMatchObject({ code: '23502' });
  });

  it('goes with the account when the account row is deleted for good: the backstop', async () => {
    const userId = await seedUser(database);
    await insertPreferences(userId);
    await db().execute(sql`delete from "user" where id = ${userId}`);
    expect(
      await rowsOf(
        database,
        sql`select 1 from user_preferences where user_id = ${userId}`,
      ),
    ).toEqual([]);
  });

  it('adds communication_preferences to person as a nullable jsonb, with no default', async () => {
    const [column] = await rowsOf(
      database,
      sql`select data_type, is_nullable, column_default
          from information_schema.columns
          where table_schema = 'public' and table_name = 'person'
            and column_name = 'communication_preferences'`,
    );
    expect(column).toEqual({
      data_type: 'jsonb',
      is_nullable: 'YES',
      column_default: null,
    });
    expect(
      getTableConfig(person).columns.find(
        (c) => c.name === 'communication_preferences',
      )?.notNull,
    ).toBe(false);
  });
});
