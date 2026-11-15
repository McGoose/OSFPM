import { eq, getTableName, is, sql } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import {
  declaredRetentionClasses,
  organisationForeignKeyName,
  retentionClassForeignKeyName,
  tenantTableNames,
} from './columns.js';
import { newId } from './ids.js';
import { migrate } from './migrate.js';
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
          'audit_event',
          'block',
          'change_event',
          'change_seq',
          'company',
          'department',
          'episode',
          'installation',
          'legal_hold',
          'location',
          'org_membership',
          'org_membership_role',
          'organisation',
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
          'retention_class',
          'role',
          'role_permission',
          'setting_value',
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
        // Every tenant table and `user` carry the column; nothing else does.
        expect(withColumn.map((r) => r.table_name as string).sort()).toEqual(
          [...tenantTableNames(), 'user'].sort(),
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

      it('installation has only its own four columns', async () => {
        const columns = await columnsOf(database, 'installation');
        expect([...columns.keys()].sort()).toEqual([
          'base_url',
          'created_at',
          'id',
          'server_public_key',
        ]);
        expect(columns.get('server_public_key')?.nullable).toBe(true);
      });

      it('never generates ids in the database', async () => {
        for (const table of [
          'installation',
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
      it('rejects an upper-case email', async () => {
        const failure = await failureOf(() =>
          database.db
            .insert(user)
            .values(userValues({ email: 'Mixed.Case@example.test' })),
        );
        expect(failure).toEqual({
          code: SQLSTATE.checkViolation,
          constraint: 'user_email_lowercase_check',
        });
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
