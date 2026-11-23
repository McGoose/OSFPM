import type { FastifyPluginAsync } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSession } from '@osfpm/core/src/auth/sessions.js';
import {
  seedActiveUser,
  seedInstallation,
} from '@osfpm/core/src/auth/test-support.js';
import { migrate } from '@osfpm/core/src/db/migrate.js';
import {
  testTargets,
  type TestTarget,
} from '@osfpm/core/src/db/test-support.js';
import { API_PREFIX } from '../api-version.js';
import { createTestApp, TEST_PUBLIC_ORIGIN } from '../test-support.js';
import { SESSION_COOKIE } from './cookie.js';

/**
 * Routes that exist only in these tests. A route is closed to a recovery
 * session unless it says `allowedInRecovery`, whatever its `auth` mode.
 */
const testRoutes: FastifyPluginAsync = (app) => {
  app.get('/test/scope/closed', () => ({ ok: true }));
  app.get(
    '/test/scope/allowed',
    { config: { allowedInRecovery: true } },
    () => ({ ok: true }),
  );
  app.get('/test/scope/optional', { config: { auth: 'optional' } }, () => ({
    ok: true,
  }));
  app.get(
    '/test/scope/optional-allowed',
    { config: { auth: 'optional', allowedInRecovery: true } },
    () => ({ ok: true }),
  );
  app.get('/test/scope/none', { config: { auth: 'none' } }, () => ({
    ok: true,
  }));
  app.get(
    '/test/scope/limited',
    { config: { sessionRateLimit: true } },
    () => ({ ok: true }),
  );
  return Promise.resolve();
};

describe.each(testTargets)(
  'the recovery scope on $name',
  (target: TestTarget) => {
    let ctx: Awaited<ReturnType<typeof createTestApp>>;
    let addresses = 0;

    beforeAll(async () => {
      ctx = await createTestApp(target);
      await ctx.app.register(testRoutes, { prefix: API_PREFIX });
      await migrate(ctx.database);
      await seedInstallation(ctx.database);
    });
    afterAll(async () => {
      await ctx.close();
    });

    const freshAddress = () =>
      `10.7.${Math.floor(addresses / 250)}.${(addresses++ % 250) + 1}`;

    /**
     * A session of `method`. `recovery` and `reset` are always recovery scope; a
     * `setup` or an `invite` session is, when it was opened with no password.
     */
    async function signedIn(
      method: 'recovery' | 'password' | 'reset' | 'setup' | 'invite',
      scope?: 'recovery',
    ) {
      const userId = await seedActiveUser(ctx.database);
      const { token } = await createSession(ctx.database.db, {
        userId,
        method,
        ...(scope === undefined ? {} : { scope }),
        now: new Date(),
      });
      return { userId, token };
    }

    const get = (path: string, token?: string) =>
      ctx.app.inject({
        method: 'GET',
        url: `${API_PREFIX}${path}`,
        headers:
          token === undefined ? {} : { cookie: `${SESSION_COOKIE}=${token}` },
        remoteAddress: freshAddress(),
      });

    /**
     * The 403 a recovery session gets on a route that is closed to it. The detail
     * is true of every recovery-scope session, whichever way it was opened: a
     * recovery code, first-run setup, an invite or an admin reset link.
     */
    function expectRecoveryRequired(response: Awaited<ReturnType<typeof get>>) {
      expect(response.statusCode).toBe(403);
      expect(response.headers['content-type']).toMatch(
        /^application\/problem\+json/,
      );
      expect(response.json<Record<string, unknown>>()).toMatchObject({
        status: 403,
        code: 'account-recovery-required',
        type: '/problems/account-recovery-required',
        detail:
          'This session can only be used to secure the account: set a password or add a passkey.',
      });
    }

    it('closes a route to a recovery session unless the route allows it', async () => {
      const { token } = await signedIn('recovery');
      expectRecoveryRequired(await get('/test/scope/closed', token));
      expect((await get('/test/scope/allowed', token)).statusCode).toBe(200);
    });

    it('closes a route that only optionally uses the session as well', async () => {
      const { token } = await signedIn('recovery');
      expectRecoveryRequired(await get('/test/scope/optional', token));
      expect(
        (await get('/test/scope/optional-allowed', token)).statusCode,
      ).toBe(200);
    });

    it('leaves a route that does not use the session alone', async () => {
      const { token } = await signedIn('recovery');
      expect((await get('/test/scope/none', token)).statusCode).toBe(200);
    });

    it('does not touch a full session, a missing session or an unknown route', async () => {
      const { token } = await signedIn('password');
      expect((await get('/test/scope/closed', token)).statusCode).toBe(200);
      expect((await get('/test/scope/closed')).statusCode).toBe(401);
      const recovery = await signedIn('recovery');
      expect(
        (await get('/test/scope/nowhere', recovery.token)).statusCode,
      ).toBe(404);
    });

    it('says the same to every recovery-scope session, whichever way it was opened: a recovery code, a reset link, setup or an invite', async () => {
      const bodies = new Set<string>();
      for (const [method, scope] of [
        ['recovery', undefined],
        ['reset', undefined],
        ['setup', 'recovery'],
        ['invite', 'recovery'],
      ] as const) {
        const { token } = await signedIn(method, scope);
        const response = await get('/test/scope/closed', token);
        expectRecoveryRequired(response);
        bodies.add(
          JSON.stringify({
            ...response.json<Record<string, unknown>>(),
            requestId: undefined,
            instance: undefined,
          }),
        );
      }
      expect(bodies.size).toBe(1);
    });

    it('answers the same body every time', async () => {
      const { token } = await signedIn('recovery');
      const first = await get('/test/scope/closed', token);
      const second = await get('/test/scope/optional', token);
      const strip = (response: typeof first) => ({
        ...response.json<Record<string, unknown>>(),
        requestId: undefined,
        instance: undefined,
      });
      expect(strip(first)).toEqual(strip(second));
    });

    it('checks the Origin before it says anything about the scope, so a forged request learns nothing', async () => {
      const { token } = await signedIn('recovery');
      const response = await ctx.app.inject({
        method: 'POST',
        url: `${API_PREFIX}/auth/logout`,
        headers: {
          cookie: `${SESSION_COOKIE}=${token}`,
          origin: 'https://evil.example',
        },
        remoteAddress: freshAddress(),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json<{ code: string }>().code).toBe('origin-mismatch');
    });

    it('counts a refused request against the session limit like any other', async () => {
      const { token } = await signedIn('recovery');
      // 120 allowed in a minute; the route is closed to a recovery session, so
      // each is a 403, and the 121st is a 429.
      for (let i = 0; i < 120; i += 1) {
        expect((await get('/test/scope/limited', token)).statusCode).toBe(403);
      }
      expect((await get('/test/scope/limited', token)).statusCode).toBe(429);
    });

    it('lets the session read who it is and sign out, and nothing else of the session routes', async () => {
      const { token } = await signedIn('recovery');
      expect((await get('/auth/me', token)).statusCode).toBe(200);
      expectRecoveryRequired(await get('/auth/sessions', token));
      const logout = await ctx.app.inject({
        method: 'POST',
        url: `${API_PREFIX}/auth/logout`,
        headers: {
          cookie: `${SESSION_COOKIE}=${token}`,
          origin: TEST_PUBLIC_ORIGIN,
        },
        remoteAddress: freshAddress(),
      });
      expect(logout.statusCode).toBe(204);
    });
  },
);
