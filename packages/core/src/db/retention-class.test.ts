import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedOrganisation } from '../access/test-fixtures.js';
import { rowsOf } from '../auth/test-support.js';
import {
  RETENTION_CLASS_KEYS,
  SHIPPED_RETENTION_DEFAULTS,
} from '../retention/defaults.js';
import type { Database } from './client.js';
import { newId } from './ids.js';
import { MIGRATIONS_FOLDER, migrate } from './migrate.js';
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

  it('seeds every class with its anchor', async () => {
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
      transient: 'record-created',
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

  describe('the transient class on an existing database', () => {
    const TRANSIENT_MIGRATION = '0027_transient_retention_class';

    it('moves the sessions and login challenges written before it off security-log, and leaves a setup code there', async () => {
      const { database: existing, cleanup: drop } = await target.create();
      const folder = mkdtempSync(join(tmpdir(), 'osfpm-migrations-'));
      try {
        // Stop one migration short: a copy of the folder whose journal ends
        // before the migration that adds the class.
        cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
        const journalPath = join(folder, 'meta', '_journal.json');
        const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
          entries: { tag: string }[];
        };
        const cut = journal.entries.findIndex(
          (e) => e.tag === TRANSIENT_MIGRATION,
        );
        expect(cut).toBeGreaterThan(0);
        writeFileSync(
          journalPath,
          JSON.stringify({
            ...journal,
            entries: journal.entries.slice(0, cut),
          }),
        );
        await migrate(existing, folder);

        // Plain SQL, so the rows do not depend on columns added later.
        const userId = newId();
        const sessionId = newId();
        const challengeId = newId();
        const setupCodeId = newId();
        const origin = newId();
        await existing.db.execute(
          sql`insert into "user" (id, origin_server, email, display_name, locale, timezone, status)
              values (${userId}, ${origin}, 'upgrade.user@example.test', 'Upgrade User',
                'en-GB', 'Europe/London', 'active')`,
        );
        await existing.db.execute(
          sql`insert into session (id, origin_server, user_id, token_hash, method,
                last_seen_at, idle_expires_at, absolute_expires_at)
              values (${sessionId}, ${origin}, ${userId}, 'upgrade-session-hash', 'password',
                now(), now() + interval '12 hours', now() + interval '30 days')`,
        );
        await existing.db.execute(
          sql`insert into login_challenge (id, origin_server, user_id, kind, token_hash, expires_at)
              values (${challengeId}, ${origin}, ${userId}, 'totp', 'upgrade-challenge-hash',
                now() + interval '5 minutes')`,
        );
        await existing.db.execute(
          sql`insert into setup_code (id, origin_server, code_hash, expires_at)
              values (${setupCodeId}, ${origin}, 'upgrade-setup-hash',
                now() + interval '1 day')`,
        );

        const classes = async () =>
          Object.fromEntries(
            (
              await rowsOf(
                existing,
                sql`select 'session' as source, retention_class from session
                      where id = ${sessionId}
                    union all
                    select 'login_challenge', retention_class from login_challenge
                      where id = ${challengeId}
                    union all
                    select 'setup_code', retention_class from setup_code
                      where id = ${setupCodeId}`,
              )
            ).map((row) => [
              row.source as string,
              row.retention_class as string,
            ]),
          );
        // The starting point: all three were written under the old default.
        expect(await classes()).toEqual({
          session: 'security-log',
          login_challenge: 'security-log',
          setup_code: 'security-log',
        });

        await migrate(existing);
        expect(await classes()).toEqual({
          session: 'transient',
          login_challenge: 'transient',
          setup_code: 'security-log',
        });
      } finally {
        rmSync(folder, { recursive: true, force: true });
        await drop();
      }
    });
  });
});
