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
import {
  testTargets,
  type TestTarget,
} from '@osfpm/core/src/db/test-support.js';
import { API_PREFIX } from '../api-version.js';
import { createTestApp, UUID_V7 } from '../test-support.js';
import { AUTH_RATE_LIMIT } from './rate-limit.js';

/**
 * Routes that exist only in these tests. Under `/auth/` they carry the
 * `authRateLimit` option, as every route there must; the others do not.
 */
const testRoutes: FastifyPluginAsync = (app) => {
  // Each declares `auth` differently, because the limit must come first
  // whatever the answer would have been.
  app.get('/auth/test/required', { config: { authRateLimit: true } }, () => ({
    ok: true,
  }));
  app.get(
    '/auth/test/none',
    { config: { auth: 'none', authRateLimit: true } },
    () => ({ ok: true }),
  );
  app.post(
    '/auth/test/optional',
    { config: { auth: 'optional', authRateLimit: true } },
    () => ({ ok: true }),
  );
  app.get('/test/not-limited', { config: { auth: 'none' } }, () => ({
    ok: true,
  }));
  return Promise.resolve();
};

describe('the limit on auth routes', () => {
  it('is 10 requests per minute per IP, in one place', () => {
    expect(AUTH_RATE_LIMIT).toEqual({ max: 10, timeWindowMs: 60_000 });
  });
});

describe.each(testTargets)('rate limits on $name', (target: TestTarget) => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  /** A new address for each test, so one test's requests do not count against the next. */
  let addresses = 0;
  const freshAddress = () =>
    `10.9.${Math.floor(addresses / 250)}.${(addresses++ % 250) + 1}`;

  beforeAll(async () => {
    ctx = await createTestApp(target);
    await ctx.app.register(testRoutes, { prefix: API_PREFIX });
  });
  afterAll(async () => {
    await ctx.close();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const call = (
    method: 'GET' | 'POST',
    path: string,
    remoteAddress: string,
    headers: Record<string, string> = {},
  ) =>
    ctx.app.inject({
      method,
      url: `${API_PREFIX}${path}`,
      remoteAddress,
      headers,
    });

  it('lets 10 requests through and refuses the 11th with a 429 problem and Retry-After', async () => {
    const ip = freshAddress();
    for (let n = 1; n <= AUTH_RATE_LIMIT.max; n += 1) {
      // 401 is the route's own answer: the request was let through to it.
      expect(
        (await call('GET', '/auth/test/required', ip)).statusCode,
        `request ${n}`,
      ).toBe(401);
    }
    const refused = await call('GET', '/auth/test/required', ip);
    expect(refused.statusCode).toBe(429);
    expect(refused.headers['content-type']).toMatch(
      /^application\/problem\+json/,
    );
    expect(refused.headers['x-request-id']).toMatch(UUID_V7);
    expect(refused.json()).toMatchObject({
      type: '/problems/rate-limited',
      code: 'rate-limited',
      status: 429,
      instance: `${API_PREFIX}/auth/test/required`,
      requestId: refused.headers['x-request-id'],
    });
    // Whole seconds, at least 1, at most the window.
    const retryAfter = Number(refused.headers['retry-after']);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(AUTH_RATE_LIMIT.timeWindowMs / 1000);
  });

  it('counts a request before it checks who is asking, so a caller with no session is limited too', async () => {
    const ip = freshAddress();
    const statuses: number[] = [];
    for (let n = 0; n < AUTH_RATE_LIMIT.max + 3; n += 1) {
      statuses.push((await call('GET', '/auth/test/required', ip)).statusCode);
    }
    // Ten 401s, then 429s. If the session check came first, it would be 401 throughout.
    expect(statuses).toEqual([
      ...Array<number>(AUTH_RATE_LIMIT.max).fill(401),
      429,
      429,
      429,
    ]);
  });

  it('counts a wrong cookie and a wrong Origin the same way', async () => {
    const ip = freshAddress();
    for (let n = 0; n < AUTH_RATE_LIMIT.max; n += 1) {
      await call('POST', '/auth/test/optional', ip, {
        cookie: '__Host-osfpm_session=junk',
        origin: 'https://attacker.example.test',
      });
    }
    expect((await call('POST', '/auth/test/optional', ip)).statusCode).toBe(
      429,
    );
  });

  it('limits a route that says auth: none as well', async () => {
    const ip = freshAddress();
    for (let n = 0; n < AUTH_RATE_LIMIT.max; n += 1) {
      expect((await call('GET', '/auth/test/none', ip)).statusCode).toBe(200);
    }
    expect((await call('GET', '/auth/test/none', ip)).statusCode).toBe(429);
  });

  it('shares one count across the auth routes, so a caller cannot get ten of each', async () => {
    const ip = freshAddress();
    for (let n = 0; n < 6; n += 1) await call('GET', '/auth/test/required', ip);
    for (let n = 0; n < 4; n += 1) await call('GET', '/auth/test/none', ip);
    expect((await call('GET', '/auth/test/required', ip)).statusCode).toBe(429);
    expect((await call('GET', '/auth/test/none', ip)).statusCode).toBe(429);
  });

  it('counts each address on its own', async () => {
    const busy = freshAddress();
    const quiet = freshAddress();
    for (let n = 0; n <= AUTH_RATE_LIMIT.max; n += 1) {
      await call('GET', '/auth/test/none', busy);
    }
    expect((await call('GET', '/auth/test/none', busy)).statusCode).toBe(429);
    expect((await call('GET', '/auth/test/none', quiet)).statusCode).toBe(200);
  });

  it('lets requests through again once the minute is up', async () => {
    const ip = freshAddress();
    vi.useFakeTimers({
      toFake: ['Date'],
      now: new Date('2031-05-05T10:00:00Z'),
    });
    for (let n = 0; n <= AUTH_RATE_LIMIT.max; n += 1) {
      await call('GET', '/auth/test/none', ip);
    }
    expect((await call('GET', '/auth/test/none', ip)).statusCode).toBe(429);
    vi.setSystemTime(new Date('2031-05-05T10:01:01Z'));
    expect((await call('GET', '/auth/test/none', ip)).statusCode).toBe(200);
  });

  it('never limits a route that does not ask for it: health, meta and the OpenAPI document included', async () => {
    const ip = freshAddress();
    for (const path of [
      '/test/not-limited',
      '/health',
      '/health/ready',
      '/meta',
      '/openapi.json',
    ]) {
      for (let n = 0; n < AUTH_RATE_LIMIT.max * 3; n += 1) {
        const response = await call('GET', path, ip);
        expect(response.statusCode, `${path} request ${n + 1}`).toBe(200);
        expect(response.headers['retry-after']).toBeUndefined();
      }
    }
  });

  it('is not used up by requests to routes that are not limited', async () => {
    const ip = freshAddress();
    for (let n = 0; n < 50; n += 1) await call('GET', '/health', ip);
    expect((await call('GET', '/auth/test/none', ip)).statusCode).toBe(200);
  });

  it('says nothing about the address, the count or the limit in the 429 body', async () => {
    const ip = freshAddress();
    for (let n = 0; n <= AUTH_RATE_LIMIT.max; n += 1) {
      await call('GET', '/auth/test/none', ip);
    }
    const refused = await call('GET', '/auth/test/none', ip);
    expect(refused.statusCode).toBe(429);
    expect(refused.body).not.toContain(ip);
    expect(refused.body).not.toMatch(/\b10\b|\b60\b/);
    expect(refused.headers['x-ratelimit-limit']).toBeUndefined();
  });

  it('keeps the address out of the log', async () => {
    const ip = freshAddress();
    ctx.lines.length = 0;
    for (let n = 0; n <= AUTH_RATE_LIMIT.max; n += 1) {
      await call('GET', '/auth/test/none', ip);
    }
    expect(ctx.lines.join('')).not.toContain(ip);
    const refused = ctx
      .records()
      .filter((record) => record.msg === 'request refused');
    expect(
      refused.map((record) => (record.err as { type: string }).type),
    ).toEqual(['RateLimitedError']);
  });
});
