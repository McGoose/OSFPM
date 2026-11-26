import { eq } from 'drizzle-orm';
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
import { seedActiveUser } from './test-support.js';

/**
 * The two columns that say who issued and who revoked a reset link, and the checks
 * that keep them honest (P-09a2, decision D-81): a link is made by a person
 * (`created_by`) or by the system (`issued_by_system`, the admin command line), and is
 * revoked by a person (`revoked_by`) or by the system (`revoked_by_system`), never
 * both and never neither. The rest of the table is tested in `access-reset-tables.test.ts`;
 * here rows are inserted directly, as fixtures do (CLAUDE.md, Data rules).
 */

const T0 = new Date('2026-03-02T09:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const at = (ms: number) => new Date(T0.getTime() + ms);

const check = (constraint: string) => ({
  code: SQLSTATE.checkViolation,
  constraint,
});

let counter = 0;
const next = () => (counter += 1);

describe.each(testTargets)(
  'who issued and who revoked a reset link, on $name',
  (target) => {
    let database: Database;
    let cleanup: () => Promise<void>;
    let organisationId: string;
    /** A person who makes and revokes links. A member of the organisation. */
    let adminId: string;
    /** The person a link is for. A member of the organisation. */
    let memberId: string;

    beforeAll(async () => {
      ({ database, cleanup } = await createMigratedDatabase(target));
      organisationId = (await seedOrganisation(database)).organisationId;
      adminId = await seedActiveUser(database);
      memberId = await seedActiveUser(database);
      await grantOnOrganisation(database, organisationId, adminId, 'admin', []);
      await grantOnOrganisation(
        database,
        organisationId,
        memberId,
        'member',
        [],
      );
    });
    afterAll(async () => {
      await cleanup();
    });
    // One live link per member, so a test that leaves one would stop the next.
    afterEach(async () => {
      await database.db.delete(accessReset);
    });

    const db = () => database.db;

    const resetValues = (
      overrides: Partial<typeof accessReset.$inferInsert> = {},
    ) => ({
      originServer: ORIGIN,
      organisationId,
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

    describe('who issued the link', () => {
      it('is a person unless the row says otherwise: issued_by_system is false by default', async () => {
        const row = await made();
        expect(row).toMatchObject({
          createdBy: adminId,
          issuedBySystem: false,
          revokedBySystem: false,
        });
      });

      it('is the system when there is no creator and the row says so', async () => {
        const row = await made({
          createdBy: null,
          updatedBy: null,
          issuedBySystem: true,
        });
        expect(row).toMatchObject({
          createdBy: null,
          updatedBy: null,
          issuedBySystem: true,
        });
      });

      // The four combinations of "has a creator" and "says the system issued it".
      it.each([
        ['a creator, not the system', 'creator', false, true],
        ['no creator, the system', 'nobody', true, true],
        ['a creator, and the system', 'creator', true, false],
        ['no creator, and not the system', 'nobody', false, false],
      ] as const)(
        'with %s: %s',
        async (_name, creator, issuedBySystem, allowed) => {
          const insert = () =>
            db()
              .insert(accessReset)
              .values(
                resetValues({
                  createdBy: creator === 'creator' ? adminId : null,
                  issuedBySystem,
                }),
              );
          if (allowed) {
            await insert();
          } else {
            expect(await failureOf(insert)).toEqual(
              check('access_reset_issuer_check'),
            );
          }
        },
      );

      it('cannot be changed into a contradiction later', async () => {
        const byPerson = await made();
        expect(
          await failureOf(() =>
            db()
              .update(accessReset)
              .set({ issuedBySystem: true })
              .where(eq(accessReset.id, byPerson.id)),
          ),
        ).toEqual(check('access_reset_issuer_check'));
        const bySystem = await made({
          userId: memberId,
          createdBy: null,
          issuedBySystem: true,
          usedAt: at(HOUR),
        });
        expect(
          await failureOf(() =>
            db()
              .update(accessReset)
              .set({ issuedBySystem: false })
              .where(eq(accessReset.id, bySystem.id)),
          ),
        ).toEqual(check('access_reset_issuer_check'));
      });

      it('still never lets a person reset themselves: a creator is checked as before', async () => {
        expect(
          await failureOf(() =>
            db()
              .insert(accessReset)
              .values(resetValues({ createdBy: memberId })),
          ),
        ).toEqual(check('access_reset_not_self_check'));
      });
    });

    describe('who revoked the link', () => {
      type Revocation = {
        readonly revokedAt: Date | null;
        readonly revokedBy: 'person' | null;
        readonly revokedBySystem: boolean;
      };
      const revoke = (revokedAt: boolean, by: boolean, system: boolean) =>
        ({
          revokedAt: revokedAt ? at(HOUR) : null,
          revokedBy: by ? ('person' as const) : null,
          revokedBySystem: system,
        }) satisfies Revocation;

      // Every combination of revoked_at, revoked_by and revoked_by_system. A link
      // that is not revoked names no revoker; a revoked one names exactly one.
      it.each([
        ['not revoked, nobody named', revoke(false, false, false), 'allowed'],
        ['revoked by a person', revoke(true, true, false), 'allowed'],
        ['revoked by the system', revoke(true, false, true), 'allowed'],
        [
          'revoked, nobody named',
          revoke(true, false, false),
          'access_reset_revoked_pair_check',
        ],
        [
          'not revoked, but a person is named',
          revoke(false, true, false),
          'access_reset_revoked_pair_check',
        ],
        [
          'not revoked, but the system is named',
          revoke(false, false, true),
          'access_reset_revoked_pair_check',
        ],
        [
          'revoked by a person and by the system',
          revoke(true, true, true),
          'access_reset_revoker_one_check',
        ],
      ] as const)('%s', async (_name, revocation, outcome) => {
        const insert = () =>
          db()
            .insert(accessReset)
            .values(
              resetValues({
                revokedAt: revocation.revokedAt,
                revokedBy: revocation.revokedBy === null ? null : adminId,
                revokedBySystem: revocation.revokedBySystem,
              }),
            );
        if (outcome === 'allowed') {
          await insert();
        } else {
          expect(await failureOf(insert)).toEqual(check(outcome));
        }
      });

      it('refuses a link that is not revoked and names both a person and the system, whichever check the database reports first', async () => {
        const failure = await failureOf(() =>
          db()
            .insert(accessReset)
            .values(resetValues({ revokedBy: adminId, revokedBySystem: true })),
        );
        expect(failure?.code).toBe(SQLSTATE.checkViolation);
        expect([
          'access_reset_revoked_pair_check',
          'access_reset_revoker_one_check',
        ]).toContain(failure?.constraint);
      });

      it('is set in one update, as the service does it, and never left half done', async () => {
        const row = await made();
        await db()
          .update(accessReset)
          .set({
            revokedAt: at(HOUR),
            revokedBy: null,
            revokedBySystem: true,
          })
          .where(eq(accessReset.id, row.id));
        const [revoked] = await db()
          .select()
          .from(accessReset)
          .where(eq(accessReset.id, row.id));
        expect(revoked).toMatchObject({
          revokedBy: null,
          revokedBySystem: true,
        });
        // Taking the system flag away alone would leave a revoked link with no revoker.
        expect(
          await failureOf(() =>
            db()
              .update(accessReset)
              .set({ revokedBySystem: false })
              .where(eq(accessReset.id, row.id)),
          ),
        ).toEqual(check('access_reset_revoked_pair_check'));
      });

      it('frees the live place, as a revocation by a person does', async () => {
        const first = await made();
        await db()
          .update(accessReset)
          .set({ revokedAt: at(HOUR), revokedBySystem: true })
          .where(eq(accessReset.id, first.id));
        const second = await made();
        expect(second.revokedAt).toBeNull();
        expect(
          (await db().select().from(accessReset)).filter(
            (row) => row.usedAt === null && row.revokedAt === null,
          ),
        ).toHaveLength(1);
      });

      it('still names a revoker who exists', async () => {
        const failure = await failureOf(() =>
          db()
            .insert(accessReset)
            .values(resetValues({ revokedAt: at(HOUR), revokedBy: newId() })),
        );
        expect(failure).toEqual({
          code: SQLSTATE.foreignKeyViolation,
          constraint: 'access_reset_revoked_by_fk',
        });
      });
    });
  },
);
