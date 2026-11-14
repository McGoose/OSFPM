import { and, eq, isNull, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { organisationForeignKeyName } from './columns.js';
import { newId } from './ids.js';
import {
  changeEvent,
  company,
  department,
  location,
  organisation,
  person,
  personCompany,
  project,
  projectCompany,
  projectLocation,
  projectPerson,
} from './schema/index.js';
import { sensitiveColumns } from './sensitive.js';
import {
  createMigratedDatabase,
  failureOf,
  SQLSTATE,
  testTargets,
} from './test-support.js';
import { insertRecord, type WriteContext } from './write.js';

type Row = Record<string, unknown>;

async function rows(database: Database, query: ReturnType<typeof sql>) {
  const result = (await database.db.execute(query)) as { rows: Row[] };
  return result.rows;
}

const TIMESTAMPTZ = 'timestamp with time zone';
const STANDARD_COLUMNS: Record<string, { type: string; nullable: boolean }> = {
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

/** Each new table, its default visibility and its composite foreign keys. */
const TABLES = [
  {
    name: 'person',
    visibility: 'private',
    table: person,
    fks: ['person_department_fk'],
  },
  { name: 'company', visibility: 'private', table: company, fks: [] },
  {
    name: 'person_company',
    visibility: 'private',
    table: personCompany,
    fks: ['person_company_person_fk', 'person_company_company_fk'],
  },
  {
    name: 'location',
    visibility: 'private',
    table: location,
    fks: ['location_company_fk', 'location_person_fk', 'location_location_fk'],
  },
  {
    name: 'project_person',
    visibility: 'project',
    table: projectPerson,
    fks: [
      'project_person_project_fk',
      'project_person_person_fk',
      'project_person_department_fk',
    ],
  },
  {
    name: 'project_company',
    visibility: 'project',
    table: projectCompany,
    fks: ['project_company_project_fk', 'project_company_company_fk'],
  },
  {
    name: 'project_location',
    visibility: 'project',
    table: projectLocation,
    fks: ['project_location_project_fk', 'project_location_location_fk'],
  },
] as const;

const ORIGIN = newId();

/** Standard columns every tenant insert needs. */
const base = (organisationId: string) => ({
  organisationId,
  ownerOrgId: organisationId,
  originServer: ORIGIN,
});

type Seed = {
  organisationId: string;
  projectId: string;
  departmentId: string;
  personId: string;
  companyId: string;
  locationId: string;
};

let counter = 0;

/** One organisation with a project, a department, a person, a company and a location. */
async function seedOrganisation(database: Database): Promise<Seed> {
  counter += 1;
  const organisationId = newId();
  await database.db.insert(organisation).values({
    id: organisationId,
    organisationId,
    ownerOrgId: organisationId,
    originServer: ORIGIN,
    slug: `library-demo-org-${counter}`,
    name: 'Demo Pictures',
    country: 'GB',
    defaultLocale: 'en-GB',
    defaultTimezone: 'Europe/London',
    baseCurrency: 'GBP',
    status: 'active',
  });
  const [p] = await database.db
    .insert(project)
    .values({
      ...base(organisationId),
      code: 'TLW',
      title: 'The Last Withdrawal',
      format: 'feature',
      status: 'development',
      timezone: 'Europe/London',
      locale: 'en-GB',
      currency: 'GBP',
    })
    .returning();
  const [d] = await database.db
    .insert(department)
    .values({ ...base(organisationId), key: 'camera', name: 'Camera' })
    .returning();
  const [per] = await database.db
    .insert(person)
    .values({ ...base(organisationId), displayName: 'Alex Demo' })
    .returning();
  const [c] = await database.db
    .insert(company)
    .values({
      ...base(organisationId),
      name: 'Demo Rentals Ltd',
      kind: 'rental-house',
    })
    .returning();
  const [l] = await database.db
    .insert(location)
    .values({
      ...base(organisationId),
      name: 'Harbour Warehouse',
      kind: 'location',
    })
    .returning();
  return {
    organisationId,
    projectId: p!.id,
    departmentId: d!.id,
    personId: per!.id,
    companyId: c!.id,
    locationId: l!.id,
  };
}

/** Rows for each new table that are valid for `s`, with `over` applied on top. */
const valid = {
  person: (s: Seed, over: Partial<typeof person.$inferInsert> = {}) => ({
    ...base(s.organisationId),
    displayName: 'Sam Example',
    ...over,
  }),
  company: (s: Seed, over: Partial<typeof company.$inferInsert> = {}) => ({
    ...base(s.organisationId),
    name: 'Example Lighting Ltd',
    kind: 'vendor' as const,
    ...over,
  }),
  personCompany: (
    s: Seed,
    over: Partial<typeof personCompany.$inferInsert> = {},
  ) => ({
    ...base(s.organisationId),
    personId: s.personId,
    companyId: s.companyId,
    relation: 'employee' as const,
    ...over,
  }),
  location: (s: Seed, over: Partial<typeof location.$inferInsert> = {}) => ({
    ...base(s.organisationId),
    name: 'Example Car Park',
    kind: 'parking' as const,
    ...over,
  }),
  projectPerson: (
    s: Seed,
    over: Partial<typeof projectPerson.$inferInsert> = {},
  ) => ({
    ...base(s.organisationId),
    projectId: s.projectId,
    personId: s.personId,
    engagement: 'crew' as const,
    status: 'proposed' as const,
    ...over,
  }),
  projectCompany: (
    s: Seed,
    over: Partial<typeof projectCompany.$inferInsert> = {},
  ) => ({
    ...base(s.organisationId),
    projectId: s.projectId,
    companyId: s.companyId,
    role: 'vendor' as const,
    status: 'proposed' as const,
    ...over,
  }),
  projectLocation: (
    s: Seed,
    over: Partial<typeof projectLocation.$inferInsert> = {},
  ) => ({
    ...base(s.organisationId),
    projectId: s.projectId,
    locationId: s.locationId,
    status: 'scouted' as const,
    ...over,
  }),
};

/** A value the column's type allows but its CHECK must refuse. */
const bad = (value: string) => value as never;

const check = (constraint: string) => ({
  code: SQLSTATE.checkViolation,
  constraint,
});
const unique = (constraint: string) => ({
  code: SQLSTATE.uniqueViolation,
  constraint,
});
const foreignKey = (constraint: string) => ({
  code: SQLSTATE.foreignKeyViolation,
  constraint,
});

describe.each(testTargets)('library tables on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
  });
  afterAll(async () => {
    await cleanup();
  });

  const insert = (table: PgTable, values: object) =>
    database.db.insert(table as never).values(values as never);

  describe('introspection', () => {
    it.each(TABLES)(
      '$name has the standard columns, its default visibility and a named organisation FK',
      async ({ name, visibility, table }) => {
        const found = await rows(
          database,
          sql`select column_name, data_type, is_nullable, column_default
              from information_schema.columns
              where table_schema = 'public' and table_name = ${name}`,
        );
        const columns = new Map(found.map((c) => [c.column_name as string, c]));
        for (const [column, spec] of Object.entries(STANDARD_COLUMNS)) {
          const actual = columns.get(column);
          expect(actual, `${name}.${column}`).toBeDefined();
          expect(actual!.data_type, `${name}.${column}`).toBe(spec.type);
          expect(actual!.is_nullable === 'YES', `${name}.${column}`).toBe(
            spec.nullable,
          );
        }
        expect(columns.get('visibility')!.column_default).toBe(
          `'${visibility}'::text`,
        );

        const fks = await rows(
          database,
          sql`select conname from pg_constraint
              where contype = 'f' and conrelid = ${name}::regclass
                and confrelid = 'organisation'::regclass`,
        );
        expect(fks.map((f) => f.conname)).toEqual([
          organisationForeignKeyName(name),
        ]);
        expect(sensitiveColumns(table).size).toBe(0);
      },
    );

    it.each(TABLES)(
      '$name has its composite foreign keys',
      async ({ name, fks }) => {
        const found = await rows(
          database,
          sql`select conname from pg_constraint
            where contype = 'f' and conrelid = ${name}::regclass
              and cardinality(conkey) = 2`,
        );
        expect(found.map((f) => f.conname as string).sort()).toEqual(
          [...fks].sort(),
        );
      },
    );

    it('has a unique (organisation_id, id) target on every composite FK target', async () => {
      const found = await rows(
        database,
        sql`select conrelid::regclass::text as table_name
            from pg_constraint
            where contype = 'u' and conname like '%_organisation_id_id_unique'`,
      );
      const names = found.map((r) => r.table_name as string);
      for (const target of [
        'person',
        'company',
        'location',
        'project_person',
        'project_location',
      ]) {
        expect(names).toContain(target);
      }
    });

    it('keeps notes and sensitive data off person', async () => {
      const found = await rows(
        database,
        sql`select column_name from information_schema.columns
            where table_schema = 'public' and table_name = 'person'`,
      );
      const names = found.map((c) => c.column_name as string);
      expect(names.filter((n) => /note/.test(n))).toEqual([]);
    });
  });

  describe('composite foreign keys', () => {
    let a: Seed;
    let b: Seed;

    beforeAll(async () => {
      a = await seedOrganisation(database);
      b = await seedOrganisation(database);
    });

    const cases: {
      constraint: string;
      table: PgTable;
      values: () => object;
    }[] = [
      {
        constraint: 'person_department_fk',
        table: person,
        values: () => valid.person(a, { defaultDepartmentId: b.departmentId }),
      },
      {
        constraint: 'person_company_person_fk',
        table: personCompany,
        values: () => valid.personCompany(a, { personId: b.personId }),
      },
      {
        constraint: 'person_company_company_fk',
        table: personCompany,
        values: () => valid.personCompany(a, { companyId: b.companyId }),
      },
      {
        constraint: 'location_company_fk',
        table: location,
        values: () => valid.location(a, { ownerCompanyId: b.companyId }),
      },
      {
        constraint: 'location_person_fk',
        table: location,
        values: () => valid.location(a, { contactPersonId: b.personId }),
      },
      {
        constraint: 'location_location_fk',
        table: location,
        values: () => valid.location(a, { nearestHospitalId: b.locationId }),
      },
      {
        constraint: 'project_person_project_fk',
        table: projectPerson,
        values: () => valid.projectPerson(a, { projectId: b.projectId }),
      },
      {
        constraint: 'project_person_person_fk',
        table: projectPerson,
        values: () => valid.projectPerson(a, { personId: b.personId }),
      },
      {
        constraint: 'project_person_department_fk',
        table: projectPerson,
        values: () => valid.projectPerson(a, { departmentId: b.departmentId }),
      },
      {
        constraint: 'project_company_project_fk',
        table: projectCompany,
        values: () => valid.projectCompany(a, { projectId: b.projectId }),
      },
      {
        constraint: 'project_company_company_fk',
        table: projectCompany,
        values: () => valid.projectCompany(a, { companyId: b.companyId }),
      },
      {
        constraint: 'project_location_project_fk',
        table: projectLocation,
        values: () => valid.projectLocation(a, { projectId: b.projectId }),
      },
      {
        constraint: 'project_location_location_fk',
        table: projectLocation,
        values: () => valid.projectLocation(a, { locationId: b.locationId }),
      },
    ];

    it('covers every composite foreign key', () => {
      const covered = cases.map((c) => c.constraint).sort();
      const declared = TABLES.flatMap((t) => [...t.fks]).sort();
      expect(covered).toEqual(declared);
    });

    it.each(cases)(
      'rejects a cross-organisation reference through $constraint',
      async ({ constraint, table, values }) => {
        expect(await failureOf(() => insert(table, values()))).toEqual(
          foreignKey(constraint),
        );
      },
    );

    it('accepts the same references inside one organisation', async () => {
      const hospital = await database.db
        .insert(location)
        .values(valid.location(a, { name: 'Demo General', kind: 'hospital' }))
        .returning();
      await insert(
        location,
        valid.location(a, {
          ownerCompanyId: a.companyId,
          contactPersonId: a.personId,
          nearestHospitalId: hospital[0]!.id,
        }),
      );
      await insert(
        projectPerson,
        valid.projectPerson(a, { departmentId: a.departmentId }),
      );
    });
  });

  describe('CHECK constraints', () => {
    let s: Seed;

    beforeAll(async () => {
      s = await seedOrganisation(database);
    });

    const enumCases: [string, PgTable, (s: Seed) => object, string][] = [
      [
        'person status',
        person,
        (x) => valid.person(x, { status: bad('retired') }),
        'person_status_check',
      ],
      [
        'company kind',
        company,
        (x) => valid.company(x, { kind: bad('studio') }),
        'company_kind_check',
      ],
      [
        'person_company relation',
        personCompany,
        (x) => valid.personCompany(x, { relation: bad('friend') }),
        'person_company_relation_check',
      ],
      [
        'location kind',
        location,
        (x) => valid.location(x, { kind: bad('castle') }),
        'location_kind_check',
      ],
      [
        'location status',
        location,
        (x) => valid.location(x, { status: bad('closed') }),
        'location_status_check',
      ],
      [
        'project_person engagement',
        projectPerson,
        (x) => valid.projectPerson(x, { engagement: bad('extra') }),
        'project_person_engagement_check',
      ],
      [
        'project_person status',
        projectPerson,
        (x) => valid.projectPerson(x, { status: bad('hired') }),
        'project_person_status_check',
      ],
      [
        'project_company role',
        projectCompany,
        (x) => valid.projectCompany(x, { role: bad('agency') }),
        'project_company_role_check',
      ],
      [
        'project_company status',
        projectCompany,
        (x) => valid.projectCompany(x, { status: bad('paid') }),
        'project_company_status_check',
      ],
      [
        'project_location status',
        projectLocation,
        (x) => valid.projectLocation(x, { status: bad('booked') }),
        'project_location_status_check',
      ],
    ];

    it.each(enumCases)(
      'rejects an unknown %s',
      async (_label, table, values, constraint) => {
        expect(await failureOf(() => insert(table, values(s)))).toEqual(
          check(constraint),
        );
      },
    );

    it.each([
      [
        'person email',
        person,
        (x: Seed) => valid.person(x, { email: 'Sam.Example@Example.test' }),
        'person_email_lowercase_check',
      ],
      [
        'company email',
        company,
        (x: Seed) => valid.company(x, { email: 'Hello@Example.test' }),
        'company_email_lowercase_check',
      ],
    ] as const)('rejects an upper-case %s', async (_l, table, values, name) => {
      expect(await failureOf(() => insert(table, values(s)))).toEqual(
        check(name),
      );
    });

    it.each([
      [
        'company country, lower case',
        company,
        (x: Seed) => valid.company(x, { country: 'gb' }),
        'company_country_check',
      ],
      [
        'company country, three letters',
        company,
        (x: Seed) => valid.company(x, { country: 'GBR' }),
        'company_country_check',
      ],
      [
        'company address country',
        company,
        (x: Seed) => valid.company(x, { addressCountry: 'United Kingdom' }),
        'company_address_country_check',
      ],
      [
        'location address country',
        location,
        (x: Seed) => valid.location(x, { addressCountry: 'g1' }),
        'location_address_country_check',
      ],
    ] as const)('rejects a malformed %s', async (_l, table, values, name) => {
      expect(await failureOf(() => insert(table, values(s)))).toEqual(
        check(name),
      );
    });

    it.each([
      [
        'latitude above 90',
        { latitude: '90.000001', longitude: '0' },
        'location_latitude_check',
      ],
      [
        'latitude below -90',
        { latitude: '-91', longitude: '0' },
        'location_latitude_check',
      ],
      [
        'longitude above 180',
        { latitude: '0', longitude: '180.5' },
        'location_longitude_check',
      ],
      [
        'longitude below -180',
        { latitude: '0', longitude: '-181' },
        'location_longitude_check',
      ],
      [
        'latitude without longitude',
        { latitude: '51.5', longitude: null },
        'location_coordinates_pair_check',
      ],
      [
        'longitude without latitude',
        { latitude: null, longitude: '-0.12' },
        'location_coordinates_pair_check',
      ],
    ] as const)('rejects %s', async (_l, coordinates, name) => {
      expect(
        await failureOf(() =>
          insert(location, valid.location(s, { ...coordinates })),
        ),
      ).toEqual(check(name));
    });

    it('accepts coordinates on the limits, and none at all', async () => {
      await insert(
        location,
        valid.location(s, { latitude: '-90', longitude: '180' }),
      );
      await insert(
        location,
        valid.location(s, { latitude: '90', longitude: '-180' }),
      );
      await insert(location, valid.location(s));
    });

    it.each([
      [
        'person_company',
        personCompany,
        (x: Seed) =>
          valid.personCompany(x, {
            startDate: '2026-02-01',
            endDate: '2026-01-31',
          }),
        'person_company_dates_check',
      ],
      [
        'project_person',
        projectPerson,
        (x: Seed) =>
          valid.projectPerson(x, {
            startDate: '2026-02-01',
            endDate: '2026-01-31',
          }),
        'project_person_dates_check',
      ],
    ] as const)(
      'rejects an end date before the start date on %s',
      async (_l, table, values, name) => {
        expect(await failureOf(() => insert(table, values(s)))).toEqual(
          check(name),
        );
      },
    );

    it('accepts an end date on the start date, or only one of the two', async () => {
      await insert(
        projectPerson,
        valid.projectPerson(s, {
          engagement: 'contact',
          startDate: '2026-03-01',
          endDate: '2026-03-01',
        }),
      );
      await insert(
        projectPerson,
        valid.projectPerson(s, {
          engagement: 'background',
          endDate: '2026-03-01',
        }),
      );
    });

    it('rejects a cast number on a non-cast engagement', async () => {
      expect(
        await failureOf(() =>
          insert(
            projectPerson,
            valid.projectPerson(s, { engagement: 'crew', castNumber: 3 }),
          ),
        ),
      ).toEqual(check('project_person_cast_number_cast_only_check'));
    });

    it.each([0, -1])('rejects the cast number %i', async (castNumber) => {
      expect(
        await failureOf(() =>
          insert(
            projectPerson,
            valid.projectPerson(s, { engagement: 'cast', castNumber }),
          ),
        ),
      ).toEqual(check('project_person_cast_number_positive_check'));
    });

    it('rejects a location that is its own nearest hospital', async () => {
      const id = newId();
      expect(
        await failureOf(() =>
          insert(location, valid.location(s, { id, nearestHospitalId: id })),
        ),
      ).toEqual(check('location_nearest_hospital_self_check'));
    });
  });

  describe('uniqueness', () => {
    let s: Seed;

    beforeAll(async () => {
      s = await seedOrganisation(database);
    });

    const newPerson = async (name: string) => {
      const [row] = await database.db
        .insert(person)
        .values(valid.person(s, { displayName: name }))
        .returning();
      return row!.id;
    };

    it('rejects two links with the same project, person and engagement and no character', async () => {
      await insert(projectPerson, valid.projectPerson(s));
      expect(
        await failureOf(() => insert(projectPerson, valid.projectPerson(s))),
      ).toEqual(unique('project_person_engagement_unique'));
    });

    it('allows the same person to play two characters, and to hold two engagements', async () => {
      const personId = await newPerson('Jo Twin');
      await insert(
        projectPerson,
        valid.projectPerson(s, {
          personId,
          engagement: 'cast',
          characterName: 'Mara (young)',
        }),
      );
      await insert(
        projectPerson,
        valid.projectPerson(s, {
          personId,
          engagement: 'cast',
          characterName: 'Mara (old)',
        }),
      );
      await insert(
        projectPerson,
        valid.projectPerson(s, { personId, engagement: 'crew' }),
      );
      expect(
        await failureOf(() =>
          insert(
            projectPerson,
            valid.projectPerson(s, {
              personId,
              engagement: 'cast',
              characterName: 'Mara (old)',
            }),
          ),
        ),
      ).toEqual(unique('project_person_engagement_unique'));
    });

    it('allows two cast engagements to share a cast number', async () => {
      const first = await newPerson('Cast One');
      const second = await newPerson('Cast Two');
      for (const [personId, characterName] of [
        [first, 'Mara (young)'],
        [second, 'Mara (old)'],
      ] as const) {
        await insert(
          projectPerson,
          valid.projectPerson(s, {
            personId,
            engagement: 'cast',
            castNumber: 1,
            characterName,
          }),
        );
      }
      const shared = await database.db
        .select()
        .from(projectPerson)
        .where(
          and(
            eq(projectPerson.projectId, s.projectId),
            eq(projectPerson.castNumber, 1),
          ),
        );
      expect(shared).toHaveLength(2);
    });

    it('rejects a second link of the same person to the same company, relation and start date', async () => {
      await insert(personCompany, valid.personCompany(s));
      expect(
        await failureOf(() => insert(personCompany, valid.personCompany(s))),
      ).toEqual(unique('person_company_link_unique'));
      await insert(
        personCompany,
        valid.personCompany(s, { startDate: '2026-01-01' }),
      );
      await insert(
        personCompany,
        valid.personCompany(s, { relation: 'director' }),
      );
    });

    it('rejects a company with the same role twice on a project', async () => {
      await insert(projectCompany, valid.projectCompany(s));
      expect(
        await failureOf(() => insert(projectCompany, valid.projectCompany(s))),
      ).toEqual(unique('project_company_role_unique'));
      await insert(projectCompany, valid.projectCompany(s, { role: 'funder' }));
    });

    it('rejects a location linked to a project twice', async () => {
      await insert(projectLocation, valid.projectLocation(s));
      expect(
        await failureOf(() =>
          insert(projectLocation, valid.projectLocation(s)),
        ),
      ).toEqual(unique('project_location_unique'));
    });

    it('links a person to a user at most once per organisation', async () => {
      const t = await seedOrganisation(database);
      const userRows = (await rows(
        database,
        sql`insert into "user" (id, origin_server, email, display_name, locale, timezone, status)
            values (${newId()}, ${ORIGIN}, ${`library.user${counter}@example.test`},
                    'Demo User', 'en-GB', 'Europe/London', 'active')
            returning id`,
      )) as { id: string }[];
      const userId = userRows[0]!.id;
      await insert(person, valid.person(t, { userId }));
      expect(
        await failureOf(() => insert(person, valid.person(t, { userId }))),
      ).toEqual(unique('person_organisation_user_unique'));
      // The same user may be a person in another organisation, and many
      // people may have no user at all.
      await insert(person, valid.person(s, { userId }));
      await insert(person, valid.person(t));
      await insert(person, valid.person(t));
    });
  });

  describe('write helper', () => {
    const ctx = (): WriteContext => ({
      actor: { type: 'system', id: null },
      originServer: ORIGIN,
      clock: () => new Date(Date.UTC(2026, 0, 1, 12)),
    });

    const eventsOf = (entityId: string) =>
      database.db
        .select()
        .from(changeEvent)
        .where(eq(changeEvent.entityId, entityId));

    it('logs a person in the organisation sequence', async () => {
      const s = await seedOrganisation(database);
      const created = await database.db.transaction((tx) =>
        insertRecord(tx, person, valid.person(s), ctx()),
      );
      const events = await eventsOf(created.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        organisationId: s.organisationId,
        projectId: null,
        entityType: 'person',
        action: 'create',
        seq: 1,
      });
    });

    it('logs a project_person in its project’s sequence, apart from the organisation’s', async () => {
      const s = await seedOrganisation(database);
      const created = await database.db.transaction((tx) =>
        insertRecord(tx, projectPerson, valid.projectPerson(s), ctx()),
      );
      const events = await eventsOf(created.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        organisationId: s.organisationId,
        projectId: s.projectId,
        entityType: 'project_person',
        action: 'create',
        seq: 1,
      });

      // A library write afterwards starts the organisation sequence at 1, and
      // a second link takes the project sequence to 2.
      const library = await database.db.transaction((tx) =>
        insertRecord(tx, company, valid.company(s), ctx()),
      );
      const second = await database.db.transaction((tx) =>
        insertRecord(
          tx,
          projectCompany,
          valid.projectCompany(s, { companyId: library.id }),
          ctx(),
        ),
      );
      const [libraryEvent] = await eventsOf(library.id);
      const [secondEvent] = await eventsOf(second.id);
      expect(libraryEvent).toMatchObject({ projectId: null, seq: 1 });
      expect(secondEvent).toMatchObject({ projectId: s.projectId, seq: 2 });

      const organisationSequence = await database.db
        .select({ id: changeEvent.entityId })
        .from(changeEvent)
        .where(
          and(
            eq(changeEvent.organisationId, s.organisationId),
            isNull(changeEvent.projectId),
          ),
        );
      expect(organisationSequence.map((e) => e.id)).toEqual([library.id]);
    });
  });
});
