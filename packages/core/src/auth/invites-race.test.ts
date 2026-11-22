import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { base, seedUser } from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import { invite, orgMembership, role, user } from '../db/schema/index.js';
import { RecordNotFoundError } from '../db/write.js';
import {
  createMigratedDatabase,
  interleave,
  succeeded,
  testTargets,
} from '../db/test-support.js';
import { completeFirstRunSetup } from './first-run-setup.js';
import { AlreadyMemberError, InviteInvalidError } from './invite-errors.js';
import { acceptInvite, createInvite, revokeInvite } from './invites.js';
import { demoSetupInput, seedFirstRun } from './test-support.js';

const T0 = new Date('2026-03-02T09:00:00.000Z');
const MINUTE = 60 * 1000;
const at = (ms: number) => new Date(T0.getTime() + ms);

/** The PostgreSQL target, when `DATABASE_URL` names a server. PGlite has one connection, so it cannot run this. */
const postgres = testTargets.find((target) => target.name === 'postgres');

/**
 * Invites racing: two accepts of one token, an accept and a revoke of one
 * invite, and one person accepting two invites of one organisation. Each case
 * holds one transaction open after its work while the other starts, and the
 * call waits until the second is blocked on a lock (`interleave`), so the two
 * really overlap and the order is the one the test names. They need two real
 * sessions, so they run on PostgreSQL and are skipped on PGlite.
 *
 * What they pin: an accept makes one membership however many run at once, an
 * invite ends used or revoked and never both, and a membership never exists
 * without a used invite. The invite row lock is what decides an accept against a
 * revoke; the organisation's change counter, taken before it, is what queues two
 * accepts in one organisation (CLAUDE.md, Data rules: counter before any row lock).
 */
describe.skipIf(postgres === undefined)('invites racing, on PostgreSQL', () => {
  let database: Database;
  let cleanup: () => Promise<void>;
  let organisationId: string;
  let adminId: string;
  let crewRoleId: string;
  let counter = 0;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(postgres!));
    const code = await seedFirstRun(database, T0);
    const done = await completeFirstRunSetup(
      database.db,
      demoSetupInput(code),
      T0,
    );
    if (!done.ok) throw new Error('the setup was refused');
    organisationId = done.organisation.id;
    adminId = done.user.id;
    const [crew] = await database.db
      .insert(role)
      .values({
        ...base(organisationId),
        projectId: null,
        key: 'crew',
        name: 'Crew',
      })
      .returning();
    crewRoleId = crew!.id;
  });
  afterAll(async () => {
    await cleanup();
  });

  const db = () => database.db;

  /** A new invite for one role, as the administrator. */
  const make = async () =>
    createInvite(
      db(),
      { userId: adminId },
      organisationId,
      { tier: 'member', roleIds: [crewRoleId] },
      at((10 + (counter += 1)) * MINUTE),
    );

  /** A new account's details, with an address of its own. */
  const newcomer = (name: string) =>
    ({
      kind: 'new-account',
      account: {
        email: `${name}.race@demopictures.example`,
        displayName: name,
      },
    }) as const;

  const inviteRow = async (id: string) =>
    (await db().select().from(invite).where(eq(invite.id, id)))[0]!;
  const usersWith = async (email: string) =>
    (await db().select().from(user)).filter((found) => found.email === email);
  const membershipsOf = async (userId: string) =>
    (await db().select().from(orgMembership)).filter(
      (found) =>
        found.organisationId === organisationId && found.userId === userId,
    );
  const allMemberships = async () =>
    (await db().select().from(orgMembership)).filter(
      (found) => found.organisationId === organisationId,
    );

  it('makes one membership when two accepts of one token overlap, and the second gets the invalid answer', async () => {
    const made = await make();
    const before = (await allMemberships()).length;
    const outcomes = await interleave(
      db(),
      (tx) => acceptInvite(tx, made.token, newcomer('first'), at(100 * MINUTE)),
      (tx) =>
        acceptInvite(tx, made.token, newcomer('second'), at(100 * MINUTE)),
    );
    expect(succeeded(outcomes)).toBe(1);
    expect(outcomes[0].status).toBe('fulfilled');
    expect(outcomes[1]).toMatchObject({ status: 'rejected' });
    expect((outcomes[1] as PromiseRejectedResult).reason).toBeInstanceOf(
      InviteInvalidError,
    );
    expect((await allMemberships()).length).toBe(before + 1);
    // One account was made, the first one's, and the second's was not.
    expect(await usersWith('first.race@demopictures.example')).toHaveLength(1);
    expect(await usersWith('second.race@demopictures.example')).toHaveLength(0);
    const row = await inviteRow(made.invite.id);
    expect(row.usedBy).toBe(
      (await usersWith('first.race@demopictures.example'))[0]!.id,
    );
    expect(row.revokedAt).toBeNull();
  });

  it('makes one membership when many accepts of one token start together', async () => {
    const made = await make();
    const before = (await allMemberships()).length;
    const outcomes = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) =>
        db().transaction((tx) =>
          acceptInvite(
            tx,
            made.token,
            newcomer(`crowd${index}`),
            at(101 * MINUTE),
          ),
        ),
      ),
    );
    expect(succeeded(outcomes)).toBe(1);
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        expect(outcome.reason).toBeInstanceOf(InviteInvalidError);
      }
    }
    expect((await allMemberships()).length).toBe(before + 1);
    const row = await inviteRow(made.invite.id);
    expect(row.usedBy).not.toBeNull();
    expect(row.revokedAt).toBeNull();
  });

  it('ends revoked, with no membership, when a revoke holds the invite and an accept arrives', async () => {
    const made = await make();
    const before = (await allMemberships()).length;
    const outcomes = await interleave(
      db(),
      (tx) =>
        revokeInvite(
          tx,
          { userId: adminId },
          organisationId,
          made.invite.id,
          at(110 * MINUTE),
        ),
      (tx) =>
        acceptInvite(tx, made.token, newcomer('latecomer'), at(110 * MINUTE)),
    );
    expect(outcomes[0].status).toBe('fulfilled');
    expect(outcomes[1]).toMatchObject({ status: 'rejected' });
    // A refusal, not a failure of the database: the invite row lock made the
    // accept wait, and it found the invite revoked.
    expect((outcomes[1] as PromiseRejectedResult).reason).toBeInstanceOf(
      InviteInvalidError,
    );
    const row = await inviteRow(made.invite.id);
    expect(row.revokedAt).not.toBeNull();
    expect(row.usedAt).toBeNull();
    expect(row.usedBy).toBeNull();
    expect((await allMemberships()).length).toBe(before);
    expect(await usersWith('latecomer.race@demopictures.example')).toHaveLength(
      0,
    );
  });

  it('ends used, not revoked, with its membership, when an accept holds the invite and a revoke arrives', async () => {
    const made = await make();
    const before = (await allMemberships()).length;
    const outcomes = await interleave(
      db(),
      (tx) => acceptInvite(tx, made.token, newcomer('early'), at(120 * MINUTE)),
      (tx) =>
        revokeInvite(
          tx,
          { userId: adminId },
          organisationId,
          made.invite.id,
          at(120 * MINUTE),
        ),
    );
    expect(outcomes[0].status).toBe('fulfilled');
    expect(outcomes[1]).toMatchObject({ status: 'rejected' });
    expect((outcomes[1] as PromiseRejectedResult).reason).toBeInstanceOf(
      RecordNotFoundError,
    );
    const row = await inviteRow(made.invite.id);
    expect(row.usedAt).not.toBeNull();
    expect(row.revokedAt).toBeNull();
    expect((await allMemberships()).length).toBe(before + 1);
    const [early] = await usersWith('early.race@demopictures.example');
    expect(row.usedBy).toBe(early!.id);
    expect(await membershipsOf(early!.id)).toHaveLength(1);
  });

  it('never leaves an invite both used and revoked, and never a membership without a used invite, however an accept and a revoke are ordered', async () => {
    for (let round = 0; round < 6; round += 1) {
      const made = await make();
      const before = (await allMemberships()).length;
      const outcomes = await Promise.allSettled([
        db().transaction((tx) =>
          acceptInvite(
            tx,
            made.token,
            newcomer(`mixed${round}`),
            at(130 * MINUTE),
          ),
        ),
        db().transaction((tx) =>
          revokeInvite(
            tx,
            { userId: adminId },
            organisationId,
            made.invite.id,
            at(130 * MINUTE),
          ),
        ),
      ]);
      const row = await inviteRow(made.invite.id);
      // Exactly one of the two won.
      expect(row.usedAt === null, `round ${round}`).not.toBe(
        row.revokedAt === null,
      );
      expect(succeeded(outcomes), `round ${round}`).toBe(1);
      const joined = (await allMemberships()).length - before;
      expect(joined, `round ${round}`).toBe(row.usedAt === null ? 0 : 1);
    }
  });

  it('makes one membership when one person accepts two invites of the organisation at once, and refuses the second as a member already', async () => {
    const userId = await seedUser(database);
    const first = await make();
    const second = await make();
    const outcomes = await interleave(
      db(),
      (tx) =>
        acceptInvite(
          tx,
          first.token,
          { kind: 'signed-in', userId },
          at(140 * MINUTE),
        ),
      (tx) =>
        acceptInvite(
          tx,
          second.token,
          { kind: 'signed-in', userId },
          at(140 * MINUTE),
        ),
    );
    expect(outcomes[0].status).toBe('fulfilled');
    expect(outcomes[1]).toMatchObject({ status: 'rejected' });
    expect((outcomes[1] as PromiseRejectedResult).reason).toBeInstanceOf(
      AlreadyMemberError,
    );
    expect(await membershipsOf(userId)).toHaveLength(1);
    // The second invite was not used up.
    expect((await inviteRow(second.invite.id)).usedAt).toBeNull();
    expect((await inviteRow(first.invite.id)).usedBy).toBe(userId);
  });
});
