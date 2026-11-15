import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedOrganisation } from '../access/test-fixtures.js';
import {
  RETENTION_CLASS_KEYS,
  SHIPPED_RETENTION_DEFAULTS,
} from '../retention/defaults.js';
import type { Database } from './client.js';
import { newId } from './ids.js';
import {
  department,
  organisation,
  project,
  retentionClass,
  unit,
  user,
} from './schema/index.js';
import {
  createMigratedDatabase,
  failureOf,
  SQLSTATE,
  testTargets,
} from './test-support.js';

const ORIGIN = newId();

describe.each(testTargets)('retention classes on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
  });
  afterAll(async () => {
    await cleanup();
  });

  it('seeds the seven classes with their anchors', async () => {
    const found = await database.db.select().from(retentionClass);
    const byKey = Object.fromEntries(
      found.map((c) => [c.key, { anchor: c.anchor, text: c.description }]),
    );
    expect(Object.keys(byKey).sort()).toEqual([...RETENTION_CLASS_KEYS].sort());
    expect(Object.fromEntries(found.map((c) => [c.key, c.anchor]))).toEqual({
      standard: 'project-delivery',
      'financial-record': 'first-exploitation',
      contract: 'first-exploitation',
      'crew-personal': 'project-wrap',
      'crew-health': 'project-wrap',
      'minor-record': 'project-wrap',
      'security-log': 'record-created',
    });
    for (const { text } of Object.values(byKey)) {
      expect(text.length).toBeGreaterThan(0);
    }
    // The shipped defaults and the table agree on the list of classes.
    expect(Object.keys(SHIPPED_RETENTION_DEFAULTS).sort()).toEqual(
      found.map((c) => c.key).sort(),
    );
  });

  it('refuses an anchor outside the fixed list', async () => {
    expect(
      await failureOf(() =>
        database.db.insert(retentionClass).values({
          key: 'odd',
          description: 'Odd',
          anchor: 'whenever' as never,
        }),
      ),
    ).toEqual({
      code: SQLSTATE.checkViolation,
      constraint: 'retention_class_anchor_check',
    });
  });

  it('gives a record the standard class unless told otherwise', async () => {
    const { organisationId } = await seedOrganisation(database);
    const [row] = await database.db
      .insert(department)
      .values({
        organisationId,
        ownerOrgId: organisationId,
        originServer: ORIGIN,
        key: 'sound',
        name: 'Sound',
      })
      .returning();
    expect(row!.retentionClass).toBe('standard');
  });

  it('accepts every seeded class on a record', async () => {
    const { organisationId } = await seedOrganisation(database);
    for (const key of RETENTION_CLASS_KEYS) {
      const [row] = await database.db
        .insert(department)
        .values({
          organisationId,
          ownerOrgId: organisationId,
          originServer: ORIGIN,
          key: `dept-${key}`,
          name: key,
          retentionClass: key,
        })
        .returning();
      expect(row!.retentionClass).toBe(key);
    }
  });

  describe('an unknown class is refused by the foreign key', () => {
    it('on an organisation-level record', async () => {
      const { organisationId } = await seedOrganisation(database);
      expect(
        await failureOf(() =>
          database.db.insert(department).values({
            organisationId,
            ownerOrgId: organisationId,
            originServer: ORIGIN,
            key: 'wardrobe',
            name: 'Wardrobe',
            retentionClass: 'forever',
          }),
        ),
      ).toEqual({
        code: SQLSTATE.foreignKeyViolation,
        constraint: 'department_retention_class_fk',
      });
    });

    it('on a project-level record', async () => {
      const { organisationId, projectId } = await seedOrganisation(database);
      expect(
        await failureOf(() =>
          database.db.insert(unit).values({
            organisationId,
            ownerOrgId: organisationId,
            originServer: ORIGIN,
            projectId,
            key: 'second',
            name: 'Second unit',
            kind: 'second',
            retentionClass: 'forever',
          }),
        ),
      ).toEqual({
        code: SQLSTATE.foreignKeyViolation,
        constraint: 'unit_retention_class_fk',
      });
    });

    it('on the project record itself', async () => {
      const { organisationId } = await seedOrganisation(database);
      expect(
        await failureOf(() =>
          database.db.insert(project).values({
            organisationId,
            ownerOrgId: organisationId,
            originServer: ORIGIN,
            code: 'NEW',
            title: 'The Last Withdrawal II',
            format: 'feature',
            status: 'development',
            timezone: 'Europe/London',
            locale: 'en-GB',
            currency: 'GBP',
            retentionClass: 'forever',
          }),
        ),
      ).toEqual({
        code: SQLSTATE.foreignKeyViolation,
        constraint: 'project_retention_class_fk',
      });
    });

    it('on the organisation record', async () => {
      const id = newId();
      expect(
        await failureOf(() =>
          database.db.insert(organisation).values({
            id,
            organisationId: id,
            ownerOrgId: id,
            originServer: ORIGIN,
            slug: 'retention-org',
            name: 'Demo Pictures',
            country: 'GB',
            defaultLocale: 'en-GB',
            defaultTimezone: 'Europe/London',
            baseCurrency: 'GBP',
            status: 'active',
            retentionClass: 'forever',
          }),
        ),
      ).toEqual({
        code: SQLSTATE.foreignKeyViolation,
        constraint: 'organisation_retention_class_fk',
      });
    });

    it('on an install-level record', async () => {
      expect(
        await failureOf(() =>
          database.db.insert(user).values({
            originServer: ORIGIN,
            email: 'retention.user@example.test',
            displayName: 'Retention User',
            locale: 'en-GB',
            timezone: 'Europe/London',
            status: 'active',
            retentionClass: 'forever',
          }),
        ),
      ).toEqual({
        code: SQLSTATE.foreignKeyViolation,
        constraint: 'user_retention_class_fk',
      });
    });

    it('on an update that changes the class', async () => {
      const { organisationId } = await seedOrganisation(database);
      await database.db.insert(department).values({
        organisationId,
        ownerOrgId: organisationId,
        originServer: ORIGIN,
        key: 'props',
        name: 'Props',
      });
      expect(
        await failureOf(() =>
          database.db.execute(
            sql`update department set retention_class = 'forever'
                  where organisation_id = ${organisationId} and key = 'props'`,
          ),
        ),
      ).toEqual({
        code: SQLSTATE.foreignKeyViolation,
        constraint: 'department_retention_class_fk',
      });
    });
  });

  it('refuses a null class', async () => {
    const { organisationId } = await seedOrganisation(database);
    expect(
      await failureOf(() =>
        database.db.insert(department).values({
          organisationId,
          ownerOrgId: organisationId,
          originServer: ORIGIN,
          key: 'grip',
          name: 'Grip',
          retentionClass: null as never,
        }),
      ),
    ).toMatchObject({ code: '23502' });
  });

  it('refuses to delete a class that a record uses', async () => {
    const { organisationId } = await seedOrganisation(database);
    await database.db.insert(department).values({
      organisationId,
      ownerOrgId: organisationId,
      originServer: ORIGIN,
      key: 'locations',
      name: 'Locations',
      retentionClass: 'minor-record',
    });
    expect(
      await failureOf(() =>
        database.db.execute(
          sql`delete from retention_class where key = 'minor-record'`,
        ),
      ),
    ).toMatchObject({ code: SQLSTATE.foreignKeyViolation });
  });
});
