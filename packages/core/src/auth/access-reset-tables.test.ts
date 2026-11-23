import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  grantOnOrganisation,
  ORIGIN,
  seedOrganisation,
} from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import { accessReset } from '../db/schema/index.js';
import {
  createMigratedDatabase,
  failureOf,
  SQLSTATE,
  testTargets,
} from '../db/test-support.js';
import { rowsOf, seedActiveUser } from './test-support.js';

/**
 * The `access_reset` table: what the database itself refuses. The service that
 * writes it is tested in `access-reset.test.ts`; here rows are inserted directly,
 * as fixtures do (CLAUDE.md, Data rules).
 */

const T0 = new Date('2026-03-02T09:00:00.000Z');
const HOUR = 60 * 60 * 1000;
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

describe.each(testTargets)('access_reset table on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  let organisationA: string;
  let organisationB: string;
  /** Creates the links. A member of organisation A. */
  let adminId: string;
  /** The person a link is for. A member of organisation A. */
  let memberId: string;
  /** A member of organisation B only. */
  let strangerId: string;
  /** Has no membership anywhere. */
  let nobodyId: string;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    organisationA = (await seedOrganisation(database)).organisationId;
    organisationB = (await seedOrganisation(database)).organisationId;
    adminId = await seedActiveUser(database);
    memberId = await seedActiveUser(database);
    strangerId = await seedActiveUser(database);
    nobodyId = await seedActiveUser(database);
    await grantOnOrganisation(database, organisationA, adminId, 'admin', []);
    await grantOnOrganisation(database, organisationA, memberId, 'member', []);
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

  // Only one row per member may be live, so a test that leaves one behind would
  // stop the next from making its own. A fixture may delete what it inserted.
  afterEach(async () => {
    await db().delete(accessReset);
  });

  const resetValues = (
    overrides: Partial<typeof accessReset.$inferInsert> = {},
  ) => ({
    originServer: ORIGIN,
    organisationId: organisationA,
    userId: memberId,
    tokenHash: `reset-hash-${next()}`,
    createdAt: T0,
    createdBy: adminId,
    expiresAt: at(24 * HOUR),
    ...overrides,
  });

  const made = async (
    overrides: Partial<typeof accessReset.$inferInsert> = {},
  ) => {
    const [row] = await db()
      .insert(accessReset)
      .values(resetValues(overrides))
      .returning();
    return row!;
  };

  it('takes a minimal row: passkeys kept, not used, not revoked, and the transient class', async () => {
    const row = await made();
    expect(row).toMatchObject({
      removePasskeys: false,
      usedAt: null,
      revokedAt: null,
      revokedBy: null,
      retentionClass: 'transient',
      version: 1,
    });
    const [column] = await rowsOf(
      database,
      sql`select column_default from information_schema.columns
          where table_schema = 'public' and table_name = 'access_reset'
            and column_name = 'retention_class'`,
    );
    expect(column!.column_default).toBe("'transient'::text");
  });

  it('is for a member of the issuing organisation, and for no one else', async () => {
    // Someone who belongs to another organisation only, and someone who belongs
    // to none: the composite key to org_membership refuses both.
    for (const userId of [strangerId, nobodyId]) {
      expect(
        await failureOf(() =>
          db().insert(accessReset).values(resetValues({ userId })),
        ),
      ).toEqual(foreignKey('access_reset_org_membership_fk'));
    }
    // A member of A named under organisation B is not a member of B.
    expect(
      await failureOf(() =>
        db()
          .insert(accessReset)
          .values(resetValues({ organisationId: organisationB })),
      ),
    ).toEqual(foreignKey('access_reset_org_membership_fk'));
  });

  it('names a user and an organisation that exist', async () => {
    const failure = await failureOf(() =>
      db()
        .insert(accessReset)
        .values(resetValues({ userId: newId() })),
    );
    // Both the key to the user and the key to the membership refuse an unknown
    // user; which one the database reports first is not for the test to say.
    expect(failure?.code).toBe(SQLSTATE.foreignKeyViolation);
    expect([
      'access_reset_user_fk',
      'access_reset_org_membership_fk',
    ]).toContain(failure?.constraint);
    const noOrganisation = await failureOf(() =>
      db()
        .insert(accessReset)
        .values(resetValues({ organisationId: newId() })),
    );
    expect(noOrganisation?.code).toBe(SQLSTATE.foreignKeyViolation);
    expect([
      'access_reset_organisation_fk',
      'access_reset_org_membership_fk',
    ]).toContain(noOrganisation?.constraint);
  });

  it('is made by a user who exists, and never by the person it is for', async () => {
    expect(
      await failureOf(() =>
        db()
          .insert(accessReset)
          .values(resetValues({ createdBy: newId() })),
      ),
    ).toEqual(foreignKey('access_reset_created_by_user_id_fk'));
    expect(
      await failureOf(() =>
        db()
          .insert(accessReset)
          .values(resetValues({ createdBy: memberId })),
      ),
    ).toEqual(check('access_reset_not_self_check'));
  });

  it('needs revoked_at and revoked_by together, and a revoker who exists', async () => {
    await made({ revokedAt: at(HOUR), revokedBy: adminId });
    for (const overrides of [
      { revokedAt: at(HOUR) },
      { revokedBy: adminId },
    ] as const) {
      expect(
        await failureOf(() =>
          db().insert(accessReset).values(resetValues(overrides)),
        ),
      ).toEqual(check('access_reset_revoked_pair_check'));
    }
    expect(
      await failureOf(() =>
        db()
          .insert(accessReset)
          .values(resetValues({ revokedAt: at(HOUR), revokedBy: newId() })),
      ),
    ).toEqual(foreignKey('access_reset_revoked_by_fk'));
  });

  it('is never both used and revoked, also when one of the two is set later', async () => {
    expect(
      await failureOf(() =>
        db()
          .insert(accessReset)
          .values(
            resetValues({
              usedAt: at(HOUR),
              revokedAt: at(HOUR),
              revokedBy: adminId,
            }),
          ),
      ),
    ).toEqual(check('access_reset_not_used_and_revoked_check'));
    const used = await made({ usedAt: at(HOUR) });
    expect(
      await failureOf(() =>
        db()
          .update(accessReset)
          .set({ revokedAt: at(2 * HOUR), revokedBy: adminId })
          .where(eq(accessReset.id, used.id)),
      ),
    ).toEqual(check('access_reset_not_used_and_revoked_check'));
    const revoked = await made({ revokedAt: at(HOUR), revokedBy: adminId });
    expect(
      await failureOf(() =>
        db()
          .update(accessReset)
          .set({ usedAt: at(2 * HOUR) })
          .where(eq(accessReset.id, revoked.id)),
      ),
    ).toEqual(check('access_reset_not_used_and_revoked_check'));
  });

  it('expires after it is made', async () => {
    for (const expiresAt of [T0, at(-HOUR)]) {
      expect(
        await failureOf(() =>
          db().insert(accessReset).values(resetValues({ expiresAt })),
        ),
      ).toEqual(check('access_reset_expiry_check'));
    }
  });

  it('has one row for a token hash, whatever the organisation', async () => {
    const tokenHash = `duplicate-${next()}`;
    // Used, so the row is not also the one live row, which would make the
    // database free to report either key first.
    await made({ tokenHash, usedAt: at(HOUR) });
    expect(
      await failureOf(() =>
        db()
          .insert(accessReset)
          .values(resetValues({ tokenHash, usedAt: at(2 * HOUR) })),
      ),
    ).toEqual(unique('access_reset_token_hash_unique'));
  });

  it('keeps the unique key on organisation and id that a later table can point at', async () => {
    const keys = await rowsOf(
      database,
      sql`select conname from pg_constraint
          where conrelid = 'access_reset'::regclass and contype = 'u'
          order by conname`,
    );
    expect(keys.map((key) => key.conname)).toEqual([
      'access_reset_organisation_id_id_unique',
      'access_reset_token_hash_unique',
    ]);
  });

  describe('one live link per member per organisation', () => {
    it('is a partial unique index on organisation and member, for rows neither used nor revoked', async () => {
      const [index] = await rowsOf(
        database,
        sql`select indexdef from pg_indexes
            where tablename = 'access_reset' and indexname = 'access_reset_live_unique'`,
      );
      expect(index?.indexdef).toContain('UNIQUE');
      expect(index?.indexdef).toContain('(organisation_id, user_id)');
      expect(index?.indexdef).toContain('used_at IS NULL');
      expect(index?.indexdef).toContain('revoked_at IS NULL');
    });

    it('refuses a second row that is neither used nor revoked, whatever its expiry', async () => {
      await made();
      for (const expiresAt of [at(HOUR), at(72 * HOUR)]) {
        expect(
          await failureOf(() =>
            db().insert(accessReset).values(resetValues({ expiresAt })),
          ),
        ).toEqual(unique('access_reset_live_unique'));
      }
    });

    it('frees the place when the live row is used or revoked, and allows any number of those', async () => {
      const first = await made();
      await db()
        .update(accessReset)
        .set({ usedAt: at(HOUR) })
        .where(eq(accessReset.id, first.id));
      const second = await made();
      await db()
        .update(accessReset)
        .set({ revokedAt: at(2 * HOUR), revokedBy: adminId })
        .where(eq(accessReset.id, second.id));
      await made({ usedAt: at(HOUR) });
      await made({ usedAt: at(2 * HOUR) });
      await made({ revokedAt: at(HOUR), revokedBy: adminId });
      await made({ revokedAt: at(2 * HOUR), revokedBy: adminId });
      const live = await made();
      expect(live.usedAt).toBeNull();
      expect(
        (await db().select().from(accessReset)).filter(
          (row) => row.usedAt === null && row.revokedAt === null,
        ),
      ).toHaveLength(1);
    });

    it('is per member: another member of the organisation has a live row of their own', async () => {
      const colleagueId = await seedActiveUser(database);
      await grantOnOrganisation(
        database,
        organisationA,
        colleagueId,
        'member',
        [],
      );
      await made();
      await made({ userId: colleagueId });
      // The same member is still refused a second.
      expect(
        await failureOf(() =>
          db()
            .insert(accessReset)
            .values(resetValues({ userId: colleagueId })),
        ),
      ).toEqual(unique('access_reset_live_unique'));
    });
  });
});
