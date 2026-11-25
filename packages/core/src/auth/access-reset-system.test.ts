import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORIGIN, seedUser } from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import {
  accessReset,
  apiToken,
  auditEvent,
  changeEvent,
  orgMembership,
  passkeyCredential,
  passwordCredential,
  recoveryCode,
  session,
  totpCredential,
  type OrgRole,
} from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import {
  AccessResetInvalidError,
  type AccessResetRefusalReason,
} from './access-reset-errors.js';
import {
  ACCESS_RESET_LIFETIME,
  createAccessReset,
  createSystemAccessReset,
  inspectAccessReset,
  useAccessReset,
  type CreateAccessResetInput,
} from './access-reset.js';
import { AuthInputError } from './errors.js';
import { generateRecoveryCodes } from './recovery.js';
import { createSession, revokeSession } from './sessions.js';
import { AUTH_AUDIT } from './shared.js';
import {
  everyRowAsText,
  markUserDeleted,
  seedApiToken,
  seedMembership,
  seedOrganisationRole,
  seedPasskey,
  seedPassword,
  seedResetScene,
  seedTotp,
  setMemberRolesEnded,
  setMembershipStatus,
  setMembershipTier,
  setUserStatus,
  type ResetScene,
} from './test-support.js';
import { hashToken } from './tokens.js';
import { useTestServerKeys } from '../keys/test-support.js';

/** The server keys of this test file, in a key directory that is deleted afterwards. */
const serverKeys = useTestServerKeys();

/**
 * Reset links that the system issues (P-09a2, decision D-81): the emergency access of
 * the admin command line. Same table, same lock order and same use as a link an
 * administrator makes, but with its own rule set (`checkSystemRules`): the person is
 * an active user with an active membership, and is an owner or holds the
 * organisation's managed Administrator role. Checked when the link is made, when it
 * is inspected and again when it is used. The links people make are in
 * `access-reset.test.ts` and `access-reset-use.test.ts`, which this file leaves as
 * they are.
 */

const T0 = new Date('2026-03-02T09:00:00.000Z');
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const at = (ms: number) => new Date(T0.getTime() + ms);

/** An invented password the locked-out people had. */
const OLD_PASSWORD = 'meadow-lantern-slow-river';

describe.each(testTargets)(
  'reset links issued by the system on $name',
  (target) => {
    let database: Database;
    let cleanup: () => Promise<void>;
    let scene: ResetScene;

    beforeAll(async () => {
      ({ database, cleanup } = await createMigratedDatabase(target));
      scene = await seedResetScene(database, T0);
    });
    afterAll(async () => {
      await cleanup();
    });

    const db = () => database.db;

    /** A member of the organisation, `tier` with the roles given. */
    const member = async (
      tier: OrgRole,
      roleIds: readonly string[],
      options: {
        status?: 'active' | 'invited' | 'removed';
        deleted?: boolean;
      } = {},
    ) => {
      const userId = await seedUser(database);
      await seedMembership(
        database,
        scene.organisationId,
        userId,
        tier,
        roleIds,
        options,
      );
      return userId;
    };

    /** An administrator who is not an owner: tier `admin` with the Administrator role. */
    const administrator = () => member('admin', [scene.roles.administrator]);

    let clock = 100;
    /** What `createSystemAccessReset` answers for `userId`, a minute after the last call. */
    const system = async (
      userId: string,
      input: CreateAccessResetInput = {},
      organisationId: string = scene.organisationId,
    ) => {
      const when = at((clock += 1) * MINUTE);
      const result = await createSystemAccessReset(
        db(),
        organisationId,
        userId,
        input,
        when,
      );
      return { result, when };
    };
    /** A link the system made, which must have been made. */
    const issued = async (
      userId: string,
      input: CreateAccessResetInput = {},
    ) => {
      const { result, when } = await system(userId, input);
      if (!result.ok) throw new Error(`refused: ${result.reason}`);
      return { ...result, when };
    };
    /** A link `actorId` made for `userId`. */
    const byPerson = async (
      actorId: string,
      userId: string,
      input: CreateAccessResetInput = {},
    ) => {
      const when = at((clock += 1) * MINUTE);
      const made = await createAccessReset(
        db(),
        { userId: actorId },
        scene.organisationId,
        userId,
        input,
        when,
      );
      return { ...made, when };
    };

    /** The events of one category in the order they were written: ids are UUIDv7. */
    const audits = async (category: string) =>
      (await db().select().from(auditEvent))
        .filter((event) => event.category === category)
        .sort((a, b) => a.id.localeCompare(b.id));
    const row = async (id: string) =>
      (await db().select().from(accessReset).where(eq(accessReset.id, id)))[0]!;
    const linksOf = async (userId: string) =>
      (await db().select().from(accessReset)).filter(
        (found) => found.userId === userId,
      );
    const liveLinksOf = async (userId: string) =>
      (await linksOf(userId)).filter(
        (found) => found.usedAt === null && found.revokedAt === null,
      );

    const rejection = async (promise: Promise<unknown>) => {
      try {
        await promise;
      } catch (error) {
        return error;
      }
      throw new Error('Expected the call to be refused, but it succeeded');
    };

    /** Everything a refused call must leave alone: the links and the events. */
    const everythingWritten = async () =>
      JSON.stringify([
        await db().select().from(accessReset),
        await db().select().from(auditEvent),
      ]);

    describe('making one', () => {
      it('makes a link for an owner with no creator, issued by the system, and returns it with its token once', async () => {
        const { reset, token, when } = await issued(scene.ownerId);

        expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(reset).toMatchObject({
          organisationId: scene.organisationId,
          userId: scene.ownerId,
          removePasskeys: false,
          createdBy: null,
          issuedBySystem: true,
        });
        expect(reset.expiresAt.getTime() - when.getTime()).toBe(
          ACCESS_RESET_LIFETIME.defaultHours * HOUR,
        );
        const stored = await row(reset.id);
        expect(stored).toMatchObject({
          createdBy: null,
          updatedBy: null,
          issuedBySystem: true,
          revokedBySystem: false,
          tokenHash: hashToken(token),
        });
        // The view has no hash and no token.
        expect(Object.keys(reset)).not.toContain('tokenHash');
      });

      it('lasts the hours asked for, from 1 to 72, and refuses any other number without writing anything', async () => {
        const person = await administrator();
        for (const hours of [1, 2, 72]) {
          const { reset, when } = await issued(person, {
            expiresInHours: hours,
          });
          expect(reset.expiresAt.getTime() - when.getTime()).toBe(hours * HOUR);
        }
        const before = await everythingWritten();
        for (const value of [0, 73, 1.5, -1, Number.NaN, '2' as never]) {
          const error = await rejection(
            system(person, { expiresInHours: value }),
          );
          expect(error, String(value)).toBeInstanceOf(AuthInputError);
          expect((error as AuthInputError).field).toBe('expiresInHours');
        }
        expect(await everythingWritten()).toBe(before);
      });

      it('remembers whether using the link also revokes the passkeys', async () => {
        const person = await administrator();
        const kept = await issued(person);
        const removed = await issued(person, { removePasskeys: true });
        expect(kept.reset.removePasskeys).toBe(false);
        expect(removed.reset.removePasskeys).toBe(true);
        expect((await row(removed.reset.id)).removePasskeys).toBe(true);
        const error = await rejection(
          system(person, { removePasskeys: 'yes' as never }),
        );
        expect((error as AuthInputError).field).toBe('removePasskeys');
      });

      it('audits it once, from the system, with the link, the person and that the system issued it, and never the token', async () => {
        const before = (await audits(AUTH_AUDIT.accessResetCreated)).length;
        const person = await administrator();
        const { reset, token } = await issued(person, {
          expiresInHours: 2,
          removePasskeys: true,
        });

        const events = (await audits(AUTH_AUDIT.accessResetCreated)).slice(
          before,
        );
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          action: 'create',
          actorType: 'system',
          actorId: null,
          targetType: 'access_reset',
          targetId: reset.id,
          organisationId: scene.organisationId,
          details: {
            userId: person,
            expiresAt: reset.expiresAt.toISOString(),
            removePasskeys: true,
            issuedBySystem: true,
          },
        });
        expect(
          JSON.stringify(await db().select().from(auditEvent)),
        ).not.toContain(token);
        expect(
          JSON.stringify(await db().select().from(changeEvent)),
        ).not.toContain(token);
        expect(await everyRowAsText(database)).not.toContain(token);
      });

      it('leaves the event of a link a person made as it was: no issuedBySystem in it', async () => {
        const person = await administrator();
        const made = await byPerson(scene.ownerId, person);
        const [event] = (await audits(AUTH_AUDIT.accessResetCreated)).filter(
          (found) => found.targetId === made.reset.id,
        );
        expect(event!.details).toEqual({
          userId: person,
          expiresAt: made.reset.expiresAt.toISOString(),
          removePasskeys: false,
        });
        expect(made.reset.issuedBySystem).toBe(false);
        expect(made.reset.createdBy).toBe(scene.ownerId);
      });
    });

    describe('who may be given one: an owner, or a holder of the Administrator role', () => {
      it.each([
        ['an owner', () => Promise.resolve(scene.ownerId)],
        [
          'an administrator who is not an owner',
          () => Promise.resolve(scene.adminId),
        ],
        [
          'a member whose tier is owner and who holds no role at all',
          () => member('owner', []),
        ],
        [
          'a member of the tier member who holds the Administrator role',
          () => member('member', [scene.roles.administrator]),
        ],
        [
          'a member of the tier admin who holds the Administrator role',
          administrator,
        ],
      ])('gives a link to %s', async (_name, who) => {
        const person = await who();
        const result = (await system(person)).result;
        expect(result.ok).toBe(true);
      });

      it.each([
        ['a member with a role that only holds accounts:read', 'plain'],
        ['a member who may make reset links', 'resetter'],
        ['a member of the tier admin who holds no Administrator role', 'tier'],
      ] as const)('refuses %s, writing nothing', async (_name, kind) => {
        const person =
          kind === 'plain'
            ? scene.plainId
            : kind === 'resetter'
              ? scene.resetterId
              : await member('admin', [scene.roles.crew]);
        const before = await everythingWritten();

        const { result } = await system(person);

        expect(result).toEqual({ ok: false, reason: 'not-an-administrator' });
        expect(await everythingWritten()).toBe(before);
      });

      it('counts the Administrator role only while the person holds it', async () => {
        const person = await administrator();
        await setMemberRolesEnded(database, scene.organisationId, person, true);
        expect((await system(person)).result).toEqual({
          ok: false,
          reason: 'not-an-administrator',
        });
        await setMemberRolesEnded(
          database,
          scene.organisationId,
          person,
          false,
        );
        expect((await system(person)).result.ok).toBe(true);
      });

      it('does not count a role the organisation made, whatever it holds', async () => {
        const lookalike = await seedOrganisationRole(
          database,
          scene.organisationId,
          'administrators',
          [['members:reset-access', 'own-scope']],
        );
        const person = await member('member', [lookalike]);
        expect((await system(person)).result).toEqual({
          ok: false,
          reason: 'not-an-administrator',
        });
      });

      it('does not ask whether the person belongs to another organisation: shell access is install-wide', async () => {
        const person = await administrator();
        await seedMembership(
          database,
          scene.otherOrganisationId,
          person,
          'member',
          [],
        );
        // The rule an administrator's link has (422 user-in-other-organisations)
        // does not apply to the system's.
        const refusedForAPerson = await rejection(
          byPerson(scene.ownerId, person),
        );
        expect(refusedForAPerson).toMatchObject({
          name: 'UserInOtherOrganisationsError',
        });
        expect((await system(person)).result.ok).toBe(true);
      });

      it('does not ask for a creator: no creator rule applies, so an owner needs no one to be above them', async () => {
        // An administrator may not make a link for an owner (OwnerResetNeedsOwnerError);
        // the system may.
        await expect(
          byPerson(scene.adminId, scene.ownerId),
        ).rejects.toMatchObject({ name: 'OwnerResetNeedsOwnerError' });
        expect((await system(scene.ownerId)).result.ok).toBe(true);
      });
    });

    describe('who may not be given one: the state of the person', () => {
      it.each([
        ['disabled', 'disabled'],
        ['only invited', 'invited'],
      ] as const)(
        'refuses a person whose account is %s',
        async (_name, status) => {
          const person = await administrator();
          await setUserStatus(database, person, status);
          const before = await everythingWritten();

          expect((await system(person)).result).toEqual({
            ok: false,
            reason: 'target-not-active',
          });
          expect(await everythingWritten()).toBe(before);
        },
      );

      it('refuses a person whose account was deleted', async () => {
        const person = await administrator();
        await markUserDeleted(database, person, at(HOUR));
        expect((await system(person)).result).toEqual({
          ok: false,
          reason: 'target-not-active',
        });
      });

      it.each([['removed'], ['invited']] as const)(
        'refuses a person whose membership is %s, whatever they hold',
        async (status) => {
          const person = await member('owner', [scene.roles.administrator], {
            status,
          });
          const before = await everythingWritten();

          expect((await system(person)).result).toEqual({
            ok: false,
            reason: 'target-membership-not-active',
          });
          expect(await everythingWritten()).toBe(before);
        },
      );

      it('says the account first when both the account and the membership are not in use', async () => {
        const person = await member('owner', [], { status: 'removed' });
        await setUserStatus(database, person, 'disabled');
        expect((await system(person)).result).toEqual({
          ok: false,
          reason: 'target-not-active',
        });
      });

      it('refuses a person with no live membership of the organisation, however they come to be named', async () => {
        const deleted = await member('owner', [], { deleted: true });
        const before = await everythingWritten();
        for (const [userId, organisationId] of [
          // Their membership row was deleted.
          [deleted, scene.organisationId],
          // A member of the other organisation only.
          [scene.strangerId, scene.organisationId],
          // The right person, another organisation.
          [scene.ownerId, scene.otherOrganisationId],
          // Ids that are no one's, and text that is no id.
          [await seedUser(database), scene.organisationId],
          ['not-an-id', scene.organisationId],
          [scene.ownerId, 'not-an-id'],
        ] as const) {
          const { result } = await system(userId, {}, organisationId);
          expect(result, `${userId} in ${organisationId}`).toEqual({
            ok: false,
            reason: 'target-not-member',
          });
        }
        expect(await everythingWritten()).toBe(before);
      });
    });

    describe('one live link per person', () => {
      it('supersedes the earlier live link of a person, one an administrator made too, as the system', async () => {
        const person = await administrator();
        const earlier = await byPerson(scene.ownerId, person);

        const { reset, when } = await issued(person);

        expect(await row(earlier.reset.id)).toMatchObject({
          revokedAt: when,
          revokedBy: null,
          revokedBySystem: true,
          updatedBy: null,
          usedAt: null,
        });
        const [event] = (await audits(AUTH_AUDIT.accessResetRevoked)).filter(
          (found) => found.targetId === earlier.reset.id,
        );
        expect(event).toMatchObject({
          action: 'revoke',
          actorType: 'system',
          actorId: null,
          organisationId: scene.organisationId,
          details: { userId: person, reason: 'superseded' },
        });
        // The new link is the only live one.
        expect((await liveLinksOf(person)).map((found) => found.id)).toEqual([
          reset.id,
        ]);
        expect(await row(reset.id)).toMatchObject({
          revokedAt: null,
          revokedBySystem: false,
        });
      });

      it('supersedes an earlier link of the system the same way, and one that has expired', async () => {
        const person = await administrator();
        const first = await issued(person, { expiresInHours: 1 });
        // The first has expired by the time of the second: the index still holds the
        // place, so it is revoked too.
        const later = at(1000 * HOUR);
        const second = await createSystemAccessReset(
          db(),
          scene.organisationId,
          person,
          {},
          later,
        );
        expect(second.ok).toBe(true);
        expect(await row(first.reset.id)).toMatchObject({
          revokedAt: later,
          revokedBySystem: true,
          revokedBy: null,
        });
      });

      it('leaves links that were used or revoked as they are', async () => {
        const person = await administrator();
        const used = await issued(person);
        await useAccessReset(
          db(),
          used.token,
          new Date(used.when.getTime() + MINUTE),
        );
        const revoked = await byPerson(scene.ownerId, person);
        await db()
          .update(accessReset)
          .set({ revokedAt: revoked.when, revokedBy: scene.ownerId })
          .where(eq(accessReset.id, revoked.reset.id));
        const before = [await row(used.reset.id), await row(revoked.reset.id)];

        await issued(person);

        expect([await row(used.reset.id), await row(revoked.reset.id)]).toEqual(
          before,
        );
      });

      it('is superseded in turn by a link a person makes, which is then the person’s revocation', async () => {
        const person = await administrator();
        const first = await issued(person);

        await byPerson(scene.ownerId, person);

        expect(await row(first.reset.id)).toMatchObject({
          revokedBy: scene.ownerId,
          revokedBySystem: false,
        });
      });

      it('is refused without superseding anything: the earlier link stays live', async () => {
        const person = await member('admin', [scene.roles.crew]);
        // A link a person made earlier, for a person the system will refuse.
        await db()
          .insert(accessReset)
          .values({
            originServer: ORIGIN,
            organisationId: scene.organisationId,
            userId: person,
            tokenHash: `earlier-${person}`,
            createdAt: T0,
            createdBy: scene.ownerId,
            expiresAt: at(24 * HOUR),
          });
        const before = JSON.stringify(await linksOf(person));

        expect((await system(person)).result).toEqual({
          ok: false,
          reason: 'not-an-administrator',
        });

        expect(JSON.stringify(await linksOf(person))).toBe(before);
      });
    });

    describe('looking at one', () => {
      it('says when it ends, and nothing else', async () => {
        const person = await administrator();
        const { reset, token, when } = await issued(person);
        await expect(
          inspectAccessReset(db(), token, new Date(when.getTime() + MINUTE)),
        ).resolves.toEqual({ expiresAt: reset.expiresAt });
      });

      it('refuses a link whose person has stopped being an administrator, as any bad link, and audits why', async () => {
        const person = await administrator();
        const { reset, token, when } = await issued(person);
        await setMemberRolesEnded(database, scene.organisationId, person, true);
        const events = (await audits(AUTH_AUDIT.accessResetInspectFailed))
          .length;

        const error = await rejection(
          inspectAccessReset(db(), token, new Date(when.getTime() + MINUTE)),
        );

        expect(error).toBeInstanceOf(AccessResetInvalidError);
        expect((error as AccessResetInvalidError).reason).toBe(
          'not-an-administrator',
        );
        const written = (
          await audits(AUTH_AUDIT.accessResetInspectFailed)
        ).slice(events);
        expect(written).toHaveLength(1);
        expect(written[0]).toMatchObject({
          actorType: 'system',
          targetId: reset.id,
          details: { reason: 'not-an-administrator' },
        });
        // Looking uses nothing up.
        expect((await row(reset.id)).usedAt).toBeNull();
      });
    });

    describe('using one', () => {
      /**
       * A person who is locked out and may be given an emergency link: an
       * administrator with a password, an authenticator, ten recovery codes, two
       * live passkeys and one revoked, two live sessions and one that ended, and a
       * personal API token.
       */
      const lockedOut = async () => {
        const userId = await administrator();
        await seedPassword(database, userId, OLD_PASSWORD, { now: T0 });
        await seedTotp(database, userId, {
          now: T0,
          dataKeys: serverKeys().dataKeys,
        });
        await generateRecoveryCodes(db(), userId, { now: T0 });
        const livePasskeys = [
          await seedPasskey(database, userId),
          await seedPasskey(database, userId),
        ];
        await seedPasskey(database, userId, { revokedAt: at(MINUTE) });
        const live = [
          await createSession(db(), {
            userId,
            method: 'password',
            now: at(HOUR),
          }),
          await createSession(db(), {
            userId,
            method: 'password+totp',
            now: at(HOUR + MINUTE),
          }),
        ];
        const ended = await createSession(db(), {
          userId,
          method: 'password',
          now: at(HOUR + 2 * MINUTE),
        });
        await revokeSession(db(), ended.session.id, {
          reason: 'logout',
          now: at(HOUR + 3 * MINUTE),
        });
        const token = await seedApiToken(
          database,
          scene.organisationId,
          userId,
        );
        return { userId, livePasskeys, live, ended, tokenId: token.id };
      };

      const stateOf = async (userId: string) => ({
        sessions: (await db().select().from(session)).filter(
          (found) => found.userId === userId,
        ),
        passwords: (await db().select().from(passwordCredential)).filter(
          (found) => found.userId === userId,
        ),
        totp: (await db().select().from(totpCredential)).filter(
          (found) => found.userId === userId,
        ),
        codes: (await db().select().from(recoveryCode)).filter(
          (found) => found.userId === userId,
        ),
        passkeys: (await db().select().from(passkeyCredential)).filter(
          (found) => found.userId === userId,
        ),
        tokens: (await db().select().from(apiToken)).filter(
          (found) => found.userId === userId,
        ),
      });

      // The two kinds of link, used the same way: the point is that the system's
      // clears exactly what an administrator's does.
      describe.each([
        [
          'a link an owner made',
          (userId: string, input?: CreateAccessResetInput) =>
            byPerson(scene.ownerId, userId, input),
        ],
        [
          'a link the system made',
          (userId: string, input?: CreateAccessResetInput) =>
            issued(userId, input),
        ],
      ])('%s', (_name, make) => {
        it('revokes every session and API token, clears the password, authenticator and recovery codes, keeps the passkeys, and marks the link used', async () => {
          const locked = await lockedOut();
          const bystander = await lockedOut();
          const made = await make(locked.userId);
          const now = new Date(made.when.getTime() + 10 * MINUTE);

          const used = await useAccessReset(db(), made.token, now);

          expect(used.user).toMatchObject({
            id: locked.userId,
            status: 'active',
          });
          expect(used.organisationId).toBe(scene.organisationId);
          const after = await stateOf(locked.userId);
          for (const live of locked.live) {
            const found = after.sessions.find((s) => s.id === live.session.id)!;
            expect(found.revokedAt).toEqual(now);
            expect(found.revokedReason).toBe('access-reset');
          }
          expect(
            after.sessions.find((s) => s.id === locked.ended.session.id)!
              .revokedReason,
          ).toBe('logout');
          expect(after.tokens).toHaveLength(1);
          expect(after.tokens[0]).toMatchObject({
            revokedAt: now,
            revokeReason: 'access-reset',
            revokedBy: null,
          });
          expect(after.passwords).toEqual([]);
          expect(after.totp).toEqual([]);
          expect(after.codes).toEqual([]);
          expect(
            after.passkeys.filter((found) => found.revokedAt === null),
          ).toHaveLength(2);
          // Someone else's access is not touched.
          const other = await stateOf(bystander.userId);
          expect(other.passwords).toHaveLength(1);
          expect(other.totp).toHaveLength(1);
          expect(other.codes).toHaveLength(10);
          expect(other.tokens[0]!.revokedAt).toBeNull();
          expect(
            other.sessions.filter((found) => found.revokedAt === null),
          ).toHaveLength(2);
          // The link is spent, not revoked.
          const spent = await row(made.reset.id);
          expect(spent.usedAt).toEqual(now);
          expect(spent.revokedAt).toBeNull();
        });

        it('audits the use once, from the person, with the same counts whoever made the link', async () => {
          const locked = await lockedOut();
          const made = await make(locked.userId);
          await useAccessReset(
            db(),
            made.token,
            new Date(made.when.getTime() + MINUTE),
          );

          const [event] = (await audits(AUTH_AUDIT.accessResetUsed)).filter(
            (found) => found.targetId === made.reset.id,
          );
          expect(event).toMatchObject({
            action: 'use',
            actorType: 'user',
            actorId: locked.userId,
            organisationId: scene.organisationId,
            details: {
              userId: locked.userId,
              sessionsRevoked: 2,
              tokensRevoked: 1,
              passwordCleared: true,
              totpRemoved: true,
              recoveryCodesRemoved: 10,
              passkeysRemoved: 0,
            },
          });
          expect(JSON.stringify(event)).not.toContain(made.token);
        });

        it('also revokes the passkeys, and counts them, when the link says so', async () => {
          const locked = await lockedOut();
          const made = await make(locked.userId, { removePasskeys: true });
          const now = new Date(made.when.getTime() + MINUTE);

          await useAccessReset(db(), made.token, now);

          const after = await stateOf(locked.userId);
          for (const id of locked.livePasskeys) {
            expect(after.passkeys.find((p) => p.id === id)!.revokedAt).toEqual(
              now,
            );
          }
          const [event] = (await audits(AUTH_AUDIT.accessResetUsed)).filter(
            (found) => found.targetId === made.reset.id,
          );
          expect(event!.details).toMatchObject({ passkeysRemoved: 2 });
        });

        it('works once: the second use of the token is the one invalid answer', async () => {
          const locked = await lockedOut();
          const made = await make(locked.userId);
          const now = new Date(made.when.getTime() + MINUTE);
          await useAccessReset(db(), made.token, now);

          const error = await rejection(
            useAccessReset(db(), made.token, new Date(now.getTime() + MINUTE)),
          );

          expect(error).toBeInstanceOf(AccessResetInvalidError);
          expect((error as AccessResetInvalidError).reason).toBe('used');
        });
      });

      describe('the rules, checked again when the link is used', () => {
        /**
         * Makes a link, changes the situation, and uses it: the answer must be the
         * one invalid error with `reason`, the person untouched, the refusal audited
         * and the link still live, so putting the situation right makes it work.
         */
        const refusedAfter = async (
          reason: AccessResetRefusalReason,
          options: {
            change: (userId: string) => Promise<void>;
            undo?: (userId: string) => Promise<void>;
          },
        ) => {
          const locked = await lockedOut();
          const made = await issued(locked.userId);
          await options.change(locked.userId);
          const before = JSON.stringify(await stateOf(locked.userId));
          const events = (await audits(AUTH_AUDIT.accessResetUseRefused))
            .length;
          const now = new Date(made.when.getTime() + 5 * MINUTE);

          const error = await rejection(useAccessReset(db(), made.token, now));

          expect(error, reason).toBeInstanceOf(AccessResetInvalidError);
          expect((error as AccessResetInvalidError).reason).toBe(reason);
          expect(JSON.stringify(await stateOf(locked.userId)), reason).toBe(
            before,
          );
          const written = (
            await audits(AUTH_AUDIT.accessResetUseRefused)
          ).slice(events);
          expect(written, reason).toHaveLength(1);
          expect(written[0], reason).toMatchObject({
            actorType: 'system',
            targetId: made.reset.id,
            organisationId: scene.organisationId,
            details: { reason },
          });
          const kept = await row(made.reset.id);
          expect(kept.usedAt, reason).toBeNull();
          expect(kept.revokedAt, reason).toBeNull();
          if (options.undo !== undefined) {
            await options.undo(locked.userId);
            await useAccessReset(
              db(),
              made.token,
              new Date(made.when.getTime() + 6 * MINUTE),
            );
            expect((await row(made.reset.id)).usedAt, reason).not.toBeNull();
          }
        };

        it('refuses a person who has stopped being an administrator, and works again when they are one', async () => {
          await refusedAfter('not-an-administrator', {
            change: (userId) =>
              setMemberRolesEnded(database, scene.organisationId, userId, true),
            undo: (userId) =>
              setMemberRolesEnded(
                database,
                scene.organisationId,
                userId,
                false,
              ),
          });
        });

        it('refuses an owner who has stopped being one, when they hold no Administrator role either', async () => {
          const owner = await member('owner', []);
          await seedPassword(database, owner, OLD_PASSWORD, { now: T0 });
          const made = await issued(owner);
          await setMembershipTier(
            database,
            scene.organisationId,
            owner,
            'member',
          );

          const error = await rejection(
            useAccessReset(
              db(),
              made.token,
              new Date(made.when.getTime() + MINUTE),
            ),
          );

          expect((error as AccessResetInvalidError).reason).toBe(
            'not-an-administrator',
          );
          expect(await stateOf(owner)).toMatchObject({
            passwords: [expect.anything()],
          });
        });

        it('refuses a person whose membership is no longer active, and works again when it is', async () => {
          await refusedAfter('target-membership-not-active', {
            change: (userId) =>
              setMembershipStatus(
                database,
                scene.organisationId,
                userId,
                'removed',
              ),
            undo: (userId) =>
              setMembershipStatus(
                database,
                scene.organisationId,
                userId,
                'active',
              ),
          });
        });

        it('refuses a person whose membership row was deleted', async () => {
          await refusedAfter('target-not-member', {
            change: async (userId) => {
              await db()
                .update(orgMembership)
                .set({ deletedAt: at(10 * HOUR) })
                .where(eq(orgMembership.userId, userId));
            },
          });
        });

        it('refuses a person whose account has been disabled or deleted, and works again once it is active', async () => {
          await refusedAfter('target-not-active', {
            change: (userId) => setUserStatus(database, userId, 'disabled'),
            undo: (userId) => setUserStatus(database, userId, 'active'),
          });
          await refusedAfter('target-not-active', {
            change: (userId) =>
              markUserDeleted(database, userId, at(10 * HOUR)),
          });
        });

        it('lets a person who has joined another organisation since use it: that rule is not the system’s', async () => {
          const locked = await lockedOut();
          const made = await issued(locked.userId);
          await seedMembership(
            database,
            scene.otherOrganisationId,
            locked.userId,
            'member',
            [],
          );

          await useAccessReset(
            db(),
            made.token,
            new Date(made.when.getTime() + MINUTE),
          );

          expect((await row(made.reset.id)).usedAt).not.toBeNull();
        });
      });
    });
  },
);
