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
      'account-lifetime': 'record-created',
    });
    for (const { text } of Object.values(byKey)) {
      expect(text.length).toBeGreaterThan(0);
    }
    // The shipped defaults and the table agree on the list of classes.
    expect(Object.keys(SHIPPED_RETENTION_DEFAULTS).sort()).toEqual(
      found.map((c) => c.key).sort(),
    );
  });

  it('seeds account-lifetime as kept while the account exists, counted from no project date', async () => {
    const found = (await database.db.select().from(retentionClass)).find(
      (c) => c.key === 'account-lifetime',
    );
    expect(found).toEqual({
      key: 'account-lifetime',
      description:
        'Kept while the account exists; deleted with the account or when the person deletes it',
      // The anchor list is fixed and has no "never": record-created is the one
      // that names no project, and the class has no period, so nothing ends it.
      anchor: 'record-created',
    });
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

    it('moves the sessions, login challenges and setup codes written before it off security-log, and leaves a class that was set on purpose', async () => {
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
        const keptSessionId = newId();
        const challengeId = newId();
        const keptChallengeId = newId();
        const setupCodeId = newId();
        const keptSetupCodeId = newId();
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
        // For each table, a row whose class was set on purpose, not left to the
        // default.
        await existing.db.execute(
          sql`insert into session (id, origin_server, user_id, token_hash, method,
                last_seen_at, idle_expires_at, absolute_expires_at, retention_class)
              values (${keptSessionId}, ${origin}, ${userId}, 'upgrade-kept-hash', 'password',
                now(), now() + interval '12 hours', now() + interval '30 days', 'standard')`,
        );
        await existing.db.execute(
          sql`insert into login_challenge (id, origin_server, user_id, kind, token_hash, expires_at)
              values (${challengeId}, ${origin}, ${userId}, 'totp', 'upgrade-challenge-hash',
                now() + interval '5 minutes')`,
        );
        await existing.db.execute(
          sql`insert into
                login_challenge (id, origin_server, user_id, kind, token_hash, expires_at, retention_class)
              values (${keptChallengeId}, ${origin}, ${userId}, 'totp', 'upgrade-kept-challenge-hash',
                now() + interval '5 minutes', 'standard')`,
        );
        await existing.db.execute(
          sql`insert into setup_code (id, origin_server, code_hash, expires_at)
              values (${setupCodeId}, ${origin}, 'upgrade-setup-hash',
                now() + interval '1 day')`,
        );
        // Revoked, so it is not a second live code.
        await existing.db.execute(
          sql`insert into
                setup_code (id, origin_server, code_hash, expires_at, revoked_at, retention_class)
              values (${keptSetupCodeId}, ${origin}, 'upgrade-kept-setup-hash',
                now() + interval '1 day', now(), 'standard')`,
        );

        const classes = async () =>
          Object.fromEntries(
            (
              await rowsOf(
                existing,
                sql`select 'session' as source, retention_class from session
                      where id = ${sessionId}
                    union all
                    select 'kept_session', retention_class from session
                      where id = ${keptSessionId}
                    union all
                    select 'login_challenge', retention_class from login_challenge
                      where id = ${challengeId}
                    union all
                    select 'kept_login_challenge', retention_class from login_challenge
                      where id = ${keptChallengeId}
                    union all
                    select 'setup_code', retention_class from setup_code
                      where id = ${setupCodeId}
                    union all
                    select 'kept_setup_code', retention_class from setup_code
                      where id = ${keptSetupCodeId}`,
              )
            ).map((row) => [
              row.source as string,
              row.retention_class as string,
            ]),
          );
        // The starting point: one row per table under the old default, and
        // one per table set on purpose.
        expect(await classes()).toEqual({
          session: 'security-log',
          kept_session: 'standard',
          login_challenge: 'security-log',
          kept_login_challenge: 'standard',
          setup_code: 'security-log',
          kept_setup_code: 'standard',
        });

        await migrate(existing);
        expect(await classes()).toEqual({
          session: 'transient',
          kept_session: 'standard',
          login_challenge: 'transient',
          kept_login_challenge: 'standard',
          setup_code: 'transient',
          kept_setup_code: 'standard',
        });
      } finally {
        rmSync(folder, { recursive: true, force: true });
        await drop();
      }
    });
  });

  describe('the account-lifetime class on an existing database', () => {
    const ACCOUNT_LIFETIME_MIGRATION = '0036_account_lifetime_retention_class';

    it('moves the access profiles written before it off crew-health, and leaves a class set on purpose and the grants, which stay crew-health', async () => {
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
          (e) => e.tag === ACCOUNT_LIFETIME_MIGRATION,
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

        // Plain SQL, so the rows do not depend on columns added later. A person
        // with an access profile, one whose profile was given another class on
        // purpose, and a grant of the first person's.
        const origin = newId();
        const organisationId = newId();
        const projectId = newId();
        const personId = newId();
        const roleId = newId();
        const userId = newId();
        const otherUserId = newId();
        const profileId = newId();
        const keptProfileId = newId();
        const grantId = newId();
        for (const [id, email] of [
          [userId, 'upgrade.mira@example.test'],
          [otherUserId, 'upgrade.tomas@example.test'],
        ]) {
          await existing.db.execute(
            sql`insert into "user" (id, origin_server, email, display_name, locale, timezone, status)
                values (${id}, ${origin}, ${email}, 'Upgrade User',
                  'en-GB', 'Europe/London', 'active')`,
          );
        }
        await existing.db.execute(
          sql`insert into organisation (id, organisation_id, owner_org_id, origin_server,
                slug, name, country, default_locale, default_timezone, base_currency, status)
              values (${organisationId}, ${organisationId}, ${organisationId}, ${origin},
                'upgrade-org', 'Demo Pictures', 'GB', 'en-GB', 'Europe/London', 'GBP', 'active')`,
        );
        await existing.db.execute(
          sql`insert into project (id, organisation_id, owner_org_id, origin_server,
                code, title, format, status, timezone, locale, currency)
              values (${projectId}, ${organisationId}, ${organisationId}, ${origin},
                'TLW-UP', 'The Last Withdrawal', 'feature', 'development',
                'Europe/London', 'en-GB', 'GBP')`,
        );
        await existing.db.execute(
          sql`insert into person (id, organisation_id, owner_org_id, origin_server, display_name, user_id)
              values (${personId}, ${organisationId}, ${organisationId}, ${origin},
                'Mira Vukovic', ${userId})`,
        );
        await existing.db.execute(
          sql`insert into role (id, origin_server, organisation_id, owner_org_id, key, name)
              values (${roleId}, ${origin}, ${organisationId}, ${organisationId}, 'camera', 'Camera')`,
        );
        await existing.db.execute(
          sql`insert into user_access_profile (id, origin_server, user_id, payload)
              values (${profileId}, ${origin}, ${userId}, '{"stepFreeRequired": true}'::jsonb)`,
        );
        // Set on purpose, not left to the default.
        await existing.db.execute(
          sql`insert into user_access_profile (id, origin_server, user_id, payload, retention_class)
              values (${keptProfileId}, ${origin}, ${otherUserId},
                '{"stepFreeRequired": true}'::jsonb, 'standard')`,
        );
        await existing.db.execute(
          sql`insert into access_grant (id, origin_server, organisation_id, project_id,
                person_id, category, role_id, fields, granted_by, granted_at, on_behalf)
              values (${grantId}, ${origin}, ${organisationId}, ${projectId}, ${personId},
                'accessibility', ${roleId}, array['stepFreeRequired']::text[], ${userId},
                now(), false)`,
        );

        const classes = async () =>
          Object.fromEntries(
            (
              await rowsOf(
                existing,
                sql`select 'profile' as source, retention_class from user_access_profile
                      where id = ${profileId}
                    union all
                    select 'kept_profile', retention_class from user_access_profile
                      where id = ${keptProfileId}
                    union all
                    select 'grant', retention_class from access_grant
                      where id = ${grantId}`,
              )
            ).map((row) => [
              row.source as string,
              row.retention_class as string,
            ]),
          );
        // The starting point: a profile under the old default, one set on
        // purpose, and a grant.
        expect(await classes()).toEqual({
          profile: 'crew-health',
          kept_profile: 'standard',
          grant: 'crew-health',
        });

        await migrate(existing);
        expect(await classes()).toEqual({
          profile: 'account-lifetime',
          kept_profile: 'standard',
          grant: 'crew-health',
        });

        // A profile written after the migration starts in the new class.
        const laterUserId = newId();
        await existing.db.execute(
          sql`insert into "user" (id, origin_server, email, display_name, locale, timezone, status)
              values (${laterUserId}, ${origin}, 'upgrade.later@example.test', 'Upgrade User',
                'en-GB', 'Europe/London', 'active')`,
        );
        const [later] = await rowsOf(
          existing,
          sql`insert into user_access_profile (id, origin_server, user_id, payload)
              values (${newId()}, ${origin}, ${laterUserId}, '{"stepFreeRequired": true}'::jsonb)
              returning retention_class`,
        );
        expect(later).toEqual({ retention_class: 'account-lifetime' });
      } finally {
        rmSync(folder, { recursive: true, force: true });
        await drop();
      }
    });
  });
});
