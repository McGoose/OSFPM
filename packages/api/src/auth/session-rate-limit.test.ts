import type { FastifyPluginAsync } from 'fastify';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
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
import { createTestApp, TEST_PUBLIC_ORIGIN, UUID_V7 } from '../test-support.js';
import { SESSION_COOKIE } from './cookie.js';
import { AUTH_RATE_LIMIT, SESSION_RATE_LIMIT } from './rate-limit.js';

/** Routes that exist only in these tests, one for each way a route can ask for a limit. */
const testRoutes: FastifyPluginAsync = (app) => {
  // Signed in is required (the default), and the count is per session.
  app.get('/test/per-session', { config: { sessionRateLimit: true } }, () => ({
    ok: true,
  }));
  app.post('/test/per-session', { config: { sessionRateLimit: true } }, () => ({
    ok: true,
  }));
  // A route that works with no session: only a session is counted.
  app.get(
    '/test/per-session-optional',
    { config: { auth: 'optional', sessionRateLimit: true } },
    () => ({ ok: true }),
  );
  // A route that checks a secret: the strict count, per address.
  app.get(
    '/test/per-address',
    { config: { auth: 'none', authRateLimit: true } },
    () => ({ ok: true }),
  );
  // Asks for nothing.
  app.get('/test/unlimited', { config: { auth: 'none' } }, () => ({
    ok: true,
  }));
  return Promise.resolve();
};

describe('the limit on signed-in routes', () => {
  it('is 120 requests per minute per session, in one place, and the strict limit is still 10', () => {
    expect(SESSION_RATE_LIMIT).toEqual({ max: 120, timeWindowMs: 60_000 });
    expect(AUTH_RATE_LIMIT).toEqual({ max: 10, timeWindowMs: 60_000 });
  });
});

describe.each(testTargets)(
  'per-session rate limits on $name',
  (target: TestTarget) => {
    let ctx: Awaited<ReturnType<typeof createTestApp>>;
    let addresses = 0;
    const freshAddress = () =>
      `10.7.${Math.floor(addresses / 250)}.${(addresses++ % 250) + 1}`;

    beforeAll(async () => {
      ctx = await createTestApp(target);
      await migrate(ctx.database);
      await seedInstallation(ctx.database);
      await ctx.app.register(testRoutes, { prefix: API_PREFIX });
    });
    afterAll(async () => {
      await ctx.close();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    async function login(userId?: string) {
      const id = userId ?? (await seedActiveUser(ctx.database));
      const { token } = await createSession(ctx.database.db, {
        userId: id,
        method: 'password',
        now: new Date(),
      });
      return { userId: id, token };
    }

    const call = (
      path: string,
      options: {
        token?: string;
        remoteAddress?: string;
        method?: 'GET' | 'POST';
        origin?: string;
      } = {},
    ) =>
      ctx.app.inject({
        method: options.method ?? 'GET',
        url: `${API_PREFIX}${path}`,
        remoteAddress: options.remoteAddress ?? freshAddress(),
        headers: {
          ...(options.token === undefined
            ? {}
            : { cookie: `${SESSION_COOKIE}=${options.token}` }),
          ...(options.method === 'POST'
            ? { origin: options.origin ?? TEST_PUBLIC_ORIGIN }
            : {}),
        },
      });

    /** Makes `count` requests on one session, from addresses of their own. */
    async function spend(
      token: string,
      count: number,
      path = '/test/per-session',
    ) {
      for (let n = 0; n < count; n += 1) {
        const response = await call(path, { token });
        expect(response.statusCode, `request ${n + 1}`).toBe(200);
      }
    }

    it('lets 120 requests through and refuses the 121st with a 429 problem and Retry-After', async () => {
      const { token } = await login();
      await spend(token, SESSION_RATE_LIMIT.max);

      const refused = await call('/test/per-session', { token });
      expect(refused.statusCode).toBe(429);
      expect(refused.headers['content-type']).toMatch(
        /^application\/problem\+json/,
      );
      expect(refused.headers['x-request-id']).toMatch(UUID_V7);
      expect(refused.json()).toMatchObject({
        type: '/problems/rate-limited',
        code: 'rate-limited',
        status: 429,
      });
      const retryAfter = Number(refused.headers['retry-after']);
      expect(Number.isInteger(retryAfter)).toBe(true);
      expect(retryAfter).toBeGreaterThanOrEqual(1);
      expect(retryAfter).toBeLessThanOrEqual(
        SESSION_RATE_LIMIT.timeWindowMs / 1000,
      );
    });

    it('counts the session, not the address: one session from many addresses shares one count', async () => {
      const { token } = await login();
      for (let n = 0; n < SESSION_RATE_LIMIT.max; n += 1) {
        await call('/test/per-session', {
          token,
          remoteAddress: freshAddress(),
        });
      }
      expect(
        (
          await call('/test/per-session', {
            token,
            remoteAddress: freshAddress(),
          })
        ).statusCode,
      ).toBe(429);
    });

    it('gives every session its own count, also when they are the same user’s or share an address', async () => {
      const first = await login();
      const second = await login(first.userId);
      const sameAddress = freshAddress();
      for (let n = 0; n <= SESSION_RATE_LIMIT.max; n += 1) {
        await call('/test/per-session', {
          token: first.token,
          remoteAddress: sameAddress,
        });
      }
      expect(
        (await call('/test/per-session', { token: first.token })).statusCode,
      ).toBe(429);
      // The second session, from the very same address, has all its requests.
      for (let n = 0; n < SESSION_RATE_LIMIT.max; n += 1) {
        const response = await call('/test/per-session', {
          token: second.token,
          remoteAddress: sameAddress,
        });
        expect(response.statusCode).toBe(200);
      }
    });

    it('does not count a request with no valid session: it is a 401 however many there are', async () => {
      const remoteAddress = freshAddress();
      for (let n = 0; n < SESSION_RATE_LIMIT.max + 30; n += 1) {
        const response = await call('/test/per-session', { remoteAddress });
        expect(response.statusCode).toBe(401);
      }
      for (let n = 0; n < 15; n += 1) {
        const response = await call('/test/per-session', {
          token: 'not-a-real-token',
          remoteAddress,
        });
        expect(response.statusCode).toBe(401);
      }
    });

    it('does not limit a route that works without a session, until there is one', async () => {
      const remoteAddress = freshAddress();
      for (let n = 0; n < SESSION_RATE_LIMIT.max + 5; n += 1) {
        const response = await call('/test/per-session-optional', {
          remoteAddress,
        });
        expect(response.statusCode).toBe(200);
      }
      const { token } = await login();
      await spend(token, SESSION_RATE_LIMIT.max, '/test/per-session-optional');
      expect(
        (await call('/test/per-session-optional', { token })).statusCode,
      ).toBe(429);
    });

    it('is shared by the routes that ask for it, whatever their method', async () => {
      const { token } = await login();
      await spend(token, SESSION_RATE_LIMIT.max / 2, '/test/per-session');
      for (let n = 0; n < SESSION_RATE_LIMIT.max / 2; n += 1) {
        const response = await call('/test/per-session', {
          token,
          method: 'POST',
        });
        expect(response.statusCode).toBe(200);
      }
      expect((await call('/test/per-session', { token })).statusCode).toBe(429);
      expect(
        (await call('/test/per-session', { token, method: 'POST' })).statusCode,
      ).toBe(429);
      expect(
        (await call('/test/per-session-optional', { token })).statusCode,
      ).toBe(429);
    });

    it('is kept apart from the strict limit: neither count uses up the other', async () => {
      const { token } = await login();
      const remoteAddress = freshAddress();
      // Use up the strict count of this address.
      for (let n = 0; n <= AUTH_RATE_LIMIT.max; n += 1) {
        await call('/test/per-address', { remoteAddress });
      }
      expect(
        (await call('/test/per-address', { remoteAddress })).statusCode,
      ).toBe(429);
      // The signed-in routes still answer from that address.
      expect(
        (await call('/test/per-session', { token, remoteAddress })).statusCode,
      ).toBe(200);

      // And the other way round: a session at its limit does not touch the address.
      const busy = await login();
      const clean = freshAddress();
      await spend(busy.token, SESSION_RATE_LIMIT.max);
      expect(
        (
          await call('/test/per-session', {
            token: busy.token,
            remoteAddress: clean,
          })
        ).statusCode,
      ).toBe(429);
      expect(
        (await call('/test/per-address', { remoteAddress: clean })).statusCode,
      ).toBe(200);
    });

    it('is counted after the Origin check, so a forged request does not spend the session’s requests', async () => {
      const { token } = await login();
      for (let n = 0; n < SESSION_RATE_LIMIT.max + 10; n += 1) {
        const forged = await call('/test/per-session', {
          token,
          method: 'POST',
          origin: 'https://attacker.example.test',
        });
        expect(forged.statusCode).toBe(403);
      }
      expect(
        (await call('/test/per-session', { token, method: 'POST' })).statusCode,
      ).toBe(200);
    });

    it('lets requests through again once the minute is up', async () => {
      const { token } = await login();
      vi.useFakeTimers({
        toFake: ['Date'],
        now: new Date(Date.now()),
      });
      const start = Date.now();
      await spend(token, SESSION_RATE_LIMIT.max);
      expect((await call('/test/per-session', { token })).statusCode).toBe(429);
      vi.setSystemTime(start + SESSION_RATE_LIMIT.timeWindowMs + 1_000);
      expect((await call('/test/per-session', { token })).statusCode).toBe(200);
    });

    it('does not count a route that does not ask for a limit', async () => {
      const { token } = await login();
      for (let n = 0; n < SESSION_RATE_LIMIT.max * 2; n += 1) {
        const response = await call('/test/unlimited', { token });
        expect(response.statusCode).toBe(200);
      }
      expect((await call('/test/per-session', { token })).statusCode).toBe(200);
    });

    it('says nothing about the session, the count or the limit, and logs none of them', async () => {
      const { token } = await login();
      ctx.lines.length = 0;
      await spend(token, SESSION_RATE_LIMIT.max);
      const refused = await call('/test/per-session', { token });
      expect(refused.statusCode).toBe(429);
      expect(refused.body).not.toContain(token);
      expect(refused.body).not.toMatch(/\b120\b|\b60\b/);
      expect(refused.headers['x-ratelimit-limit']).toBeUndefined();
      expect(ctx.lines.join('')).not.toContain(token);
      const refusals = ctx
        .records()
        .filter((record) => record.msg === 'request refused');
      expect(
        refusals.map((record) => (record.err as { type: string }).type),
      ).toEqual(['RateLimitedError']);
    });
  },
);
