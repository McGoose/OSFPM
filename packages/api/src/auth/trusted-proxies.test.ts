import type { FastifyPluginAsync } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  testTargets,
  type TestTarget,
} from '@osfpm/core/src/db/test-support.js';
import { API_PREFIX } from '../api-version.js';
import { createTestApp } from '../test-support.js';
import { AUTH_RATE_LIMIT } from './rate-limit.js';

/** Routes that exist only in these tests: one tells the caller what address the server took it for, one is limited by address. */
const testRoutes: FastifyPluginAsync = (app) => {
  app.get('/test/ip', { config: { auth: 'none' } }, (request) => ({
    ip: request.ip,
  }));
  app.get(
    '/test/strict',
    { config: { auth: 'none', authRateLimit: true } },
    () => ({ ok: true }),
  );
  return Promise.resolve();
};

describe.each(testTargets)('trusted proxies on $name', (target: TestTarget) => {
  /** An app that trusts the proxies in `trustedProxies` (none by default), and closes itself. */
  const apps: Awaited<ReturnType<typeof createTestApp>>[] = [];
  async function appTrusting(trustedProxies?: readonly string[]) {
    const ctx = await createTestApp(target, {
      ...(trustedProxies === undefined ? {} : { trustedProxies }),
    });
    await ctx.app.register(testRoutes, { prefix: API_PREFIX });
    apps.push(ctx);
    return ctx;
  }
  afterAll(async () => {
    for (const ctx of apps) await ctx.close();
  });

  const ask = (
    ctx: Awaited<ReturnType<typeof createTestApp>>,
    path: string,
    peer: string,
    forwardedFor?: string,
  ) =>
    ctx.app.inject({
      method: 'GET',
      url: `${API_PREFIX}${path}`,
      remoteAddress: peer,
      headers:
        forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
    });
  const ipSeenAs = async (
    ctx: Awaited<ReturnType<typeof createTestApp>>,
    peer: string,
    forwardedFor?: string,
  ) =>
    (await ask(ctx, '/test/ip', peer, forwardedFor)).json<{ ip: string }>().ip;

  describe('by default, none', () => {
    let ctx: Awaited<ReturnType<typeof createTestApp>>;
    beforeAll(async () => {
      ctx = await appTrusting();
    });

    it('takes the address of the connection, and ignores X-Forwarded-For', async () => {
      expect(await ipSeenAs(ctx, '10.1.0.1', '203.0.113.7')).toBe('10.1.0.1');
      expect(await ipSeenAs(ctx, '10.1.0.1')).toBe('10.1.0.1');
    });

    it('cannot be talked out of a limit by a caller who changes the header on every request', async () => {
      for (let n = 0; n < AUTH_RATE_LIMIT.max; n += 1) {
        const response = await ask(
          ctx,
          '/test/strict',
          '10.1.0.2',
          `203.0.113.${n}`,
        );
        expect(response.statusCode).toBe(200);
      }
      const refused = await ask(
        ctx,
        '/test/strict',
        '10.1.0.2',
        '203.0.113.200',
      );
      expect(refused.statusCode).toBe(429);
    });
  });

  describe('with an address listed', () => {
    let ctx: Awaited<ReturnType<typeof createTestApp>>;
    beforeAll(async () => {
      ctx = await appTrusting(['10.2.0.1']);
    });

    it('takes the address that the proxy says it forwarded for', async () => {
      expect(await ipSeenAs(ctx, '10.2.0.1', '203.0.113.7')).toBe(
        '203.0.113.7',
      );
    });

    it('counts each client behind the proxy on its own', async () => {
      for (let n = 0; n <= AUTH_RATE_LIMIT.max; n += 1) {
        await ask(ctx, '/test/strict', '10.2.0.1', '203.0.113.50');
      }
      expect(
        (await ask(ctx, '/test/strict', '10.2.0.1', '203.0.113.50')).statusCode,
      ).toBe(429);
      expect(
        (await ask(ctx, '/test/strict', '10.2.0.1', '203.0.113.51')).statusCode,
      ).toBe(200);
    });

    it('does not believe a connection that is not the proxy', async () => {
      expect(await ipSeenAs(ctx, '10.2.0.2', '203.0.113.7')).toBe('10.2.0.2');
      // So rotating the header from such a connection does not shake off a limit.
      for (let n = 0; n < AUTH_RATE_LIMIT.max; n += 1) {
        await ask(ctx, '/test/strict', '10.2.0.2', `203.0.113.${100 + n}`);
      }
      expect(
        (await ask(ctx, '/test/strict', '10.2.0.2', '203.0.113.250'))
          .statusCode,
      ).toBe(429);
    });

    it('takes the first address from the right that is not a proxy, never one a client wrote on the left', async () => {
      // The client wrote 1.2.3.4. The proxy added the address it saw, 198.51.100.5.
      expect(await ipSeenAs(ctx, '10.2.0.1', '1.2.3.4, 198.51.100.5')).toBe(
        '198.51.100.5',
      );
      // A second proxy in the chain, also listed, is stepped over.
      const both = await appTrusting(['10.2.0.1', '10.2.0.9']);
      expect(
        await ipSeenAs(both, '10.2.0.1', '1.2.3.4, 198.51.100.5, 10.2.0.9'),
      ).toBe('198.51.100.5');
    });

    it('takes the connection when the proxy sends no header', async () => {
      expect(await ipSeenAs(ctx, '10.2.0.1')).toBe('10.2.0.1');
    });
  });

  describe('with a range, or a name for one', () => {
    it('trusts every address in a CIDR range, and none outside it', async () => {
      const ctx = await appTrusting(['10.0.0.0/8']);
      expect(await ipSeenAs(ctx, '10.200.1.1', '203.0.113.7')).toBe(
        '203.0.113.7',
      );
      expect(await ipSeenAs(ctx, '11.0.0.1', '203.0.113.7')).toBe('11.0.0.1');
    });

    it('takes IPv6 addresses and ranges', async () => {
      const ctx = await appTrusting(['fd00::/8']);
      expect(await ipSeenAs(ctx, 'fd00::1', '2001:db8::7')).toBe('2001:db8::7');
      expect(await ipSeenAs(ctx, '2001:db8::1', '2001:db8::7')).toBe(
        '2001:db8::1',
      );
    });

    it('takes a list, and the name loopback', async () => {
      const ctx = await appTrusting(['loopback', '192.168.0.0/16']);
      expect(await ipSeenAs(ctx, '127.0.0.1', '203.0.113.7')).toBe(
        '203.0.113.7',
      );
      expect(await ipSeenAs(ctx, '192.168.4.4', '203.0.113.8')).toBe(
        '203.0.113.8',
      );
      expect(await ipSeenAs(ctx, '172.16.0.1', '203.0.113.9')).toBe(
        '172.16.0.1',
      );
    });
  });
});
