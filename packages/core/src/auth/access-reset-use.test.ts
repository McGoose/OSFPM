import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORIGIN, seedUser } from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import {
  accessReset,
  auditEvent,
  orgMembership,
  orgMembershipRole,
  passkeyCredential,
  passwordCredential,
  recoveryCode,
  session,
  totpCredential,
  user,
} from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import {
  AccessResetInvalidError,
  type AccessResetRefusalReason,
} from './access-reset-errors.js';
import {
  createAccessReset,
  revokeAccessReset,
  useAccessReset,
  type CreateAccessResetInput,
} from './access-reset.js';
import { listPasskeys } from './passkeys.js';
import { verifyPasswordLogin, setPassword } from './password-service.js';
import { generateRecoveryCodes } from './recovery.js';
import { createSession, revokeSession } from './sessions.js';
import { AUTH_AUDIT } from './shared.js';
import {
  emailOf,
  markUserDeleted,
  seedMembership,
  seedOrganisationRole,
  seedPasskey,
  seedPassword,
  seedResetScene,
  seedTotp,
  setMembershipStatus,
  setUserStatus,
  type ResetScene,
} from './test-support.js';

const T0 = new Date('2026-03-02T09:00:00.000Z');
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const at = (ms: number) => new Date(T0.getTime() + ms);

/** An invented password the locked-out people had, and one they choose after. */
const OLD_PASSWORD = 'meadow-lantern-slow-river';
const NEW_PASSWORD = 'harbour-lantern-quiet-river';

describe.each(testTargets)('using an admin reset link on $name', (target) => {
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

  /** A member of the organisation holding `accounts:read`. */
  const makeTarget = async (
    roleIds: readonly string[] = [scene.roles.crew],
  ) => {
    const userId = await seedUser(database);
    await seedMembership(
      database,
      scene.organisationId,
      userId,
      'member',
      roleIds,
    );
    return userId;
  };

  /**
   * A member who is locked out: a password, a confirmed authenticator, ten
   * recovery codes, two live passkeys and one revoked, two live sessions and one
   * that ended, and, to be left alone, a session of someone else.
   */
  const lockedOut = async () => {
    const userId = await makeTarget();
    await seedPassword(database, userId, OLD_PASSWORD, { now: T0 });
    await seedTotp(database, userId, { now: T0 });
    await generateRecoveryCodes(db(), userId, { now: T0 });
    const livePasskeys = [
      await seedPasskey(database, userId),
      await seedPasskey(database, userId),
    ];
    const revokedPasskey = await seedPasskey(database, userId, {
      revokedAt: at(MINUTE),
    });
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
    return { userId, livePasskeys, revokedPasskey, live, ended };
  };

  let clock = 100;
  /** A link by `actorId` for `userId`, made a minute after the last. */
  const link = async (
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

  /** The events of one category in the order they were written: ids are UUIDv7, and a table has no order of its own. */
  const audits = async (category: string) =>
    (await db().select().from(auditEvent))
      .filter((event) => event.category === category)
      .sort((a, b) => a.id.localeCompare(b.id));
  const row = async (id: string) =>
    (await db().select().from(accessReset).where(eq(accessReset.id, id)))[0]!;
  const sessionsOf = async (userId: string) =>
    (await db().select().from(session)).filter(
      (found) => found.userId === userId,
    );
  const passwordsOf = async (userId: string) =>
    (await db().select().from(passwordCredential)).filter(
      (found) => found.userId === userId,
    );
  const totpOf = async (userId: string) =>
    (await db().select().from(totpCredential)).filter(
      (found) => found.userId === userId,
    );
  const codesOf = async (userId: string) =>
    (await db().select().from(recoveryCode)).filter(
      (found) => found.userId === userId,
    );
  const passkeysOf = async (userId: string) =>
    (await db().select().from(passkeyCredential)).filter(
      (found) => found.userId === userId,
    );

  /** What a use must leave alone when it is refused. */
  const snapshot = async (userId: string) => ({
    sessions: JSON.stringify(await sessionsOf(userId)),
    passwords: JSON.stringify(await passwordsOf(userId)),
    totp: JSON.stringify(await totpOf(userId)),
    codes: JSON.stringify(await codesOf(userId)),
    passkeys: JSON.stringify(await passkeysOf(userId)),
  });

  const rejection = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return error;
    }
    throw new Error('Expected the call to be refused, but it succeeded');
  };

  describe('what a use does', () => {
    it('revokes every session, clears the password, removes the authenticator and the recovery codes, keeps the passkeys, and marks the link used', async () => {
      const locked = await lockedOut();
      const bystander = await lockedOut();
      const [before] = await db()
        .select()
        .from(user)
        .where(eq(user.id, locked.userId));
      const made = await link(scene.ownerId, locked.userId);
      const now = new Date(made.when.getTime() + 10 * MINUTE);

      const used = await useAccessReset(db(), made.token, now);

      expect(used.user).toMatchObject({
        id: locked.userId,
        email: await emailOf(database, locked.userId),
        status: 'active',
      });
      expect(used.organisationId).toBe(scene.organisationId);

      // Every live session ended with the reset's own reason; the one that had
      // already ended keeps its reason and its time.
      const sessions = await sessionsOf(locked.userId);
      expect(sessions).toHaveLength(3);
      for (const live of locked.live) {
        const found = sessions.find((s) => s.id === live.session.id)!;
        expect(found.revokedAt).toEqual(now);
        expect(found.revokedReason).toBe('access-reset');
      }
      const ended = sessions.find((s) => s.id === locked.ended.session.id)!;
      expect(ended.revokedReason).toBe('logout');
      expect(ended.revokedAt).toEqual(at(HOUR + 3 * MINUTE));
      // Another person's sessions are not touched.
      for (const live of bystander.live) {
        const found = (await sessionsOf(bystander.userId)).find(
          (s) => s.id === live.session.id,
        )!;
        expect(found.revokedAt).toBeNull();
      }

      expect(await passwordsOf(locked.userId)).toEqual([]);
      expect(await totpOf(locked.userId)).toEqual([]);
      expect(await codesOf(locked.userId)).toEqual([]);
      // ... and only theirs.
      expect(await passwordsOf(bystander.userId)).toHaveLength(1);
      expect(await totpOf(bystander.userId)).toHaveLength(1);
      expect(await codesOf(bystander.userId)).toHaveLength(10);

      // The passkeys are kept: the person may still sign in with one.
      const passkeys = await passkeysOf(locked.userId);
      expect(passkeys).toHaveLength(3);
      expect(
        passkeys.filter((found) => found.revokedAt === null).map((p) => p.id),
      ).toEqual(expect.arrayContaining(locked.livePasskeys));
      expect(await listPasskeys(db(), locked.userId)).toHaveLength(2);
      expect(await passkeysOf(bystander.userId)).toHaveLength(3);

      // The link is spent, not revoked.
      const spent = await row(made.reset.id);
      expect(spent.usedAt).toEqual(now);
      expect(spent.revokedAt).toBeNull();

      // The account itself is as it was.
      const [after] = await db()
        .select()
        .from(user)
        .where(eq(user.id, locked.userId));
      expect(after).toMatchObject({
        email: before!.email,
        displayName: before!.displayName,
        status: 'active',
      });
    });

    it('audits it once, from the person, with ids and counts and no token, hash, password or address', async () => {
      const locked = await lockedOut();
      const made = await link(scene.adminId, locked.userId);
      const now = new Date(made.when.getTime() + 5 * MINUTE);
      const used = (await audits(AUTH_AUDIT.accessResetUsed)).length;
      const revoked = (await audits(AUTH_AUDIT.sessionsRevoked)).length;
      await useAccessReset(db(), made.token, now);

      const events = (await audits(AUTH_AUDIT.accessResetUsed)).slice(used);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: 'use',
        actorType: 'user',
        actorId: locked.userId,
        targetType: 'access_reset',
        targetId: made.reset.id,
        organisationId: scene.organisationId,
        details: {
          userId: locked.userId,
          sessionsRevoked: 2,
          passwordCleared: true,
          totpRemoved: true,
          recoveryCodesRemoved: 10,
          passkeysRemoved: 0,
        },
      });
      // The sessions' own event, with the reason.
      const sessionEvents = (await audits(AUTH_AUDIT.sessionsRevoked)).slice(
        revoked,
      );
      expect(sessionEvents).toHaveLength(1);
      expect(sessionEvents[0]).toMatchObject({
        targetId: locked.userId,
        details: { reason: 'access-reset', count: 2 },
      });
      const text = JSON.stringify([...events, ...sessionEvents]);
      for (const secret of [
        made.token,
        OLD_PASSWORD,
        await emailOf(database, locked.userId),
      ]) {
        expect(text).not.toContain(secret);
      }
    });

    it('also revokes the passkeys, and counts them, when the link says so', async () => {
      const locked = await lockedOut();
      const made = await link(scene.ownerId, locked.userId, {
        removePasskeys: true,
      });
      const now = new Date(made.when.getTime() + 2 * MINUTE);
      await useAccessReset(db(), made.token, now);

      const passkeys = await passkeysOf(locked.userId);
      expect(passkeys).toHaveLength(3);
      for (const id of locked.livePasskeys) {
        const found = passkeys.find((p) => p.id === id)!;
        expect(found.revokedAt).toEqual(now);
        expect(found.version).toBe(2);
      }
      // The one revoked before keeps its own time and version.
      const before = passkeys.find((p) => p.id === locked.revokedPasskey)!;
      expect(before.revokedAt).toEqual(at(MINUTE));
      expect(before.version).toBe(1);
      expect(await listPasskeys(db(), locked.userId)).toEqual([]);
      const [event] = await audits(AUTH_AUDIT.accessResetUsed).then((found) =>
        found.filter((e) => e.targetId === made.reset.id),
      );
      expect(event!.details).toMatchObject({ passkeysRemoved: 2 });
    });

    it('is not an error when there is nothing to clear: no password, authenticator, recovery codes or passkeys', async () => {
      const person = await makeTarget();
      const made = await link(scene.ownerId, person);
      await useAccessReset(
        db(),
        made.token,
        new Date(made.when.getTime() + MINUTE),
      );
      const [event] = (await audits(AUTH_AUDIT.accessResetUsed)).filter(
        (e) => e.targetId === made.reset.id,
      );
      expect(event!.details).toMatchObject({
        sessionsRevoked: 0,
        passwordCleared: false,
        totpRemoved: false,
        recoveryCodesRemoved: 0,
        passkeysRemoved: 0,
      });
      // No sessions to end, so no event for it.
      expect(
        (await audits(AUTH_AUDIT.sessionsRevoked)).filter(
          (e) => e.targetId === person,
        ),
      ).toEqual([]);
    });

    it('leaves the person unable to sign in with the old password, with a session that may only set a new way in', async () => {
      const locked = await lockedOut();
      const email = await emailOf(database, locked.userId);
      expect(
        (
          await verifyPasswordLogin(db(), {
            email,
            password: OLD_PASSWORD,
            now: at(2 * HOUR),
          })
        ).ok,
      ).toBe(true);
      const made = await link(scene.ownerId, locked.userId);
      const now = new Date(made.when.getTime() + 3 * MINUTE);
      await useAccessReset(db(), made.token, now);
      expect(
        await verifyPasswordLogin(db(), {
          email,
          password: OLD_PASSWORD,
          now: new Date(now.getTime() + MINUTE),
        }),
      ).toEqual({ ok: false });

      // The caller makes the session: method reset, always the recovery scope.
      const created = await createSession(db(), {
        userId: locked.userId,
        method: 'reset',
        now,
      });
      expect(created.session.scope).toBe('recovery');
      await expect(
        createSession(db(), {
          userId: locked.userId,
          method: 'reset',
          scope: 'full',
          now,
        }),
      ).rejects.toMatchObject({ name: 'AuthInputError', field: 'scope' });

      // Setting a password with that session makes it full, and the new password works.
      const set = await setPassword(db(), {
        userId: locked.userId,
        newPassword: NEW_PASSWORD,
        session: { id: created.session.id, scope: 'recovery' },
        now: new Date(now.getTime() + 2 * MINUTE),
      });
      expect(set).toEqual({ ok: true });
      const [promoted] = (await sessionsOf(locked.userId)).filter(
        (found) => found.id === created.session.id,
      );
      expect(promoted).toMatchObject({ scope: 'full', method: 'reset' });
      expect(
        (
          await verifyPasswordLogin(db(), {
            email,
            password: NEW_PASSWORD,
            now: new Date(now.getTime() + 3 * MINUTE),
          })
        ).ok,
      ).toBe(true);
    });
  });

  describe('a link that does not work', () => {
    it('is used once: the second use gets the invalid answer and changes nothing', async () => {
      const locked = await lockedOut();
      const made = await link(scene.ownerId, locked.userId);
      const now = new Date(made.when.getTime() + MINUTE);
      await useAccessReset(db(), made.token, now);
      // The person gets back in and sets a password again.
      await seedPassword(database, locked.userId, NEW_PASSWORD, { now });
      const before = await snapshot(locked.userId);
      const refused = await rejection(
        useAccessReset(db(), made.token, new Date(now.getTime() + MINUTE)),
      );
      expect(refused).toBeInstanceOf(AccessResetInvalidError);
      expect((refused as AccessResetInvalidError).reason).toBe('used');
      expect(await snapshot(locked.userId)).toEqual(before);
      const events = (await audits(AUTH_AUDIT.accessResetUseRefused)).filter(
        (e) => e.targetId === made.reset.id,
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: 'use',
        actorType: 'system',
        actorId: null,
        organisationId: scene.organisationId,
        details: { reason: 'used' },
      });
    });

    it('answers a token that is unknown, malformed, expired or revoked with the one error, and says why only in the audit trail', async () => {
      const locked = await lockedOut();
      const expired = await link(scene.ownerId, locked.userId, {
        expiresInHours: 1,
      });
      const revokedPerson = await lockedOut();
      const revoked = await link(scene.ownerId, revokedPerson.userId);
      await revokeAccessReset(
        db(),
        { userId: scene.ownerId },
        scene.organisationId,
        revokedPerson.userId,
        new Date(revoked.when.getTime() + MINUTE),
      );
      const before = [
        await snapshot(locked.userId),
        await snapshot(revokedPerson.userId),
      ];
      const when = new Date(expired.when.getTime() + 2 * HOUR);
      const cases: {
        name: string;
        token: unknown;
        reason: AccessResetRefusalReason;
        known: string | null;
      }[] = [
        {
          name: 'unknown',
          token: 'nobody-made-this',
          reason: 'unknown',
          known: null,
        },
        { name: 'empty', token: '', reason: 'unknown', known: null },
        {
          name: 'too long',
          token: 'x'.repeat(300),
          reason: 'unknown',
          known: null,
        },
        { name: 'not text', token: null, reason: 'unknown', known: null },
        {
          name: 'expired',
          token: expired.token,
          reason: 'expired',
          known: expired.reset.id,
        },
        {
          name: 'revoked',
          token: revoked.token,
          reason: 'revoked',
          known: revoked.reset.id,
        },
      ];
      const messages = new Set<string>();
      for (const found of cases) {
        const events = (await audits(AUTH_AUDIT.accessResetUseRefused)).length;
        const error = await rejection(
          useAccessReset(db(), found.token as string, when),
        );
        expect(error, found.name).toBeInstanceOf(AccessResetInvalidError);
        expect((error as AccessResetInvalidError).reason, found.name).toBe(
          found.reason,
        );
        messages.add((error as Error).message);
        const written = (await audits(AUTH_AUDIT.accessResetUseRefused)).slice(
          events,
        );
        expect(written, found.name).toHaveLength(1);
        expect(written[0], found.name).toMatchObject({
          actorType: 'system',
          targetId: found.known,
          details: { reason: found.reason },
        });
      }
      expect(messages.size).toBe(1);
      expect([
        await snapshot(locked.userId),
        await snapshot(revokedPerson.userId),
      ]).toEqual(before);
    });

    it('counts the moment a link ends as too late, and the moment before as in time', async () => {
      const early = await lockedOut();
      const made = await link(scene.ownerId, early.userId, {
        expiresInHours: 1,
      });
      await expect(
        useAccessReset(db(), made.token, made.reset.expiresAt),
      ).rejects.toMatchObject({
        name: 'AccessResetInvalidError',
        reason: 'expired',
      });
      await useAccessReset(
        db(),
        made.token,
        new Date(made.reset.expiresAt.getTime() - 1),
      );
      expect((await row(made.reset.id)).usedAt).not.toBeNull();
    });
  });

  describe('the rules, checked again when the link is used', () => {
    /**
     * Makes a link, changes the situation, and uses it: the answer must be the
     * one invalid error with `reason`, the person untouched, the refusal audited
     * and the link still live (so putting the situation right makes it work).
     */
    const refusedAfter = async (
      reason: AccessResetRefusalReason,
      options: {
        creator?: string;
        change: (userId: string, creator: string) => Promise<void>;
        undo?: (userId: string, creator: string) => Promise<void>;
      },
    ) => {
      const locked = await lockedOut();
      const creator = options.creator ?? scene.adminId;
      const made = await link(creator, locked.userId);
      await options.change(locked.userId, creator);
      const before = await snapshot(locked.userId);
      const events = (await audits(AUTH_AUDIT.accessResetUseRefused)).length;
      const now = new Date(made.when.getTime() + 5 * MINUTE);
      const error = await rejection(useAccessReset(db(), made.token, now));
      expect(error, reason).toBeInstanceOf(AccessResetInvalidError);
      expect((error as AccessResetInvalidError).reason).toBe(reason);
      expect(await snapshot(locked.userId), reason).toEqual(before);
      const written = (await audits(AUTH_AUDIT.accessResetUseRefused)).slice(
        events,
      );
      expect(written, reason).toHaveLength(1);
      expect(written[0], reason).toMatchObject({
        actorType: 'system',
        targetId: made.reset.id,
        organisationId: scene.organisationId,
        details: { reason },
      });
      // Refused, not spent: the link is as it was.
      const kept = await row(made.reset.id);
      expect(kept.usedAt, reason).toBeNull();
      expect(kept.revokedAt, reason).toBeNull();
      if (options.undo !== undefined) {
        await options.undo(locked.userId, creator);
        await useAccessReset(
          db(),
          made.token,
          new Date(made.when.getTime() + 6 * MINUTE),
        );
        expect((await row(made.reset.id)).usedAt, reason).not.toBeNull();
      }
      return error as AccessResetInvalidError;
    };

    it('refuses when the person has joined another organisation since', async () => {
      await refusedAfter('target-in-other-organisations', {
        change: async (userId) => {
          await seedMembership(
            database,
            scene.otherOrganisationId,
            userId,
            'member',
            [],
          );
        },
      });
    });

    it('refuses when the creator no longer holds members:reset-access, and works again when they do', async () => {
      await refusedAfter('creator-not-allowed', {
        change: async (_userId, creator) => {
          await db()
            .update(orgMembershipRole)
            .set({ deletedAt: at(10 * HOUR) })
            .where(
              eq(
                orgMembershipRole.membershipId,
                (
                  await db()
                    .select()
                    .from(orgMembership)
                    .where(eq(orgMembership.userId, creator))
                )[0]!.id,
              ),
            );
        },
        undo: async (_userId, creator) => {
          await db()
            .update(orgMembershipRole)
            .set({ deletedAt: null })
            .where(
              eq(
                orgMembershipRole.membershipId,
                (
                  await db()
                    .select()
                    .from(orgMembership)
                    .where(eq(orgMembership.userId, creator))
                )[0]!.id,
              ),
            );
        },
      });
    });

    it('refuses when the creator can no longer sign in: disabled, or deleted', async () => {
      const creatorA = await seedUser(database);
      await seedMembership(database, scene.organisationId, creatorA, 'admin', [
        scene.roles.administrator,
      ]);
      await refusedAfter('creator-not-allowed', {
        creator: creatorA,
        change: async () => {
          await setUserStatus(database, creatorA, 'disabled');
        },
        undo: async () => {
          await setUserStatus(database, creatorA, 'active');
        },
      });
      const creatorB = await seedUser(database);
      await seedMembership(database, scene.organisationId, creatorB, 'admin', [
        scene.roles.administrator,
      ]);
      await refusedAfter('creator-not-allowed', {
        creator: creatorB,
        change: async () => {
          await markUserDeleted(database, creatorB, at(10 * HOUR));
        },
      });
    });

    it('refuses when the person has become an owner and the creator is not one', async () => {
      await refusedAfter('target-is-owner', {
        change: async (userId) => {
          await db()
            .update(orgMembership)
            .set({ orgRole: 'owner' })
            .where(eq(orgMembership.userId, userId));
        },
        undo: async (userId) => {
          await db()
            .update(orgMembership)
            .set({ orgRole: 'member' })
            .where(eq(orgMembership.userId, userId));
        },
      });
    });

    it('lets an owner’s link through when the person has become an owner', async () => {
      const locked = await lockedOut();
      const made = await link(scene.ownerId, locked.userId);
      await db()
        .update(orgMembership)
        .set({ orgRole: 'owner' })
        .where(eq(orgMembership.userId, locked.userId));
      await useAccessReset(
        db(),
        made.token,
        new Date(made.when.getTime() + MINUTE),
      );
      expect((await row(made.reset.id)).usedAt).not.toBeNull();
    });

    it('refuses when the person’s account has been disabled or deleted, and works again once it is active', async () => {
      await refusedAfter('target-not-active', {
        change: async (userId) => {
          await setUserStatus(database, userId, 'disabled');
        },
        undo: async (userId) => {
          await setUserStatus(database, userId, 'active');
        },
      });
      await refusedAfter('target-not-active', {
        change: async (userId) => {
          await markUserDeleted(database, userId, at(10 * HOUR));
        },
      });
    });

    it('refuses when the person has been given access the creator does not hold', async () => {
      const editor = await seedOrganisationRole(
        database,
        scene.organisationId,
        `editor-later-${clock}`,
        [
          ['accounts:read', 'own-scope'],
          ['accounts:edit', 'own-scope'],
        ],
      );
      const thin = await seedUser(database);
      await seedMembership(database, scene.organisationId, thin, 'member', [
        scene.roles.resetter,
        scene.roles.crew,
      ]);
      await refusedAfter('target-exceeds-creator', {
        creator: thin,
        change: async (userId) => {
          const [membership] = await db()
            .select()
            .from(orgMembership)
            .where(eq(orgMembership.userId, userId));
          await db().insert(orgMembershipRole).values({
            organisationId: scene.organisationId,
            ownerOrgId: scene.organisationId,
            originServer: ORIGIN,
            membershipId: membership!.id,
            roleId: editor,
          });
        },
      });
    });

    it('refuses when the person’s membership of the organisation has been removed', async () => {
      await refusedAfter('target-not-member', {
        change: async (userId) => {
          await db()
            .update(orgMembership)
            .set({ deletedAt: at(10 * HOUR) })
            .where(eq(orgMembership.userId, userId));
        },
      });
    });

    it('refuses when the person’s membership is no longer active, because it was removed or is now only an invitation, and works again once it is active', async () => {
      for (const status of ['removed', 'invited'] as const) {
        await refusedAfter('target-membership-not-active', {
          change: async (userId) => {
            await setMembershipStatus(
              database,
              scene.organisationId,
              userId,
              status,
            );
          },
          undo: async (userId) => {
            await setMembershipStatus(
              database,
              scene.organisationId,
              userId,
              'active',
            );
          },
        });
      }
    });

    it('gives the same error and message for every one of these refusals', async () => {
      const reasons = new Set<string>();
      const messages = new Set<string>();
      const names = new Set<string>();
      for (const [reason, change] of [
        [
          'target-in-other-organisations',
          async (userId: string) => {
            await seedMembership(
              database,
              scene.otherOrganisationId,
              userId,
              'member',
              [],
            );
          },
        ],
        [
          'target-not-active',
          async (userId: string) => setUserStatus(database, userId, 'disabled'),
        ],
        [
          'target-membership-not-active',
          async (userId: string) =>
            setMembershipStatus(
              database,
              scene.organisationId,
              userId,
              'removed',
            ),
        ],
      ] as const) {
        const error = await refusedAfter(reason, { change });
        reasons.add(error.reason);
        messages.add(error.message);
        names.add(error.name);
      }
      // The reasons differ for the audit trail; nothing else does.
      expect(reasons.size).toBe(3);
      expect(messages.size).toBe(1);
      expect(names.size).toBe(1);
    });
  });
});
