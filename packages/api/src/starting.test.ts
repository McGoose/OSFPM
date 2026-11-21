import type { FastifyPluginAsync } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  testTargets,
  type TestTarget,
} from '@osfpm/core/src/db/test-support.js';
import { API_PREFIX } from './api-version.js';
import { SESSION_COOKIE } from './auth/cookie.js';
import { buildApp } from './app.js';
import { TEST_PUBLIC_ORIGIN, UUID_V7 } from './test-support.js';

/** Routes that exist only in these tests: one says nothing, one opts in to being open while starting. */
const testRoutes: FastifyPluginAsync = (app) => {
  app.get('/test/says-nothing', { config: { auth: 'none' } }, () => ({
    ok: true,
  }));
  app.get(
    '/test/open-while-starting',
    { config: { auth: 'none', availableWhileStarting: true } },
    () => ({ ok: true }),
  );
  return Promise.resolve();
};

describe.each(testTargets)(
  'a server that has not finished starting, on $name',
  (target: TestTarget) => {
    let created: Awaited<ReturnType<TestTarget['create']>>;
    let app: ReturnType<typeof buildApp>;

    // An empty database: nothing is migrated, so any route that reached for a
    // table would fail with a 500 instead of the 503 these tests expect.
    beforeEach(async () => {
      created = await target.create();
      app = buildApp({
        db: created.database,
        publicOrigin: TEST_PUBLIC_ORIGIN,
      });
      void app.register(testRoutes, { prefix: API_PREFIX });
    });
    afterEach(async () => {
      await app.close();
      await created.cleanup();
    });

    const call = (
      method: 'GET' | 'POST' | 'DELETE',
      path: string,
      headers: Record<string, string> = {},
    ) => app.inject({ method, url: `${API_PREFIX}${path}`, headers });

    const SESSION_ID = '01900000-0000-7000-8000-000000000001';

    it.each([
      ['GET', '/meta'],
      ['GET', '/openapi.json'],
      ['GET', '/auth/me'],
      ['GET', '/auth/sessions'],
      ['POST', '/auth/logout'],
      ['DELETE', `/auth/sessions/${SESSION_ID}`],
      ['GET', '/test/says-nothing'],
    ] as const)(
      '%s %s answers a 503 problem "starting"',
      async (method, path) => {
        const response = await call(method, path);
        expect(response.statusCode).toBe(503);
        expect(response.headers['content-type']).toMatch(
          /^application\/problem\+json/,
        );
        expect(response.headers['x-request-id']).toMatch(UUID_V7);
        expect(response.json()).toMatchObject({
          type: '/problems/starting',
          code: 'starting',
          status: 503,
          instance: `${API_PREFIX}${path}`,
          requestId: response.headers['x-request-id'],
        });
      },
    );

    it('answers the same whether or not the request has a cookie, and never touches the database or the cookie', async () => {
      const bare = await call('GET', '/auth/me');
      const withCookie = await call('GET', '/auth/me', {
        cookie: `${SESSION_COOKIE}=junk-token`,
      });
      // Had the auth plugin run, it would have looked in a table that does not
      // exist and answered 500, or cleared the cookie.
      expect(withCookie.statusCode).toBe(503);
      expect(withCookie.headers['set-cookie']).toBeUndefined();
      expect(
        JSON.stringify({ ...withCookie.json<object>(), requestId: 0 }),
      ).toBe(JSON.stringify({ ...bare.json<object>(), requestId: 0 }));
    });

    it('does not run the Origin check or the rate limit first: a foreign Origin is a 503 too', async () => {
      const response = await call('POST', '/auth/logout', {
        cookie: `${SESSION_COOKIE}=junk-token`,
        origin: 'https://attacker.example.test',
      });
      expect(response.statusCode).toBe(503);
    });

    it('says nothing but that it is starting', async () => {
      const response = await call('GET', '/meta');
      expect(response.body).not.toMatch(
        /migrat|database|permission|pglite|postgres/i,
      );
    });

    it('keeps /health and /health/ready open: alive, and not ready', async () => {
      const alive = await call('GET', '/health');
      expect(alive.statusCode).toBe(200);
      expect(alive.json()).toEqual({ status: 'ok' });

      const ready = await call('GET', '/health/ready');
      expect(ready.statusCode).toBe(503);
      // Readiness keeps its own problem: it is the probe, not a refused route.
      expect(ready.json<{ code: string }>().code).toBe('service-unavailable');
    });

    it('lets a route that says so through', async () => {
      const response = await call('GET', '/test/open-while-starting');
      expect(response.statusCode).toBe(200);
    });

    it('treats a route that says nothing as closed, so a new route cannot be open by accident', async () => {
      expect((await call('GET', '/test/says-nothing')).statusCode).toBe(503);
    });

    it('answers an unknown route with the 404 problem, as it always does', async () => {
      const response = await call('GET', '/nowhere');
      expect(response.statusCode).toBe(404);
      expect(response.json<{ code: string }>().code).toBe('route-not-found');
    });

    it('opens every route once start-up has finished', async () => {
      app.readiness.markReady();
      expect((await call('GET', '/meta')).statusCode).toBe(200);
      expect((await call('GET', '/test/says-nothing')).statusCode).toBe(200);
      expect((await call('GET', '/auth/me')).statusCode).toBe(401);
    });
  },
);
