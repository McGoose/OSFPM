import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, getTableName, is, sql } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import {
  declaredRetentionClasses,
  organisationForeignKeyName,
  retentionClassForeignKeyName,
  securityTableNames,
  tenantTableNames,
} from './columns.js';
import { newId } from './ids.js';
import { MIGRATIONS_FOLDER, migrate } from './migrate.js';
import { hasProjectResolver, isOrganisationLevel } from './project-resolver.js';
import { sensitiveColumns } from './sensitive.js';
import * as schemaModule from './schema/index.js';
import {
  department,
  installation,
  orgMembership,
  orgMembershipRole,
  organisation,
  permission,
  project,
  projectMembership,
  projectMembershipRole,
  role,
  rolePermission,
  SECURITY_TABLES,
  settingValue,
  user,
} from './schema/index.js';
import {
  createMigratedDatabase,
  failureOf,
  SQLSTATE,
  testTargets,
} from './test-support.js';

type Row = Record<string, unknown>;

async function rows(database: Database, query: ReturnType<typeof sql>) {
  const result = (await database.db.execute(query)) as { rows: Row[] };
  return result.rows;
}

type ColumnSpec = { type: string; nullable: boolean };
const TIMESTAMPTZ = 'timestamp with time zone';

const STANDARD_COLUMNS: Record<string, ColumnSpec> = {
  id: { type: 'uuid', nullable: false },
  organisation_id: { type: 'uuid', nullable: false },
  owner_org_id: { type: 'uuid', nullable: false },
  origin_server: { type: 'uuid', nullable: false },
  visibility: { type: 'text', nullable: false },
  version: { type: 'integer', nullable: false },
  created_at: { type: TIMESTAMPTZ, nullable: false },
  updated_at: { type: TIMESTAMPTZ, nullable: false },
  created_by: { type: 'uuid', nullable: true },
  updated_by: { type: 'uuid', nullable: true },
  deleted_at: { type: TIMESTAMPTZ, nullable: true },
  deleted_by: { type: 'uuid', nullable: true },
  retention_class: { type: 'text', nullable: false },
};

const USER_OMITTED = ['organisation_id', 'owner_org_id', 'visibility'];

async function columnsOf(database: Database, table: string) {
  const found = await rows(
    database,
    sql`select column_name, data_type, is_nullable, column_default
        from information_schema.columns
        where table_schema = 'public' and table_name = ${table}`,
  );
  return new Map(
    found.map((c) => [
      c.column_name as string,
      {
        type: c.data_type as string,
        nullable: c.is_nullable === 'YES',
        default: c.column_default as string | null,
      },
    ]),
  );
}

let slugCounter = 0;
function organisationValues(
  overrides: Partial<typeof organisation.$inferInsert> = {},
) {
  const id = newId();
  slugCounter += 1;
  return {
    id,
    organisationId: id,
    ownerOrgId: id,
    originServer: newId(),
    slug: `demo-org-${slugCounter}`,
    name: 'Demo Pictures',
    country: 'GB',
    defaultLocale: 'en-GB',
    defaultTimezone: 'Europe/London',
    baseCurrency: 'GBP',
    status: 'active',
    ...overrides,
  } satisfies typeof organisation.$inferInsert;
}

function projectValues(
  organisationId: string,
  overrides: Partial<typeof project.$inferInsert> = {},
) {
  return {
    organisationId,
    ownerOrgId: organisationId,
    originServer: newId(),
    code: 'TLW',
    title: 'The Last Withdrawal',
    format: 'feature',
    status: 'development',
    timezone: 'Europe/London',
    locale: 'en-GB',
    currency: 'GBP',
    ...overrides,
  } satisfies typeof project.$inferInsert;
}

let emailCounter = 0;
function userValues(overrides: Partial<typeof user.$inferInsert> = {}) {
  emailCounter += 1;
  return {
    originServer: newId(),
    email: `demo.user${emailCounter}@example.test`,
    displayName: 'Demo User',
    locale: 'en-GB',
    timezone: 'Europe/London',
    status: 'active',
    ...overrides,
  } satisfies typeof user.$inferInsert;
}

const NAME_LIMIT = 63;

/**
 * Unique indexes and constraints that have a nullable column and are not NULLS
 * NOT DISTINCT, because several NULLs are meant to be allowed. Name of the index
 * or constraint, then why. Adding an entry needs a reason a reviewer can check.
 */
const SEVERAL_NULLS_ALLOWED: Record<string, string> = {
  person_organisation_user_unique:
    'Most people have no user account, so many rows with a NULL user_id are normal; the key only stops one user being two people in an organisation',
};

/**
 * Every unique index or constraint of the migrated database, primary keys apart,
 * that has a nullable column among its key columns, with whether it is NULLS NOT
 * DISTINCT. Expression columns have no attribute and are skipped. Sorted by name
 * in JavaScript, because the database collation orders underscores differently.
 */
async function uniqueKeysWithNullableColumns(database: Database) {
  const found = await rows(
    database,
    sql`select i.relname as name,
               c.relname as table_name,
               x.indnullsnotdistinct as nulls_not_distinct,
               (select array_to_string(array_agg(a.attname::text order by k.ord), ',')
                  from unnest(x.indkey::int2[]) with ordinality as k(attnum, ord)
                  join pg_attribute a
                    on a.attrelid = x.indrelid and a.attnum = k.attnum
                 where k.ord <= x.indnkeyatts and not a.attnotnull) as nullable_columns,
               (select array_to_string(array_agg(a.attname::text order by k.ord), ',')
                  from unnest(x.indkey::int2[]) with ordinality as k(attnum, ord)
                  join pg_attribute a
                    on a.attrelid = x.indrelid and a.attnum = k.attnum
                 where k.ord <= x.indnkeyatts) as key_columns
        from pg_index x
        join pg_class c on c.oid = x.indrelid
        join pg_class i on i.oid = x.indexrelid
        where x.indisunique and not x.indisprimary
          and c.relnamespace = 'public'::regnamespace`,
  );
  return found
    .filter((r) => r.nullable_columns !== null)
    .map((r) => ({
      name: r.name as string,
      table: r.table_name as string,
      nullsNotDistinct: r.nulls_not_distinct as boolean,
      columns: (r.key_columns as string).split(','),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

const schemaTables = Object.values(schemaModule).filter((value) =>
  is(value, PgTable),
);

/** Every named constraint and index the schema declares, with its table. */
function declaredNames() {
  return schemaTables.flatMap((table) => {
    const config = getTableConfig(table);
    const names = [
      ...config.foreignKeys.map((fk) => fk.getName()),
      ...config.uniqueConstraints.map((u) => u.getName()),
      ...config.checks.map((c) => c.name),
      ...config.indexes.map((i) => i.config.name),
      ...config.primaryKeys.map((pk) => pk.getName()),
    ];
    return names
      .filter((name): name is string => typeof name === 'string')
      .map((name) => ({ table: config.name, name }));
  });
}

describe('constraint names in the schema', () => {
  it('finds the tables it is meant to check', () => {
    expect(schemaTables.length).toBeGreaterThanOrEqual(15);
    expect(declaredNames().length).toBeGreaterThan(50);
  });

  it(`are all ${NAME_LIMIT} characters or fewer`, () => {
    const tooLong = declaredNames().filter(
      ({ name }) => name.length > NAME_LIMIT,
    );
    expect(tooLong).toEqual([]);
  });

  it('give every table with an organisation_id an organisation FK named <table>_organisation_fk', () => {
    const withOrganisation = schemaTables.filter((table) =>
      getTableConfig(table).columns.some((c) => c.name === 'organisation_id'),
    );
    expect(withOrganisation.length).toBeGreaterThanOrEqual(12);
    for (const table of withOrganisation) {
      const config = getTableConfig(table);
      const found = config.foreignKeys.filter((fk) => {
        const ref = fk.reference();
        return (
          ref.columns.length === 1 &&
          ref.columns[0]!.name === 'organisation_id' &&
          getTableName(ref.foreignTable) === 'organisation' &&
          ref.foreignColumns[0]!.name === 'id'
        );
      });
      expect(
        found.map((fk) => fk.getName()),
        config.name,
      ).toEqual([organisationForeignKeyName(config.name)]);
    }
  });

  it('give every tenant table one <table>_visibility_check, from tenantTable', () => {
    const tenant = schemaTables.filter((table) =>
      tenantTableNames().has(getTableName(table)),
    );
    expect(tenant.length).toBeGreaterThanOrEqual(9);
    for (const table of tenant) {
      const name = getTableName(table);
      const checks = getTableConfig(table)
        .checks.map((c) => c.name)
        .filter((n) => n.endsWith('_visibility_check'));
      expect(checks, name).toEqual([`${name}_visibility_check`]);
    }
  });

  it('define every table with the standard columns through tenantTable', () => {
    const standard = schemaTables
      .filter((table) =>
        getTableConfig(table).columns.some((c) => c.name === 'owner_org_id'),
      )
      .map((table) => getTableName(table))
      .sort();
    expect(standard.length).toBeGreaterThanOrEqual(9);
    expect([...tenantTableNames()].sort()).toEqual(standard);
  });
});

// CLAUDE.md, Data rules: tables in SECURITY_TABLES are written only by the auth
// service, never through the write helper. Both lists come from code, so a new
// security table cannot be forgotten in one of them.
describe('security tables in the schema', () => {
  const securityNames = SECURITY_TABLES.map((table) => getTableName(table));

  it('are the tables defined through securityTable, no more and no fewer', () => {
    // Guards against both lists being empty and passing for nothing.
    expect(securityNames.length).toBeGreaterThanOrEqual(6);
    expect([...securityNames].sort()).toEqual([...securityTableNames()].sort());
  });

  it('are in the schema, and are not tenant tables', () => {
    const inSchema = new Set(schemaTables.map((table) => getTableName(table)));
    for (const name of securityNames) {
      expect(inSchema.has(name), `${name} is not exported by the schema`).toBe(
        true,
      );
      expect(tenantTableNames().has(name), name).toBe(false);
    }
  });

  // The write helper needs organisation_id to number and log a change; without
  // the column a security table could never go through it.
  it('have no organisation_id, owner_org_id or visibility', () => {
    for (const table of SECURITY_TABLES) {
      const names = getTableConfig(table).columns.map((c) => c.name);
      for (const omitted of USER_OMITTED) {
        expect(names, getTableName(table)).not.toContain(omitted);
      }
    }
  });

  it('keep their foreign key to the user named <table>_user_fk', () => {
    for (const table of SECURITY_TABLES) {
      const name = getTableName(table);
      const toUser = getTableConfig(table)
        .foreignKeys.filter((fk) => {
          const ref = fk.reference();
          return (
            getTableName(ref.foreignTable) === 'user' &&
            ref.columns.length === 1 &&
            ref.columns[0]!.name === 'user_id'
          );
        })
        .map((fk) => fk.getName());
      // `setup_code` belongs to no user.
      expect(toUser, name).toEqual(
        getTableConfig(table).columns.some((c) => c.name === 'user_id')
          ? [`${name}_user_fk`]
          : [],
      );
    }
  });
});

describe('project resolution in the schema', () => {
  const tenant = schemaTables.filter((table) =>
    tenantTableNames().has(getTableName(table)),
  );
  const hasProjectId = (table: PgTable) =>
    getTableConfig(table).columns.some((c) => c.name === 'project_id');
  const names = (tables: PgTable[]) => tables.map(getTableName).sort();

  it('finds the tenant tables it is meant to check', () => {
    // Guards against the filters matching nothing and passing for nothing.
    expect(tenant.filter(hasProjectId).length).toBeGreaterThanOrEqual(5);
    expect(
      tenant.filter((table) => !hasProjectId(table)).length,
    ).toBeGreaterThanOrEqual(5);
    expect(tenant.some(hasProjectResolver)).toBe(true);
    expect(tenant.some(isOrganisationLevel)).toBe(true);
  });

  // A child table with no project_id and no resolver files its changes under
  // the organisation, as if it belonged to no project, without any error.
  it('gives every tenant table without a project_id a project resolver or an organisation-level declaration', () => {
    const undeclared = tenant.filter(
      (table) =>
        !hasProjectId(table) &&
        !hasProjectResolver(table) &&
        !isOrganisationLevel(table),
    );
    expect(names(undeclared)).toEqual([]);
  });

  it('declares only tables with neither a project_id nor a resolver as organisation-level', () => {
    const contradicting = tenant.filter(
      (table) =>
        isOrganisationLevel(table) &&
        (hasProjectId(table) || hasProjectResolver(table)),
    );
    expect(names(contradicting)).toEqual([]);
  });
});

/**
 * Every `numeric` column that does not hold money, as `table.column`, with why.
 * CLAUDE.md, Data rules: money columns are numeric, and what a line or contract
 * is worth is what people are paid, so a money column is marked sensitive and
 * its value stays out of change events (Privacy rule). A numeric column that is
 * not listed here is taken for money. Drizzle has no way to record what a
 * column means, so this list is the declaration. Adding an entry needs a reason
 * a reviewer can check.
 */
const NUMERIC_NOT_MONEY: Record<string, string> = {
  'cost_line.fx_rate':
    'An exchange rate, a ratio between two currencies; it may appear in change events (the amounts it converts do not)',
  'location.latitude': 'A coordinate in degrees',
  'location.longitude': 'A coordinate in degrees',
};

describe('numeric columns in the schema', () => {
  const numericColumns = schemaTables.flatMap((table) =>
    getTableConfig(table)
      .columns.filter((column) => column.getSQLType().startsWith('numeric'))
      .map((column) => ({
        table,
        column: column.name,
        name: `${getTableName(table)}.${column.name}`,
      })),
  );

  it('finds the numeric columns it is meant to check', () => {
    // Guards against the filter matching nothing and passing for nothing.
    expect(numericColumns.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'contract.total_value',
        'cost_line.amount',
        'cost_line.amount_project_currency',
        'cost_line.fx_rate',
        'cost_line_scheme.qualifying_amount',
      ]),
    );
  });

  it('are all marked sensitive, except the ones listed as not money', () => {
    const unmarked = numericColumns
      .filter((c) => !sensitiveColumns(c.table).has(c.column))
      .map((c) => c.name)
      .sort();
    // Equal, not a subset: an entry that is marked sensitive now, or that is no
    // longer a numeric column, is stale and must go, and a new numeric column
    // must be marked or listed.
    expect(unmarked).toEqual(Object.keys(NUMERIC_NOT_MONEY).sort());
  });

  it('give every column not holding money a reason', () => {
    for (const [name, reason] of Object.entries(NUMERIC_NOT_MONEY)) {
      expect(reason.trim().length, name).toBeGreaterThan(0);
    }
  });
});

describe.each(testTargets)('database schema on $name', (target) => {
  describe('migrations', () => {
    it('apply to an empty database, and re-running is a no-op', async () => {
      const { database, cleanup } = await target.create();
      try {
        await migrate(database);
        await migrate(database);
        const tables = await rows(
          database,
          sql`select table_name from information_schema.tables
              where table_schema = 'public' order by table_name`,
        );
        expect(tables.map((t) => t.table_name)).toEqual([
          'account',
          'account_chart',
          'audit_event',
          'block',
          'change_event',
          'change_seq',
          'company',
          'contract',
          'contract_link',
          'contract_party',
          'cost_line',
          'cost_line_scheme',
          'department',
          'episode',
          'installation',
          'legal_hold',
          'location',
          'org_membership',
          'org_membership_role',
          'organisation',
          'passkey_credential',
          'password_credential',
          'permission',
          'person',
          'person_company',
          'person_sensitive',
          'project',
          'project_company',
          'project_location',
          'project_membership',
          'project_membership_role',
          'project_person',
          'recovery_code',
          'retention_class',
          'role',
          'role_permission',
          'session',
          'setting_value',
          'setup_code',
          'totp_credential',
          'unit',
          'user',
        ]);
      } finally {
        await cleanup();
      }
    });
    it('names every tenant table’s organisation foreign key <table>_organisation_fk', async () => {
      const { database, cleanup } = await target.create();
      try {
        await migrate(database);
        const found = await rows(
          database,
          sql`select conrelid::regclass::text as table_name, conname
              from pg_constraint
              where contype = 'f' and confrelid = 'organisation'::regclass
                and conkey = array[(
                  select attnum from pg_attribute
                  where attrelid = conrelid and attname = 'organisation_id'
                )]`,
        );
        // Sorted here, not in SQL: the database collation orders names with
        // underscores differently from JavaScript.
        const byTable = (a: Row, b: Row) =>
          (a.table_name as string) < (b.table_name as string) ? -1 : 1;
        const expected = [...tenantTableNames()].map((table) => ({
          table_name: table,
          conname: organisationForeignKeyName(table),
        }));
        const tenant = new Set(tenantTableNames());
        expect(
          found.filter((r) => tenant.has(r.table_name as string)).sort(byTable),
        ).toEqual(expected.sort(byTable));
        const names = await rows(
          database,
          sql`select conname from pg_constraint
              where connamespace = 'public'::regnamespace`,
        );
        expect(
          names.filter((r) => (r.conname as string).length > NAME_LIMIT),
        ).toEqual([]);
        expect(
          names.filter((r) =>
            (r.conname as string).includes('_organisation_id_organisation_id_'),
          ),
        ).toEqual([]);
      } finally {
        await cleanup();
      }
    });
    it('links every retention_class column to retention_class(key) and defaults it to standard, or to the class its table declares', async () => {
      const { database, cleanup } = await target.create();
      try {
        await migrate(database);
        const withColumn = await rows(
          database,
          sql`select c.table_name, c.is_nullable, c.column_default
              from information_schema.columns c
              join information_schema.tables t
                on t.table_schema = c.table_schema
               and t.table_name = c.table_name
              where c.table_schema = 'public'
                and c.column_name = 'retention_class'
                and t.table_type = 'BASE TABLE'`,
        );
        // Every tenant table, security table and `user` carry the column;
        // nothing else does.
        expect(withColumn.map((r) => r.table_name as string).sort()).toEqual(
          [...tenantTableNames(), ...securityTableNames(), 'user'].sort(),
        );
        const seeded = new Set(
          (await rows(database, sql`select key from retention_class`)).map(
            (r) => r.key as string,
          ),
        );
        for (const column of withColumn) {
          const table = column.table_name as string;
          // Standard, unless the table passes `defaultRetentionClass`; then the
          // migrated database must agree with what the schema declares.
          const expected = declaredRetentionClasses().get(table) ?? 'standard';
          expect(column.is_nullable, table).toBe('NO');
          expect(column.column_default, table).toBe(`'${expected}'::text`);
          expect(
            seeded.has(expected),
            `${table} defaults to ${expected}, which is not a seeded retention class`,
          ).toBe(true);
        }
        const links = await rows(
          database,
          sql`select (select relname from pg_class where oid = conrelid) as table_name,
                     conname
              from pg_constraint
              where contype = 'f' and confrelid = 'retention_class'::regclass
                and confkey = array[(
                  select attnum from pg_attribute
                  where attrelid = confrelid and attname = 'key'
                )]
                and conkey = array[(
                  select attnum from pg_attribute
                  where attrelid = conrelid and attname = 'retention_class'
                )]`,
        );
        const byTable = (a: Row, b: Row) =>
          (a.table_name as string) < (b.table_name as string) ? -1 : 1;
        expect(links.sort(byTable)).toEqual(
          withColumn
            .map((r) => ({
              table_name: r.table_name,
              conname: retentionClassForeignKeyName(r.table_name as string),
            }))
            .sort(byTable),
        );
      } finally {
        await cleanup();
      }
    });
    it('scopes every foreign key between tenant tables by organisation_id', async () => {
      const { database, cleanup } = await target.create();
      try {
        await migrate(database);
        const found = await rows(
          database,
          sql`select c.conrelid::regclass::text as table_name,
                     c.confrelid::regclass::text as target,
                     c.conname,
                     exists (
                       select 1 from pg_attribute a
                       where a.attrelid = c.conrelid
                         and a.attname = 'organisation_id'
                         and a.attnum = any (c.conkey)
                     ) as from_scoped,
                     exists (
                       select 1 from pg_attribute a
                       where a.attrelid = c.confrelid
                         and a.attname = 'organisation_id'
                         and a.attnum = any (c.confkey)
                     ) as to_scoped
              from pg_constraint c
              where c.contype = 'f' and c.connamespace = 'public'::regnamespace`,
        );
        const tenant = tenantTableNames();
        const between = found.filter(
          (r) =>
            tenant.has(r.table_name as string) &&
            tenant.has(r.target as string) &&
            r.target !== 'organisation',
        );
        // Guards against the query matching nothing and passing for nothing.
        expect(between.length).toBeGreaterThanOrEqual(10);
        // The organisation role link's two keys are among those checked.
        expect(
          between.map(
            (r) => `${r.table_name as string}.${r.conname as string}`,
          ),
        ).toEqual(
          expect.arrayContaining([
            'org_membership_role.org_membership_role_membership_fk',
            'org_membership_role.org_membership_role_role_fk',
          ]),
        );
        // Names only: an unscoped key could point at another organisation's row.
        expect(
          between
            .filter((r) => !r.from_scoped || !r.to_scoped)
            .map((r) => `${r.table_name as string}.${r.conname as string}`),
        ).toEqual([]);
      } finally {
        await cleanup();
      }
    });
  });

  // CLAUDE.md, Data rules: a unique key with a nullable column is NULLS NOT
  // DISTINCT unless several NULLs are meant to be allowed. Drizzle cannot tell
  // an index to be, so the migration does it by hand and only the migrated
  // database shows whether it was done (`pg_index.indnullsnotdistinct`).
  describe('unique keys with a nullable column', () => {
    it('are all NULLS NOT DISTINCT, except the ones that allow several NULLs on purpose', async () => {
      const { database, cleanup } = await createMigratedDatabase(target);
      try {
        const found = await uniqueKeysWithNullableColumns(database);
        // Guards against the query matching nothing and passing for nothing.
        expect(found.length).toBeGreaterThanOrEqual(8);
        expect(
          found.filter((key) => key.nullsNotDistinct).map((key) => key.name),
        ).toEqual(
          expect.arrayContaining([
            'account_chart_default_unique',
            'account_chart_organisation_project_key_unique',
            'change_seq_organisation_project_unique',
            'contract_party_contract_person_company_role_unique',
            'department_organisation_project_key_unique',
            'role_organisation_project_key_unique',
            'setting_value_organisation_project_key_unique',
          ]),
        );
        const plain = found
          .filter((key) => !key.nullsNotDistinct)
          .map((key) => key.name)
          .sort();
        // Equal, not a subset: an entry that no longer matches a plain key is
        // stale and must go, and a new plain key must be fixed or listed.
        expect(plain).toEqual(Object.keys(SEVERAL_NULLS_ALLOWED).sort());
      } finally {
        await cleanup();
      }
    });

    it('are found by the check, which flags a plain index, a partial one and a constraint, and passes NULLS NOT DISTINCT and NOT NULL columns', async () => {
      const { database, cleanup } = await target.create();
      try {
        await database.db.execute(
          sql`create table scratch_a (x uuid, y text, z text not null)`,
        );
        await database.db.execute(
          sql`create unique index scratch_plain on scratch_a (x, y)`,
        );
        await database.db.execute(
          sql`create unique index scratch_distinct on scratch_a (x, y) nulls not distinct`,
        );
        await database.db.execute(
          sql`create unique index scratch_partial on scratch_a (x) where z = 'live'`,
        );
        await database.db.execute(
          sql`alter table scratch_a add constraint scratch_constraint unique (y)`,
        );
        await database.db.execute(
          sql`create unique index scratch_not_null on scratch_a (z)`,
        );
        await database.db.execute(
          sql`create table scratch_b (p uuid primary key, q text not null, unique (p, q))`,
        );
        const found = await uniqueKeysWithNullableColumns(database);
        expect(
          found.map((key) => [key.name, key.nullsNotDistinct, key.columns]),
        ).toEqual([
          ['scratch_constraint', false, ['y']],
          ['scratch_distinct', true, ['x', 'y']],
          ['scratch_partial', false, ['x']],
          ['scratch_plain', false, ['x', 'y']],
        ]);
      } finally {
        await cleanup();
      }
    });
  });

  describe('role_permission.reach on an existing database', () => {
    const REACH_MIGRATION = '0023_role_permission_reach';

    it('gives a grant written before the column existed own-scope', async () => {
      const { database, cleanup } = await target.create();
      const folder = mkdtempSync(join(tmpdir(), 'osfpm-migrations-'));
      try {
        // Stop one migration short: a copy of the folder whose journal ends
        // before the reach migration.
        cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
        const journalPath = join(folder, 'meta', '_journal.json');
        const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
          entries: { tag: string }[];
        };
        const cut = journal.entries.findIndex((e) => e.tag === REACH_MIGRATION);
        expect(cut).toBeGreaterThan(0);
        writeFileSync(
          journalPath,
          JSON.stringify({
            ...journal,
            entries: journal.entries.slice(0, cut),
          }),
        );
        await migrate(database, folder);
        // Plain SQL, so the rows do not depend on columns added later.
        const organisationId = newId();
        const roleId = newId();
        const grantId = newId();
        const origin = newId();
        await database.db.execute(
          sql`insert into organisation (id, organisation_id, owner_org_id, origin_server,
                slug, name, country, default_locale, default_timezone, base_currency, status)
              values (${organisationId}, ${organisationId}, ${organisationId}, ${origin},
                'upgrade-org', 'Demo Pictures', 'GB', 'en-GB', 'Europe/London', 'GBP', 'active')`,
        );
        await database.db.execute(
          sql`insert into permission (key, module, description)
              values ('upgrade:read', 'upgrade', 'Upgrade test')`,
        );
        await database.db.execute(
          sql`insert into role (id, origin_server, organisation_id, owner_org_id, key, name)
              values (${roleId}, ${origin}, ${organisationId}, ${organisationId}, 'upgrade', 'Upgrade')`,
        );
        await database.db.execute(
          sql`insert into role_permission (id, origin_server, organisation_id, owner_org_id,
                role_id, permission_key)
              values (${grantId}, ${origin}, ${organisationId}, ${organisationId},
                ${roleId}, 'upgrade:read')`,
        );
        await migrate(database);
        const [row] = await rows(
          database,
          sql`select reach from role_permission where id = ${grantId}`,
        );
        expect(row).toEqual({ reach: 'own-scope' });
      } finally {
        rmSync(folder, { recursive: true, force: true });
        await cleanup();
      }
    });
  });

  describe('constraints', () => {
    let database: Database;
    let cleanup: () => Promise<void>;

    beforeAll(async () => {
      ({ database, cleanup } = await createMigratedDatabase(target));
    });
    afterAll(async () => {
      await cleanup();
    });

    describe('standard columns', () => {
      for (const table of [
        'organisation',
        'project',
        'org_membership',
        'org_membership_role',
        'department',
        'role',
        'role_permission',
        'project_membership',
        'project_membership_role',
        'setting_value',
        'contract',
        'contract_party',
        'contract_link',
        'account_chart',
        'account',
        'cost_line',
        'cost_line_scheme',
      ]) {
        it(`${table} has every standard column with the right type and nullability`, async () => {
          const columns = await columnsOf(database, table);
          for (const [name, spec] of Object.entries(STANDARD_COLUMNS)) {
            expect(columns.get(name), `${table}.${name}`).toMatchObject(spec);
          }
        });
      }

      it('user has the standard columns except organisation_id, owner_org_id and visibility', async () => {
        const columns = await columnsOf(database, 'user');
        for (const [name, spec] of Object.entries(STANDARD_COLUMNS)) {
          if (USER_OMITTED.includes(name)) {
            expect(columns.has(name), `user.${name}`).toBe(false);
          } else {
            expect(columns.get(name), `user.${name}`).toMatchObject(spec);
          }
        }
      });

      it('installation has only its own five columns', async () => {
        const columns = await columnsOf(database, 'installation');
        expect([...columns.keys()].sort()).toEqual([
          'base_url',
          'created_at',
          'id',
          'server_public_key',
          'setup_completed_at',
        ]);
        expect(columns.get('server_public_key')?.nullable).toBe(true);
        expect(columns.get('setup_completed_at')).toMatchObject({
          type: TIMESTAMPTZ,
          nullable: true,
        });
      });

      it('gives every security table the standard columns except the tenant trio', async () => {
        for (const table of SECURITY_TABLES) {
          const name = getTableName(table);
          const columns = await columnsOf(database, name);
          for (const [column, spec] of Object.entries(STANDARD_COLUMNS)) {
            if (USER_OMITTED.includes(column)) {
              expect(columns.has(column), `${name}.${column}`).toBe(false);
            } else {
              expect(columns.get(column), `${name}.${column}`).toMatchObject(
                spec,
              );
            }
          }
        }
      });

      it('never generates ids in the database', async () => {
        for (const table of [
          ...securityTableNames(),
          'installation',
          'account',
          'account_chart',
          'contract',
          'contract_party',
          'contract_link',
          'cost_line',
          'cost_line_scheme',
          'legal_hold',
          'organisation',
          'project',
          'user',
          'org_membership',
          'org_membership_role',
          'department',
          'role',
          'role_permission',
          'project_membership',
          'project_membership_role',
          'setting_value',
        ]) {
          const columns = await columnsOf(database, table);
          expect(columns.get('id')?.default, table).toBeNull();
        }
      });

      it('defaults visibility to project, and to private for organisation', async () => {
        const projectColumns = await columnsOf(database, 'project');
        const organisationColumns = await columnsOf(database, 'organisation');
        expect(projectColumns.get('visibility')?.default).toContain(
          "'project'",
        );
        expect(organisationColumns.get('visibility')?.default).toContain(
          "'private'",
        );
      });

      it('defaults version to 1 and fills timestamps', async () => {
        const values = organisationValues();
        await database.db.insert(organisation).values(values);
        const [row] = await rows(
          database,
          sql`select version, created_at is not null as has_created
              from organisation where id = ${values.id}`,
        );
        expect(row).toEqual({ version: 1, has_created: true });
      });

      it('rejects created_by that is not a user', async () => {
        const failure = await failureOf(() =>
          database.db
            .insert(organisation)
            .values(organisationValues({ createdBy: newId() })),
        );
        expect(failure.code).toBe(SQLSTATE.foreignKeyViolation);
      });
    });

    describe('installation', () => {
      it('allows only one row', async () => {
        const row = { baseUrl: 'https://osfpm.example.test' };
        await database.db.insert(installation).values({ id: newId(), ...row });
        const failure = await failureOf(() =>
          database.db.insert(installation).values({ id: newId(), ...row }),
        );
        expect(failure).toEqual({
          code: SQLSTATE.uniqueViolation,
          constraint: 'installation_single_row',
        });
      });
    });

    describe('organisation', () => {
      it('requires organisation_id to equal id', async () => {
        const failure = await failureOf(() =>
          database.db
            .insert(organisation)
            .values(organisationValues({ organisationId: newId() })),
        );
        expect(failure).toEqual({
          code: SQLSTATE.checkViolation,
          constraint: 'organisation_is_own_tenant_check',
        });
      });

      it('rejects a duplicate slug', async () => {
        await database.db
          .insert(organisation)
          .values(organisationValues({ slug: 'duplicate-slug' }));
        const failure = await failureOf(() =>
          database.db
            .insert(organisation)
            .values(organisationValues({ slug: 'duplicate-slug' })),
        );
        expect(failure).toEqual({
          code: SQLSTATE.uniqueViolation,
          constraint: 'organisation_slug_unique',
        });
      });

      it('rejects an unknown status', async () => {
        const failure = await failureOf(() =>
          database.db
            .insert(organisation)
            .values(organisationValues({ status: 'deleted' as never })),
        );
        expect(failure.constraint).toBe('organisation_status_check');
      });

      it('rejects an unknown visibility', async () => {
        const failure = await failureOf(() =>
          database.db
            .insert(organisation)
            .values(organisationValues({ visibility: 'public' as never })),
        );
        expect(failure.constraint).toBe('organisation_visibility_check');
      });
    });

    describe('project', () => {
      let organisationId: string;
      beforeAll(async () => {
        const values = organisationValues();
        await database.db.insert(organisation).values(values);
        organisationId = values.id;
      });

      it('rejects a duplicate (organisation_id, code)', async () => {
        await database.db
          .insert(project)
          .values(projectValues(organisationId, { code: 'DUP' }));
        const failure = await failureOf(() =>
          database.db
            .insert(project)
            .values(projectValues(organisationId, { code: 'DUP' })),
        );
        expect(failure).toEqual({
          code: SQLSTATE.uniqueViolation,
          constraint: 'project_organisation_code_unique',
        });
      });

      it('allows the same code in a different organisation', async () => {
        const other = organisationValues();
        await database.db.insert(organisation).values(other);
        await database.db
          .insert(project)
          .values(projectValues(other.id, { code: 'DUP' }));
      });

      it('rejects an organisation that does not exist', async () => {
        const failure = await failureOf(() =>
          database.db.insert(project).values(projectValues(newId())),
        );
        expect(failure.code).toBe(SQLSTATE.foreignKeyViolation);
      });

      it('rejects an unknown format', async () => {
        const failure = await failureOf(() =>
          database.db.insert(project).values(
            projectValues(organisationId, {
              code: 'F1',
              format: 'opera' as never,
            }),
          ),
        );
        expect(failure.constraint).toBe('project_format_check');
      });

      it('rejects an unknown status', async () => {
        const failure = await failureOf(() =>
          database.db.insert(project).values(
            projectValues(organisationId, {
              code: 'S1',
              status: 'wrapped' as never,
            }),
          ),
        );
        expect(failure.constraint).toBe('project_status_check');
      });

      it('rejects an unknown visibility', async () => {
        const failure = await failureOf(() =>
          database.db.insert(project).values(
            projectValues(organisationId, {
              code: 'V1',
              visibility: 'everyone' as never,
            }),
          ),
        );
        expect(failure.constraint).toBe('project_visibility_check');
      });

      it('defaults involves_minors to false and visibility to project', async () => {
        await database.db
          .insert(project)
          .values(projectValues(organisationId, { code: 'D1' }));
        const [row] = await rows(
          database,
          sql`select involves_minors, visibility from project
              where organisation_id = ${organisationId} and code = 'D1'`,
        );
        expect(row).toEqual({ involves_minors: false, visibility: 'project' });
      });
    });

    describe('user', () => {
      const NORMALISED = {
        code: SQLSTATE.checkViolation,
        constraint: 'user_email_normalised_check',
      };

      // No whitespace anywhere, and lower case. `[[:space:]]` covers space, tab,
      // line feed, carriage return, vertical tab and form feed.
      it.each([
        ['an upper-case', 'Mixed.Case@example.test'],
        ['a leading-space', ' leading@example.test'],
        ['a trailing-space', 'trailing@example.test '],
        ['a space-padded', '  padded@example.test  '],
        ['a space-padded upper-case', ' Padded.Upper@Example.test '],
        ['a space-only', '   '],
        ['an inner-space', 'first last@example.test'],
        ['an inner-space in the domain', 'first.last@exam ple.test'],
        ['a leading-tab', '\tleading.tab@example.test'],
        ['a trailing-tab', 'trailing.tab@example.test\t'],
        ['an inner-tab', 'inner\ttab@example.test'],
        ['a trailing-newline', 'trailing.newline@example.test\n'],
        ['a leading-newline', '\nleading.newline@example.test'],
        ['an inner-newline', 'inner\nnewline@example.test'],
        ['a trailing-carriage-return', 'trailing.cr@example.test\r'],
        ['a Windows line-break', 'trailing.crlf@example.test\r\n'],
        ['a vertical-tab', 'inner\vtab@example.test'],
        ['a form-feed', 'inner\fform@example.test'],
        ['a tab-only', '\t'],
        ['a newline-only', '\n'],
      ])('rejects %s email', async (_label, email) => {
        const failure = await failureOf(() =>
          database.db.insert(user).values(userValues({ email })),
        );
        expect(failure).toEqual(NORMALISED);
      });

      it('rejects changing a stored email to one that is not normalised', async () => {
        const email = 'normalised.before@example.test';
        await database.db.insert(user).values(userValues({ email }));
        for (const bad of [
          'Normalised.Before@example.test',
          `${email} `,
          `${email}\t`,
          `${email}\n`,
          'normalised before@example.test',
        ]) {
          const failure = await failureOf(() =>
            database.db
              .update(user)
              .set({ email: bad })
              .where(eq(user.email, email)),
          );
          expect(failure).toEqual(NORMALISED);
        }
      });

      it('accepts a lower-case email with no whitespace in it', async () => {
        for (const email of [
          'plain@example.test',
          'first.last+tag@example.test',
          'under_score-and-dash@sub.example.test',
          'digits.123@example.test',
        ]) {
          await database.db.insert(user).values(userValues({ email }));
        }
      });

      it('rejects a duplicate email', async () => {
        const email = 'duplicate@example.test';
        await database.db.insert(user).values(userValues({ email }));
        const failure = await failureOf(() =>
          database.db.insert(user).values(userValues({ email })),
        );
        expect(failure).toEqual({
          code: SQLSTATE.uniqueViolation,
          constraint: 'user_email_unique',
        });
      });

      it('rejects an unknown status', async () => {
        const failure = await failureOf(() =>
          database.db
            .insert(user)
            .values(userValues({ status: 'banned' as never })),
        );
        expect(failure.constraint).toBe('user_status_check');
      });

      it('lets a user reference another user as creator', async () => {
        const creatorId = newId();
        await database.db.insert(user).values(userValues({ id: creatorId }));
        await database.db
          .insert(user)
          .values(userValues({ createdBy: creatorId }));
      });
    });

    describe('format checks', () => {
      const bad = async (
        values: () => Parameters<typeof insertOrganisation>[1],
      ) => failureOf(() => insertOrganisation(database, values()));

      it.each(['gb', 'GBR', 'G', 'G1', ''])(
        'rejects organisation country %j',
        async (country) => {
          const failure = await bad(() => ({ country }));
          expect(failure).toEqual({
            code: SQLSTATE.checkViolation,
            constraint: 'organisation_country_check',
          });
        },
      );

      it.each(['gbp', 'GB', 'GBPP', 'G1P', ''])(
        'rejects organisation base currency %j',
        async (baseCurrency) => {
          const failure = await bad(() => ({ baseCurrency }));
          expect(failure).toEqual({
            code: SQLSTATE.checkViolation,
            constraint: 'organisation_base_currency_check',
          });
        },
      );

      it.each(['eur', 'EU', 'EURO', ''])(
        'rejects project currency %j',
        async (currency) => {
          const tenant = await seedTenant(database);
          const failure = await failureOf(() =>
            database.db
              .insert(project)
              .values(
                projectValues(tenant.organisationId, { code: 'C1', currency }),
              ),
          );
          expect(failure).toEqual({
            code: SQLSTATE.checkViolation,
            constraint: 'project_currency_check',
          });
        },
      );
    });

    describe('access and settings tables', () => {
      let a: Tenant;
      let b: Tenant;

      beforeAll(async () => {
        a = await seedTenant(database);
        b = await seedTenant(database);
        await database.db.insert(permission).values([
          {
            key: 'budget:read',
            module: 'budget',
            description: 'Read budgets',
          },
        ]);
      });

      const fkViolation = (constraint: string) => ({
        code: SQLSTATE.foreignKeyViolation,
        constraint,
      });
      const uniqueViolation = (constraint: string) => ({
        code: SQLSTATE.uniqueViolation,
        constraint,
      });
      const checkViolation = (constraint: string) => ({
        code: SQLSTATE.checkViolation,
        constraint,
      });

      describe('org_membership', () => {
        it('rejects a second membership for the same user', async () => {
          const u = await insertUser(database);
          const values = orgMembershipValues(a.organisationId, u);
          await database.db.insert(orgMembership).values(values);
          const failure = await failureOf(() =>
            database.db.insert(orgMembership).values(values),
          );
          expect(failure).toEqual(
            uniqueViolation('org_membership_organisation_user_unique'),
          );
        });

        it('rejects an unknown organisation', async () => {
          const u = await insertUser(database);
          const failure = await failureOf(() =>
            database.db
              .insert(orgMembership)
              .values(orgMembershipValues(newId(), u)),
          );
          expect(failure).toEqual(
            fkViolation('org_membership_organisation_fk'),
          );
        });

        it('rejects an unknown user', async () => {
          const failure = await failureOf(() =>
            database.db
              .insert(orgMembership)
              .values(orgMembershipValues(a.organisationId, newId())),
          );
          expect(failure).toEqual(fkViolation('org_membership_user_id_fk'));
        });

        it('rejects an unknown role and status', async () => {
          const u = await insertUser(database);
          const badRole = await failureOf(() =>
            database.db.insert(orgMembership).values({
              ...orgMembershipValues(a.organisationId, u),
              orgRole: 'root' as never,
            }),
          );
          expect(badRole).toEqual(
            checkViolation('org_membership_org_role_check'),
          );
          const badStatus = await failureOf(() =>
            database.db.insert(orgMembership).values({
              ...orgMembershipValues(a.organisationId, u),
              status: 'gone' as never,
            }),
          );
          expect(badStatus).toEqual(
            checkViolation('org_membership_status_check'),
          );
        });
      });

      describe('org_membership_role', () => {
        const ORG_ROLE_ONLY = 'org_membership_role_org_role_only';
        const orgRoleOnly = {
          code: SQLSTATE.checkViolation,
          constraint: ORG_ROLE_ONLY,
        };

        const newMembership = async (organisationId = a.organisationId) =>
          insertOrgMembership(
            database,
            organisationId,
            await insertUser(database),
          );

        it('backs the composite membership key with a unique (organisation_id, id) on org_membership', async () => {
          const found = await rows(
            database,
            sql`select a.attname
                from pg_constraint c
                join pg_attribute a
                  on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
                where c.contype = 'u'
                  and c.conrelid = 'org_membership'::regclass
                  and c.conname = 'org_membership_organisation_id_id_unique'
                order by a.attname`,
          );
          expect(found.map((r) => r.attname)).toEqual([
            'id',
            'organisation_id',
          ]);
        });

        it('links a membership to an organisation role, defaulting to private', async () => {
          const m = await newMembership();
          const r = await insertRole(database, a.organisationId, 'link-ok');
          const [link] = await database.db
            .insert(orgMembershipRole)
            .values(orgMembershipRoleValues(a.organisationId, m, r))
            .returning();
          expect(link).toMatchObject({
            membershipId: m,
            roleId: r,
            visibility: 'private',
          });
        });

        it('rejects the same role twice on one membership', async () => {
          const m = await newMembership();
          const r = await insertRole(database, a.organisationId, 'link-twice');
          await database.db
            .insert(orgMembershipRole)
            .values(orgMembershipRoleValues(a.organisationId, m, r));
          const failure = await failureOf(() =>
            database.db
              .insert(orgMembershipRole)
              .values(orgMembershipRoleValues(a.organisationId, m, r)),
          );
          expect(failure).toEqual(
            uniqueViolation('org_membership_role_membership_role_unique'),
          );
        });

        it('rejects an organisation that does not exist', async () => {
          const m = await newMembership();
          const r = await insertRole(database, a.organisationId, 'link-no-org');
          const failure = await failureOf(() =>
            database.db
              .insert(orgMembershipRole)
              .values(orgMembershipRoleValues(newId(), m, r)),
          );
          // The composite keys fail too, so only the code is asserted.
          expect(failure.code).toBe(SQLSTATE.foreignKeyViolation);
        });

        it('rejects a membership in another organisation', async () => {
          const bMembership = await newMembership(b.organisationId);
          const aRole = await insertRole(database, a.organisationId, 'link-x1');
          const failure = await failureOf(() =>
            database.db
              .insert(orgMembershipRole)
              .values(
                orgMembershipRoleValues(a.organisationId, bMembership, aRole),
              ),
          );
          expect(failure).toEqual(
            fkViolation('org_membership_role_membership_fk'),
          );
        });

        it('rejects a role in another organisation', async () => {
          const aMembership = await newMembership();
          const bRole = await insertRole(database, b.organisationId, 'link-x2');
          const failure = await failureOf(() =>
            database.db
              .insert(orgMembershipRole)
              .values(
                orgMembershipRoleValues(a.organisationId, aMembership, bRole),
              ),
          );
          expect(failure).toEqual(fkViolation('org_membership_role_role_fk'));
        });

        it('rejects a project role, naming the rule in the message', async () => {
          const m = await newMembership();
          const projectRole = await insertProjectRole(
            database,
            a.organisationId,
            a.projectId,
            'link-project-role',
          );
          const failure = await failureWithMessageOf(() =>
            database.db
              .insert(orgMembershipRole)
              .values(
                orgMembershipRoleValues(a.organisationId, m, projectRole),
              ),
          );
          expect(failure).toMatchObject(orgRoleOnly);
          expect(failure.message).toContain(ORG_ROLE_ONLY);
        });

        it('rejects pointing an existing link at a project role', async () => {
          const m = await newMembership();
          const orgRole = await insertRole(
            database,
            a.organisationId,
            'repoint',
          );
          const projectRole = await insertProjectRole(
            database,
            a.organisationId,
            a.projectId,
            'repoint-project-role',
          );
          const [link] = await database.db
            .insert(orgMembershipRole)
            .values(orgMembershipRoleValues(a.organisationId, m, orgRole))
            .returning({ id: orgMembershipRole.id });
          const failure = await failureWithMessageOf(() =>
            database.db
              .update(orgMembershipRole)
              .set({ roleId: projectRole })
              .where(eq(orgMembershipRole.id, link!.id)),
          );
          expect(failure).toMatchObject(orgRoleOnly);
          expect(failure.message).toContain(ORG_ROLE_ONLY);
        });

        it('rejects turning a linked organisation role into a project role, naming the rule in the message', async () => {
          const m = await newMembership();
          const r = await insertRole(database, a.organisationId, 'turn-linked');
          await database.db
            .insert(orgMembershipRole)
            .values(orgMembershipRoleValues(a.organisationId, m, r));
          const failure = await failureWithMessageOf(() =>
            database.db
              .update(role)
              .set({ projectId: a.projectId })
              .where(eq(role.id, r)),
          );
          expect(failure).toMatchObject(orgRoleOnly);
          expect(failure.message).toContain(ORG_ROLE_ONLY);
          const [row] = await rows(
            database,
            sql`select project_id from role where id = ${r}`,
          );
          expect(row).toEqual({ project_id: null });
        });

        it('keeps a role organisation-wide while only a deleted link references it', async () => {
          const m = await newMembership();
          const r = await insertRole(
            database,
            a.organisationId,
            'turn-deleted',
          );
          await database.db.insert(orgMembershipRole).values({
            ...orgMembershipRoleValues(a.organisationId, m, r),
            deletedAt: new Date(),
          });
          const failure = await failureOf(() =>
            database.db
              .update(role)
              .set({ projectId: a.projectId })
              .where(eq(role.id, r)),
          );
          expect(failure).toEqual(orgRoleOnly);
        });

        it('lets an unlinked organisation role become a project role', async () => {
          const r = await insertRole(database, a.organisationId, 'turn-free');
          await database.db
            .update(role)
            .set({ projectId: a.projectId })
            .where(eq(role.id, r));
          const [row] = await rows(
            database,
            sql`select project_id from role where id = ${r}`,
          );
          expect(row).toEqual({ project_id: a.projectId });
        });

        it('does not block other changes to a linked role or to its link', async () => {
          const m = await newMembership();
          const r = await insertRole(database, a.organisationId, 'other-edits');
          const [link] = await database.db
            .insert(orgMembershipRole)
            .values(orgMembershipRoleValues(a.organisationId, m, r))
            .returning({ id: orgMembershipRole.id });
          await database.db
            .update(role)
            .set({ name: 'Renamed' })
            .where(eq(role.id, r));
          await database.db
            .update(orgMembershipRole)
            .set({ deletedAt: new Date() })
            .where(eq(orgMembershipRole.id, link!.id));
          const [row] = await rows(
            database,
            sql`select
                  (select name from role where id = ${r}) as role_name,
                  (select deleted_at is not null from org_membership_role
                   where id = ${link!.id}) as link_deleted`,
          );
          expect(row).toEqual({ role_name: 'Renamed', link_deleted: true });
        });
      });

      describe('role_permission reach', () => {
        const ORG_ROLE_ONLY = 'role_permission_all_projects_org_role_only';
        const NOT_SENSITIVE = 'role_permission_all_projects_not_sensitive';
        const NO_DEPARTMENT =
          'role_permission_all_projects_no_department_check';
        const orgRoleOnly = {
          code: SQLSTATE.checkViolation,
          constraint: ORG_ROLE_ONLY,
        };
        const notSensitive = {
          code: SQLSTATE.checkViolation,
          constraint: NOT_SENSITIVE,
        };

        let permissionCounter = 0;
        /** A catalogue row that nothing else in this file uses. */
        const newPermission = async (grantsSensitive = false) => {
          permissionCounter += 1;
          const key = `reach:key-${permissionCounter}`;
          await database.db.insert(permission).values({
            key,
            module: 'reach',
            description: 'Reach test',
            grantsSensitive,
          });
          return key;
        };

        const grant = (
          roleId: string,
          permissionKey: string,
          overrides: Partial<typeof rolePermission.$inferInsert> = {},
        ) => ({
          ...rolePermissionValues(a.organisationId, roleId, null),
          permissionKey,
          reach: 'all-projects' as const,
          ...overrides,
        });

        const reachOf = async (id: string) => {
          const [row] = await rows(
            database,
            sql`select reach from role_permission where id = ${id}`,
          );
          return row!.reach;
        };

        it('defaults reach to own-scope', async () => {
          const r = await insertRole(
            database,
            a.organisationId,
            'reach-default',
          );
          const [row] = await database.db
            .insert(rolePermission)
            .values(rolePermissionValues(a.organisationId, r, null))
            .returning({ id: rolePermission.id });
          expect(await reachOf(row!.id)).toBe('own-scope');
        });

        it('rejects an unknown reach', async () => {
          const r = await insertRole(database, a.organisationId, 'reach-bad');
          const failure = await failureOf(() =>
            database.db.insert(rolePermission).values(
              grant(r, 'budget:read', {
                reach: 'everywhere' as never,
              }),
            ),
          );
          expect(failure).toEqual(
            checkViolation('role_permission_reach_check'),
          );
        });

        it('accepts an organisation-wide all-projects grant on an organisation role', async () => {
          const r = await insertRole(database, a.organisationId, 'reach-ok');
          const key = await newPermission();
          const [row] = await database.db
            .insert(rolePermission)
            .values(grant(r, key))
            .returning({ id: rolePermission.id });
          expect(await reachOf(row!.id)).toBe('all-projects');
        });

        it('rejects a department-scoped all-projects grant, but allows a department-scoped own-scope one', async () => {
          const r = await insertRole(database, a.organisationId, 'reach-dept');
          const d = await insertDepartment(database, a.organisationId, 'reach');
          const key = await newPermission();
          const failure = await failureOf(() =>
            database.db
              .insert(rolePermission)
              .values(grant(r, key, { departmentId: d })),
          );
          expect(failure).toEqual(checkViolation(NO_DEPARTMENT));
          await database.db
            .insert(rolePermission)
            .values(grant(r, key, { departmentId: d, reach: 'own-scope' }));
        });

        it('rejects an all-projects grant on a project role, naming the rule in the message', async () => {
          const projectRole = await insertProjectRole(
            database,
            a.organisationId,
            a.projectId,
            'reach-project-role',
          );
          const key = await newPermission();
          const failure = await failureWithMessageOf(() =>
            database.db.insert(rolePermission).values(grant(projectRole, key)),
          );
          expect(failure).toMatchObject(orgRoleOnly);
          expect(failure.message).toContain(ORG_ROLE_ONLY);
        });

        it('rejects making a grant on a project role all-projects', async () => {
          const projectRole = await insertProjectRole(
            database,
            a.organisationId,
            a.projectId,
            'reach-project-role-update',
          );
          const key = await newPermission();
          const [row] = await database.db
            .insert(rolePermission)
            .values(grant(projectRole, key, { reach: 'own-scope' }))
            .returning({ id: rolePermission.id });
          const failure = await failureOf(() =>
            database.db
              .update(rolePermission)
              .set({ reach: 'all-projects' })
              .where(eq(rolePermission.id, row!.id)),
          );
          expect(failure).toEqual(orgRoleOnly);
        });

        it('rejects pointing an all-projects grant at a project role', async () => {
          const orgRole = await insertRole(
            database,
            a.organisationId,
            'reach-repoint',
          );
          const projectRole = await insertProjectRole(
            database,
            a.organisationId,
            a.projectId,
            'reach-repoint-project-role',
          );
          const key = await newPermission();
          const [row] = await database.db
            .insert(rolePermission)
            .values(grant(orgRole, key))
            .returning({ id: rolePermission.id });
          const failure = await failureOf(() =>
            database.db
              .update(rolePermission)
              .set({ roleId: projectRole })
              .where(eq(rolePermission.id, row!.id)),
          );
          expect(failure).toEqual(orgRoleOnly);
        });

        it('rejects turning an organisation role with all-projects grants into a project role, naming the rule in the message', async () => {
          const r = await insertRole(database, a.organisationId, 'reach-turn');
          const key = await newPermission();
          await database.db.insert(rolePermission).values(grant(r, key));
          const failure = await failureWithMessageOf(() =>
            database.db
              .update(role)
              .set({ projectId: a.projectId })
              .where(eq(role.id, r)),
          );
          expect(failure).toMatchObject(orgRoleOnly);
          expect(failure.message).toContain(ORG_ROLE_ONLY);
          const [row] = await rows(
            database,
            sql`select project_id from role where id = ${r}`,
          );
          expect(row).toEqual({ project_id: null });
        });

        it('keeps a role organisation-wide while only a deleted all-projects grant references it', async () => {
          const r = await insertRole(
            database,
            a.organisationId,
            'reach-turn-deleted',
          );
          const key = await newPermission();
          await database.db
            .insert(rolePermission)
            .values(grant(r, key, { deletedAt: new Date() }));
          const failure = await failureOf(() =>
            database.db
              .update(role)
              .set({ projectId: a.projectId })
              .where(eq(role.id, r)),
          );
          expect(failure).toEqual(orgRoleOnly);
        });

        it('lets a role with only own-scope grants become a project role', async () => {
          const r = await insertRole(database, a.organisationId, 'reach-free');
          const key = await newPermission();
          await database.db
            .insert(rolePermission)
            .values(grant(r, key, { reach: 'own-scope' }));
          await database.db
            .update(role)
            .set({ projectId: a.projectId })
            .where(eq(role.id, r));
          const [row] = await rows(
            database,
            sql`select project_id from role where id = ${r}`,
          );
          expect(row).toEqual({ project_id: a.projectId });
        });

        it('rejects an all-projects grant of a sensitive permission, naming the rule in the message', async () => {
          const r = await insertRole(database, a.organisationId, 'reach-sens');
          const key = await newPermission(true);
          const failure = await failureWithMessageOf(() =>
            database.db.insert(rolePermission).values(grant(r, key)),
          );
          expect(failure).toMatchObject(notSensitive);
          expect(failure.message).toContain(NOT_SENSITIVE);
        });

        it('allows an own-scope grant of a sensitive permission', async () => {
          const r = await insertRole(database, a.organisationId, 'reach-own');
          const key = await newPermission(true);
          await database.db
            .insert(rolePermission)
            .values(grant(r, key, { reach: 'own-scope' }));
        });

        it('rejects making an own-scope grant of a sensitive permission all-projects', async () => {
          const r = await insertRole(database, a.organisationId, 'reach-widen');
          const key = await newPermission(true);
          const [row] = await database.db
            .insert(rolePermission)
            .values(grant(r, key, { reach: 'own-scope' }))
            .returning({ id: rolePermission.id });
          const failure = await failureOf(() =>
            database.db
              .update(rolePermission)
              .set({ reach: 'all-projects' })
              .where(eq(rolePermission.id, row!.id)),
          );
          expect(failure).toEqual(notSensitive);
        });

        it('rejects pointing an all-projects grant at a sensitive permission', async () => {
          const r = await insertRole(database, a.organisationId, 'reach-swap');
          const plain = await newPermission();
          const sensitive = await newPermission(true);
          const [row] = await database.db
            .insert(rolePermission)
            .values(grant(r, plain))
            .returning({ id: rolePermission.id });
          const failure = await failureOf(() =>
            database.db
              .update(rolePermission)
              .set({ permissionKey: sensitive })
              .where(eq(rolePermission.id, row!.id)),
          );
          expect(failure).toEqual(notSensitive);
        });

        it('rejects flagging a permission sensitive while an all-projects grant exists, naming the rule in the message', async () => {
          const r = await insertRole(database, a.organisationId, 'reach-flip');
          const key = await newPermission();
          await database.db.insert(rolePermission).values(grant(r, key));
          const failure = await failureWithMessageOf(() =>
            database.db
              .update(permission)
              .set({ grantsSensitive: true })
              .where(eq(permission.key, key)),
          );
          expect(failure).toMatchObject(notSensitive);
          expect(failure.message).toContain(NOT_SENSITIVE);
          const [row] = await rows(
            database,
            sql`select grants_sensitive from permission where key = ${key}`,
          );
          expect(row).toEqual({ grants_sensitive: false });
        });

        it('counts a deleted all-projects grant when a permission is flagged sensitive', async () => {
          const r = await insertRole(
            database,
            a.organisationId,
            'reach-flip-deleted',
          );
          const key = await newPermission();
          await database.db
            .insert(rolePermission)
            .values(grant(r, key, { deletedAt: new Date() }));
          const failure = await failureOf(() =>
            database.db
              .update(permission)
              .set({ grantsSensitive: true })
              .where(eq(permission.key, key)),
          );
          expect(failure).toEqual(notSensitive);
        });

        it('lets a permission with only own-scope grants become sensitive', async () => {
          const r = await insertRole(
            database,
            a.organisationId,
            'reach-flip-ok',
          );
          const key = await newPermission();
          await database.db
            .insert(rolePermission)
            .values(grant(r, key, { reach: 'own-scope' }));
          await database.db
            .update(permission)
            .set({ grantsSensitive: true })
            .where(eq(permission.key, key));
          const [row] = await rows(
            database,
            sql`select grants_sensitive from permission where key = ${key}`,
          );
          expect(row).toEqual({ grants_sensitive: true });
        });

        it('does not block other changes to a permission or a role that has all-projects grants', async () => {
          const r = await insertRole(database, a.organisationId, 'reach-other');
          const key = await newPermission();
          await database.db.insert(rolePermission).values(grant(r, key));
          await database.db
            .update(permission)
            .set({ description: 'Reworded' })
            .where(eq(permission.key, key));
          await database.db
            .update(role)
            .set({ name: 'Renamed' })
            .where(eq(role.id, r));
          const [row] = await rows(
            database,
            sql`select
                  (select description from permission where key = ${key}) as description,
                  (select name from role where id = ${r}) as role_name`,
          );
          expect(row).toEqual({
            description: 'Reworded',
            role_name: 'Renamed',
          });
        });
      });

      describe('duplicate keys with a NULL project', () => {
        it('rejects a duplicate department key', async () => {
          const values = departmentValues(a.organisationId, null, 'camera');
          await database.db.insert(department).values(values);
          const failure = await failureOf(() =>
            database.db
              .insert(department)
              .values(departmentValues(a.organisationId, null, 'camera')),
          );
          expect(failure).toEqual(
            uniqueViolation('department_organisation_project_key_unique'),
          );
        });

        it('rejects a duplicate role key', async () => {
          await database.db
            .insert(role)
            .values(roleValues(a.organisationId, null, 'director'));
          const failure = await failureOf(() =>
            database.db
              .insert(role)
              .values(roleValues(a.organisationId, null, 'director')),
          );
          expect(failure).toEqual(
            uniqueViolation('role_organisation_project_key_unique'),
          );
        });

        it('rejects a duplicate org-layer setting key', async () => {
          await database.db
            .insert(settingValue)
            .values(settingValues(a.organisationId, null, 'currency'));
          const failure = await failureOf(() =>
            database.db
              .insert(settingValue)
              .values(settingValues(a.organisationId, null, 'currency')),
          );
          expect(failure).toEqual(
            uniqueViolation('setting_value_organisation_project_key_unique'),
          );
        });

        it('allows the same key in a project, in another organisation, and as a template and project copy', async () => {
          await database.db
            .insert(department)
            .values(departmentValues(a.organisationId, null, 'sound'));
          await database.db
            .insert(department)
            .values(departmentValues(a.organisationId, a.projectId, 'sound'));
          await database.db
            .insert(department)
            .values(departmentValues(b.organisationId, null, 'sound'));
        });

        it('rejects a duplicate role_permission with no department', async () => {
          const r = await insertRole(database, a.organisationId, 'rp-dup');
          await database.db
            .insert(rolePermission)
            .values(rolePermissionValues(a.organisationId, r, null));
          const failure = await failureOf(() =>
            database.db
              .insert(rolePermission)
              .values(rolePermissionValues(a.organisationId, r, null)),
          );
          expect(failure).toEqual(
            uniqueViolation(
              'role_permission_role_permission_department_unique',
            ),
          );
        });
      });

      describe('organisation references', () => {
        it('rejects an organisation-wide template row with an unknown organisation', async () => {
          const unknown = newId();
          const department_ = await failureOf(() =>
            database.db
              .insert(department)
              .values(departmentValues(unknown, null, 'camera')),
          );
          expect(department_).toEqual(
            fkViolation('department_organisation_fk'),
          );
          const role_ = await failureOf(() =>
            database.db
              .insert(role)
              .values(roleValues(unknown, null, 'director')),
          );
          expect(role_).toEqual(fkViolation('role_organisation_fk'));
          const setting = await failureOf(() =>
            database.db
              .insert(settingValue)
              .values(settingValues(unknown, null, 'currency')),
          );
          expect(setting).toEqual(fkViolation('setting_value_organisation_fk'));
        });

        it('gives every table with an organisation_id column a foreign key to organisation', async () => {
          const missing = await rows(
            database,
            sql`select c.table_name
                from information_schema.columns c
                where c.table_schema = 'public' and c.column_name = 'organisation_id'
                  and not exists (
                    select 1 from pg_constraint k
                    where k.contype = 'f'
                      and k.conrelid = format('public.%I', c.table_name)::regclass
                      and k.confrelid = 'public.organisation'::regclass
                      and array_length(k.conkey, 1) = 1
                      and k.conkey[1] = (
                        select attnum from pg_attribute
                        where attrelid = k.conrelid and attname = 'organisation_id'
                      )
                  )`,
          );
          expect(missing).toEqual([]);
        });
      });

      describe('cross-organisation references', () => {
        it('rejects a department in another organisation’s project', async () => {
          const failure = await failureOf(() =>
            database.db
              .insert(department)
              .values(departmentValues(a.organisationId, b.projectId, 'x1')),
          );
          expect(failure).toEqual(fkViolation('department_project_fk'));
        });

        it('rejects a role in another organisation’s project', async () => {
          const failure = await failureOf(() =>
            database.db
              .insert(role)
              .values(roleValues(a.organisationId, b.projectId, 'x1')),
          );
          expect(failure).toEqual(fkViolation('role_project_fk'));
        });

        it('rejects a role_permission for another organisation’s role', async () => {
          const bRole = await insertRole(database, b.organisationId, 'x2');
          const failure = await failureOf(() =>
            database.db
              .insert(rolePermission)
              .values(rolePermissionValues(a.organisationId, bRole, null)),
          );
          expect(failure).toEqual(fkViolation('role_permission_role_fk'));
        });

        it('rejects a role_permission for another organisation’s department', async () => {
          const aRole = await insertRole(database, a.organisationId, 'x3');
          const bDept = await insertDepartment(
            database,
            b.organisationId,
            'x3',
          );
          const failure = await failureOf(() =>
            database.db
              .insert(rolePermission)
              .values(rolePermissionValues(a.organisationId, aRole, bDept)),
          );
          expect(failure).toEqual(fkViolation('role_permission_department_fk'));
        });

        it('rejects a project_membership on another organisation’s project', async () => {
          const u = await insertUser(database);
          const failure = await failureOf(() =>
            database.db
              .insert(projectMembership)
              .values(
                projectMembershipValues(a.organisationId, b.projectId, u),
              ),
          );
          expect(failure).toEqual(fkViolation('project_membership_project_fk'));
        });

        it('rejects a membership role on another organisation’s membership', async () => {
          const u = await insertUser(database);
          const bMembership = await insertProjectMembership(
            database,
            b.organisationId,
            b.projectId,
            u,
          );
          const aRole = await insertRole(database, a.organisationId, 'x4');
          const failure = await failureOf(() =>
            database.db
              .insert(projectMembershipRole)
              .values(
                membershipRoleValues(a.organisationId, bMembership, aRole),
              ),
          );
          expect(failure).toEqual(
            fkViolation('project_membership_role_membership_fk'),
          );
        });

        it('rejects a membership role for another organisation’s role', async () => {
          const u = await insertUser(database);
          const aMembership = await insertProjectMembership(
            database,
            a.organisationId,
            a.projectId,
            u,
          );
          const bRole = await insertRole(database, b.organisationId, 'x5');
          const failure = await failureOf(() =>
            database.db
              .insert(projectMembershipRole)
              .values(
                membershipRoleValues(a.organisationId, aMembership, bRole),
              ),
          );
          expect(failure).toEqual(
            fkViolation('project_membership_role_role_fk'),
          );
        });

        it('rejects a project-layer setting on another organisation’s project', async () => {
          const failure = await failureOf(() =>
            database.db.insert(settingValue).values({
              ...settingValues(a.organisationId, b.projectId, 'x6'),
              layer: 'project',
            }),
          );
          expect(failure).toEqual(fkViolation('setting_value_project_fk'));
        });
      });

      describe('project memberships', () => {
        it('rejects a second membership for the same user and project', async () => {
          const u = await insertUser(database);
          await insertProjectMembership(
            database,
            a.organisationId,
            a.projectId,
            u,
          );
          const failure = await failureOf(() =>
            database.db
              .insert(projectMembership)
              .values(
                projectMembershipValues(a.organisationId, a.projectId, u),
              ),
          );
          expect(failure).toEqual(
            uniqueViolation('project_membership_project_user_unique'),
          );
        });

        it('rejects an unknown status', async () => {
          const u = await insertUser(database);
          const failure = await failureOf(() =>
            database.db.insert(projectMembership).values({
              ...projectMembershipValues(a.organisationId, a.projectId, u),
              status: 'paused' as never,
            }),
          );
          expect(failure).toEqual(
            checkViolation('project_membership_status_check'),
          );
        });

        it('rejects the same role twice on one membership', async () => {
          const u = await insertUser(database);
          const m = await insertProjectMembership(
            database,
            a.organisationId,
            a.projectId,
            u,
          );
          const r = await insertRole(database, a.organisationId, 'twice');
          await database.db
            .insert(projectMembershipRole)
            .values(membershipRoleValues(a.organisationId, m, r));
          const failure = await failureOf(() =>
            database.db
              .insert(projectMembershipRole)
              .values(membershipRoleValues(a.organisationId, m, r)),
          );
          expect(failure).toEqual(
            uniqueViolation('project_membership_role_membership_role_unique'),
          );
        });
      });

      describe('permission', () => {
        it('rejects an unknown permission_key on role_permission', async () => {
          const r = await insertRole(database, a.organisationId, 'unknown-key');
          const failure = await failureOf(() =>
            database.db.insert(rolePermission).values({
              ...rolePermissionValues(a.organisationId, r, null),
              permissionKey: 'budget:destroy',
            }),
          );
          expect(failure).toEqual(
            fkViolation('role_permission_permission_key_fk'),
          );
        });

        it.each([
          'budget',
          'Budget:read',
          'budget:Read',
          ':read',
          'budget:',
          '1budget:read',
          'budget:read now',
          'budget_x:read',
        ])('rejects malformed key %j', async (key) => {
          const failure = await failureOf(() =>
            database.db
              .insert(permission)
              .values({ key, module: 'budget', description: 'Bad key' }),
          );
          expect(failure).toEqual(
            checkViolation('permission_key_format_check'),
          );
        });

        it('accepts well-formed keys and defaults grants_sensitive to false', async () => {
          await database.db.insert(permission).values([
            { key: 'call-sheet:read', module: 'call-sheet', description: 'x' },
            { key: 'crew:read:bank', module: 'crew', description: 'x' },
          ]);
          const [row] = await rows(
            database,
            sql`select grants_sensitive from permission where key = 'crew:read:bank'`,
          );
          expect(row).toEqual({ grants_sensitive: false });
        });

        it('has no standard columns', async () => {
          const columns = await columnsOf(database, 'permission');
          expect([...columns.keys()].sort()).toEqual([
            'description',
            'grants_sensitive',
            'key',
            'module',
          ]);
        });
      });

      describe('setting_value', () => {
        it('rejects the org layer with a project', async () => {
          const failure = await failureOf(() =>
            database.db.insert(settingValue).values({
              ...settingValues(a.organisationId, a.projectId, 'y1'),
              layer: 'org',
            }),
          );
          expect(failure).toEqual(
            checkViolation('setting_value_layer_project_check'),
          );
        });

        it('rejects the project layer without a project', async () => {
          const failure = await failureOf(() =>
            database.db.insert(settingValue).values({
              ...settingValues(a.organisationId, null, 'y2'),
              layer: 'project',
            }),
          );
          expect(failure).toEqual(
            checkViolation('setting_value_layer_project_check'),
          );
        });

        it('rejects an unknown layer', async () => {
          const failure = await failureOf(() =>
            database.db.insert(settingValue).values({
              ...settingValues(a.organisationId, null, 'y3'),
              layer: 'install' as never,
            }),
          );
          expect(failure.constraint).toBe('setting_value_layer_check');
        });

        it('stores json values and keeps org and project layers apart', async () => {
          await database.db.insert(settingValue).values({
            ...settingValues(a.organisationId, null, 'shared-key'),
            value: { nested: [1, 2] },
          });
          await database.db.insert(settingValue).values({
            ...settingValues(a.organisationId, a.projectId, 'shared-key'),
            layer: 'project',
          });
          const [row] = await rows(
            database,
            sql`select value from setting_value
                where organisation_id = ${a.organisationId}
                  and project_id is null and key = 'shared-key'`,
          );
          expect(row).toEqual({ value: { nested: [1, 2] } });
        });

        it('rejects a null value', async () => {
          const failure = await failureOf(() =>
            database.db.insert(settingValue).values({
              ...settingValues(a.organisationId, null, 'y4'),
              value: null,
            }),
          );
          expect(failure.code).toBe('23502');
        });
      });

      describe('defaults', () => {
        it('uses private visibility for memberships and settings, project elsewhere', async () => {
          const expected: Record<string, string> = {
            org_membership: 'private',
            org_membership_role: 'private',
            setting_value: 'private',
            department: 'project',
            role: 'project',
            role_permission: 'project',
            project_membership: 'project',
            project_membership_role: 'project',
          };
          for (const [table, visibility] of Object.entries(expected)) {
            const columns = await columnsOf(database, table);
            expect(columns.get('visibility')?.default, table).toContain(
              `'${visibility}'`,
            );
          }
        });

        it('defaults role.is_default and department.sort_order', async () => {
          const r = await insertRole(database, a.organisationId, 'defaults');
          const d = await insertDepartment(
            database,
            a.organisationId,
            'defaults',
          );
          const [row] = await rows(
            database,
            sql`select
                  (select is_default from role where id = ${r}) as is_default,
                  (select sort_order from department where id = ${d}) as sort_order`,
          );
          expect(row).toEqual({ is_default: false, sort_order: 0 });
        });
      });
    });
  });
});

type Tenant = { organisationId: string; projectId: string };

async function insertOrganisation(
  database: Database,
  overrides: Partial<typeof organisation.$inferInsert> = {},
) {
  const values = organisationValues(overrides);
  await database.db.insert(organisation).values(values);
  return values.id;
}

async function seedTenant(database: Database): Promise<Tenant> {
  const organisationId = await insertOrganisation(database);
  const [row] = await database.db
    .insert(project)
    .values(projectValues(organisationId))
    .returning({ id: project.id });
  return { organisationId, projectId: row!.id };
}

async function insertUser(database: Database) {
  const [row] = await database.db
    .insert(user)
    .values(userValues())
    .returning({ id: user.id });
  return row!.id;
}

function orgMembershipValues(organisationId: string, userId: string) {
  return {
    organisationId,
    ownerOrgId: organisationId,
    originServer: newId(),
    userId,
    orgRole: 'member',
    status: 'active',
  } satisfies typeof orgMembership.$inferInsert;
}

async function insertOrgMembership(
  database: Database,
  organisationId: string,
  userId: string,
) {
  const [row] = await database.db
    .insert(orgMembership)
    .values(orgMembershipValues(organisationId, userId))
    .returning({ id: orgMembership.id });
  return row!.id;
}

function orgMembershipRoleValues(
  organisationId: string,
  membershipId: string,
  roleId: string,
) {
  return {
    organisationId,
    ownerOrgId: organisationId,
    originServer: newId(),
    membershipId,
    roleId,
  } satisfies typeof orgMembershipRole.$inferInsert;
}

async function insertProjectRole(
  database: Database,
  organisationId: string,
  projectId: string,
  key: string,
) {
  const [row] = await database.db
    .insert(role)
    .values(roleValues(organisationId, projectId, key))
    .returning({ id: role.id });
  return row!.id;
}

/** Like `failureOf`, and also returns the driver's message, for trigger errors. */
async function failureWithMessageOf(action: () => PromiseLike<unknown>) {
  try {
    await action();
  } catch (error) {
    let current: unknown = error;
    while (current && typeof current === 'object') {
      const found = current as {
        code?: unknown;
        constraint?: unknown;
        message?: unknown;
        cause?: unknown;
      };
      if (typeof found.code === 'string') {
        return {
          code: found.code,
          constraint: found.constraint,
          message: String(found.message),
        };
      }
      current = found.cause;
    }
    throw error;
  }
  throw new Error('Expected the statement to fail, but it succeeded');
}

function departmentValues(
  organisationId: string,
  projectId: string | null,
  key: string,
) {
  return {
    organisationId,
    ownerOrgId: organisationId,
    originServer: newId(),
    projectId,
    key,
    name: key,
  } satisfies typeof department.$inferInsert;
}

function roleValues(
  organisationId: string,
  projectId: string | null,
  key: string,
) {
  return {
    organisationId,
    ownerOrgId: organisationId,
    originServer: newId(),
    projectId,
    key,
    name: key,
  } satisfies typeof role.$inferInsert;
}

function rolePermissionValues(
  organisationId: string,
  roleId: string,
  departmentId: string | null,
) {
  return {
    organisationId,
    ownerOrgId: organisationId,
    originServer: newId(),
    roleId,
    permissionKey: 'budget:read',
    departmentId,
  } satisfies typeof rolePermission.$inferInsert;
}

function projectMembershipValues(
  organisationId: string,
  projectId: string,
  userId: string,
) {
  return {
    organisationId,
    ownerOrgId: organisationId,
    originServer: newId(),
    projectId,
    userId,
    status: 'active',
  } satisfies typeof projectMembership.$inferInsert;
}

function membershipRoleValues(
  organisationId: string,
  membershipId: string,
  roleId: string,
) {
  return {
    organisationId,
    ownerOrgId: organisationId,
    originServer: newId(),
    membershipId,
    roleId,
  } satisfies typeof projectMembershipRole.$inferInsert;
}

function settingValues(
  organisationId: string,
  projectId: string | null,
  key: string,
) {
  return {
    organisationId,
    ownerOrgId: organisationId,
    originServer: newId(),
    layer: projectId === null ? 'org' : 'project',
    projectId,
    key,
    value: { enabled: true },
  } satisfies typeof settingValue.$inferInsert;
}

async function insertRole(
  database: Database,
  organisationId: string,
  key: string,
) {
  const [row] = await database.db
    .insert(role)
    .values(roleValues(organisationId, null, key))
    .returning({ id: role.id });
  return row!.id;
}

async function insertDepartment(
  database: Database,
  organisationId: string,
  key: string,
) {
  const [row] = await database.db
    .insert(department)
    .values(departmentValues(organisationId, null, key))
    .returning({ id: department.id });
  return row!.id;
}

async function insertProjectMembership(
  database: Database,
  organisationId: string,
  projectId: string,
  userId: string,
) {
  const [row] = await database.db
    .insert(projectMembership)
    .values(projectMembershipValues(organisationId, projectId, userId))
    .returning({ id: projectMembership.id });
  return row!.id;
}
