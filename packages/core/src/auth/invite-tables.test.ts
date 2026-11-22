import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORIGIN, seedOrganisation } from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import { invite, inviteRole, role } from '../db/schema/index.js';
import {
  createMigratedDatabase,
  failureOf,
  SQLSTATE,
  testTargets,
} from '../db/test-support.js';
import { rowsOf, seedActiveUser } from './test-support.js';

/**
 * The `invite` and `invite_role` tables: what the database itself refuses. The
 * service that writes them comes later; rows are inserted directly, as fixtures
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

describe.each(testTargets)('invite tables on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  let userId: string;
  let a: { organisationId: string; roleId: string };
  let b: { organisationId: string; roleId: string };

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    userId = await seedActiveUser(database);
    const organisation = async () => {
      const { organisationId } = await seedOrganisation(database);
      const [created] = await database.db
        .insert(role)
        .values({
          organisationId,
          ownerOrgId: organisationId,
          originServer: ORIGIN,
          projectId: null,
          key: 'crew',
          name: 'Crew',
        })
        .returning();
      return { organisationId, roleId: created!.id };
    };
    a = await organisation();
    b = await organisation();
  });
  afterAll(async () => {
    await cleanup();
  });

  const db = () => database.db;

  const inviteValues = (
    overrides: Partial<typeof invite.$inferInsert> = {},
  ) => ({
    originServer: ORIGIN,
    organisationId: a.organisationId,
    tokenHash: `invite-hash-${next()}`,
    tier: 'member' as const,
    createdAt: T0,
    createdBy: userId,
    expiresAt: at(7 * DAY),
    ...overrides,
  });

  const made = async (overrides: Partial<typeof invite.$inferInsert> = {}) => {
    const [row] = await db()
      .insert(invite)
      .values(inviteValues(overrides))
      .returning();
    return row!;
  };

  describe('invite', () => {
    it('takes a minimal row: no address, not used, not revoked, and the transient class', async () => {
      const row = await made();
      expect(row).toMatchObject({
        email: null,
        usedAt: null,
        usedBy: null,
        revokedAt: null,
        revokedBy: null,
        retentionClass: 'transient',
        version: 1,
      });
      const [column] = await rowsOf(
        database,
        sql`select column_default from information_schema.columns
            where table_schema = 'public' and table_name = 'invite'
              and column_name = 'retention_class'`,
      );
      expect(column!.column_default).toBe("'transient'::text");
    });

    it('takes every tier but owner, and refuses owner and anything else', async () => {
      for (const tier of ['admin', 'member', 'supervisor', 'guest'] as const) {
        await made({ tier });
      }
      for (const tier of ['owner', 'superuser']) {
        const failure = await failureOf(() =>
          db()
            .insert(invite)
            .values(inviteValues({ tier: tier as never })),
        );
        expect(failure, tier).toEqual(check('invite_tier_check'));
      }
    });

    it('takes an address in the form user.email has, and refuses upper case, white space and no @', async () => {
      await made({ email: 'sam.demo@demopictures.example' });
      for (const email of [
        'Sam.Demo@demopictures.example',
        'sam demo@demopictures.example',
        'sam.demo@demopictures.example\n',
        'sam.demo.demopictures.example',
        '@demopictures.example',
        '',
      ]) {
        const failure = await failureOf(() =>
          db().insert(invite).values(inviteValues({ email })),
        );
        expect(failure, JSON.stringify(email)).toEqual(
          check('invite_email_normalised_check'),
        );
      }
    });

    it('needs used_at and used_by together, and revoked_at and revoked_by together', async () => {
      await made({ usedAt: at(DAY), usedBy: userId });
      await made({ revokedAt: at(DAY), revokedBy: userId });
      for (const overrides of [
        { usedAt: at(DAY) },
        { usedBy: userId },
      ] as const) {
        expect(
          await failureOf(() =>
            db().insert(invite).values(inviteValues(overrides)),
          ),
        ).toEqual(check('invite_used_pair_check'));
      }
      for (const overrides of [
        { revokedAt: at(DAY) },
        { revokedBy: userId },
      ] as const) {
        expect(
          await failureOf(() =>
            db().insert(invite).values(inviteValues(overrides)),
          ),
        ).toEqual(check('invite_revoked_pair_check'));
      }
    });

    it('is never both used and revoked, also when one of the two is set later', async () => {
      expect(
        await failureOf(() =>
          db()
            .insert(invite)
            .values(
              inviteValues({
                usedAt: at(DAY),
                usedBy: userId,
                revokedAt: at(DAY),
                revokedBy: userId,
              }),
            ),
        ),
      ).toEqual(check('invite_not_used_and_revoked_check'));
      const used = await made({ usedAt: at(DAY), usedBy: userId });
      expect(
        await failureOf(() =>
          db()
            .update(invite)
            .set({ revokedAt: at(2 * DAY), revokedBy: userId })
            .where(eq(invite.id, used.id)),
        ),
      ).toEqual(check('invite_not_used_and_revoked_check'));
    });

    it('expires after it is made', async () => {
      for (const expiresAt of [T0, at(-DAY)]) {
        expect(
          await failureOf(() =>
            db().insert(invite).values(inviteValues({ expiresAt })),
          ),
        ).toEqual(check('invite_expiry_check'));
      }
    });

    it('has one row for a token hash, whatever the organisation', async () => {
      const tokenHash = `duplicate-${next()}`;
      await made({ tokenHash });
      for (const organisationId of [a.organisationId, b.organisationId]) {
        expect(
          await failureOf(() =>
            db()
              .insert(invite)
              .values(inviteValues({ tokenHash, organisationId })),
          ),
        ).toEqual(unique('invite_token_hash_unique'));
      }
    });

    it('belongs to an organisation that exists, and names users that exist', async () => {
      expect(
        await failureOf(() =>
          db()
            .insert(invite)
            .values(inviteValues({ organisationId: newId() })),
        ),
      ).toEqual(foreignKey('invite_organisation_fk'));
      expect(
        await failureOf(() =>
          db()
            .insert(invite)
            .values(inviteValues({ usedAt: at(DAY), usedBy: newId() })),
        ),
      ).toEqual(foreignKey('invite_used_by_fk'));
      expect(
        await failureOf(() =>
          db()
            .insert(invite)
            .values(inviteValues({ revokedAt: at(DAY), revokedBy: newId() })),
        ),
      ).toEqual(foreignKey('invite_revoked_by_fk'));
    });
  });

  describe('invite_role', () => {
    it('ties an invite to a role of its own organisation', async () => {
      const row = await made();
      await db().insert(inviteRole).values({
        organisationId: a.organisationId,
        inviteId: row.id,
        roleId: a.roleId,
      });
      expect(
        (await db().select().from(inviteRole)).filter(
          (link) => link.inviteId === row.id,
        ),
      ).toHaveLength(1);
    });

    it('can never attach another organisation’s role to an invite', async () => {
      const row = await made();
      // The row says the organisation of the invite, and the role is another's.
      expect(
        await failureOf(() =>
          db().insert(inviteRole).values({
            organisationId: a.organisationId,
            inviteId: row.id,
            roleId: b.roleId,
          }),
        ),
      ).toEqual(foreignKey('invite_role_role_fk'));
      // The row says the organisation of the role, and the invite is another's.
      expect(
        await failureOf(() =>
          db().insert(inviteRole).values({
            organisationId: b.organisationId,
            inviteId: row.id,
            roleId: b.roleId,
          }),
        ),
      ).toEqual(foreignKey('invite_role_invite_fk'));
    });

    it('attaches a role to an invite once', async () => {
      const row = await made();
      const link = {
        organisationId: a.organisationId,
        inviteId: row.id,
        roleId: a.roleId,
      };
      await db().insert(inviteRole).values(link);
      expect(
        await failureOf(() => db().insert(inviteRole).values(link)),
      ).toEqual(unique('invite_role_pk'));
    });

    it('names an organisation that exists', async () => {
      expect(
        await failureOf(() =>
          db().insert(inviteRole).values({
            organisationId: newId(),
            inviteId: newId(),
            roleId: newId(),
          }),
        ),
      ).toEqual(foreignKey('invite_role_organisation_fk'));
    });

    it('goes with its invite when the invite is deleted', async () => {
      const row = await made();
      await db().insert(inviteRole).values({
        organisationId: a.organisationId,
        inviteId: row.id,
        roleId: a.roleId,
      });
      await db().delete(invite).where(eq(invite.id, row.id));
      expect(
        (await db().select().from(inviteRole)).filter(
          (link) => link.inviteId === row.id,
        ),
      ).toEqual([]);
    });

    it('drops off the invites still waiting when its role is deleted, and leaves the invite', async () => {
      const [doomed] = await db()
        .insert(role)
        .values({
          organisationId: a.organisationId,
          ownerOrgId: a.organisationId,
          originServer: ORIGIN,
          projectId: null,
          key: 'doomed',
          name: 'Doomed',
        })
        .returning();
      const row = await made();
      await db()
        .insert(inviteRole)
        .values([
          {
            organisationId: a.organisationId,
            inviteId: row.id,
            roleId: doomed!.id,
          },
          {
            organisationId: a.organisationId,
            inviteId: row.id,
            roleId: a.roleId,
          },
        ]);
      await db().delete(role).where(eq(role.id, doomed!.id));
      const links = (await db().select().from(inviteRole)).filter(
        (link) => link.inviteId === row.id,
      );
      expect(links.map((link) => link.roleId)).toEqual([a.roleId]);
      expect(
        (await db().select().from(invite)).some((found) => found.id === row.id),
      ).toBe(true);
    });
  });
});
