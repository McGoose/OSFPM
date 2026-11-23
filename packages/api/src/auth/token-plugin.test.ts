import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createApiToken,
  revokeOwnApiToken,
  setApiTokenSwitches,
} from '@osfpm/core/src/auth/api-tokens.js';
import { createSession } from '@osfpm/core/src/auth/sessions.js';
import {
  seedTokenScene,
  setMembershipStatus,
  setUserStatus,
  type TokenScene,
} from '@osfpm/core/src/auth/test-support.js';
import { migrate } from '@osfpm/core/src/db/migrate.js';
import {
  apiToken,
  auditEvent,
  settingValue,
} from '@osfpm/core/src/db/schema/index.js';
import {
  testTargets,
  type TestTarget,
} from '@osfpm/core/src/db/test-support.js';
import { API_PREFIX } from '../api-version.js';
import { createTestApp, UUID_V7 } from '../test-support.js';
import { SESSION_COOKIE } from './cookie.js';
import { assertTokenAccessDeclaration, requireCaller } from './plugin.js';
import { AUTH_RATE_LIMIT, SESSION_RATE_LIMIT } from './rate-limit.js';

/**
 * Personal API tokens in the auth plugin (SC-10, decisions D-17 and D-68): a request
 * with `Authorization: Bearer <token>` on a route that says `tokenAccess`. Routes that
 * exist only in these tests stand for the real ones.
 */

const T0 = new Date('2026-03-02T09:00:00.000Z');
const MINUTE = 60 * 1000;
let clock = 0;
const next = () => new Date(T0.getTime() + (clock += 1) * MINUTE);

/** What a route that reads the caller says about the request. */
function describeCaller(request: FastifyRequest) {
  const caller = requireCaller(request);
  return {
    kind: caller.credential.kind,
    userId: caller.user.id,
    actor: caller.context.actor,
    onBehalfOfUserId:
      'onBehalfOfUserId' in caller.context
        ? caller.context.onBehalfOfUserId
        : null,
    credential: caller.credential,
    hasAuth: request.auth !== null,
    hasTokenAuth: request.tokenAuth !== null,
  };
}

const testRoutes: FastifyPluginAsync = (app) => {
  app.get('/test/token/read', { config: { tokenAccess: 'read' } }, (request) =>
    describeCaller(request),
  );
  app.get(
    '/test/token/read/:id',
    { config: { tokenAccess: 'read' } },
    (request) => describeCaller(request),
  );
  app.post(
    '/test/token/write',
    { config: { tokenAccess: 'write' } },
    (request) => describeCaller(request),
  );
  app.get(
    '/test/org/:organisationId/read',
    { config: { tokenAccess: 'read' } },
    (request) => describeCaller(request),
  );
  app.get(
    '/test/token/write-by-get',
    { config: { tokenAccess: 'write' } },
    (request) => describeCaller(request),
  );
  app.get(
    '/test/token/optional',
    { config: { auth: 'optional', tokenAccess: 'read' } },
    (request) => ({
      who: request.auth ? 'session' : request.tokenAuth ? 'token' : 'anonymous',
    }),
  );
  app.get(
    '/test/token/none',
    { config: { auth: 'none', tokenAccess: 'read' } },
    (request) => ({ token: request.tokenAuth !== null }),
  );
  // Routes that say nothing about tokens, so they refuse them.
  app.get('/test/no-token', (request) => ({
    signedIn: request.auth !== null,
    hasTokenAuth: request.tokenAuth !== null,
  }));
  app.post('/test/no-token', () => ({ ok: true }));
  app.get('/test/no-token-optional', { config: { auth: 'optional' } }, () => ({
    ok: true,
  }));
  app.get('/test/no-token-none', { config: { auth: 'none' } }, () => ({
    ok: true,
  }));
  return Promise.resolve();
};

describe.each(testTargets)(
  'personal API tokens in the plugin on $name',
  (target: TestTarget) => {
    let ctx: Awaited<ReturnType<typeof createTestApp>>;
    let scene: TokenScene;
    /** Every raw token made in this file, so the checks below can look for each. */
    const tokens: string[] = [];
    let addresses = 0;

    beforeAll(async () => {
      ctx = await createTestApp(target);
      await migrate(ctx.database);
      scene = await seedTokenScene(ctx.database, T0);
      await ctx.app.register(testRoutes, { prefix: API_PREFIX });
      await ctx.database.db.transaction((tx) =>
        setApiTokenSwitches(
          tx,
          { userId: scene.ownerId },
          scene.organisationId,
          { personalTokens: true, sensitive: true },
          next(),
        ),
      );
    });
    afterAll(async () => {
      await ctx.close();
    });

    /** A token made through the core, for a member of the scene. */
    async function makeToken(
      userId: string,
      input: Partial<Parameters<typeof createApiToken>[3]> = {},
    ) {
      const made = await ctx.database.db.transaction((tx) =>
        createApiToken(
          tx,
          { userId },
          scene.organisationId,
          { name: 'Call sheet export', access: 'read', ...input },
          new Date(),
        ),
      );
      tokens.push(made.token);
      return made;
    }

    /** A request from an address of its own, so the strict limit counts only what a test means it to. */
    const call = (
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      path: string,
      headers: Record<string, string> = {},
      remoteAddress?: string,
    ) =>
      ctx.app.inject({
        method,
        url: `${API_PREFIX}${path}`,
        headers,
        remoteAddress:
          remoteAddress ??
          `10.7.${Math.floor(addresses / 250)}.${(addresses += 1) % 250}`,
      });
    const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

    /** The body of a problem answer without what differs between requests. */
    const problemOf = (response: { json: () => unknown }) => {
      const body = { ...(response.json() as Record<string, unknown>) };
      delete body.requestId;
      delete body.instance;
      return body;
    };
    const auditRows = async () => ctx.database.db.select().from(auditEvent);
    const callsOf = async (tokenId: string) =>
      (await auditRows()).filter(
        (event) => event.category === 'api.call' && event.actorId === tokenId,
      );

    describe('a token on a route that accepts it', () => {
      it('puts the owner on the request as a core WriteContext of the token, and not on request.auth', async () => {
        const made = await makeToken(scene.tokensId, { access: 'write' });
        const response = await call(
          'GET',
          '/test/token/read',
          bearer(made.token),
        );
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          kind: 'token',
          userId: scene.tokensId,
          actor: { type: 'token', id: made.apiToken.id },
          onBehalfOfUserId: scene.tokensId,
          credential: {
            kind: 'token',
            tokenId: made.apiToken.id,
            organisationId: scene.organisationId,
            projectId: null,
            access: 'write',
            sensitivePermissions: [],
          },
          hasAuth: false,
          hasTokenAuth: true,
        });
        expect(response.headers['x-request-id']).toMatch(UUID_V7);
      });

      it('needs no Origin: a token is not a cookie, so there is nothing for another site to borrow', async () => {
        const made = await makeToken(scene.tokensId, { access: 'write' });
        const response = await call(
          'POST',
          '/test/token/write',
          bearer(made.token),
        );
        expect(response.statusCode).toBe(200);
        // A foreign Origin does not matter either.
        const foreign = await call('POST', '/test/token/write', {
          ...bearer(made.token),
          origin: 'https://evil.example',
        });
        expect(foreign.statusCode).toBe(200);
      });

      it('takes the scheme in any case, and refuses an empty token as a token', async () => {
        const made = await makeToken(scene.tokensId);
        for (const header of [
          `bearer ${made.token}`,
          `BEARER   ${made.token}`,
          ` Bearer ${made.token} `,
        ]) {
          const response = await call('GET', '/test/token/read', {
            authorization: header,
          });
          expect(response.statusCode, header).toBe(200);
        }
        for (const header of ['Bearer', 'Bearer ', 'Bearer  ']) {
          const response = await call('GET', '/test/token/read', {
            authorization: header,
          });
          expect(response.statusCode, header).toBe(401);
          expect(response.json<{ code: string }>().code).toBe('invalid-token');
        }
      });

      it('leaves another scheme alone, which a reverse proxy may use for its own purposes', async () => {
        const response = await call('GET', '/test/token/optional', {
          authorization: 'Basic dXNlcjpwYXNz',
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ who: 'anonymous' });
      });

      it('on an optional route, is a token when a good one is sent, and a 401 when a bad one is', async () => {
        const made = await makeToken(scene.tokensId);
        expect(
          (
            await call('GET', '/test/token/optional', bearer(made.token))
          ).json(),
        ).toEqual({
          who: 'token',
        });
        const bad = await call(
          'GET',
          '/test/token/optional',
          bearer(`osfpm_pat_${'A'.repeat(43)}`),
        );
        expect(bad.statusCode).toBe(401);
      });

      it('on a route that is auth none, answers the same with or without a token, and checks one that is sent', async () => {
        const made = await makeToken(scene.tokensId);
        expect((await call('GET', '/test/token/none')).json()).toEqual({
          token: false,
        });
        expect(
          (await call('GET', '/test/token/none', bearer(made.token))).json(),
        ).toEqual({
          token: true,
        });
        const bad = await call(
          'GET',
          '/test/token/none',
          bearer(`osfpm_pat_${'B'.repeat(43)}`),
        );
        expect(bad.statusCode).toBe(401);
        expect(bad.json<{ code: string }>().code).toBe('invalid-token');
      });
    });

    describe('a token on a route that does not accept it', () => {
      it('is a 403 token-not-accepted, whatever the route’s mode and method, before the token is looked up', async () => {
        const made = await makeToken(scene.tokensId, { access: 'write' });
        const before = (await auditRows()).length;
        for (const [method, path] of [
          ['GET', '/test/no-token'],
          ['POST', '/test/no-token'],
          ['GET', '/test/no-token-optional'],
          ['GET', '/auth/me'],
          ['POST', '/auth/logout'],
          ['GET', `/organisations/${scene.organisationId}/invites`],
        ] as const) {
          const response = await call(method, path, bearer(made.token));
          expect(response.statusCode, `${method} ${path}`).toBe(403);
          expect(response.json<{ code: string }>().code).toBe(
            'token-not-accepted',
          );
        }
        // Not even a bad token is looked up: the answer is the same, and nothing was audited.
        const bad = await call(
          'GET',
          '/test/no-token',
          bearer(`osfpm_pat_${'C'.repeat(43)}`),
        );
        expect(bad.statusCode).toBe(403);
        expect(bad.json<{ code: string }>().code).toBe('token-not-accepted');
        expect((await auditRows()).length).toBe(before);
      });

      it('is ignored on a route that is auth none and says nothing about tokens', async () => {
        const response = await call('GET', '/test/no-token-none', {
          authorization: `Bearer ${'osfpm_pat_'}${'D'.repeat(43)}`,
        });
        expect(response.statusCode).toBe(200);
        const health = await call('GET', '/health', {
          authorization: 'Bearer anything',
        });
        expect(health.statusCode).toBe(200);
      });
    });

    describe('a Bearer value that is not one of ours', () => {
      // An authenticating reverse proxy may forward its own `Authorization: Bearer <jwt>`
      // to every request. Every token OSFPM makes starts with `osfpm_pat_`, so a value
      // that does not is someone else's and is left alone, as another scheme is.
      const foreign = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJkZW1vIn0.c2lnbmF0dXJl';

      it('is left alone when a session cookie comes with it: the session works, and nothing is looked up', async () => {
        const { token: sessionToken } = await createSession(ctx.database.db, {
          userId: scene.tokensId,
          method: 'password',
          now: new Date(),
        });
        const before = (await auditRows()).length;
        for (const path of [
          '/test/no-token',
          '/test/token/read',
          '/test/token/optional',
          '/auth/me',
        ]) {
          const response = await call('GET', path, {
            authorization: `Bearer ${foreign}`,
            cookie: `${SESSION_COOKIE}=${sessionToken}`,
          });
          expect(response.statusCode, path).toBe(200);
        }
        const asSession = await call('GET', '/test/token/read', {
          authorization: `Bearer ${foreign}`,
          cookie: `${SESSION_COOKIE}=${sessionToken}`,
        });
        expect(asSession.json<{ kind: string }>().kind).toBe('session');
        expect((await auditRows()).length).toBe(before);
      });

      it('is no credential on its own: a route answers as it would with no header at all', async () => {
        for (const path of [
          '/test/no-token',
          '/test/token/read',
          '/test/token/optional',
        ]) {
          const without = await call('GET', path);
          const withForeign = await call('GET', path, {
            authorization: `Bearer ${foreign}`,
          });
          expect(withForeign.statusCode, path).toBe(without.statusCode);
          expect(problemOf(withForeign), path).toEqual(problemOf(without));
        }
        // Not a 403 token-not-accepted, and not a 401 invalid-token.
        const refused = await call('GET', '/test/no-token', {
          authorization: `Bearer ${foreign}`,
        });
        expect(refused.json<{ code: string }>().code).toBe(
          'authentication-required',
        );
        // On a route that is auth none and takes tokens, it is the same 200 as with none.
        const none = await call('GET', '/test/token/none', {
          authorization: `Bearer ${foreign}`,
        });
        expect(none.statusCode).toBe(200);
        expect(none.json()).toEqual({ token: false });
      });

      it('is not counted against the strict limit, and is not audited', async () => {
        const address = '10.99.0.4';
        const before = (await auditRows()).length;
        for (let i = 0; i < AUTH_RATE_LIMIT.max * 2; i += 1) {
          const response = await call(
            'GET',
            '/test/token/none',
            { authorization: `Bearer ${foreign}` },
            address,
          );
          expect(response.statusCode, `request ${i}`).toBe(200);
        }
        expect((await auditRows()).length).toBe(before);
      });

      it('is not the Bearer scheme when the word goes on or is not followed by a space or a tab', async () => {
        const made = await makeToken(scene.tokensId);
        const nonBreakingSpace = String.fromCodePoint(0xa0);
        for (const header of [
          `Bearers ${made.token}`,
          `Bearer${nonBreakingSpace}${made.token}`,
          `Bearer:${made.token}`,
          made.token,
        ]) {
          const response = await call('GET', '/test/token/none', {
            authorization: header,
          });
          expect(response.statusCode).toBe(200);
          expect(response.json()).toEqual({ token: false });
        }
        // The scheme with a tab is the scheme.
        const tab = await call('GET', '/test/token/none', {
          authorization: `Bearer\t${made.token}`,
        });
        expect(tab.json()).toEqual({ token: true });
      });

      it('leaves only a value that starts with osfpm_pat_ to the token, which a cookie then makes ambiguous', async () => {
        const { token: sessionToken } = await createSession(ctx.database.db, {
          userId: scene.tokensId,
          method: 'password',
          now: new Date(),
        });
        for (const value of [
          'osfpm_pat_short',
          `osfpm_pat_${'M'.repeat(43)}`,
          'osfpm_pat_',
        ]) {
          const response = await call('GET', '/test/token/read', {
            authorization: `Bearer ${value}`,
            cookie: `${SESSION_COOKIE}=${sessionToken}`,
          });
          expect(response.statusCode, value).toBe(400);
          expect(response.json<{ code: string }>().code).toBe(
            'ambiguous-credentials',
          );
        }
        // The prefix is the token's own start, in the case it is made: another case is
        // someone else's value.
        const upper = await call('GET', '/test/token/read', {
          authorization: `Bearer OSFPM_PAT_${'M'.repeat(43)}`,
          cookie: `${SESSION_COOKIE}=${sessionToken}`,
        });
        expect(upper.statusCode).toBe(200);
      });
    });

    describe('a session cookie as well', () => {
      it('is a 400 ambiguous-credentials, whichever is good, on every route that would use either', async () => {
        const made = await makeToken(scene.tokensId);
        const { token: sessionToken } = await createSession(ctx.database.db, {
          userId: scene.tokensId,
          method: 'password',
          now: new Date(),
        });
        for (const path of [
          '/test/token/read',
          '/test/token/none',
          '/test/token/optional',
        ]) {
          const response = await call('GET', path, {
            ...bearer(made.token),
            cookie: `${SESSION_COOKIE}=${sessionToken}`,
          });
          expect(response.statusCode, path).toBe(400);
          expect(response.json<{ code: string }>().code).toBe(
            'ambiguous-credentials',
          );
        }
        // A bad token and a bad cookie are the same: nothing says which was good.
        const bothBad = await call('GET', '/test/token/read', {
          ...bearer(`osfpm_pat_${'E'.repeat(43)}`),
          cookie: `${SESSION_COOKIE}=nonsense`,
        });
        expect(bothBad.statusCode).toBe(400);
        // And on a route that does not take tokens, it is the same 400: the request is
        // ambiguous before it is anything else.
        const noToken = await call('GET', '/test/no-token', {
          ...bearer(made.token),
          cookie: `${SESSION_COOKIE}=${sessionToken}`,
        });
        expect(noToken.statusCode).toBe(400);
        // The session alone works as ever, and the token alone as well.
        expect(
          (
            await call('GET', '/test/no-token', {
              cookie: `${SESSION_COOKIE}=${sessionToken}`,
            })
          ).statusCode,
        ).toBe(200);
        expect(
          (await call('GET', '/test/token/read', bearer(made.token)))
            .statusCode,
        ).toBe(200);
      });
    });

    describe('a token that does not work', () => {
      it('is one 401 invalid-token, with one body, for every way a token can be no good', async () => {
        const bodies = new Set<string>();
        const statuses = new Set<number>();
        const check = async (token: string) => {
          const response = await call('GET', '/test/token/read', bearer(token));
          statuses.add(response.statusCode);
          bodies.add(JSON.stringify(problemOf(response)));
          expect(response.statusCode).toBe(401);
          expect(response.json<{ code: string }>().code).toBe('invalid-token');
          expect(response.headers['set-cookie']).toBeUndefined();
          expect(response.headers['www-authenticate']).toBeUndefined();
        };

        // Unknown, and not shaped like a token.
        await check(`osfpm_pat_${'F'.repeat(43)}`);
        await check('osfpm_pat_not-a-token');
        await check(`osfpm_pat_${'G'.repeat(200)}`);
        // Revoked.
        const revoked = await makeToken(scene.tokensId);
        await ctx.database.db.transaction((tx) =>
          revokeOwnApiToken(
            tx,
            { userId: scene.tokensId },
            scene.organisationId,
            revoked.apiToken.id,
            new Date(),
          ),
        );
        await check(revoked.token);
        // Expired: the clock moves past its end.
        const expiring = await makeToken(scene.tokensId, { expiresInDays: 1 });
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
          vi.setSystemTime(new Date(Date.now() + 2 * 24 * 60 * MINUTE));
          await check(expiring.token);
        } finally {
          vi.useRealTimers();
        }
        // Its owner is disabled, and its membership is removed.
        const disabled = await makeToken(scene.medicalId);
        await setUserStatus(ctx.database, scene.medicalId, 'disabled');
        await check(disabled.token);
        await setUserStatus(ctx.database, scene.medicalId, 'active');
        await setMembershipStatus(
          ctx.database,
          scene.organisationId,
          scene.medicalId,
          'removed',
        );
        await check(disabled.token);
        await setMembershipStatus(
          ctx.database,
          scene.organisationId,
          scene.medicalId,
          'active',
        );
        // The switch is off, and the token was not revoked.
        const missed = await makeToken(scene.tokensId);
        await ctx.database.db.update(settingValue).set({ value: false });
        await check(missed.token);
        await ctx.database.db.update(settingValue).set({ value: true });

        expect(statuses.size).toBe(1);
        expect(bodies.size).toBe(1);
      });

      it('is the same 401 for a token used on another organisation’s path, whether that organisation exists or not', async () => {
        const made = await makeToken(scene.tokensId);
        const good = await call(
          'GET',
          `/test/org/${scene.organisationId}/read`,
          bearer(made.token),
        );
        expect(good.statusCode).toBe(200);
        const bodies = new Set<string>();
        for (const organisationId of [
          scene.otherOrganisationId,
          '00000000-0000-7000-8000-000000000000',
          'not-an-id',
        ]) {
          const response = await call(
            'GET',
            `/test/org/${organisationId}/read`,
            bearer(made.token),
          );
          expect(response.statusCode, organisationId).toBe(401);
          expect(response.json<{ code: string }>().code).toBe('invalid-token');
          bodies.add(JSON.stringify(problemOf(response)));
        }
        // The body is the one every other refusal has.
        const unknown = await call(
          'GET',
          `/test/org/${scene.organisationId}/read`,
          bearer(`osfpm_pat_${'K'.repeat(43)}`),
        );
        bodies.add(JSON.stringify(problemOf(unknown)));
        expect(bodies.size).toBe(1);
        // The cause is in the audit trail, with the token it was for, and it did not
        // count as a use of the token.
        const wrong = (await auditRows()).filter(
          (event) =>
            event.category === 'auth.api-token-auth-failed' &&
            event.details?.reason === 'wrong-organisation' &&
            event.targetId === made.apiToken.id,
        );
        expect(wrong).toHaveLength(3);
      });

      it('is audited with the reason, and the audit holds no part of the token', async () => {
        const failures = (await auditRows()).filter(
          (event) => event.category === 'auth.api-token-auth-failed',
        );
        expect(failures.length).toBeGreaterThanOrEqual(7);
        const reasons = new Set(
          failures.map((event) => String(event.details?.reason)),
        );
        for (const reason of [
          'unknown',
          'revoked',
          'expired',
          'user-not-active',
          'membership-not-active',
          'switch-off',
        ]) {
          expect(reasons, reason).toContain(reason);
        }
        const text = JSON.stringify(failures);
        for (const token of tokens) expect(text).not.toContain(token);
      });
    });

    describe('the strict limit per address', () => {
      it('counts failed attempts, answers 429 with Retry-After past the limit, and writes no more audit events from that address', async () => {
        const address = '10.99.0.1';
        const made = await makeToken(scene.tokensId);
        const failuresBefore = (await auditRows()).filter(
          (event) => event.category === 'auth.api-token-auth-failed',
        ).length;
        const statuses: number[] = [];
        for (let i = 0; i < AUTH_RATE_LIMIT.max + 5; i += 1) {
          const response = await call(
            'GET',
            '/test/token/read',
            bearer(`osfpm_pat_${String(i).padStart(43, 'H')}`),
            address,
          );
          statuses.push(response.statusCode);
          if (response.statusCode === 429) {
            expect(
              Number(response.headers['retry-after']),
            ).toBeGreaterThanOrEqual(1);
            expect(response.json<{ code: string }>().code).toBe('rate-limited');
          }
        }
        // Ten failures are answered 401; the eleventh makes the count past the limit and
        // is answered 429, and so is every one after it, but those are not written to the
        // audit trail: a flood of bad tokens writes no more rows than the limit allows.
        expect(statuses).toEqual([
          ...Array.from({ length: AUTH_RATE_LIMIT.max }, () => 401),
          ...Array.from({ length: 5 }, () => 429),
        ]);
        const failuresAfter = (await auditRows()).filter(
          (event) => event.category === 'auth.api-token-auth-failed',
        ).length;
        expect(failuresAfter - failuresBefore).toBe(AUTH_RATE_LIMIT.max + 1);
        // A token that works is not held up by the failures at its address, which are
        // someone else's, and it is not counted: it works from that address and from
        // another one.
        expect(
          (await call('GET', '/test/token/read', bearer(made.token), address))
            .statusCode,
        ).toBe(200);
        expect(
          (await call('GET', '/test/token/read', bearer(made.token)))
            .statusCode,
        ).toBe(200);
      });

      it('lets a token that works through while its address is over the limit, however many times, and keeps answering a bad one with a 429', async () => {
        const address = '10.99.0.3';
        const made = await makeToken(scene.tokensId);
        // Someone at the same address fills the bucket: a script with a token that
        // ended, or a handful of people signing in.
        for (let i = 0; i <= AUTH_RATE_LIMIT.max; i += 1) {
          await call(
            'GET',
            '/test/token/read',
            bearer(`osfpm_pat_${String(i).padStart(43, 'J')}`),
            address,
          );
        }
        const failuresBefore = (await auditRows()).filter(
          (event) => event.category === 'auth.api-token-auth-failed',
        ).length;
        for (let i = 0; i < AUTH_RATE_LIMIT.max * 2; i += 1) {
          const good = await call(
            'GET',
            '/test/token/read',
            bearer(made.token),
            address,
          );
          expect(good.statusCode, `request ${i}`).toBe(200);
        }
        const bad = await call(
          'GET',
          '/test/token/read',
          bearer(`osfpm_pat_${'L'.repeat(43)}`),
          address,
        );
        expect(bad.statusCode).toBe(429);
        expect(bad.json<{ code: string }>().code).toBe('rate-limited');
        expect(Number(bad.headers['retry-after'])).toBeGreaterThanOrEqual(1);
        // And a token that was revoked is a 429 as well, not a 401 that says it was.
        const revoked = await makeToken(scene.tokensId);
        await ctx.database.db.transaction((tx) =>
          revokeOwnApiToken(
            tx,
            { userId: scene.tokensId },
            scene.organisationId,
            revoked.apiToken.id,
            new Date(),
          ),
        );
        const refused = await call(
          'GET',
          '/test/token/read',
          bearer(revoked.token),
          address,
        );
        expect(refused.statusCode).toBe(429);
        // None of those refusals was written down: the log holds the 429s.
        const failuresAfter = (await auditRows()).filter(
          (event) => event.category === 'auth.api-token-auth-failed',
        ).length;
        expect(failuresAfter).toBe(failuresBefore);
      });

      it('does not count a token that works, or a request that is refused before the token is looked up', async () => {
        const address = '10.99.0.2';
        const made = await makeToken(scene.tokensId);
        for (let i = 0; i < AUTH_RATE_LIMIT.max * 3; i += 1) {
          const response = await call(
            'GET',
            '/test/token/read',
            bearer(made.token),
            address,
          );
          expect(response.statusCode).toBe(200);
        }
        for (let i = 0; i < AUTH_RATE_LIMIT.max * 2; i += 1) {
          const response = await call(
            'GET',
            '/test/no-token',
            bearer(made.token),
            address,
          );
          expect(response.statusCode).toBe(403);
        }
        expect(
          (await call('GET', '/test/token/read', bearer(made.token), address))
            .statusCode,
        ).toBe(200);
      });
    });

    describe('the limit per token', () => {
      it('is the limit of a session, counted per token, on every route that accepts one', async () => {
        const first = await makeToken(scene.tokensId);
        const second = await makeToken(scene.tokensId);
        const statuses = new Set<number>();
        for (let i = 0; i < SESSION_RATE_LIMIT.max; i += 1) {
          statuses.add(
            (await call('GET', '/test/token/read', bearer(first.token)))
              .statusCode,
          );
        }
        expect([...statuses]).toEqual([200]);
        const over = await call('GET', '/test/token/read', bearer(first.token));
        expect(over.statusCode).toBe(429);
        expect(over.json<{ code: string }>().code).toBe('rate-limited');
        expect(Number(over.headers['retry-after'])).toBeGreaterThanOrEqual(1);
        // The token's other routes are the same count, and another token has its own.
        expect(
          (await call('GET', '/test/token/none', bearer(first.token)))
            .statusCode,
        ).toBe(429);
        expect(
          (await call('GET', '/test/token/read', bearer(second.token)))
            .statusCode,
        ).toBe(200);
      });
    });

    describe('a token that can only read', () => {
      it('is refused on a route that says write, with a 403 token-read-only, and passes a write token', async () => {
        const reader = await makeToken(scene.tokensId, { access: 'read' });
        const writer = await makeToken(scene.tokensId, { access: 'write' });
        for (const [method, path] of [
          ['POST', '/test/token/write'],
          ['GET', '/test/token/write-by-get'],
        ] as const) {
          const refused = await call(method, path, bearer(reader.token));
          expect(refused.statusCode, `${method} ${path}`).toBe(403);
          expect(refused.json<{ code: string }>().code).toBe('token-read-only');
          const allowed = await call(method, path, bearer(writer.token));
          expect(allowed.statusCode, `${method} ${path}`).toBe(200);
        }
        // Both pass a read route.
        expect(
          (await call('GET', '/test/token/read', bearer(reader.token)))
            .statusCode,
        ).toBe(200);
        expect(
          (await call('GET', '/test/token/read', bearer(writer.token)))
            .statusCode,
        ).toBe(200);
      });
    });

    describe('last_used_at', () => {
      it('is written by a request, and only once in a minute', async () => {
        const made = await makeToken(scene.tokensId);
        const read = async () =>
          (await ctx.database.db.select().from(apiToken)).find(
            (row) => row.id === made.apiToken.id,
          )!.lastUsedAt;
        expect(await read()).toBeNull();
        await call('GET', '/test/token/read', bearer(made.token));
        const first = await read();
        expect(first).not.toBeNull();
        await call('GET', '/test/token/read', bearer(made.token));
        expect(await read()).toEqual(first);
      });
    });

    describe('the audit of an outside call', () => {
      it('writes one event for every request a token made, after the response, with the route pattern and the status, and nothing of the request', async () => {
        const made = await makeToken(scene.tokensId);
        const id = 'a-path-parameter-that-is-not-logged';
        const ok = await call(
          'GET',
          `/test/token/read/${id}?secret=query-value-that-is-not-logged`,
          bearer(made.token),
        );
        expect(ok.statusCode).toBe(200);
        const refused = await call(
          'POST',
          '/test/token/write',
          bearer(made.token),
        );
        // The token can only read, so this is refused after the token is accepted: it
        // is a call of the token, and has its event.
        expect(refused.statusCode).toBe(403);
        // A route that does not take tokens refuses before the token is looked at, so
        // the token has made no call there and there is no event.
        const notAccepted = await call(
          'GET',
          '/test/no-token',
          bearer(made.token),
        );
        expect(notAccepted.statusCode).toBe(403);
        // The events are written after the response has gone: let them settle.
        for (
          let i = 0;
          i < 40 && (await callsOf(made.apiToken.id)).length < 2;
          i += 1
        ) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const events = (await callsOf(made.apiToken.id)).sort(
          (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime(),
        );
        expect(events.map((event) => event.details)).toEqual([
          {
            userId: scene.tokensId,
            method: 'GET',
            route: `${API_PREFIX}/test/token/read/:id`,
            status: 200,
          },
          {
            userId: scene.tokensId,
            method: 'POST',
            route: `${API_PREFIX}/test/token/write`,
            status: 403,
          },
        ]);
        for (const event of events) {
          expect(event).toMatchObject({
            actorType: 'token',
            actorId: made.apiToken.id,
            targetType: 'api_token',
            targetId: made.apiToken.id,
            organisationId: scene.organisationId,
          });
          expect(event.requestId).toMatch(UUID_V7);
        }
        const text = JSON.stringify(events);
        expect(text).not.toContain(id);
        expect(text).not.toContain('query-value');
        expect(text).not.toContain(made.token);
      });

      it('writes none for a request with no token, a session, a refused token or a request that did not name a route', async () => {
        const made = await makeToken(scene.tokensId);
        const before = (await auditRows()).filter(
          (event) => event.category === 'api.call',
        ).length;
        await call('GET', '/test/token/none');
        await call(
          'GET',
          '/test/token/read',
          bearer(`osfpm_pat_${'J'.repeat(43)}`),
        );
        await call('GET', '/test/does-not-exist', bearer(made.token));
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(
          (await auditRows()).filter((event) => event.category === 'api.call')
            .length,
        ).toBe(before);
      });
    });

    describe('a route that declares tokenAccess wrongly', () => {
      // The plugin calls this for every route as it is made, so a mistake stops the
      // server from starting. A throw inside Fastify's `onRoute` hook is not a clean
      // rejection of `ready()`, so the rule is tested where it lives.
      it('is refused: the value is read or write, and read is for a safe method', () => {
        const route = (
          method: string | string[],
          tokenAccess?: unknown,
        ): Parameters<typeof assertTokenAccessDeclaration>[0] => ({
          url: '/api/v1/things/:id',
          method,
          config: tokenAccess === undefined ? {} : { tokenAccess },
        });
        // Says nothing: passes, whatever the method.
        expect(() => assertTokenAccessDeclaration(route('POST'))).not.toThrow();
        // Read, on a safe method or on several.
        for (const method of ['GET', 'HEAD', 'OPTIONS', ['GET', 'HEAD']]) {
          expect(() =>
            assertTokenAccessDeclaration(route(method, 'read')),
          ).not.toThrow();
        }
        // Write, on any method.
        for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
          expect(() =>
            assertTokenAccessDeclaration(route(method, 'write')),
          ).not.toThrow();
        }
        // Read on a method that changes data, alone or among safe ones.
        for (const method of [
          'POST',
          'PUT',
          'PATCH',
          'DELETE',
          ['GET', 'POST'],
        ]) {
          expect(() =>
            assertTokenAccessDeclaration(route(method, 'read')),
          ).toThrow(/tokenAccess 'read' for a method that changes data/);
        }
        // A value that is neither.
        for (const value of ['admin', 'READ', true, null, 1, {}]) {
          expect(() =>
            assertTokenAccessDeclaration(route('GET', value)),
          ).toThrow(/neither 'read' nor 'write'/);
        }
        // The message names the route's pattern, which holds no request data.
        expect(() =>
          assertTokenAccessDeclaration(route('POST', 'read')),
        ).toThrow('/api/v1/things/:id');
      });
    });

    describe('what the log may hold', () => {
      it('never holds a token, its hash, or an Authorization header', () => {
        const text = ctx.lines.join('');
        expect(tokens.length).toBeGreaterThan(5);
        for (const token of tokens) expect(text).not.toContain(token);
        expect(text).not.toMatch(/osfpm_pat_/i);
        expect(text.toLowerCase()).not.toContain('bearer');
        expect(text.toLowerCase()).not.toContain('authorization');
      });
    });
  },
);
