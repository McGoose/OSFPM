import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@osfpm/core/src/db/ids.js';
import { testTargets } from '@osfpm/core/src/db/test-support.js';
import { createTestApp, TEST_PUBLIC_ORIGIN, UUID_V7 } from './test-support.js';

describe.each(testTargets)('the app on $name', (target) => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeAll(async () => {
    ctx = await createTestApp(target);
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('answers every request with a new UUIDv7 in X-Request-Id', async () => {
    const first = await ctx.app.inject({ method: 'GET', url: '/nowhere' });
    const second = await ctx.app.inject({ method: 'GET', url: '/nowhere' });
    expect(first.headers['x-request-id']).toMatch(UUID_V7);
    expect(second.headers['x-request-id']).toMatch(UUID_V7);
    expect(second.headers['x-request-id']).not.toBe(
      first.headers['x-request-id'],
    );
  });

  it('ignores a request ID sent by the caller, even a valid UUIDv7', async () => {
    // A value that would pass any check on the shape of the ID, so only
    // ignoring the header can make the response differ from it.
    const chosen = newId();
    const valid = await ctx.app.inject({
      method: 'GET',
      url: '/nowhere',
      headers: { 'x-request-id': chosen },
    });
    expect(valid.headers['x-request-id']).toMatch(UUID_V7);
    expect(valid.headers['x-request-id']).not.toBe(chosen);

    const odd = await ctx.app.inject({
      method: 'GET',
      url: '/nowhere',
      headers: { 'x-request-id': 'chosen-by-the-caller' },
    });
    expect(odd.headers['x-request-id']).toMatch(UUID_V7);

    // The log line carries the server's ID, not the caller's.
    ctx.lines.length = 0;
    await ctx.app.inject({
      method: 'GET',
      url: '/nowhere',
      headers: { 'x-request-id': chosen },
    });
    expect(ctx.lines.join('')).not.toContain(chosen);
  });

  it('logs one line per request: method, route, status, duration and request ID', async () => {
    ctx.lines.length = 0;
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/nowhere?page=2',
    });
    // The whole log for the request is that one line: Fastify's own
    // "incoming request" line, which would repeat the route, is off.
    expect(ctx.records()).toHaveLength(1);
    const completed = ctx
      .records()
      .filter((record) => record.msg === 'request completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      requestId: response.headers['x-request-id'],
      method: 'GET',
      route: '(unmatched)',
      statusCode: 404,
    });
    expect(typeof completed[0]!.durationMs).toBe('number');
    // Nothing of the URL is logged, not even the unmatched path or its query.
    expect(ctx.lines.join('')).not.toContain('nowhere');
    expect(ctx.lines.join('')).not.toContain('page=2');
  });
});

describe('the app without a logger', () => {
  it('can be built and used, and answers like any other', async () => {
    const { buildApp } = await import('./app.js');
    const { createDatabase } = await import('@osfpm/core/src/db/client.js');
    const database = createDatabase({ driver: 'pglite' });
    const app = buildApp({ db: database, publicOrigin: TEST_PUBLIC_ORIGIN });
    try {
      const response = await app.inject({ method: 'GET', url: '/nowhere' });
      expect(response.statusCode).toBe(404);
      expect(response.headers['x-request-id']).toMatch(UUID_V7);
    } finally {
      await app.close();
      await database.close();
    }
  });
});
