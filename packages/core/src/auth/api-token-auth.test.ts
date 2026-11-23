import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../db/client.js';
import {
  apiToken,
  auditEvent,
  orgMembership,
  settingValue,
  user,
} from '../db/schema/index.js';
import { createMigratedDatabase, testTargets } from '../db/test-support.js';
import {
  ApiTokenInvalidError,
  API_TOKEN_FAILURE_REASONS,
} from './api-token-errors.js';
import {
  authenticateApiToken,
  createApiToken,
  recordApiTokenCall,
  revokeOwnApiToken,
  setApiTokenSwitches,
  type CreateApiTokenInput,
} from './api-tokens.js';
import { AuthInputError } from './errors.js';
import { AUTH_AUDIT } from './shared.js';
import {
  everyRowAsText,
  markUserDeleted,
  seedTokenScene,
  setMembershipStatus,
  setUserStatus,
  type TokenScene,
} from './test-support.js';
import { hashToken } from './tokens.js';

/**
 * Using a personal API token: `authenticateApiToken` answers the credential or one
 * answer for every way a token can be no good, and `recordApiTokenCall` writes the
 * audit event of an outside call (SC-10, decisions D-17 and D-68).
 */

const T0 = new Date('2026-03-02T09:00:00.000Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;
const at = (ms: number) => new Date(T0.getTime() + ms);

/** A time no other test uses, for making things and finding their audit events. */
let clock = 0;
const next = () => at((clock += 1) * MINUTE);

describe.each(testTargets)('using a personal API token on $name', (target) => {
  let database: Database;
  let cleanup: () => Promise<void>;
  let scene: TokenScene;

  beforeAll(async () => {
    ({ database, cleanup } = await createMigratedDatabase(target));
    scene = await seedTokenScene(database, T0);
  });
  afterAll(async () => {
    await cleanup();
  });
  /** Puts back what a test changed about the people who own tokens. */
  const restorePeople = async () => {
    for (const userId of [scene.tokensId, scene.medicalId]) {
      await setUserStatus(database, userId, 'active');
      await setMembershipStatus(
        database,
        scene.organisationId,
        userId,
        'active',
      );
      await database.db
        .update(user)
        .set({ deletedAt: null })
        .where(eq(user.id, userId));
    }
    await database.db
      .update(orgMembership)
      .set({ deletedAt: null })
      .where(eq(orgMembership.organisationId, scene.organisationId));
  };
  afterEach(async () => {
    await database.db.delete(apiToken);
    await database.db.delete(settingValue);
    await restorePeople();
  });

  const db = () => database.db;
  const turn = (personalTokens: boolean, sensitive = false) =>
    db().transaction((tx) =>
      setApiTokenSwitches(
        tx,
        { userId: scene.ownerId },
        scene.organisationId,
        { personalTokens, sensitive },
        next(),
      ),
    );
  const make = (
    userId: string,
    input: Partial<CreateApiTokenInput> = {},
    now = next(),
  ) =>
    db().transaction((tx) =>
      createApiToken(
        tx,
        { userId },
        scene.organisationId,
        { name: 'Call sheet export', access: 'read', ...input },
        now,
      ),
    );
  /** What the API plugin does: the failure's audit event is committed, then it is answered. */
  const authenticate = (
    token: string,
    now: Date,
    options: { organisationId?: string; auditFailure?: boolean } = {},
  ) =>
    db().transaction(async (tx) => {
      try {
        return {
          ok: true as const,
          found: await authenticateApiToken(tx, token, now, options),
        };
      } catch (error) {
        if (error instanceof ApiTokenInvalidError) {
          return { ok: false as const, error };
        }
        throw error;
      }
    });
  const failuresAt = async (now: Date) =>
    (await db().select().from(auditEvent)).filter(
      (event) =>
        event.category === AUTH_AUDIT.apiTokenAuthFailed &&
        event.occurredAt.getTime() === now.getTime(),
    );

  describe('authenticateApiToken', () => {
    it('answers the credential of a live token and the user who owns it, and writes no audit event', async () => {
      await turn(true, true);
      const made = await make(scene.medicalId, {
        access: 'write',
        projectId: scene.projectId,
        sensitivePermissions: ['sensitive:read:medical'],
        expiresInDays: 30,
      });
      const now = next();
      const result = await authenticate(made.token, now);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.found.credential).toEqual({
        kind: 'token',
        tokenId: made.apiToken.id,
        organisationId: scene.organisationId,
        projectId: scene.projectId,
        access: 'write',
        sensitivePermissions: ['sensitive:read:medical'],
      });
      expect(result.found.user).toMatchObject({
        id: scene.medicalId,
        status: 'active',
      });
      expect(Object.keys(result.found.user).sort()).toEqual(
        ['displayName', 'email', 'id', 'locale', 'status', 'timezone'].sort(),
      );
      expect(JSON.stringify(result.found)).not.toContain(made.token);
      expect(await failuresAt(now)).toEqual([]);
    });

    it('accepts a token that never expires, and one used with the switches’ sensitive half off if it has no scope', async () => {
      await turn(true, true);
      const never = await make(scene.tokensId, { noExpiry: true });
      const farAway = at(5 * 365 * DAY);
      expect((await authenticate(never.token, farAway)).ok).toBe(true);
      // The sensitive switch off does not touch a token that has no sensitive scope.
      await turn(true, false);
      expect((await authenticate(never.token, farAway)).ok).toBe(true);
    });

    it('writes last_used_at at most once a minute', async () => {
      await turn(true);
      const made = await make(scene.tokensId);
      const row = async () =>
        (await db().select().from(apiToken)).find(
          (candidate) => candidate.id === made.apiToken.id,
        )!;
      const start = next();
      await authenticate(made.token, start);
      expect((await row()).lastUsedAt).toEqual(start);
      const updatedAt = (await row()).updatedAt;
      // Inside the minute: nothing is written.
      await authenticate(made.token, new Date(start.getTime() + 30 * SECOND));
      expect((await row()).lastUsedAt).toEqual(start);
      expect((await row()).updatedAt).toEqual(updatedAt);
      // A minute on, it is written again.
      const later = new Date(start.getTime() + MINUTE);
      await authenticate(made.token, later);
      expect((await row()).lastUsedAt).toEqual(later);
      // Writing it is no edit of the token.
      expect((await row()).version).toBe(1);
    });

    describe('refusals', () => {
      /** Every way a token is no good, each made in turn, with what the audit event should say. */
      const refusals: {
        reason: (typeof API_TOKEN_FAILURE_REASONS)[number];
        /** Makes a token that is no good for this reason, and answers it. */
        spoil: () => Promise<{
          token: string;
          id: string | null;
          now: Date;
          /** The organisation the request names in its path, when it does. */
          organisationId?: string;
        }>;
      }[] = [
        {
          reason: 'unknown',
          spoil: () =>
            Promise.resolve({
              token: `osfpm_pat_${'A'.repeat(43)}`,
              id: null,
              now: next(),
            }),
        },
        {
          reason: 'expired',
          spoil: async () => {
            const made = await make(scene.tokensId, { expiresInDays: 1 });
            // Ending exactly now counts as expired.
            return {
              token: made.token,
              id: made.apiToken.id,
              now: made.apiToken.expiresAt!,
            };
          },
        },
        {
          reason: 'revoked',
          spoil: async () => {
            const made = await make(scene.tokensId);
            await db().transaction((tx) =>
              revokeOwnApiToken(
                tx,
                { userId: scene.tokensId },
                scene.organisationId,
                made.apiToken.id,
                next(),
              ),
            );
            return { token: made.token, id: made.apiToken.id, now: next() };
          },
        },
        {
          // A revocation that was missed: the switch is off and the token is not revoked.
          reason: 'switch-off',
          spoil: async () => {
            const made = await make(scene.tokensId);
            await db().update(settingValue).set({ value: false });
            return { token: made.token, id: made.apiToken.id, now: next() };
          },
        },
        {
          reason: 'sensitive-switch-off',
          spoil: async () => {
            const made = await make(scene.medicalId, {
              sensitivePermissions: ['sensitive:read:medical'],
            });
            await db()
              .update(settingValue)
              .set({ value: false })
              .where(eq(settingValue.key, 'api.personal-tokens.sensitive'));
            return { token: made.token, id: made.apiToken.id, now: next() };
          },
        },
        {
          // The request names another organisation in its path than the token's.
          reason: 'wrong-organisation',
          spoil: async () => {
            const made = await make(scene.tokensId);
            return {
              token: made.token,
              id: made.apiToken.id,
              now: next(),
              organisationId: scene.otherOrganisationId,
            };
          },
        },
        {
          reason: 'user-not-active',
          spoil: async () => {
            const made = await make(scene.tokensId);
            await setUserStatus(database, scene.tokensId, 'disabled');
            return { token: made.token, id: made.apiToken.id, now: next() };
          },
        },
        {
          reason: 'user-not-active',
          spoil: async () => {
            const made = await make(scene.tokensId);
            await markUserDeleted(database, scene.tokensId);
            return { token: made.token, id: made.apiToken.id, now: next() };
          },
        },
        {
          reason: 'membership-not-active',
          spoil: async () => {
            const made = await make(scene.tokensId);
            await setMembershipStatus(
              database,
              scene.organisationId,
              scene.tokensId,
              'removed',
            );
            return { token: made.token, id: made.apiToken.id, now: next() };
          },
        },
        {
          reason: 'membership-not-active',
          spoil: async () => {
            const made = await make(scene.tokensId);
            await setMembershipStatus(
              database,
              scene.organisationId,
              scene.tokensId,
              'invited',
            );
            return { token: made.token, id: made.apiToken.id, now: next() };
          },
        },
        {
          reason: 'membership-not-active',
          spoil: async () => {
            const made = await make(scene.tokensId);
            await db()
              .update(orgMembership)
              .set({ deletedAt: new Date() })
              .where(
                and(
                  eq(orgMembership.organisationId, scene.organisationId),
                  eq(orgMembership.userId, scene.tokensId),
                ),
              );
            return { token: made.token, id: made.apiToken.id, now: next() };
          },
        },
      ];

      it('lists every reason the audit trail can give, and each case below uses one of them', () => {
        expect(
          [...new Set(refusals.map((refusal) => refusal.reason))].sort(),
        ).toEqual([...API_TOKEN_FAILURE_REASONS].sort());
      });

      it('is one answer for all of them, and the audit event says which', async () => {
        const answers = new Set<string>();
        for (const refusal of refusals) {
          await turn(true, true);
          const { token, id, now, organisationId } = await refusal.spoil();
          const result = await authenticate(
            token,
            now,
            organisationId === undefined ? {} : { organisationId },
          );
          expect(result.ok, refusal.reason).toBe(false);
          if (result.ok) continue;
          expect(result.error).toBeInstanceOf(ApiTokenInvalidError);
          expect(result.error.reason).toBe(refusal.reason);
          answers.add(`${result.error.name}: ${result.error.message}`);

          // The event was written before the error was thrown, and committed.
          const events = await failuresAt(now);
          expect(events, refusal.reason).toHaveLength(1);
          expect(events[0]).toMatchObject({
            actorType: 'system',
            actorId: null,
            targetType: id === null ? null : 'api_token',
            targetId: id,
            organisationId: id === null ? null : scene.organisationId,
            details: { reason: refusal.reason },
          });
          const text = JSON.stringify(events[0]);
          expect(text).not.toContain(token);
          expect(text).not.toContain(hashToken(token));
          expect(text).not.toContain(token.slice(10));
          await db().delete(apiToken);
          await db().delete(settingValue);
          await restorePeople();
        }
        // One message for every cause: nothing in it says which.
        expect(answers.size).toBe(1);
        expect([...answers][0]).not.toMatch(
          /unknown|expired|revoked|switch|user|member|sensitive/i,
        );
      });

      it('writes no audit event when the caller says the address is over its limit, and refuses all the same', async () => {
        await turn(true);
        const revoked = await make(scene.tokensId);
        await db().transaction((tx) =>
          revokeOwnApiToken(
            tx,
            { userId: scene.tokensId },
            scene.organisationId,
            revoked.apiToken.id,
            next(),
          ),
        );
        const failures = async () =>
          (await db().select().from(auditEvent)).filter(
            (event) => event.category === AUTH_AUDIT.apiTokenAuthFailed,
          ).length;
        const before = await failures();
        for (const token of [
          revoked.token,
          `osfpm_pat_${'Q'.repeat(43)}`,
          'not-a-token',
        ]) {
          const now = next();
          const result = await authenticate(token, now, {
            auditFailure: false,
          });
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error).toBeInstanceOf(ApiTokenInvalidError);
          }
          expect(await failuresAt(now)).toEqual([]);
        }
        expect(await failures()).toBe(before);
        // Left out or true, the refusal is written as ever.
        const now = next();
        await authenticate(revoked.token, now, { auditFailure: true });
        expect(await failuresAt(now)).toHaveLength(1);
        // A token that works is answered whatever the flag says.
        const good = await make(scene.tokensId);
        expect(
          (await authenticate(good.token, next(), { auditFailure: false })).ok,
        ).toBe(true);
      });

      it('refuses a value that cannot be a token without looking it up, as unknown', async () => {
        const noise = [
          '',
          'osfpm_pat_',
          `osfpm_pat_${'A'.repeat(42)}`,
          `osfpm_pat_${'A'.repeat(44)}`,
          `osfpm_pat_${'A'.repeat(42)}!`,
          `OSFPM_PAT_${'A'.repeat(43)}`,
          'A'.repeat(43),
          'x'.repeat(10_000),
          7,
          null,
          undefined,
          { token: 'x' },
        ];
        for (const token of noise) {
          const now = next();
          const result = await authenticate(token as never, now);
          expect(result.ok).toBe(false);
          if (result.ok) continue;
          expect(result.error.reason).toBe('unknown');
          const events = await failuresAt(now);
          expect(events).toHaveLength(1);
          expect(events[0]).toMatchObject({
            targetId: null,
            organisationId: null,
            details: { reason: 'unknown' },
          });
          // The event holds none of what was sent.
          if (typeof token === 'string' && token.length > 3) {
            expect(JSON.stringify(events[0])).not.toContain(token);
          }
        }
      });

      it('does not write last_used_at for a token it refuses', async () => {
        await turn(true);
        const made = await make(scene.tokensId, { expiresInDays: 1 });
        await authenticate(made.token, made.apiToken.expiresAt!);
        expect(
          (await db().select().from(apiToken)).find(
            (row) => row.id === made.apiToken.id,
          )!.lastUsedAt,
        ).toBeNull();
      });

      it('keeps refusing a token after its organisation turned tokens off and on again: the switch restores nothing', async () => {
        await turn(true);
        const made = await make(scene.tokensId);
        expect((await authenticate(made.token, next())).ok).toBe(true);
        await turn(false);
        // The switch revoked it, so it is refused, and it stays refused when the
        // switch is turned back on.
        const off = await authenticate(made.token, next());
        expect(off.ok).toBe(false);
        await turn(true);
        const on = await authenticate(made.token, next());
        expect(on.ok).toBe(false);
        if (!on.ok) expect(on.error.reason).toBe('revoked');
      });
    });

    it('never stores or audits the token, in any table', async () => {
      await turn(true, true);
      const made = await make(scene.medicalId, {
        sensitivePermissions: ['sensitive:read:medical'],
      });
      await authenticate(made.token, next());
      await authenticate(`${made.token}x`, next());
      const everything = await everyRowAsText(database);
      expect(everything).not.toContain(made.token);
      expect(everything).not.toContain(made.token.slice('osfpm_pat_'.length));
    });
  });

  describe('recordApiTokenCall', () => {
    const credentialOf = async (
      overrides: Partial<CreateApiTokenInput> = {},
    ) => {
      const made = await make(scene.tokensId, overrides);
      const result = await authenticate(made.token, next());
      if (!result.ok) throw new Error('the token was refused');
      return { made, credential: result.found.credential };
    };
    const callsAt = async (now: Date) =>
      (await db().select().from(auditEvent)).filter(
        (event) =>
          event.category === AUTH_AUDIT.apiCall &&
          event.occurredAt.getTime() === now.getTime(),
      );

    it('writes one event with the token, its owner, the organisation, the method, the route pattern and the status, and nothing else', async () => {
      await turn(true);
      const { made, credential } = await credentialOf();
      const now = next();
      await db().transaction((tx) =>
        recordApiTokenCall(
          tx,
          credential,
          {
            userId: scene.tokensId,
            method: 'GET',
            route: '/api/v1/organisations/:organisationId/members',
            status: 200,
            requestId: '0199a3c4-0000-7000-8000-000000000001',
          },
          now,
        ),
      );
      const events = await callsAt(now);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        category: 'api.call',
        action: 'call',
        organisationId: scene.organisationId,
        actorType: 'token',
        actorId: made.apiToken.id,
        targetType: 'api_token',
        targetId: made.apiToken.id,
        requestId: '0199a3c4-0000-7000-8000-000000000001',
        details: {
          userId: scene.tokensId,
          method: 'GET',
          route: '/api/v1/organisations/:organisationId/members',
          status: 200,
        },
      });
      expect(Object.keys(events[0]!.details!).sort()).toEqual([
        'method',
        'route',
        'status',
        'userId',
      ]);
      expect(JSON.stringify(events[0])).not.toContain(made.token);
    });

    it('refuses a method, a route or a status that the server could not have made, and writes nothing', async () => {
      await turn(true);
      const { credential } = await credentialOf();
      const good = {
        userId: scene.tokensId,
        method: 'GET',
        route: '/api/v1/meta',
        status: 200,
      };
      for (const [field, value] of [
        ['method', 'get'],
        ['method', 'BREW'],
        ['method', ''],
        ['route', ''],
        ['route', 'x'.repeat(301)],
        ['status', 99],
        ['status', 600],
        ['status', 200.5],
        ['status', '200'],
        ['userId', 'not-an-id'],
      ] as const) {
        const now = next();
        const refused = await db()
          .transaction((tx) =>
            recordApiTokenCall(
              tx,
              credential,
              { ...good, [field]: value },
              now,
            ),
          )
          .then(
            () => undefined,
            (caught: unknown) => caught,
          );
        expect(refused, `${field} ${String(value)}`).toBeInstanceOf(
          AuthInputError,
        );
        expect((refused as AuthInputError).field).toBe(field);
        expect(await callsAt(now)).toEqual([]);
      }
    });
  });
});
