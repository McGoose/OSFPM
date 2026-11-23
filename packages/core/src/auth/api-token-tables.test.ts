import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  grantOnOrganisation,
  ORIGIN,
  seedOrganisation,
} from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import { apiToken } from '../db/schema/index.js';
import {
  createMigratedDatabase,
  failureOf,
  SQLSTATE,
  testTargets,
} from '../db/test-support.js';
import { rowsOf, seedActiveUser } from './test-support.js';

/**
 * The `api_token` table: what the database itself refuses. The service that writes
 * it is tested in `api-tokens.test.ts`; here rows are inserted directly, as fixtures
 * do (CLAUDE.md, Data rules).
 */

const T0 = new Date('2026-03-02T09:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const at = (ms: number) => new Date(T0.getTime() + ms);

const unique = (constraint: string) => ({
  code: SQLSTATE.uniqueViolation,
  constraint,
});
const check = (constraint: string) => ({
  code: SQLSTATE.checkViolation,
  constraint,
});
const foreignKey = (constraint: string) => ({
  code: SQLSTATE.foreignKeyViolation,
  constraint,
});

let counter = 0;
const next = () => (counter += 1);

describe.each(testTargets)('api_token table on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  let organisationA: string;
  let organisationB: string;
  let projectA: string;
  let projectB: string;
  /** A member of organisation A: the owner of the tokens. */
  let ownerId: string;
  /** A member of organisation B only. */
  let strangerId: string;
  /** Has no membership anywhere. */
  let nobodyId: string;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    const a = await seedOrganisation(database);
    const b = await seedOrganisation(database);
    organisationA = a.organisationId;
    projectA = a.projectId;
    organisationB = b.organisationId;
    projectB = b.projectId;
    ownerId = await seedActiveUser(database);
    strangerId = await seedActiveUser(database);
    nobodyId = await seedActiveUser(database);
    await grantOnOrganisation(database, organisationA, ownerId, 'member', []);
    await grantOnOrganisation(
      database,
      organisationB,
      strangerId,
      'member',
      [],
    );
  });
  afterAll(async () => {
    await cleanup();
  });

  const db = () => database.db;

  afterEach(async () => {
    await db().delete(apiToken);
  });

  const tokenValues = (
    overrides: Partial<typeof apiToken.$inferInsert> = {},
  ) => ({
    originServer: ORIGIN,
    organisationId: organisationA,
    userId: ownerId,
    name: 'Call sheet export',
    prefix: `osfpm_pat_fixture${next()}`,
    tokenHash: `token-hash-${next()}`,
    access: 'read' as const,
    createdAt: T0,
    createdBy: ownerId,
    ...overrides,
  });

  const made = async (
    overrides: Partial<typeof apiToken.$inferInsert> = {},
  ) => {
    const [row] = await db()
      .insert(apiToken)
      .values(tokenValues(overrides))
      .returning();
    return row!;
  };

  it('takes a minimal row: no project, no scope, no expiry, never used, not revoked, and the transient class', async () => {
    const row = await made();
    expect(row).toMatchObject({
      projectId: null,
      sensitivePermissions: [],
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
      revokedBy: null,
      revokeReason: null,
      retentionClass: 'transient',
      version: 1,
    });
    const [column] = await rowsOf(
      database,
      sql`select column_default from information_schema.columns
          where table_schema = 'public' and table_name = 'api_token'
            and column_name = 'retention_class'`,
    );
    expect(column!.column_default).toBe("'transient'::text");
  });

  it('is for a member of the issuing organisation, and for no one else', async () => {
    for (const userId of [strangerId, nobodyId]) {
      expect(
        await failureOf(() =>
          db().insert(apiToken).values(tokenValues({ userId })),
        ),
      ).toEqual(foreignKey('api_token_org_membership_fk'));
    }
    // A member of A named under organisation B is not a member of B.
    expect(
      await failureOf(() =>
        db()
          .insert(apiToken)
          .values(tokenValues({ organisationId: organisationB })),
      ),
    ).toEqual(foreignKey('api_token_org_membership_fk'));
  });

  it('names a user and an organisation that exist', async () => {
    const noUser = await failureOf(() =>
      db()
        .insert(apiToken)
        .values(tokenValues({ userId: newId() })),
    );
    // Both the key to the user and the key to the membership refuse an unknown
    // user; which one the database reports first is not for the test to say.
    expect(noUser?.code).toBe(SQLSTATE.foreignKeyViolation);
    expect(['api_token_user_fk', 'api_token_org_membership_fk']).toContain(
      noUser?.constraint,
    );
    const noOrganisation = await failureOf(() =>
      db()
        .insert(apiToken)
        .values(tokenValues({ organisationId: newId() })),
    );
    expect(noOrganisation?.code).toBe(SQLSTATE.foreignKeyViolation);
    expect([
      'api_token_organisation_fk',
      'api_token_org_membership_fk',
    ]).toContain(noOrganisation?.constraint);
  });

  it('may belong to a project of the same organisation, and to none of another', async () => {
    const own = await made({ projectId: projectA });
    expect(own.projectId).toBe(projectA);
    expect(
      await failureOf(() =>
        db()
          .insert(apiToken)
          .values(tokenValues({ projectId: projectB })),
      ),
    ).toEqual(foreignKey('api_token_project_fk'));
    expect(
      await failureOf(() =>
        db()
          .insert(apiToken)
          .values(tokenValues({ projectId: newId() })),
      ),
    ).toEqual(foreignKey('api_token_project_fk'));
  });

  it('lets one member hold many tokens, in one organisation or two', async () => {
    await made();
    await made();
    await made({ projectId: projectA });
    expect(await db().select().from(apiToken)).toHaveLength(3);
  });

  it('is read or write, and nothing else', async () => {
    await made({ access: 'read' });
    await made({ access: 'write' });
    for (const access of ['admin', 'READ', '']) {
      expect(
        await failureOf(() =>
          db()
            .insert(apiToken)
            .values(tokenValues({ access: access as never })),
        ),
      ).toEqual(check('api_token_access_check'));
    }
  });

  it('has a name of 1 to 100 characters', async () => {
    await made({ name: 'x' });
    await made({ name: 'x'.repeat(100) });
    for (const name of ['', 'x'.repeat(101)]) {
      expect(
        await failureOf(() =>
          db().insert(apiToken).values(tokenValues({ name })),
        ),
      ).toEqual(check('api_token_name_check'));
    }
  });

  it('expires after it is made, or never', async () => {
    expect((await made({ expiresAt: null })).expiresAt).toBeNull();
    expect((await made({ expiresAt: at(DAY) })).expiresAt).toEqual(at(DAY));
    for (const expiresAt of [T0, at(-DAY)]) {
      expect(
        await failureOf(() =>
          db().insert(apiToken).values(tokenValues({ expiresAt })),
        ),
      ).toEqual(check('api_token_expiry_check'));
    }
  });

  it('has one row for a token hash and one for a prefix, whatever the organisation', async () => {
    const first = await made();
    expect(
      await failureOf(() =>
        db()
          .insert(apiToken)
          .values(tokenValues({ tokenHash: first.tokenHash })),
      ),
    ).toEqual(unique('api_token_token_hash_unique'));
    expect(
      await failureOf(() =>
        db()
          .insert(apiToken)
          .values(tokenValues({ prefix: first.prefix })),
      ),
    ).toEqual(unique('api_token_prefix_unique'));
  });

  describe('revoking', () => {
    it('needs revoked_at and revoke_reason together', async () => {
      await made({ revokedAt: at(DAY), revokeReason: 'switch-off' });
      for (const overrides of [
        { revokedAt: at(DAY) },
        { revokeReason: 'switch-off' as const },
      ]) {
        expect(
          await failureOf(() =>
            db().insert(apiToken).values(tokenValues(overrides)),
          ),
        ).toEqual(check('api_token_revoked_pair_check'));
      }
    });

    it('takes one of the four reasons, and no other', async () => {
      for (const revokeReason of [
        'switch-off',
        'access-reset',
        'membership-ended',
      ] as const) {
        const row = await made({ revokedAt: at(DAY), revokeReason });
        expect(row.revokeReason).toBe(revokeReason);
      }
      await made({
        revokedAt: at(DAY),
        revokeReason: 'manual',
        revokedBy: ownerId,
      });
      expect(
        await failureOf(() =>
          db()
            .insert(apiToken)
            .values(
              tokenValues({
                revokedAt: at(DAY),
                revokeReason: 'because' as never,
              }),
            ),
        ),
      ).toEqual(check('api_token_revoke_reason_check'));
    });

    // The three reasons the server itself acts for leave `revoked_by` empty: no
    // person revoked the token (the switch audit, the reset use and the member
    // removal say who and why). A manual revocation names the person.
    it('names a revoker for a manual revocation, may leave it empty for the other three, and never names one on a live token', async () => {
      expect(
        await failureOf(() =>
          db()
            .insert(apiToken)
            .values(
              tokenValues({ revokedAt: at(DAY), revokeReason: 'manual' }),
            ),
        ),
      ).toEqual(check('api_token_manual_revoker_check'));
      for (const revokeReason of [
        'switch-off',
        'access-reset',
        'membership-ended',
      ] as const) {
        const withNobody = await made({ revokedAt: at(DAY), revokeReason });
        expect(withNobody.revokedBy).toBeNull();
        const withSomeone = await made({
          revokedAt: at(DAY),
          revokeReason,
          revokedBy: ownerId,
        });
        expect(withSomeone.revokedBy).toBe(ownerId);
      }
      expect(
        await failureOf(() =>
          db()
            .insert(apiToken)
            .values(tokenValues({ revokedBy: ownerId })),
        ),
      ).toEqual(check('api_token_revoker_check'));
    });

    it('is by a user who exists', async () => {
      expect(
        await failureOf(() =>
          db()
            .insert(apiToken)
            .values(
              tokenValues({
                revokedAt: at(DAY),
                revokeReason: 'manual',
                revokedBy: newId(),
              }),
            ),
        ),
      ).toEqual(foreignKey('api_token_revoked_by_fk'));
    });

    it('can be set later, in one update, as the service does it', async () => {
      const row = await made();
      await db()
        .update(apiToken)
        .set({
          revokedAt: at(DAY),
          revokeReason: 'manual',
          revokedBy: ownerId,
        })
        .where(eq(apiToken.id, row.id));
      // Clearing only the reason of a revoked token is refused: the pair stays whole.
      expect(
        await failureOf(() =>
          db()
            .update(apiToken)
            .set({ revokeReason: null })
            .where(eq(apiToken.id, row.id)),
        ),
      ).toEqual(check('api_token_revoked_pair_check'));
    });
  });

  describe('the sensitive scope', () => {
    it('keeps the permission keys it was given, in order', async () => {
      const row = await made({
        sensitivePermissions: ['sensitive:read:medical', 'costs:read'],
      });
      expect(row.sensitivePermissions).toEqual([
        'sensitive:read:medical',
        'costs:read',
      ]);
    });

    it('refuses the same key twice', async () => {
      expect(
        await failureOf(() =>
          db()
            .insert(apiToken)
            .values(
              tokenValues({
                sensitivePermissions: [
                  'sensitive:read:medical',
                  'sensitive:read:medical',
                ],
              }),
            ),
        ),
      ).toEqual(check('api_token_sensitive_permissions_distinct_check'));
    });

    it('refuses an empty entry in the list too, which is no key', async () => {
      const row = await made();
      expect(
        await failureOf(() =>
          db().execute(
            sql`update api_token set sensitive_permissions = array['a', null]::text[]
                where id = ${row.id}`,
          ),
        ),
      ).toEqual(check('api_token_sensitive_permissions_distinct_check'));
    });

    // The CHECK calls a function the migration writes by hand, because a CHECK
    // cannot hold a subquery: the function holds it.
    it('has that function, which tells a list with a repeat from one without', async () => {
      const [answer] = await rowsOf(
        database,
        sql`select
              osfpm_text_array_is_distinct(array['a', 'b']::text[]) as plain,
              osfpm_text_array_is_distinct(array[]::text[]) as empty,
              osfpm_text_array_is_distinct(array['a', 'a']::text[]) as repeated`,
      );
      expect(answer).toMatchObject({
        plain: true,
        empty: true,
        repeated: false,
      });
    });
  });

  it('keeps one unique key on the token hash and one on the prefix, and no other', async () => {
    const keys = await rowsOf(
      database,
      sql`select conname from pg_constraint
          where conrelid = 'api_token'::regclass and contype = 'u'
          order by conname`,
    );
    expect(keys.map((key) => key.conname)).toEqual([
      'api_token_prefix_unique',
      'api_token_token_hash_unique',
    ]);
  });
});
