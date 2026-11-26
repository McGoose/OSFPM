import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedUser } from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import { apiToken, auditEvent, session } from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import type { AdminPerson } from './admin-report.js';
import {
  listUsersWithLiveAccess,
  revokeSessionsOfPerson,
} from './admin-sessions.js';
import { AUTH_AUDIT } from './shared.js';
import {
  emailOf,
  markUserDeleted,
  seedApiToken,
  seedMembership,
  seedResetScene,
  seedSession,
  setUserStatus,
  type ResetScene,
} from './test-support.js';

/**
 * What the admin command `revoke-sessions` asks of the core (P-09a2, decision D-81):
 * end every live session of one person, and with the flag their live personal API
 * tokens too, and list who has anything live for `--all`. The lock the command takes
 * on the person's user row is shown against `createApiToken` on PostgreSQL in
 * `session-revocation-locks.test.ts`. The totals event is the command's own, written
 * by the API package, and is tested there.
 */

const T0 = new Date('2026-03-02T09:00:00.000Z');
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const at = (ms: number) => new Date(T0.getTime() + ms);

const byId = (userId: string): AdminPerson => ({ kind: 'user', userId });
const byEmail = (email: string): AdminPerson => ({ kind: 'email', email });

describe.each(testTargets)(
  'revoking sessions and tokens from the command line on $name',
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

    let clock = 0;
    /** A time no other call uses, so a revocation can be told from the ones before it. */
    const next = () => at((clock += 1) * MINUTE + 10 * DAY);

    /** A member of the organisation. */
    const person = async () => {
      const userId = await seedUser(database);
      await seedMembership(
        database,
        scene.organisationId,
        userId,
        'member',
        [],
      );
      return userId;
    };

    /**
     * A person with what a revocation has to tell apart: two live sessions, one that
     * was revoked, one that ran out, and, as tokens, one live, one expired, one revoked.
     */
    const withAccess = async () => {
      const userId = await person();
      const live = [
        await seedSession(database, userId),
        await seedSession(database, userId),
      ];
      const revoked = await seedSession(database, userId, {
        revokedAt: at(MINUTE),
        revokedReason: 'logout',
      });
      const expired = await seedSession(database, userId, {
        idleExpiresAt: at(2 * MINUTE),
        absoluteExpiresAt: at(3 * MINUTE),
      });
      const liveToken = await seedApiToken(
        database,
        scene.organisationId,
        userId,
      );
      const expiredToken = await seedApiToken(
        database,
        scene.organisationId,
        userId,
        { expiresAt: new Date('2026-02-01T00:00:00.000Z') },
      );
      const revokedToken = await seedApiToken(
        database,
        scene.organisationId,
        userId,
        {
          revokedAt: at(MINUTE),
          revokeReason: 'manual',
          revokedBy: userId,
        },
      );
      return {
        userId,
        live,
        revoked,
        expired,
        liveToken: liveToken.id,
        expiredToken: expiredToken.id,
        revokedToken: revokedToken.id,
      };
    };

    const sessionRow = async (id: string) =>
      (await db().select().from(session).where(eq(session.id, id)))[0]!;
    const tokenRow = async (id: string) =>
      (await db().select().from(apiToken).where(eq(apiToken.id, id)))[0]!;
    const audits = async (category: string) =>
      (await db().select().from(auditEvent))
        .filter((event) => event.category === category)
        .sort((a, b) => a.id.localeCompare(b.id));

    describe('one person', () => {
      it('revokes every live session with the reason admin-action, and leaves the ones that had ended, the tokens and other people alone', async () => {
        const target = await withAccess();
        const bystander = await withAccess();
        const now = next();

        const result = await revokeSessionsOfPerson(db(), byId(target.userId), {
          includeApiTokens: false,
          now,
        });

        expect(result).toEqual({
          userId: target.userId,
          sessions: 2,
          tokens: 0,
        });
        for (const id of target.live) {
          expect(await sessionRow(id)).toMatchObject({
            revokedAt: now,
            revokedReason: 'admin-action',
          });
        }
        // What had ended keeps its own reason and time.
        expect(await sessionRow(target.revoked)).toMatchObject({
          revokedAt: at(MINUTE),
          revokedReason: 'logout',
        });
        expect((await sessionRow(target.expired)).revokedAt).toBeNull();
        // Tokens are not touched unless asked for.
        expect((await tokenRow(target.liveToken)).revokedAt).toBeNull();
        // Nor is anyone else.
        for (const id of bystander.live) {
          expect((await sessionRow(id)).revokedAt).toBeNull();
        }
        expect((await tokenRow(bystander.liveToken)).revokedAt).toBeNull();
      });

      it('finds the person by the address as typed', async () => {
        const target = await withAccess();
        const email = await emailOf(database, target.userId);

        const result = await revokeSessionsOfPerson(
          db(),
          byEmail(`  ${email.toUpperCase()} `),
          { includeApiTokens: false, now: next() },
        );

        expect(result).toEqual({
          userId: target.userId,
          sessions: 2,
          tokens: 0,
        });
      });

      it('writes the sessions’ own event once, from the system, with the reason and the count, and no address', async () => {
        const target = await withAccess();
        const email = await emailOf(database, target.userId);
        const before = (await audits(AUTH_AUDIT.sessionsRevoked)).length;
        const now = next();

        await revokeSessionsOfPerson(db(), byEmail(email), {
          includeApiTokens: false,
          now,
        });

        const events = (await audits(AUTH_AUDIT.sessionsRevoked)).slice(before);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          action: 'revoke-all',
          actorType: 'system',
          actorId: null,
          targetType: 'user',
          targetId: target.userId,
          occurredAt: now,
          details: { reason: 'admin-action', count: 2 },
        });
        expect(JSON.stringify(events)).not.toContain(email);
        // The command's own event is not written here.
        expect(await audits(AUTH_AUDIT.adminCommandRun)).toEqual([]);
      });

      it('writes nothing for a person who has nothing live', async () => {
        const quiet = await person();
        const before = (await db().select().from(auditEvent)).length;

        expect(
          await revokeSessionsOfPerson(db(), byId(quiet), {
            includeApiTokens: true,
            now: next(),
          }),
        ).toEqual({ userId: quiet, sessions: 0, tokens: 0 });

        expect(await db().select().from(auditEvent)).toHaveLength(before);
      });

      it('ends the live personal API tokens too when asked: the reason admin-action, nobody named, expired and revoked ones left alone', async () => {
        const target = await withAccess();
        const bystander = await withAccess();
        const now = next();

        const result = await revokeSessionsOfPerson(db(), byId(target.userId), {
          includeApiTokens: true,
          now,
        });

        expect(result).toEqual({
          userId: target.userId,
          sessions: 2,
          tokens: 1,
        });
        expect(await tokenRow(target.liveToken)).toMatchObject({
          revokedAt: now,
          revokeReason: 'admin-action',
          revokedBy: null,
          version: 2,
        });
        // A token that had run out, and one that was revoked, are as they were.
        expect(await tokenRow(target.expiredToken)).toMatchObject({
          revokedAt: null,
          revokeReason: null,
        });
        expect(await tokenRow(target.revokedToken)).toMatchObject({
          revokedAt: at(MINUTE),
          revokeReason: 'manual',
        });
        expect((await tokenRow(bystander.liveToken)).revokedAt).toBeNull();
      });

      it('writes one event for the tokens it ended, as it does for the sessions: from the system, about the person, with the reason and the count, and nothing that names a token', async () => {
        const target = await withAccess();
        // Three live tokens against two live sessions, so the count in the event can
        // only be the tokens'.
        const more = [
          await seedApiToken(database, scene.organisationId, target.userId),
          await seedApiToken(database, scene.organisationId, target.userId),
        ];
        const before = (await audits(AUTH_AUDIT.apiTokensRevoked)).length;
        const now = next();

        await revokeSessionsOfPerson(db(), byId(target.userId), {
          includeApiTokens: true,
          now,
        });

        const events = (await audits(AUTH_AUDIT.apiTokensRevoked)).slice(
          before,
        );
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          action: 'revoke-all',
          actorType: 'system',
          actorId: null,
          targetType: 'user',
          targetId: target.userId,
          organisationId: null,
          occurredAt: now,
        });
        // Exactly the reason and the count.
        expect(events[0]!.details).toEqual({
          reason: 'admin-action',
          count: 3,
        });
        const text = JSON.stringify(events);
        for (const id of [target.liveToken, ...more.map((row) => row.id)]) {
          const row = await tokenRow(id);
          expect(text).not.toContain(row.id);
          expect(text).not.toContain(row.prefix);
          expect(text).not.toContain(row.tokenHash);
        }
      });

      it('writes the tokens event for a person who holds only a token, and no sessions event for them', async () => {
        const tokenOnly = await person();
        await seedApiToken(database, scene.organisationId, tokenOnly);
        const tokenEvents = (await audits(AUTH_AUDIT.apiTokensRevoked)).length;
        const sessionEvents = (await audits(AUTH_AUDIT.sessionsRevoked)).length;

        const result = await revokeSessionsOfPerson(db(), byId(tokenOnly), {
          includeApiTokens: true,
          now: next(),
        });

        expect(result).toEqual({ userId: tokenOnly, sessions: 0, tokens: 1 });
        const events = (await audits(AUTH_AUDIT.apiTokensRevoked)).slice(
          tokenEvents,
        );
        expect(events.map((event) => event.targetId)).toEqual([tokenOnly]);
        expect(events[0]!.details).toEqual({
          reason: 'admin-action',
          count: 1,
        });
        expect(await audits(AUTH_AUDIT.sessionsRevoked)).toHaveLength(
          sessionEvents,
        );
      });

      it('writes no tokens event when it was not asked to end the tokens, though the person has a live one', async () => {
        const target = await withAccess();
        const before = (await audits(AUTH_AUDIT.apiTokensRevoked)).length;

        await revokeSessionsOfPerson(db(), byId(target.userId), {
          includeApiTokens: false,
          now: next(),
        });

        expect(await audits(AUTH_AUDIT.apiTokensRevoked)).toHaveLength(before);
        expect((await tokenRow(target.liveToken)).revokedAt).toBeNull();
      });

      it('writes no tokens event for a person whose tokens had all ended already, and still writes the sessions’ own', async () => {
        const target = await person();
        await seedSession(database, target);
        await seedApiToken(database, scene.organisationId, target, {
          expiresAt: new Date('2026-02-01T00:00:00.000Z'),
        });
        await seedApiToken(database, scene.organisationId, target, {
          revokedAt: at(MINUTE),
          revokeReason: 'manual',
          revokedBy: target,
        });
        const tokenEvents = (await audits(AUTH_AUDIT.apiTokensRevoked)).length;
        const sessionEvents = (await audits(AUTH_AUDIT.sessionsRevoked)).length;

        const result = await revokeSessionsOfPerson(db(), byId(target), {
          includeApiTokens: true,
          now: next(),
        });

        expect(result).toEqual({ userId: target, sessions: 1, tokens: 0 });
        expect(await audits(AUTH_AUDIT.apiTokensRevoked)).toHaveLength(
          tokenEvents,
        );
        expect(await audits(AUTH_AUDIT.sessionsRevoked)).toHaveLength(
          sessionEvents + 1,
        );
      });

      it('answers null for an address no one has, an id no one has, text that is no id and a deleted account, and writes nothing', async () => {
        const deleted = await withAccess();
        await markUserDeleted(database, deleted.userId, at(HOUR));
        const before = JSON.stringify([
          await db().select().from(session),
          await db().select().from(auditEvent),
        ]);

        for (const who of [
          byEmail('nobody.here@example.test'),
          byEmail(''),
          byId('01a21347-bb08-7167-bc54-000000000000'),
          byId('not-an-id'),
          byId(deleted.userId),
        ]) {
          expect(
            await revokeSessionsOfPerson(db(), who, {
              includeApiTokens: true,
              now: next(),
            }),
            JSON.stringify(who),
          ).toBeNull();
        }

        expect(
          JSON.stringify([
            await db().select().from(session),
            await db().select().from(auditEvent),
          ]),
        ).toBe(before);
      });

      it('still ends the sessions of an account that is disabled', async () => {
        const target = await withAccess();
        await setUserStatus(database, target.userId, 'disabled');

        expect(
          await revokeSessionsOfPerson(db(), byId(target.userId), {
            includeApiTokens: false,
            now: next(),
          }),
        ).toEqual({ userId: target.userId, sessions: 2, tokens: 0 });
      });
    });

    describe('who has anything live', () => {
      it('lists, in id order, the people with a live session, and not those whose sessions have all ended or run out', async () => {
        const live = await withAccess();
        const alsoLive = await person();
        await seedSession(database, alsoLive);
        const ended = await person();
        await seedSession(database, ended, {
          revokedAt: at(MINUTE),
          revokedReason: 'logout',
        });
        await seedSession(database, ended, {
          idleExpiresAt: at(2 * MINUTE),
          absoluteExpiresAt: at(3 * MINUTE),
        });
        const now = next();

        const ids = await listUsersWithLiveAccess(db(), {
          includeApiTokens: false,
          now,
        });

        expect(ids).toEqual([...ids].sort());
        expect(ids).toContain(live.userId);
        expect(ids).toContain(alsoLive);
        expect(ids).not.toContain(ended);
        // Once each, however many sessions.
        expect(ids.filter((id) => id === live.userId)).toHaveLength(1);
      });

      it('lists people with only a live token only when tokens are asked for', async () => {
        const tokenOnly = await person();
        await seedApiToken(database, scene.organisationId, tokenOnly);
        const now = next();

        expect(
          await listUsersWithLiveAccess(db(), { includeApiTokens: false, now }),
        ).not.toContain(tokenOnly);
        expect(
          await listUsersWithLiveAccess(db(), { includeApiTokens: true, now }),
        ).toContain(tokenOnly);
      });

      it('leaves out a person whose only token has expired or been revoked', async () => {
        const nobody = await person();
        await seedApiToken(database, scene.organisationId, nobody, {
          expiresAt: new Date('2026-02-01T00:00:00.000Z'),
        });
        await seedApiToken(database, scene.organisationId, nobody, {
          revokedAt: at(MINUTE),
          revokeReason: 'manual',
          revokedBy: nobody,
        });

        expect(
          await listUsersWithLiveAccess(db(), {
            includeApiTokens: true,
            now: next(),
          }),
        ).not.toContain(nobody);
      });

      it('leaves out a deleted account: it cannot sign in, so what it holds is of no use to anyone', async () => {
        const gone = await withAccess();
        await markUserDeleted(database, gone.userId, at(HOUR));

        expect(
          await listUsersWithLiveAccess(db(), {
            includeApiTokens: true,
            now: next(),
          }),
        ).not.toContain(gone.userId);
      });

      it('names a person once when they have both a session and a token', async () => {
        const both = await withAccess();

        const ids = await listUsersWithLiveAccess(db(), {
          includeApiTokens: true,
          now: next(),
        });

        expect(ids.filter((id) => id === both.userId)).toHaveLength(1);
      });
    });
  },
);
