import { eq, is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import * as schemaModule from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { SHIPPED_RETENTION_DEFAULTS } from './defaults.js';
import { retentionEndDate, type RetentionDates } from './end-date.js';
import { TRANSIENT_CLEANUPS } from './transient-cleanups.js';

/**
 * The `account-lifetime` class never ends a row by time (decision D-69, carry-over B of
 * P-02l2): a row of it belongs to an account, so it goes only when the person deletes it or
 * when the account is deleted, never because years have passed since it was made. The
 * class is merged with no period and the anchor `record-created`; these tests pin that for
 * every table that uses it, found from the schema and not from a list kept here, so a table
 * that joins the class later is held to it too. `profile-retention.test.ts` covers one
 * profile through a project's wrap and a century of cleanups; this covers the class.
 */

const CLASS = 'account-lifetime';

/** Every date a period can count from, a century in the past: if any period applied, the end would be long gone. */
const A_CENTURY_AGO: RetentionDates = {
  recordCreated: '1926-01-01',
  lastActivity: '1926-01-01',
  wrapDate: '1926-01-01',
  deliveryDate: '1926-01-01',
  firstExploitationDate: '1926-01-01',
};

/** The anchors that name a project, which a row of an account has none of. */
const PROJECT_ANCHORS: readonly string[] = [
  'project-wrap',
  'project-delivery',
  'first-exploitation',
];

/** The tables whose `retention_class` column defaults to `key`, with their column names, read from the schema. */
function tablesInClass(key: string) {
  return Object.values(schemaModule)
    .flatMap((value) => {
      if (!is(value, PgTable)) return [];
      const config = getTableConfig(value);
      const column = config.columns.find((c) => c.name === 'retention_class');
      return column?.default === key
        ? [{ name: config.name, columns: config.columns.map((c) => c.name) }]
        : [];
    })
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

describe('the account-lifetime class has no time-based end', () => {
  const tables = tablesInClass(CLASS);
  const shipped = SHIPPED_RETENTION_DEFAULTS[CLASS];

  it('is used by tables, which are found from the schema', () => {
    // Guards against finding nothing and the checks below passing for nothing.
    expect(tables.map((table) => table.name)).toContain('user_access_profile');
  });

  it('ships with no period, and not as a placeholder a lawyer has yet to confirm', () => {
    expect(shipped).toEqual({ periodYears: null, verified: false });
  });

  it('works out no end date from any anchor, with every date a century old, however the periods are given', () => {
    for (const anchor of schemaModule.RETENTION_ANCHORS) {
      for (const periodsYears of [[shipped.periodYears], [null], []]) {
        expect(
          retentionEndDate({ anchor, periodsYears, dates: A_CENTURY_AGO }),
          `${anchor} with ${JSON.stringify(periodsYears)}`,
        ).toBeNull();
      }
    }
  });

  it('is in no cleanup list, so no job deletes a row of it for its age', () => {
    for (const table of tables) {
      expect(TRANSIENT_CLEANUPS.has(table.name), table.name).toBe(false);
    }
  });

  it('has no table that belongs to a project, whose wrap could end it', () => {
    for (const table of tables) {
      expect(table.columns, table.name).not.toContain('project_id');
    }
  });
});

describe.each(testTargets)(
  'the account-lifetime class in a migrated database, on $name',
  (target) => {
    let database: Database;
    let cleanup: () => Promise<void>;

    beforeAll(async () => {
      ({ database, cleanup } = await createMigratedDatabase(target));
    });
    afterAll(async () => {
      await cleanup();
    });

    it('counts from record-created, the one anchor that names no project', async () => {
      const [definition] = await database.db
        .select()
        .from(schemaModule.retentionClass)
        .where(eq(schemaModule.retentionClass.key, CLASS));
      expect(definition?.anchor).toBe('record-created');
      expect(PROJECT_ANCHORS).not.toContain(definition?.anchor);
    });
  },
);
