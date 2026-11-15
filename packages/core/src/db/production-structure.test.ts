import { and, asc, eq, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProject } from '../projects/create.js';
import type { Database } from './client.js';
import { organisationForeignKeyName } from './columns.js';
import { newId } from './ids.js';
import {
  block,
  changeEvent,
  episode,
  organisation,
  project,
  unit,
} from './schema/index.js';
import {
  createMigratedDatabase,
  failureOf,
  SQLSTATE,
  testTargets,
} from './test-support.js';
import { softDeleteRecord, type WriteContext } from './write.js';

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
  retention_class: { type: 'text', nullable: false },
};

/** Each new table, its own columns, and its composite foreign keys. */
const TABLES = [
  {
    name: 'unit',
    table: unit,
    columns: {
      project_id: { type: 'uuid', nullable: false },
      key: { type: 'text', nullable: false },
      name: { type: 'text', nullable: false },
      kind: { type: 'text', nullable: false },
      sort_order: { type: 'integer', nullable: false },
    },
    fks: ['unit_project_fk'],
  },
  {
    name: 'block',
    table: block,
    columns: {
      project_id: { type: 'uuid', nullable: false },
      key: { type: 'text', nullable: false },
      name: { type: 'text', nullable: false },
      sort_order: { type: 'integer', nullable: false },
    },
    fks: ['block_project_fk'],
  },
  {
    name: 'episode',
    table: episode,
    columns: {
      project_id: { type: 'uuid', nullable: false },
      block_id: { type: 'uuid', nullable: true },
      number: { type: 'text', nullable: false },
      title: { type: 'text', nullable: true },
      status: { type: 'text', nullable: false },
      sort_order: { type: 'integer', nullable: false },
    },
    // Only the two-column foreign keys; `episode_block_fk` has three columns.
    fks: ['episode_project_fk'],
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
  /** A second project in the same organisation. */
  otherProjectId: string;
};

let counter = 0;

const projectValues = (
  organisationId: string,
  over: Partial<typeof project.$inferInsert> = {},
) => ({
  ...base(organisationId),
  code: 'TLW',
  title: 'The Last Withdrawal',
  format: 'feature' as const,
  status: 'development' as const,
  timezone: 'Europe/London',
  locale: 'en-GB',
  currency: 'GBP',
  ...over,
});

/** One organisation with two projects. */
async function seedOrganisation(database: Database): Promise<Seed> {
  counter += 1;
  const organisationId = newId();
  await database.db.insert(organisation).values({
    id: organisationId,
    organisationId,
    ownerOrgId: organisationId,
    originServer: ORIGIN,
    slug: `structure-demo-org-${counter}`,
    name: 'Demo Pictures',
    country: 'GB',
    defaultLocale: 'en-GB',
    defaultTimezone: 'Europe/London',
    baseCurrency: 'GBP',
    status: 'active',
  });
  const [first, second] = await database.db
    .insert(project)
    .values([
      projectValues(organisationId),
      projectValues(organisationId, {
        code: 'TLW2',
        title: 'The Last Withdrawal: Series',
        format: 'series',
      }),
    ])
    .returning();
  return {
    organisationId,
    projectId: first!.id,
    otherProjectId: second!.id,
  };
}

const valid = {
  unit: (s: Seed, over: Partial<typeof unit.$inferInsert> = {}) => ({
    ...base(s.organisationId),
    projectId: s.projectId,
    key: `unit-${newId()}`,
    name: 'Second unit',
    kind: 'second' as const,
    ...over,
  }),
  block: (s: Seed, over: Partial<typeof block.$inferInsert> = {}) => ({
    ...base(s.organisationId),
    projectId: s.projectId,
    key: `block-${newId()}`,
    name: 'Block 1',
    ...over,
  }),
  episode: (s: Seed, over: Partial<typeof episode.$inferInsert> = {}) => ({
    ...base(s.organisationId),
    projectId: s.projectId,
    number: `ep-${newId()}`,
    status: 'planned' as const,
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

describe.each(testTargets)('units, blocks and episodes on $name', (target) => {
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
      '$name has the standard columns, its own columns and a named organisation FK',
      async ({ name, columns: own }) => {
        const found = await rows(
          database,
          sql`select column_name, data_type, is_nullable, column_default
              from information_schema.columns
              where table_schema = 'public' and table_name = ${name}`,
        );
        const columns = new Map(found.map((c) => [c.column_name as string, c]));
        for (const [column, spec] of [
          ...Object.entries(STANDARD_COLUMNS),
          ...Object.entries(own),
        ]) {
          const actual = columns.get(column);
          expect(actual, `${name}.${column}`).toBeDefined();
          expect(actual!.data_type, `${name}.${column}`).toBe(spec.type);
          expect(actual!.is_nullable === 'YES', `${name}.${column}`).toBe(
            spec.nullable,
          );
        }
        expect(columns.size).toBe(
          Object.keys(STANDARD_COLUMNS).length + Object.keys(own).length,
        );
        expect(columns.get('visibility')!.column_default).toBe(
          `'project'::text`,
        );
        expect(columns.get('sort_order')!.column_default).toBe('0');

        const fks = await rows(
          database,
          sql`select conname from pg_constraint
              where contype = 'f' and conrelid = ${name}::regclass
                and confrelid = 'organisation'::regclass`,
        );
        expect(fks.map((f) => f.conname)).toEqual([
          organisationForeignKeyName(name),
        ]);
      },
    );

    it.each(TABLES)(
      '$name has its composite foreign keys, all starting with organisation_id',
      async ({ name, fks }) => {
        const found = await rows(
          database,
          sql`select c.conname,
                     (select a.attname from pg_attribute a
                       where a.attrelid = c.conrelid and a.attnum = c.conkey[1]) as first_column
              from pg_constraint c
              where c.contype = 'f' and c.conrelid = ${name}::regclass
                and cardinality(c.conkey) > 1`,
        );
        const expected = [
          ...fks,
          ...(name === 'episode' ? ['episode_block_fk'] : []),
        ].sort();
        expect(found.map((f) => f.conname as string).sort()).toEqual(expected);
        for (const f of found) {
          expect(f.first_column, f.conname as string).toBe('organisation_id');
        }
      },
    );

    it.each(TABLES)(
      '$name is a composite FK target through (organisation_id, id)',
      async ({ name }) => {
        const found = await rows(
          database,
          sql`select conname from pg_constraint
              where contype = 'u' and conrelid = ${name}::regclass
                and conname = ${`${name}_organisation_id_id_unique`}`,
        );
        expect(found).toHaveLength(1);
      },
    );

    it('keeps the episode block FK inside one project', async () => {
      const [fk] = await rows(
        database,
        sql`select
              (select array_agg(a.attname::text order by k.ord)
                 from unnest(c.conkey) with ordinality as k(attnum, ord)
                 join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as columns,
              (select array_agg(a.attname::text order by k.ord)
                 from unnest(c.confkey) with ordinality as k(attnum, ord)
                 join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum) as target_columns,
              c.confrelid::regclass::text as target
            from pg_constraint c
            where c.conname = 'episode_block_fk'`,
      );
      expect(fk).toEqual({
        columns: ['organisation_id', 'project_id', 'block_id'],
        target_columns: ['organisation_id', 'project_id', 'id'],
        target: 'block',
      });
    });

    it('adds three nullable date columns to project', async () => {
      const found = await rows(
        database,
        sql`select column_name, data_type, is_nullable
            from information_schema.columns
            where table_schema = 'public' and table_name = 'project'
              and column_name in ('wrap_date', 'delivery_date', 'first_exploitation_date')
            order by column_name`,
      );
      expect(found).toEqual([
        {
          column_name: 'delivery_date',
          data_type: 'date',
          is_nullable: 'YES',
        },
        {
          column_name: 'first_exploitation_date',
          data_type: 'date',
          is_nullable: 'YES',
        },
        { column_name: 'wrap_date', data_type: 'date', is_nullable: 'YES' },
      ]);
    });
  });

  describe('composite foreign keys', () => {
    let a: Seed;
    let b: Seed;
    let blockOfB: string;
    let blockOfOtherProject: string;

    beforeAll(async () => {
      a = await seedOrganisation(database);
      b = await seedOrganisation(database);
      const [inB] = await database.db
        .insert(block)
        .values(valid.block(b))
        .returning();
      blockOfB = inB!.id;
      const [elsewhere] = await database.db
        .insert(block)
        .values(valid.block(a, { projectId: a.otherProjectId }))
        .returning();
      blockOfOtherProject = elsewhere!.id;
    });

    it.each([
      [
        'unit',
        unit,
        () => valid.unit(a, { projectId: b.projectId }),
        'unit_project_fk',
      ],
      [
        'block',
        block,
        () => valid.block(a, { projectId: b.projectId }),
        'block_project_fk',
      ],
      [
        'episode project',
        episode,
        () => valid.episode(a, { projectId: b.projectId }),
        'episode_project_fk',
      ],
      [
        'episode block, from another organisation',
        episode,
        () => valid.episode(a, { blockId: blockOfB }),
        'episode_block_fk',
      ],
    ] as const)(
      'rejects a cross-organisation reference on %s',
      async (_label, table, values, constraint) => {
        expect(await failureOf(() => insert(table, values()))).toEqual(
          foreignKey(constraint),
        );
      },
    );

    it('rejects an episode pointing at a block of another project', async () => {
      expect(
        await failureOf(() =>
          insert(episode, valid.episode(a, { blockId: blockOfOtherProject })),
        ),
      ).toEqual(foreignKey('episode_block_fk'));
    });

    it('accepts an episode with no block, and with a block of its own project', async () => {
      const [own] = await database.db
        .insert(block)
        .values(valid.block(a))
        .returning();
      await insert(episode, valid.episode(a));
      await insert(episode, valid.episode(a, { blockId: own!.id }));
      await insert(
        episode,
        valid.episode(a, {
          projectId: a.otherProjectId,
          blockId: blockOfOtherProject,
        }),
      );
    });
  });

  describe('CHECK constraints', () => {
    let s: Seed;

    beforeAll(async () => {
      s = await seedOrganisation(database);
    });

    it('rejects an unknown unit kind', async () => {
      expect(
        await failureOf(() =>
          insert(unit, valid.unit(s, { kind: bad('camera') })),
        ),
      ).toEqual(check('unit_kind_check'));
    });

    it('rejects an unknown episode status', async () => {
      expect(
        await failureOf(() =>
          insert(episode, valid.episode(s, { status: bad('shot') })),
        ),
      ).toEqual(check('episode_status_check'));
    });

    it.each(['main', 'second', 'splinter', 'vfx', 'other'] as const)(
      'accepts the unit kind %s',
      async (kind) => {
        // Use a project of its own so `main` never meets another live main unit.
        const t = await seedOrganisation(database);
        await insert(unit, valid.unit(t, { kind }));
      },
    );

    it.each(['planned', 'in-production', 'delivered'] as const)(
      'accepts the episode status %s',
      async (status) => {
        await insert(episode, valid.episode(s, { status }));
      },
    );
  });

  describe('uniqueness', () => {
    let s: Seed;

    beforeAll(async () => {
      s = await seedOrganisation(database);
    });

    it('rejects a duplicate unit key in one project, and allows it in another', async () => {
      await insert(unit, valid.unit(s, { key: 'b-camera' }));
      expect(
        await failureOf(() => insert(unit, valid.unit(s, { key: 'b-camera' }))),
      ).toEqual(unique('unit_project_key_unique'));
      await insert(
        unit,
        valid.unit(s, { key: 'b-camera', projectId: s.otherProjectId }),
      );
    });

    it('rejects a duplicate block key in one project, and allows it in another', async () => {
      await insert(block, valid.block(s, { key: 'block-a' }));
      expect(
        await failureOf(() =>
          insert(block, valid.block(s, { key: 'block-a' })),
        ),
      ).toEqual(unique('block_project_key_unique'));
      await insert(
        block,
        valid.block(s, { key: 'block-a', projectId: s.otherProjectId }),
      );
    });

    it('rejects a duplicate episode number in one project, and allows it in two projects', async () => {
      await insert(episode, valid.episode(s, { number: '2.05' }));
      expect(
        await failureOf(() =>
          insert(episode, valid.episode(s, { number: '2.05' })),
        ),
      ).toEqual(unique('episode_project_number_unique'));
      await insert(
        episode,
        valid.episode(s, { number: '2.05', projectId: s.otherProjectId }),
      );
    });

    it('treats episode numbers as text, so "101" and "101 " and "1.01" differ', async () => {
      for (const number of ['101', '101 ', '1.01', '0101']) {
        await insert(episode, valid.episode(s, { number }));
      }
    });
  });

  describe('main unit', () => {
    const ctx = (): WriteContext => ({
      actor: { type: 'system', id: null },
      originServer: ORIGIN,
      clock: () => new Date(Date.UTC(2026, 0, 1, 12)),
    });

    it('rejects a second live main unit in a project', async () => {
      const s = await seedOrganisation(database);
      await insert(unit, valid.unit(s, { kind: 'main', key: 'main' }));
      expect(
        await failureOf(() =>
          insert(unit, valid.unit(s, { kind: 'main', key: 'main-2' })),
        ),
      ).toEqual(unique('unit_project_main_unique'));
    });

    it('allows one main unit in each project, and any number of other units', async () => {
      const s = await seedOrganisation(database);
      await insert(unit, valid.unit(s, { kind: 'main' }));
      await insert(
        unit,
        valid.unit(s, { kind: 'main', projectId: s.otherProjectId }),
      );
      await insert(unit, valid.unit(s, { kind: 'second' }));
      await insert(unit, valid.unit(s, { kind: 'second' }));
      await insert(unit, valid.unit(s, { kind: 'vfx' }));
    });

    it('allows a new main unit once the old one is soft-deleted', async () => {
      const s = await seedOrganisation(database);
      const [old] = await database.db
        .insert(unit)
        .values(valid.unit(s, { kind: 'main', key: 'main' }))
        .returning();
      await database.db.transaction((tx) =>
        softDeleteRecord(tx, unit, old!.id, old!.version, ctx()),
      );
      await insert(unit, valid.unit(s, { kind: 'main', key: 'main-new' }));
      // The new one holds the slot again.
      expect(
        await failureOf(() =>
          insert(unit, valid.unit(s, { kind: 'main', key: 'main-third' })),
        ),
      ).toEqual(unique('unit_project_main_unique'));
    });
  });

  describe('project key dates', () => {
    it('are optional, and accept any order', async () => {
      const s = await seedOrganisation(database);
      const [plain] = await database.db
        .select()
        .from(project)
        .where(eq(project.id, s.projectId));
      expect(plain).toMatchObject({
        wrapDate: null,
        deliveryDate: null,
        firstExploitationDate: null,
      });

      // A festival screening before delivery, and delivery before wrap.
      const [dated] = await database.db
        .insert(project)
        .values(
          projectValues(s.organisationId, {
            code: 'DATES',
            wrapDate: '2026-09-01',
            deliveryDate: '2026-06-01',
            firstExploitationDate: '2026-03-01',
          }),
        )
        .returning();
      expect(dated).toMatchObject({
        wrapDate: '2026-09-01',
        deliveryDate: '2026-06-01',
        firstExploitationDate: '2026-03-01',
      });
    });
  });

  describe('createProject', () => {
    const ctx = (): WriteContext => ({
      actor: { type: 'system', id: null },
      originServer: ORIGIN,
      clock: () => new Date(Date.UTC(2026, 0, 1, 12)),
    });

    const newOrganisationId = async () =>
      (await seedOrganisation(database)).organisationId;

    it('creates one project and one main unit, with one change_event each, in the project sequence', async () => {
      const organisationId = await newOrganisationId();
      const created = await database.db.transaction((tx) =>
        createProject(
          tx,
          ctx(),
          projectValues(organisationId, {
            code: 'NEW',
            title: 'The Last Withdrawal (new)',
          }),
        ),
      );

      const projects = await database.db
        .select()
        .from(project)
        .where(
          and(
            eq(project.organisationId, organisationId),
            eq(project.code, 'NEW'),
          ),
        );
      expect(projects.map((p) => p.id)).toEqual([created.project.id]);

      const units = await database.db
        .select()
        .from(unit)
        .where(eq(unit.projectId, created.project.id));
      expect(units).toHaveLength(1);
      expect(units[0]).toMatchObject({
        id: created.mainUnit.id,
        organisationId,
        ownerOrgId: organisationId,
        visibility: created.project.visibility,
        projectId: created.project.id,
        key: 'main',
        name: 'Main unit',
        kind: 'main',
        sortOrder: 0,
        version: 1,
        deletedAt: null,
      });

      const events = await database.db
        .select()
        .from(changeEvent)
        .where(
          and(
            eq(changeEvent.organisationId, organisationId),
            eq(changeEvent.projectId, created.project.id),
          ),
        )
        .orderBy(asc(changeEvent.seq));
      expect(
        events.map((e) => [e.entityType, e.entityId, e.action, e.seq]),
      ).toEqual([
        ['project', created.project.id, 'create', 1],
        ['unit', created.mainUnit.id, 'create', 2],
      ]);
    });

    it.each(['private', 'project', 'shared-with-partners'] as const)(
      'copies the project visibility %s to the main unit',
      async (visibility) => {
        const organisationId = await newOrganisationId();
        const created = await database.db.transaction((tx) =>
          createProject(tx, ctx(), {
            ...projectValues(organisationId, { code: `VIS-${visibility}` }),
            visibility,
          }),
        );
        expect(created.project.visibility).toBe(visibility);
        expect(created.mainUnit.visibility).toBe(visibility);
      },
    );

    it('rolls back both records when the transaction fails', async () => {
      const organisationId = await newOrganisationId();
      const failure = new Error('stop');
      await expect(
        database.db.transaction(async (tx) => {
          await createProject(
            tx,
            ctx(),
            projectValues(organisationId, { code: 'GONE' }),
          );
          throw failure;
        }),
      ).rejects.toBe(failure);
      const left = await database.db
        .select()
        .from(project)
        .where(
          and(
            eq(project.organisationId, organisationId),
            eq(project.code, 'GONE'),
          ),
        );
      expect(left).toEqual([]);
    });

    it('creates no unit when the project is refused', async () => {
      const s = await seedOrganisation(database);
      // The code TLW is taken in this organisation.
      await expect(
        database.db.transaction((tx) =>
          createProject(tx, ctx(), projectValues(s.organisationId)),
        ),
      ).rejects.toMatchObject({
        code: SQLSTATE.uniqueViolation,
        constraint: 'project_organisation_code_unique',
      });
      const units = await database.db
        .select()
        .from(unit)
        .where(eq(unit.organisationId, s.organisationId));
      expect(units).toEqual([]);
    });
  });
});
