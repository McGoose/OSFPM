import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { newId } from './ids.js';
import { migrate } from './migrate.js';
import { installation, organisation, project, user } from './schema/index.js';
import {
  createMigratedDatabase,
  failureOf,
  SQLSTATE,
  testTargets,
} from './test-support.js';

type Row = Record<string, unknown>;

async function rows(database: Database, query: ReturnType<typeof sql>) {
  const result = await database.db.execute(query);
  return result.rows as Row[];
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
  retention_class: { type: 'text', nullable: true },
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
          'installation',
          'organisation',
          'project',
          'user',
        ]);
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
      for (const table of ['organisation', 'project']) {
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
          'organisation',
          'project',
          'user',
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
  });
});
