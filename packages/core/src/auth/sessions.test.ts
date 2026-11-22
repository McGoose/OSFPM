import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import { auditEvent, session, user } from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import { AuthInputError, AuthStateError } from './errors.js';
import {
  createSession,
  disableUser,
  enableUser,
  listUserSessions,
  promoteSession,
  revokeSession,
  revokeUserSessions,
  SESSION_DEFAULTS,
  validateSession,
} from './sessions.js';
import { AUTH_AUDIT } from './shared.js';
import {
  everyRowAsText,
  rowsOf,
  seedActiveUser,
  seedInstallation,
  seedUserWithStatus,
  setUserStatus,
} from './test-support.js';
import { hashToken } from './tokens.js';

const T0 = new Date('2026-03-02T09:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe.each(testTargets)('sessions on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    await seedInstallation(database);
  });
  afterAll(async () => {
    await cleanup();
  });

  const db = () => database.db;

  const sessionRow = async (id: string) => {
    const [row] = await db().select().from(session).where(eq(session.id, id));
    return row!;
  };

  describe('createSession', () => {
    it('returns the raw token once and stores only its hash', async () => {
      const userId = await seedActiveUser(database);
      const { session: created, token } = await createSession(db(), {
        userId,
        method: 'password',
        now: T0,
      });
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Object.keys(created).sort()).toEqual([
        'absoluteExpiresAt',
        'createdAt',
        'id',
        'idleExpiresAt',
        'lastSeenAt',
        'method',
        'scope',
        'userAgentSummary',
        'userId',
      ]);
      const stored = await sessionRow(created.id);
      expect(stored.tokenHash).toBe(hashToken(token));
      expect(JSON.stringify(stored)).not.toContain(token);
    });

    it('sets the lifetimes from the defaults and the login time on the user', async () => {
      const userId = await seedActiveUser(database);
      const before = (
        await db().select().from(user).where(eq(user.id, userId))
      )[0]!;
      expect(before.lastLoginAt).toBeNull();
      const { session: created } = await createSession(db(), {
        userId,
        method: 'passkey',
        now: T0,
      });
      expect(created.createdAt).toEqual(T0);
      expect(created.lastSeenAt).toEqual(T0);
      expect(created.idleExpiresAt).toEqual(at(SESSION_DEFAULTS.idleMs));
      expect(created.absoluteExpiresAt).toEqual(
        at(SESSION_DEFAULTS.absoluteMs),
      );
      expect(SESSION_DEFAULTS.idleMs).toBe(12 * HOUR);
      expect(SESSION_DEFAULTS.absoluteMs).toBe(30 * DAY);
      const after = (
        await db().select().from(user).where(eq(user.id, userId))
      )[0]!;
      expect(after.lastLoginAt).toEqual(T0);
      // A login is not an edit of the user.
      expect(after.version).toBe(before.version);
    });

    it('stamps this server on the row and keeps the user agent summary short', async () => {
      const userId = await seedActiveUser(database);
      const { session: created } = await createSession(db(), {
        userId,
        method: 'setup',
        userAgentSummary: `  Firefox on Windows ${'x'.repeat(500)}`,
        now: T0,
      });
      expect(created.userAgentSummary).toHaveLength(200);
      expect(created.userAgentSummary!.startsWith('Firefox on Windows')).toBe(
        true,
      );
      const [install] = await rowsOf(
        database,
        sql`select id from installation`,
      );
      expect((await sessionRow(created.id)).originServer).toBe(install!.id);
    });

    it('accepts every method on the list', async () => {
      const userId = await seedActiveUser(database);
      for (const method of [
        'passkey',
        'password',
        'password+totp',
        'recovery',
        'setup',
        'invite',
      ] as const) {
        const { session: created } = await createSession(db(), {
          userId,
          method,
          now: T0,
        });
        expect(created.method).toBe(method);
      }
    });

    it('refuses a method that is not on the list, and writes nothing', async () => {
      const userId = await seedActiveUser(database);
      for (const method of ['magic-link', '', '__proto__', 'constructor']) {
        await expect(
          createSession(db(), { userId, method: method as never, now: T0 }),
        ).rejects.toBeInstanceOf(AuthInputError);
      }
      expect(await listUserSessions(db(), userId, T0)).toEqual([]);
    });

    it('refuses an unknown, deleted or disabled user, and writes nothing', async () => {
      const disabled = await seedUserWithStatus(database, 'disabled');
      const deleted = await seedActiveUser(database);
      await db()
        .update(user)
        .set({ deletedAt: T0 })
        .where(eq(user.id, deleted));
      const reasons = await Promise.all(
        [newId(), deleted, disabled].map((userId) =>
          createSession(db(), { userId, method: 'password', now: T0 }).catch(
            (error: unknown) => (error as AuthStateError).reason,
          ),
        ),
      );
      expect(reasons).toEqual([
        'user-not-found',
        'user-not-found',
        'user-disabled',
      ]);
      expect(await listUserSessions(db(), disabled, T0)).toEqual([]);
      const [after] = await db()
        .select()
        .from(user)
        .where(eq(user.id, disabled));
      expect(after!.lastLoginAt).toBeNull();
    });

    it('lets an invited user in, for the invite flow', async () => {
      const userId = await seedUserWithStatus(database, 'invited');
      const { session: created } = await createSession(db(), {
        userId,
        method: 'invite',
        now: T0,
      });
      expect(created.method).toBe('invite');
    });

    it('is refused before the installation row exists', async () => {
      const bare = await createMigratedDatabase(target);
      try {
        const userId = await seedActiveUser(bare.database);
        await expect(
          createSession(bare.database.db, {
            userId,
            method: 'password',
            now: T0,
          }),
        ).rejects.toMatchObject({ reason: 'installation-missing' });
      } finally {
        await bare.cleanup();
      }
    });
  });

  describe('validateSession', () => {
    const start = async (method: 'password' | 'passkey' = 'password') => {
      const userId = await seedActiveUser(database);
      const created = await createSession(db(), { userId, method, now: T0 });
      return { userId, ...created };
    };

    it('returns the session and the user, and nothing secret', async () => {
      const { userId, session: created, token } = await start();
      const found = await validateSession(db(), token, at(MINUTE / 2));
      expect(found!.session.id).toBe(created.id);
      expect(found!.user.id).toBe(userId);
      expect(Object.keys(found!.user).sort()).toEqual([
        'displayName',
        'email',
        'id',
        'locale',
        'status',
        'timezone',
      ]);
      expect(JSON.stringify(found)).not.toContain(token);
      expect(JSON.stringify(found)).not.toContain(hashToken(token));
    });

    it('returns null for a token that is unknown, empty, too long or not a string', async () => {
      await start();
      for (const token of [
        'not-a-session-token',
        '',
        'x'.repeat(1000),
        null,
        undefined,
        42,
        { token: 'x' },
      ]) {
        expect(await validateSession(db(), token as never, T0)).toBeNull();
      }
    });

    it('does not accept the stored hash as a token', async () => {
      const { token } = await start();
      expect(await validateSession(db(), hashToken(token), T0)).toBeNull();
    });

    it('writes nothing when the session was seen less than a minute ago', async () => {
      const { session: created, token } = await start();
      await validateSession(db(), token, at(MINUTE - 1));
      const row = await sessionRow(created.id);
      expect(row.lastSeenAt).toEqual(T0);
      expect(row.updatedAt).toEqual(T0);
      expect(row.idleExpiresAt).toEqual(at(12 * HOUR));
    });

    it('slides the idle expiry once a minute has passed, and at most once per minute', async () => {
      const { session: created, token } = await start();
      const slid = await validateSession(db(), token, at(MINUTE));
      expect(slid!.session.lastSeenAt).toEqual(at(MINUTE));
      expect(slid!.session.idleExpiresAt).toEqual(at(MINUTE + 12 * HOUR));
      // Less than a minute after the write: the row is not touched again.
      await validateSession(db(), token, at(MINUTE + 59 * 1000));
      let row = await sessionRow(created.id);
      expect(row.lastSeenAt).toEqual(at(MINUTE));
      expect(row.updatedAt).toEqual(at(MINUTE));
      // A minute after the write: it is.
      await validateSession(db(), token, at(2 * MINUTE));
      row = await sessionRow(created.id);
      expect(row.lastSeenAt).toEqual(at(2 * MINUTE));
      expect(row.idleExpiresAt).toEqual(at(2 * MINUTE + 12 * HOUR));
    });

    it('does not move the expiry back when the clock is behind the last write', async () => {
      const { session: created, token } = await start();
      await validateSession(db(), token, at(10 * MINUTE));
      await validateSession(db(), token, at(5 * MINUTE));
      const row = await sessionRow(created.id);
      expect(row.lastSeenAt).toEqual(at(10 * MINUTE));
      expect(row.idleExpiresAt).toEqual(at(10 * MINUTE + 12 * HOUR));
    });

    // Walks a session forward in steps shorter than the idle time, so it stays
    // alive, and stops at the last step that is not past the limit (in ms).
    const keepAliveUntil = async (token: string, limit: number) => {
      let now = 0;
      while (now + 11 * HOUR <= limit) {
        now += 11 * HOUR;
        expect(await validateSession(db(), token, at(now))).not.toBeNull();
      }
    };

    it('never slides the idle expiry past the absolute one', async () => {
      const { session: created, token } = await start();
      await keepAliveUntil(token, 30 * DAY - 2 * HOUR);
      // Two hours from the end a 12-hour slide would pass it, so it stops at it.
      const found = await validateSession(db(), token, at(30 * DAY - 2 * HOUR));
      expect(found).not.toBeNull();
      expect(found!.session.absoluteExpiresAt).toEqual(at(30 * DAY));
      expect(found!.session.idleExpiresAt).toEqual(at(30 * DAY));
      const row = await sessionRow(created.id);
      expect(row.idleExpiresAt.getTime()).toBeLessThanOrEqual(
        row.absoluteExpiresAt.getTime(),
      );
    });

    it('expires after the idle time, to the millisecond', async () => {
      const first = await start();
      expect(
        await validateSession(db(), first.token, at(12 * HOUR - 1)),
      ).not.toBeNull();
      // That call slid the first session, so the boundary uses a fresh one.
      const fresh = await start();
      expect(
        await validateSession(db(), fresh.token, at(12 * HOUR)),
      ).toBeNull();
      expect(
        await validateSession(db(), fresh.token, at(12 * HOUR + 1)),
      ).toBeNull();
      // An expired session is not brought back to life by being asked about.
      const row = await sessionRow(fresh.session.id);
      expect(row.lastSeenAt).toEqual(T0);
      expect(row.idleExpiresAt).toEqual(at(12 * HOUR));
    });

    it('expires at the absolute end however recently it was used', async () => {
      const { token } = await start();
      await keepAliveUntil(token, 30 * DAY - 2 * HOUR);
      // Used a minute before the end, so the idle time has not run out.
      expect(
        await validateSession(db(), token, at(30 * DAY - MINUTE)),
      ).not.toBeNull();
      expect(await validateSession(db(), token, at(30 * DAY))).toBeNull();
      expect(
        await validateSession(db(), token, at(30 * DAY + HOUR)),
      ).toBeNull();
    });

    it('returns null once the session is revoked', async () => {
      const { session: created, token } = await start();
      expect(
        await revokeSession(db(), created.id, {
          reason: 'logout',
          now: at(MINUTE),
        }),
      ).toBe(true);
      expect(await validateSession(db(), token, at(2 * MINUTE))).toBeNull();
    });

    it('returns null for a disabled user, and for a deleted one', async () => {
      const first = await start();
      await setUserStatus(database, first.userId, 'disabled');
      expect(await validateSession(db(), first.token, at(MINUTE))).toBeNull();
      await setUserStatus(database, first.userId, 'active');
      expect(
        await validateSession(db(), first.token, at(MINUTE)),
      ).not.toBeNull();
      await db()
        .update(user)
        .set({ deletedAt: at(MINUTE) })
        .where(eq(user.id, first.userId));
      expect(
        await validateSession(db(), first.token, at(2 * MINUTE)),
      ).toBeNull();
    });
  });

  describe('revokeSession', () => {
    it('revokes once, records the reason, and answers the same for unknown and revoked sessions', async () => {
      const userId = await seedActiveUser(database);
      const { session: created } = await createSession(db(), {
        userId,
        method: 'password',
        now: T0,
      });
      const revoke = () =>
        revokeSession(db(), created.id, { reason: 'logout', now: at(MINUTE) });
      expect(await revoke()).toBe(true);
      const row = await sessionRow(created.id);
      expect(row.revokedAt).toEqual(at(MINUTE));
      expect(row.revokedReason).toBe('logout');
      expect(await revoke()).toBe(false);
      expect(
        await revokeSession(db(), newId(), {
          reason: 'logout',
          now: at(MINUTE),
        }),
      ).toBe(false);
      // The first revocation stands; a second does not overwrite it.
      expect((await sessionRow(created.id)).revokedAt).toEqual(at(MINUTE));
    });

    it('accepts user-revoked, the reason when a user ends another of their own sessions, and records it', async () => {
      const userId = await seedActiveUser(database);
      const mine = await createSession(db(), {
        userId,
        method: 'password',
        now: T0,
      });
      const other = await createSession(db(), {
        userId,
        method: 'passkey',
        now: T0,
      });
      expect(
        await revokeSession(db(), other.session.id, {
          reason: 'user-revoked',
          now: at(MINUTE),
        }),
      ).toBe(true);
      expect((await sessionRow(other.session.id)).revokedReason).toBe(
        'user-revoked',
      );
      expect(await validateSession(db(), other.token, at(MINUTE))).toBeNull();
      // The session that did the revoking is untouched.
      expect(
        await validateSession(db(), mine.token, at(MINUTE)),
      ).not.toBeNull();
    });

    it('refuses a reason that is not on the list', async () => {
      const userId = await seedActiveUser(database);
      const { session: created } = await createSession(db(), {
        userId,
        method: 'password',
        now: T0,
      });
      for (const reason of ['because', '', '__proto__', 'toString']) {
        await expect(
          revokeSession(db(), created.id, { reason: reason as never, now: T0 }),
        ).rejects.toBeInstanceOf(AuthInputError);
      }
      expect((await sessionRow(created.id)).revokedAt).toBeNull();
    });
  });

  describe('revokeUserSessions', () => {
    it('revokes all live sessions of the user but the excepted one, and no one else’s', async () => {
      const userId = await seedActiveUser(database);
      const other = await seedActiveUser(database);
      const make = (id: string) =>
        createSession(db(), { userId: id, method: 'password', now: T0 });
      const [a, b, c] = [
        await make(userId),
        await make(userId),
        await make(userId),
      ];
      const theirs = await make(other);
      const revoked = await revokeUserSessions(db(), userId, {
        reason: 'password-changed',
        exceptSessionId: b.session.id,
        now: at(MINUTE),
      });
      expect(revoked).toBe(2);
      expect(await validateSession(db(), b.token, at(MINUTE))).not.toBeNull();
      expect(await validateSession(db(), a.token, at(MINUTE))).toBeNull();
      expect(await validateSession(db(), c.token, at(MINUTE))).toBeNull();
      expect(
        await validateSession(db(), theirs.token, at(MINUTE)),
      ).not.toBeNull();
      expect((await sessionRow(a.session.id)).revokedReason).toBe(
        'password-changed',
      );
    });

    it('revokes every session when nothing is excepted, and leaves expired and revoked ones alone', async () => {
      const userId = await seedActiveUser(database);
      const make = (now: Date) =>
        createSession(db(), { userId, method: 'password', now });
      const expired = await make(T0);
      const alreadyRevoked = await make(at(14 * HOUR));
      await revokeSession(db(), alreadyRevoked.session.id, {
        reason: 'logout',
        now: at(14 * HOUR),
      });
      const live = await make(at(14 * HOUR));
      const count = await revokeUserSessions(db(), userId, {
        reason: 'admin-action',
        now: at(15 * HOUR),
      });
      expect(count).toBe(1);
      expect((await sessionRow(live.session.id)).revokedReason).toBe(
        'admin-action',
      );
      // Expired at +12h and never revoked; the earlier revocation keeps its reason.
      expect((await sessionRow(expired.session.id)).revokedAt).toBeNull();
      expect((await sessionRow(alreadyRevoked.session.id)).revokedReason).toBe(
        'logout',
      );
    });

    it('returns 0 for a user with no sessions, and refuses an unknown reason', async () => {
      const userId = await seedActiveUser(database);
      expect(
        await revokeUserSessions(db(), userId, { reason: 'logout', now: T0 }),
      ).toBe(0);
      await expect(
        revokeUserSessions(db(), userId, { reason: 'nope' as never, now: T0 }),
      ).rejects.toBeInstanceOf(AuthInputError);
    });
  });

  describe('listUserSessions', () => {
    it('lists live sessions, most recently seen first, without the token or hash', async () => {
      const userId = await seedActiveUser(database);
      const old = await createSession(db(), {
        userId,
        method: 'password',
        userAgentSummary: 'Firefox on Windows',
        now: T0,
      });
      const recent = await createSession(db(), {
        userId,
        method: 'passkey',
        userAgentSummary: 'Safari on iPhone',
        now: at(HOUR),
      });
      const revoked = await createSession(db(), {
        userId,
        method: 'password',
        now: at(HOUR),
      });
      await revokeSession(db(), revoked.session.id, {
        reason: 'logout',
        now: at(2 * HOUR),
      });
      const listed = await listUserSessions(db(), userId, at(3 * HOUR));
      expect(listed.map((s) => s.id)).toEqual([
        recent.session.id,
        old.session.id,
      ]);
      expect(listed[0]!.userAgentSummary).toBe('Safari on iPhone');
      const text = JSON.stringify(listed);
      for (const secret of [old.token, recent.token, hashToken(old.token)]) {
        expect(text).not.toContain(secret);
      }
      expect(Object.keys(listed[0]!)).not.toContain('tokenHash');
    });

    it('leaves out a session past its idle end', async () => {
      const userId = await seedActiveUser(database);
      await createSession(db(), { userId, method: 'password', now: T0 });
      expect(await listUserSessions(db(), userId, at(12 * HOUR))).toEqual([]);
    });
  });

  describe('session scope', () => {
    it('is full unless said otherwise, and validateSession returns it', async () => {
      const userId = await seedActiveUser(database);
      const { session: created, token } = await createSession(db(), {
        userId,
        method: 'password',
        now: T0,
      });
      expect(created.scope).toBe('full');
      const found = await validateSession(db(), token, at(MINUTE));
      expect(found!.session.scope).toBe('full');
    });

    it('is recovery for a recovery session, which can never be made full', async () => {
      const userId = await seedActiveUser(database);
      const { session: created, token } = await createSession(db(), {
        userId,
        method: 'recovery',
        now: T0,
      });
      expect(created.scope).toBe('recovery');
      expect(
        (await validateSession(db(), token, at(MINUTE)))!.session.scope,
      ).toBe('recovery');
      await expect(
        createSession(db(), {
          userId,
          method: 'recovery',
          scope: 'full',
          now: T0,
        }),
      ).rejects.toMatchObject({ field: 'scope' });
    });

    it('refuses a scope that is not on the list, and writes nothing', async () => {
      const userId = await seedActiveUser(database);
      for (const scope of ['admin', '', '__proto__', 'toString']) {
        await expect(
          createSession(db(), {
            userId,
            method: 'password',
            scope: scope as never,
            now: T0,
          }),
        ).rejects.toBeInstanceOf(AuthInputError);
      }
      expect(await listUserSessions(db(), userId, T0)).toEqual([]);
    });
  });

  describe('promoteSession', () => {
    const promotions = async (sessionId: string) =>
      (await db().select().from(auditEvent)).filter(
        (event) =>
          event.category === AUTH_AUDIT.sessionPromoted &&
          event.targetId === sessionId,
      );

    it('turns a recovery session into a full one, keeping its token and its times, and audits it', async () => {
      const userId = await seedActiveUser(database);
      const { session: created, token } = await createSession(db(), {
        userId,
        method: 'recovery',
        now: T0,
      });
      expect(
        await promoteSession(db(), created.id, {
          trigger: 'password-set',
          now: at(MINUTE),
        }),
      ).toBe(true);
      const stored = await sessionRow(created.id);
      expect(stored.scope).toBe('full');
      // How the user got in does not change.
      expect(stored.method).toBe('recovery');
      expect(stored.absoluteExpiresAt).toEqual(created.absoluteExpiresAt);
      const found = await validateSession(db(), token, at(2 * MINUTE));
      expect(found!.session.scope).toBe('full');
      const [event] = await promotions(created.id);
      expect(event).toMatchObject({
        action: 'promote',
        actorType: 'user',
        actorId: userId,
        targetType: 'session',
        details: { from: 'recovery', to: 'full', trigger: 'password-set' },
      });
    });

    it('answers false and writes nothing for a full, revoked or unknown session', async () => {
      const userId = await seedActiveUser(database);
      const full = await createSession(db(), {
        userId,
        method: 'password',
        now: T0,
      });
      const revoked = await createSession(db(), {
        userId,
        method: 'recovery',
        now: T0,
      });
      await revokeSession(db(), revoked.session.id, {
        reason: 'logout',
        now: at(MINUTE),
      });
      for (const id of [full.session.id, revoked.session.id, newId()]) {
        expect(
          await promoteSession(db(), id, {
            trigger: 'totp-confirmed',
            now: at(2 * MINUTE),
          }),
        ).toBe(false);
        expect(await promotions(id)).toEqual([]);
      }
      expect((await sessionRow(revoked.session.id)).scope).toBe('recovery');
    });

    it('refuses a trigger that is not on the list', async () => {
      const userId = await seedActiveUser(database);
      const { session: created } = await createSession(db(), {
        userId,
        method: 'recovery',
        now: T0,
      });
      await expect(
        promoteSession(db(), created.id, {
          trigger: 'because' as never,
          now: T0,
        }),
      ).rejects.toBeInstanceOf(AuthInputError);
      expect((await sessionRow(created.id)).scope).toBe('recovery');
    });
  });

  describe('disableUser and enableUser', () => {
    const statusOf = async (userId: string) =>
      (await db().select().from(user).where(eq(user.id, userId)))[0]!;

    it('disabling revokes every session and bumps the version', async () => {
      const userId = await seedActiveUser(database);
      const first = await createSession(db(), {
        userId,
        method: 'password',
        now: T0,
      });
      const second = await createSession(db(), {
        userId,
        method: 'passkey',
        now: T0,
      });
      const before = await statusOf(userId);
      expect(await disableUser(db(), userId, { now: at(MINUTE) })).toBe(true);
      const after = await statusOf(userId);
      expect(after.status).toBe('disabled');
      expect(after.version).toBe(before.version + 1);
      expect(after.updatedAt).toEqual(at(MINUTE));
      for (const { token, session: s } of [first, second]) {
        expect(await validateSession(db(), token, at(MINUTE))).toBeNull();
        const row = await sessionRow(s.id);
        expect(row.revokedReason).toBe('user-disabled');
        expect(row.revokedAt).toEqual(at(MINUTE));
      }
    });

    it('blocks a new login while disabled, and allows one after enabling, but not the old sessions', async () => {
      const userId = await seedActiveUser(database);
      const old = await createSession(db(), {
        userId,
        method: 'password',
        now: T0,
      });
      await disableUser(db(), userId, { now: at(MINUTE) });
      await expect(
        createSession(db(), {
          userId,
          method: 'password',
          now: at(2 * MINUTE),
        }),
      ).rejects.toMatchObject({ reason: 'user-disabled' });
      expect(await enableUser(db(), userId, { now: at(3 * MINUTE) })).toBe(
        true,
      );
      expect((await statusOf(userId)).status).toBe('active');
      expect(await validateSession(db(), old.token, at(4 * MINUTE))).toBeNull();
      const fresh = await createSession(db(), {
        userId,
        method: 'password',
        now: at(5 * MINUTE),
      });
      expect(
        await validateSession(db(), fresh.token, at(5 * MINUTE)),
      ).not.toBeNull();
    });

    it('does nothing the second time', async () => {
      const userId = await seedActiveUser(database);
      expect(await disableUser(db(), userId, { now: T0 })).toBe(true);
      const version = (await statusOf(userId)).version;
      expect(await disableUser(db(), userId, { now: at(MINUTE) })).toBe(false);
      expect((await statusOf(userId)).version).toBe(version);
      expect(await enableUser(db(), userId, { now: at(MINUTE) })).toBe(true);
      expect(await enableUser(db(), userId, { now: at(2 * MINUTE) })).toBe(
        false,
      );
    });

    it('leaves an invited user invited when asked to enable them', async () => {
      const userId = await seedUserWithStatus(database, 'invited');
      expect(await enableUser(db(), userId, { now: T0 })).toBe(false);
      expect((await statusOf(userId)).status).toBe('invited');
    });

    it('refuses an unknown user', async () => {
      for (const action of [disableUser, enableUser]) {
        await expect(action(db(), newId(), { now: T0 })).rejects.toMatchObject({
          reason: 'user-not-found',
        });
      }
    });
  });

  it('leaves no raw token in any table after the flows above', async () => {
    const userId = await seedActiveUser(database);
    const { token } = await createSession(db(), {
      userId,
      method: 'password',
      now: T0,
    });
    await validateSession(db(), token, at(2 * MINUTE));
    await revokeUserSessions(db(), userId, { reason: 'logout', now: at(HOUR) });
    expect(await everyRowAsText(database)).not.toContain(token);
  });
});
