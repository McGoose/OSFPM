import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { organisationForeignKeyName } from '../db/columns.js';
import { newId } from '../db/ids.js';
import {
  organisation,
  PERSON_SENSITIVE_CATEGORIES,
  person,
  personSensitive,
  user,
} from '../db/schema/index.js';
import { SENSITIVE_CATEGORIES } from './schemas.js';
import { sensitiveColumns } from '../db/sensitive.js';
import {
  createMigratedDatabase,
  failureOf,
  SQLSTATE,
  testTargets,
} from '../db/test-support.js';

type Row = Record<string, unknown>;

async function rows(database: Database, query: ReturnType<typeof sql>) {
  const result = (await database.db.execute(query)) as { rows: Row[] };
  return result.rows;
}

const ORIGIN = newId();
const base = (organisationId: string) => ({
  organisationId,
  ownerOrgId: organisationId,
  originServer: ORIGIN,
});

let counter = 0;

async function seedOrganisation(database: Database) {
  counter += 1;
  const organisationId = newId();
  await database.db.insert(organisation).values({
    id: organisationId,
    organisationId,
    ownerOrgId: organisationId,
    originServer: ORIGIN,
    slug: `sensitive-table-org-${counter}`,
    name: 'Demo Pictures',
    country: 'GB',
    defaultLocale: 'en-GB',
    defaultTimezone: 'Europe/London',
    baseCurrency: 'GBP',
    status: 'active',
  });
  const [u] = await database.db
    .insert(user)
    .values({
      originServer: ORIGIN,
      email: `sensitive.table${counter}@example.test`,
      displayName: 'Demo Staff',
      locale: 'en-GB',
      timezone: 'Europe/London',
      status: 'active',
    })
    .returning();
  const [per] = await database.db
    .insert(person)
    .values({ ...base(organisationId), displayName: 'Alex Demo' })
    .returning();
  return { organisationId, userId: u!.id, personId: per!.id };
}

type Seed = Awaited<ReturnType<typeof seedOrganisation>>;

const valid = (
  s: Seed,
  over: Partial<typeof personSensitive.$inferInsert> = {},
) => ({
  ...base(s.organisationId),
  personId: s.personId,
  category: 'dietary' as const,
  payload: { restrictions: ['vegan'], allergies: [] },
  legalBasis: 'consent' as const,
  enteredByKind: 'self' as const,
  enteredBy: s.userId,
  ...over,
});

const violation = (code: string, constraint: string) => ({ code, constraint });

describe('person_sensitive categories', () => {
  it('match the payload schemas', () => {
    expect([...PERSON_SENSITIVE_CATEGORIES]).toEqual([...SENSITIVE_CATEGORIES]);
  });
});

describe.each(testTargets)('person_sensitive on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  let a: Seed;
  let b: Seed;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    a = await seedOrganisation(database);
    b = await seedOrganisation(database);
  });
  afterAll(async () => {
    await cleanup();
  });

  it('has the standard columns, private visibility and a named organisation FK', async () => {
    const found = await rows(
      database,
      sql`select column_name, column_default, is_nullable
          from information_schema.columns
          where table_schema = 'public' and table_name = 'person_sensitive'`,
    );
    const columns = new Map(found.map((c) => [c.column_name as string, c]));
    for (const name of [
      'id',
      'organisation_id',
      'owner_org_id',
      'origin_server',
      'visibility',
      'version',
      'created_at',
      'updated_at',
      'deleted_at',
      'retention_class',
    ]) {
      expect(columns.has(name), name).toBe(true);
    }
    expect(columns.get('visibility')!.column_default).toBe(`'private'::text`);
    const nullable = (name: string) => columns.get(name)!.is_nullable === 'YES';
    expect(nullable('payload')).toBe(true); // only deleted rows, by CHECK
    expect(nullable('key_id')).toBe(true);
    expect(nullable('consent_recorded_at')).toBe(true);
    expect(nullable('consent_text_version')).toBe(true);
    expect(nullable('last_confirmed_at')).toBe(true);
    expect(nullable('entered_by')).toBe(false);
    expect(nullable('entered_by_kind')).toBe(false);
    expect(nullable('legal_basis')).toBe(false);

    const fks = await rows(
      database,
      sql`select conname from pg_constraint
          where contype = 'f' and conrelid = 'person_sensitive'::regclass
            and confrelid = 'organisation'::regclass`,
    );
    expect(fks.map((f) => f.conname)).toEqual([
      organisationForeignKeyName('person_sensitive'),
    ]);
  });

  it('marks payload, and only payload, as sensitive', () => {
    expect([...sensitiveColumns(personSensitive)]).toEqual(['payload']);
  });

  it('stores a valid row', async () => {
    await database.db.insert(personSensitive).values(valid(a));
  });

  it('rejects a second row for the same person and category', async () => {
    const failure = await failureOf(() =>
      database.db.insert(personSensitive).values(valid(a)),
    );
    expect(failure).toEqual(
      violation(
        SQLSTATE.uniqueViolation,
        'person_sensitive_person_category_unique',
      ),
    );
  });

  it('allows another category for the same person', async () => {
    await database.db
      .insert(personSensitive)
      .values(valid(a, { category: 'medical', payload: { notes: 'x' } }));
  });

  it('rejects an unknown category', async () => {
    const failure = await failureOf(() =>
      database.db
        .insert(personSensitive)
        .values(valid(b, { category: 'religion' as never })),
    );
    expect(failure).toEqual(
      violation(SQLSTATE.checkViolation, 'person_sensitive_category_check'),
    );
  });

  it('rejects an unknown legal basis', async () => {
    const failure = await failureOf(() =>
      database.db
        .insert(personSensitive)
        .values(valid(b, { legalBasis: 'legitimate-interest' as never })),
    );
    expect(failure).toEqual(
      violation(SQLSTATE.checkViolation, 'person_sensitive_legal_basis_check'),
    );
  });

  it('rejects an unknown entered_by_kind', async () => {
    const failure = await failureOf(() =>
      database.db
        .insert(personSensitive)
        .values(valid(b, { enteredByKind: 'system' as never })),
    );
    expect(failure).toEqual(
      violation(
        SQLSTATE.checkViolation,
        'person_sensitive_entered_by_kind_check',
      ),
    );
  });

  it('rejects a person from another organisation', async () => {
    const failure = await failureOf(() =>
      database.db
        .insert(personSensitive)
        .values(valid(a, { personId: b.personId, category: 'financial' })),
    );
    expect(failure).toEqual(
      violation(SQLSTATE.foreignKeyViolation, 'person_sensitive_person_fk'),
    );
  });

  it('rejects an entered_by that is not a user', async () => {
    const failure = await failureOf(() =>
      database.db
        .insert(personSensitive)
        .values(valid(b, { category: 'financial', enteredBy: newId() })),
    );
    expect(failure).toEqual(
      violation(SQLSTATE.foreignKeyViolation, 'person_sensitive_entered_by_fk'),
    );
  });

  it('rejects a null payload on a live row', async () => {
    const failure = await failureOf(() =>
      database.db
        .insert(personSensitive)
        .values(valid(b, { category: 'identity', payload: null })),
    );
    expect(failure).toEqual(
      violation(SQLSTATE.checkViolation, 'person_sensitive_payload_check'),
    );
  });

  it('allows a null payload only on a deleted row', async () => {
    await database.db.insert(personSensitive).values(
      valid(b, {
        category: 'identity',
        payload: null,
        deletedAt: new Date(),
      }),
    );
    const live = await database.db
      .insert(personSensitive)
      .values(valid(b, { category: 'medical' }))
      .returning();
    const failure = await failureOf(() =>
      database.db
        .update(personSensitive)
        .set({ payload: null })
        .where(eq(personSensitive.id, live[0]!.id)),
    );
    expect(failure.constraint).toBe('person_sensitive_payload_check');
  });
});
