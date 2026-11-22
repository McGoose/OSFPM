import type { FastifyPluginAsync } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureInstallation } from '@osfpm/core/src/auth/ensure-installation.js';
import { markSetupComplete } from '@osfpm/core/src/auth/test-support.js';
import { migrate } from '@osfpm/core/src/db/migrate.js';
import { installation } from '@osfpm/core/src/db/schema/index.js';
import { testTargets } from '@osfpm/core/src/db/test-support.js';
import { API_PREFIX } from '../api-version.js';
import { SESSION_COOKIE } from '../auth/cookie.js';
import { createTestApp, TEST_PUBLIC_ORIGIN, UUID_V7 } from '../test-support.js';

/**
 * The routes that answer while first-run setup is incomplete: the two health
 * routes, `/meta`, the OpenAPI document and the two setup routes (SC-10, decision
 * D-56, Q1). Every other route of the API is closed until the first
 * administrator exists. Written out here, not read from the routes, so a route
 * that opens itself by accident is a failing test.
 */
const OPEN_BEFORE_SETUP = new Set([
  `GET ${API_PREFIX}/health`,
  `GET ${API_PREFIX}/health/ready`,
  `GET ${API_PREFIX}/meta`,
  `GET ${API_PREFIX}/openapi.json`,
  `POST ${API_PREFIX}/setup`,
  `POST ${API_PREFIX}/setup/check`,
]);

const SOME_ID = '01900000-0000-7000-8000-000000000001';

/** Routes that exist only in these tests: one says nothing, one says it is open before setup. */
const testRoutes: FastifyPluginAsync = (app) => {
  app.get('/test/says-nothing', { config: { auth: 'none' } }, () => ({
    ok: true,
  }));
  app.get(
    '/test/open-before-setup',
    { config: { auth: 'none', availableBeforeSetup: true } },
    () => ({ ok: true }),
  );
  return Promise.resolve();
};

describe.each(testTargets)('the setup gate on $name', (target) => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;

  beforeAll(async () => {
    // Setup is not complete: the app is not told it is, so it asks the database.
    ctx = await createTestApp(target, { setupComplete: false });
    await migrate(ctx.database);
    await ensureInstallation(ctx.database.db, {
      baseUrl: TEST_PUBLIC_ORIGIN,
      now: new Date(),
    });
    await ctx.app.register(testRoutes, { prefix: API_PREFIX });
  });
  afterAll(async () => {
    await ctx.close();
  });

  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    headers: Record<string, string> = {},
  ) => ctx.app.inject({ method, url: path, headers });

  /** Every route of the OpenAPI document, as `METHOD /path` with a value in place of each `{id}`. */
  async function documentedRoutes() {
    const document = (await call('GET', `${API_PREFIX}/openapi.json`)).json<{
      paths: Record<string, Record<string, unknown>>;
    }>();
    return Object.entries(document.paths).flatMap(([path, item]) =>
      Object.keys(item).map((method) => ({
        method: method.toUpperCase() as
          'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        path: path.replaceAll('{id}', SOME_ID),
        key: `${method.toUpperCase()} ${path}`,
      })),
    );
  }

  describe('before setup is complete', () => {
    it('answers /meta, and says setup is required', async () => {
      const response = await call('GET', `${API_PREFIX}/meta`);
      expect(response.statusCode).toBe(200);
      expect(response.json<{ setupRequired: boolean }>().setupRequired).toBe(
        true,
      );
    });

    it('answers /health, /health/ready and /openapi.json', async () => {
      for (const path of ['/health', '/health/ready', '/openapi.json']) {
        expect(
          (await call('GET', `${API_PREFIX}${path}`)).statusCode,
          path,
        ).toBe(200);
      }
    });

    it('answers the two setup routes, which are how setup is done: a 400 for a body that is not shaped right, not a 503', async () => {
      for (const path of ['/setup', '/setup/check']) {
        const response = await call('POST', `${API_PREFIX}${path}`);
        expect(response.statusCode, path).toBe(400);
        expect(response.json<{ code: string }>().code, path).toBe(
          'validation-failed',
        );
      }
    });

    it('answers every other route of the API with a 503 problem "setup-required"', async () => {
      const closed = (await documentedRoutes()).filter(
        (route) =>
          !OPEN_BEFORE_SETUP.has(route.key) &&
          // The two routes this test adds are checked on their own below.
          !route.path.startsWith(`${API_PREFIX}/test/`),
      );
      // Guards against checking nothing: the auth routes are most of the API.
      expect(closed.length).toBeGreaterThan(15);
      for (const route of closed) {
        const response = await call(route.method, route.path);
        expect(response.statusCode, route.key).toBe(503);
        expect(response.headers['content-type'], route.key).toMatch(
          /^application\/problem\+json/,
        );
        expect(response.headers['x-request-id']).toMatch(UUID_V7);
        expect(response.json(), route.key).toMatchObject({
          type: '/problems/setup-required',
          code: 'setup-required',
          status: 503,
          instance: route.path,
          requestId: response.headers['x-request-id'],
        });
      }
    });

    it('closes a route that says nothing, so a new route cannot be open by accident, and opens one that says so', async () => {
      expect(
        (await call('GET', `${API_PREFIX}/test/says-nothing`)).statusCode,
      ).toBe(503);
      expect(
        (await call('GET', `${API_PREFIX}/test/open-before-setup`)).statusCode,
      ).toBe(200);
    });

    it('answers an unknown path with the usual 404', async () => {
      const response = await call('GET', `${API_PREFIX}/nowhere`);
      expect(response.statusCode).toBe(404);
      expect(response.json<{ code: string }>().code).toBe('route-not-found');
    });

    it('comes before the session, the Origin check and the rate limits: the same answer with a cookie and a foreign Origin, and no cookie is touched', async () => {
      const bare = await call('POST', `${API_PREFIX}/auth/logout`);
      const forged = await call('POST', `${API_PREFIX}/auth/logout`, {
        cookie: `${SESSION_COOKIE}=junk-token`,
        origin: 'https://attacker.example.test',
      });
      expect(forged.statusCode).toBe(503);
      expect(forged.headers['set-cookie']).toBeUndefined();
      expect(JSON.stringify({ ...forged.json<object>(), requestId: 0 })).toBe(
        JSON.stringify({ ...bare.json<object>(), requestId: 0 }),
      );
    });

    it('says only that setup is needed: nothing about the database or the installation', async () => {
      const response = await call('GET', `${API_PREFIX}/auth/me`);
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toMatch(
        /database|installation|pglite|postgres|migrat/i,
      );
    });
  });

  describe('once setup is complete', () => {
    beforeAll(async () => {
      await markSetupComplete(ctx.database);
    });

    it('opens the API without a restart: /meta says setup is no longer required', async () => {
      const response = await call('GET', `${API_PREFIX}/meta`);
      expect(response.statusCode).toBe(200);
      expect(response.json<{ setupRequired: boolean }>().setupRequired).toBe(
        false,
      );
    });

    it('answers a route as it normally does: 401 with no session, and 200 for a route that is open', async () => {
      expect((await call('GET', `${API_PREFIX}/auth/me`)).statusCode).toBe(401);
      expect(
        (await call('GET', `${API_PREFIX}/test/says-nothing`)).statusCode,
      ).toBe(200);
    });

    it('closes the two setup routes: a 404 problem, the same as a path that is no route', async () => {
      const nowhere = await call('POST', `${API_PREFIX}/nowhere`);
      for (const path of ['/setup', '/setup/check']) {
        const response = await call('POST', `${API_PREFIX}${path}`);
        expect(response.statusCode, path).toBe(404);
        expect(response.json<{ code: string }>().code, path).toBe(
          'route-not-found',
        );
        expect(response.json<{ detail: string }>().detail, path).toBe(
          nowhere.json<{ detail: string }>().detail,
        );
      }
    });

    it('does not ask the database again: a server that has seen setup complete stays open', async () => {
      // Setup never goes back. A row changed by hand does not close the API.
      await ctx.database.db
        .update(installation)
        .set({ setupCompletedAt: null });
      expect((await call('GET', `${API_PREFIX}/auth/me`)).statusCode).toBe(401);
      expect(
        (await call('GET', `${API_PREFIX}/meta`)).json<{
          setupRequired: boolean;
        }>().setupRequired,
      ).toBe(false);
    });
  });
});
