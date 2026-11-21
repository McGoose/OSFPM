import type { OutgoingHttpHeaders } from 'node:http';
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
import { createTestApp, UUID_V7 } from '../test-support.js';
import { SESSION_COOKIE } from './cookie.js';
import { ADDRESS_RATE_LIMIT } from './rate-limit.js';

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

const setCookies = (headers: OutgoingHttpHeaders) => {
  const value = headers['set-cookie'];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [String(value)];
};

describe('the coarse limit per address', () => {
  it('is 300 requests per minute, in one place', () => {
    expect(ADDRESS_RATE_LIMIT).toEqual({ max: 300, timeWindowMs: 60_000 });
  });
});

describe.each(testTargets)(
  'the coarse limit per address on $name',
  (target: TestTarget) => {
    let ctx: TestApp;
    let addresses = 0;
    /** An address of its own for each test, so one test's requests do not count against the next. */
    const freshAddress = () =>
      `10.6.${Math.floor(addresses / 250)}.${(addresses++ % 250) + 1}`;

    beforeAll(async () => {
      // The real limit, not the one test apps are given by default.
      ctx = await createTestApp(target, {
        addressRateLimit: ADDRESS_RATE_LIMIT,
      });
      await migrate(ctx.database);
      await seedInstallation(ctx.database);
    });
    afterAll(async () => {
      await ctx.close();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const call = (
      path: string,
      remoteAddress: string,
      headers: Record<string, string> = {},
      app: TestApp = ctx,
    ) =>
      app.app.inject({
        method: 'GET',
        url: path.startsWith('/') ? `${API_PREFIX}${path}` : path,
        remoteAddress,
        headers,
      });

    /** Makes `count` requests and answers the status codes, as a count of each. */
    async function flood(
      path: string,
      remoteAddress: string,
      count: number,
      headers: Record<string, string> = {},
    ) {
      const statuses = new Map<number, number>();
      for (let n = 0; n < count; n += 1) {
        const { statusCode } = await call(path, remoteAddress, headers);
        statuses.set(statusCode, (statuses.get(statusCode) ?? 0) + 1);
      }
      return statuses;
    }

    it('lets 300 requests through and refuses the 301st with a 429 problem and Retry-After', async () => {
      const ip = freshAddress();
      expect(await flood('/meta', ip, ADDRESS_RATE_LIMIT.max)).toEqual(
        new Map([[200, ADDRESS_RATE_LIMIT.max]]),
      );
      const refused = await call('/meta', ip);
      expect(refused.statusCode).toBe(429);
      expect(refused.headers['content-type']).toMatch(
        /^application\/problem\+json/,
      );
      expect(refused.headers['x-request-id']).toMatch(UUID_V7);
      expect(refused.json()).toMatchObject({
        type: '/problems/rate-limited',
        code: 'rate-limited',
        status: 429,
        instance: `${API_PREFIX}/meta`,
      });
      const retryAfter = Number(refused.headers['retry-after']);
      expect(Number.isInteger(retryAfter)).toBe(true);
      expect(retryAfter).toBeGreaterThanOrEqual(1);
      expect(retryAfter).toBeLessThanOrEqual(
        ADDRESS_RATE_LIMIT.timeWindowMs / 1000,
      );
    });

    it.each([
      ['a route with no session', '/meta', 200],
      ['the OpenAPI document', '/openapi.json', 200],
      ['a signed-in route, asked by no one', '/auth/me', 401],
      ['a path that is no route', '/nowhere', 404],
    ] as const)(
      'applies to %s',
      async (_label, path, answer) => {
        const ip = freshAddress();
        expect(await flood(path, ip, ADDRESS_RATE_LIMIT.max)).toEqual(
          new Map([[answer, ADDRESS_RATE_LIMIT.max]]),
        );
        expect((await call(path, ip)).statusCode).toBe(429);
      },
      60_000,
    );

    it('shares one count across all of them', async () => {
      const ip = freshAddress();
      await flood('/meta', ip, 100);
      await flood('/auth/me', ip, 100);
      await flood('/nowhere', ip, 100);
      for (const path of ['/meta', '/auth/me', '/nowhere', '/openapi.json']) {
        expect((await call(path, ip)).statusCode, path).toBe(429);
      }
    });

    it('stops an unauthenticated flood before the session is looked up', async () => {
      const ip = freshAddress();
      const junk = { cookie: `${SESSION_COOKIE}=not-a-real-token` };
      // Each of the first 300 is looked up, found wanting, and told to drop the cookie.
      for (let n = 0; n < ADDRESS_RATE_LIMIT.max; n += 1) {
        const response = await call('/auth/me', ip, junk);
        expect(response.statusCode, `request ${n + 1}`).toBe(401);
        expect(setCookies(response.headers)).toHaveLength(1);
      }
      // The 301st is refused before that happens: nothing was looked up, so
      // nothing is cleared.
      const refused = await call('/auth/me', ip, junk);
      expect(refused.statusCode).toBe(429);
      expect(setCookies(refused.headers)).toEqual([]);
    });

    it('also refuses a request that carries a good session, before it is looked up', async () => {
      const userId = await seedActiveUser(ctx.database);
      const { token } = await createSession(ctx.database.db, {
        userId,
        method: 'password',
        now: new Date(),
      });
      const cookie = { cookie: `${SESSION_COOKIE}=${token}` };
      const busy = freshAddress();
      await flood('/meta', busy, ADDRESS_RATE_LIMIT.max);
      expect((await call('/auth/me', busy, cookie)).statusCode).toBe(429);
      // From an address that has not used its requests, the same session works.
      expect((await call('/auth/me', freshAddress(), cookie)).statusCode).toBe(
        200,
      );
    });

    it('never limits /health or /health/ready, and they use up none of the count', async () => {
      const ip = freshAddress();
      for (const path of ['/health', '/health/ready']) {
        expect(await flood(path, ip, ADDRESS_RATE_LIMIT.max * 3), path).toEqual(
          new Map([[200, ADDRESS_RATE_LIMIT.max * 3]]),
        );
        const response = await call(path, ip);
        expect(response.headers['retry-after']).toBeUndefined();
      }
      // 900 health requests later, the whole allowance is still there.
      expect(await flood('/meta', ip, ADDRESS_RATE_LIMIT.max)).toEqual(
        new Map([[200, ADDRESS_RATE_LIMIT.max]]),
      );
      expect((await call('/meta', ip)).statusCode).toBe(429);
      // And a busy address can still be probed.
      expect((await call('/health', ip)).statusCode).toBe(200);
      expect((await call('/health/ready', ip)).statusCode).toBe(200);
    });

    it('counts each address on its own', async () => {
      const busy = freshAddress();
      await flood('/meta', busy, ADDRESS_RATE_LIMIT.max);
      expect((await call('/meta', busy)).statusCode).toBe(429);
      expect((await call('/meta', freshAddress())).statusCode).toBe(200);
    });

    it('lets requests through again once the minute is up', async () => {
      const ip = freshAddress();
      vi.useFakeTimers({ toFake: ['Date'], now: new Date(Date.now()) });
      const start = Date.now();
      await flood('/meta', ip, ADDRESS_RATE_LIMIT.max);
      expect((await call('/meta', ip)).statusCode).toBe(429);
      vi.setSystemTime(start + ADDRESS_RATE_LIMIT.timeWindowMs + 1_000);
      expect((await call('/meta', ip)).statusCode).toBe(200);
    });

    it('is separate from the strict limit and the one per session: a request is counted in each that applies', async () => {
      // The signed-in routes have their own, smaller, count per session. One
      // session asking from one address hits that first.
      const userId = await seedActiveUser(ctx.database);
      const { token } = await createSession(ctx.database.db, {
        userId,
        method: 'password',
        now: new Date(),
      });
      const cookie = { cookie: `${SESSION_COOKIE}=${token}` };
      const ip = freshAddress();
      const statuses = await flood('/auth/me', ip, 130, cookie);
      expect(statuses).toEqual(
        new Map([
          [200, 120],
          [429, 10],
        ]),
      );
      // The address has used 130 of its 300, so other routes still answer.
      expect((await call('/meta', ip)).statusCode).toBe(200);
    });

    it('says nothing about the address, the count or the limit, and logs no address', async () => {
      const ip = freshAddress();
      ctx.lines.length = 0;
      await flood('/meta', ip, ADDRESS_RATE_LIMIT.max);
      const refused = await call('/meta', ip);
      expect(refused.statusCode).toBe(429);
      expect(refused.body).not.toContain(ip);
      expect(refused.body).not.toMatch(/\b300\b/);
      expect(refused.headers['x-ratelimit-limit']).toBeUndefined();
      expect(ctx.lines.join('')).not.toContain(ip);
      const refusals = ctx
        .records()
        .filter((record) => record.msg === 'request refused');
      expect(
        refusals.map((record) => (record.err as { type: string }).type),
      ).toEqual(['RateLimitedError']);
    });
  },
);

describe.each(testTargets)(
  'the coarse limit and trusted proxies on $name',
  (target: TestTarget) => {
    const apps: TestApp[] = [];
    afterAll(async () => {
      for (const app of apps) await app.close();
    });
    async function appTrusting(trustedProxies?: readonly string[]) {
      const app = await createTestApp(target, {
        addressRateLimit: ADDRESS_RATE_LIMIT,
        ...(trustedProxies === undefined ? {} : { trustedProxies }),
      });
      apps.push(app);
      return app;
    }
    const ask = (
      app: TestApp,
      peer: string,
      forwardedFor?: string,
      path = '/meta',
    ) =>
      app.app.inject({
        method: 'GET',
        url: `${API_PREFIX}${path}`,
        remoteAddress: peer,
        headers:
          forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
      });

    it('by default believes no header: a caller cannot shake off the limit by changing X-Forwarded-For', async () => {
      const app = await appTrusting();
      for (let n = 0; n < ADDRESS_RATE_LIMIT.max; n += 1) {
        const response = await ask(app, '10.5.0.2', `203.0.113.${n % 250}`);
        expect(response.statusCode).toBe(200);
      }
      expect((await ask(app, '10.5.0.2', '203.0.113.251')).statusCode).toBe(
        429,
      );
    });

    it('behind a listed proxy, counts each client the proxy forwards for on its own', async () => {
      const app = await appTrusting(['10.5.0.1']);
      for (let n = 0; n < ADDRESS_RATE_LIMIT.max; n += 1) {
        await ask(app, '10.5.0.1', '203.0.113.50');
      }
      expect((await ask(app, '10.5.0.1', '203.0.113.50')).statusCode).toBe(429);
      // Another client behind the very same proxy is not held back.
      expect((await ask(app, '10.5.0.1', '203.0.113.51')).statusCode).toBe(200);
    });

    it('does not believe a connection that is not the listed proxy', async () => {
      const app = await appTrusting(['10.5.0.1']);
      for (let n = 0; n < ADDRESS_RATE_LIMIT.max; n += 1) {
        await ask(app, '10.5.0.9', `203.0.113.${n % 250}`);
      }
      expect((await ask(app, '10.5.0.9', '203.0.113.252')).statusCode).toBe(
        429,
      );
    });

    it('lets the health routes through behind a proxy too', async () => {
      const app = await appTrusting(['10.5.0.1']);
      for (let n = 0; n < ADDRESS_RATE_LIMIT.max; n += 1) {
        await ask(app, '10.5.0.1', '203.0.113.60');
      }
      expect((await ask(app, '10.5.0.1', '203.0.113.60')).statusCode).toBe(429);
      expect(
        (await ask(app, '10.5.0.1', '203.0.113.60', '/health')).statusCode,
      ).toBe(200);
    });
  },
);
