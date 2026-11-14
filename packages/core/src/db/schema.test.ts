import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { newId } from './ids.js';
import { migrate } from './migrate.js';
import {
  department,
  installation,
  orgMembership,
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
          'department',
          'installation',
          'org_membership',
          'organisation',
          'permission',
          'project',
          'project_membership',
          'project_membership_role',
          'role',
          'role_permission',
          'setting_value',
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
      for (const table of [
        'organisation',
        'project',
        'org_membership',
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
          'organisation',
          'project',
          'user',
          'org_membership',
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
            fkViolation('org_membership_organisation_id_fk'),
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
