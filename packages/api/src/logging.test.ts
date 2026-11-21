import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { testTargets } from '@osfpm/core/src/db/test-support.js';
import { API_PREFIX } from './api-version.js';
import { REDACTED } from './logging.js';
import { createTestApp } from './test-support.js';

/** A value that must never reach a log line. */
const SECRET = 'secret-marker-7d2e';

/** A route that takes a body, answers with it, and sets a cookie: all things a log must not repeat. */
const echoRoute: FastifyPluginAsync = (app) => {
  app.withTypeProvider<ZodTypeProvider>().post(
    '/test/echo/:id',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.looseObject({}),
        querystring: z.looseObject({}),
      },
    },
    (request, reply) => {
      void reply.header('set-cookie', `session=${SECRET}; HttpOnly`);
      return { echoed: request.body };
    },
  );
  // A route that logs the whole request and reply objects, as a careless
  // handler might.
  app
    .withTypeProvider<ZodTypeProvider>()
    .get(
      '/test/whole/:id',
      { schema: { params: z.object({ id: z.string() }) } },
      (request, reply) => {
        request.log.info({ req: request, res: reply }, 'logged whole');
        return { ok: true };
      },
    );
  // Routes that go wrong in ways Fastify itself reports. Fastify's messages
  // for these name the full URL, query included.
  app.get('/test/twice', async (_request, reply) => {
    await reply.send({ first: true });
    return reply.send({ second: true });
  });
  app.get('/test/headers-sent', (_request, reply) => {
    reply.raw.writeHead(200, { 'content-type': 'text/plain' });
    reply.raw.write('partial');
    return reply.send({ late: true });
  });
  // Lines a careless handler writes by hand, under keys with no serialiser.
  app
    .withTypeProvider<ZodTypeProvider>()
    .get(
      '/test/by-hand',
      { schema: { querystring: z.looseObject({}) } },
      (request) => {
        request.log.info({ headers: request.headers }, 'headers by hand');
        request.log.info({ query: request.query }, 'query by hand');
        request.log.info({ request }, 'request by hand');
        request.log.info({ url: request.url }, 'url by hand');
        request.log.info(
          { nested: { deep: { 'x-auth-token': SECRET, kept: 'kept-value' } } },
          'nested by hand',
        );
        request.log.error(new Error(`an error that quotes ${SECRET}`));
        request.log.error({ err: new Error(`quotes ${SECRET} too`) });
        return { ok: true };
      },
    );
  return Promise.resolve();
};

describe.each(testTargets)('what the log never holds, on $name', (target) => {
  // Trace is the most a log can say, so nothing may appear even there.
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeAll(async () => {
    ctx = await createTestApp(target, { logLevel: 'trace' });
    await ctx.app.register(echoRoute, { prefix: API_PREFIX });
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('holds no body, no header value, no query value and no path parameter', async () => {
    ctx.lines.length = 0;
    const response = await ctx.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/test/echo/${SECRET}-path?token=${SECRET}-query&api_token=${SECRET}-other&page=2`,
      headers: {
        authorization: `Bearer ${SECRET}-auth`,
        cookie: `session=${SECRET}-cookie`,
        'x-api-token': `${SECRET}-header`,
        'content-type': 'application/json',
      },
      payload: { note: `${SECRET}-body`, medical: `${SECRET}-medical` },
    });
    // The response did carry the values, so the test is not vacuous.
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(`${SECRET}-body`);
    expect(response.headers['set-cookie']).toContain(SECRET);

    expect(ctx.lines.length).toBeGreaterThan(0);
    const log = ctx.lines.join('');
    expect(log).not.toContain(SECRET);
    expect(log).not.toContain('page=2');
    expect(log).not.toContain('Bearer');

    // What is there: the route pattern, not the path that was asked for.
    const completed = ctx
      .records()
      .find((record) => record.msg === 'request completed');
    expect(completed).toMatchObject({
      method: 'POST',
      route: `${API_PREFIX}/test/echo/:id`,
      statusCode: 200,
      requestId: response.headers['x-request-id'],
    });
  });

  it('holds no secret when the request is refused', async () => {
    ctx.lines.length = 0;
    await ctx.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/test/echo/${SECRET}-path?token=${SECRET}-query`,
      headers: {
        authorization: `Bearer ${SECRET}-auth`,
        cookie: `session=${SECRET}-cookie`,
        'content-type': 'application/json',
      },
      payload: `[${SECRET}`,
    });
    await ctx.app.inject({
      method: 'GET',
      url: `/${SECRET}-nowhere?token=${SECRET}-query`,
      headers: { authorization: `Bearer ${SECRET}-auth` },
    });
    expect(ctx.lines.length).toBeGreaterThan(0);
    expect(ctx.lines.join('')).not.toContain(SECRET);
  });

  it('masks authorization, cookie and set-cookie if a line is ever written with them', () => {
    ctx.lines.length = 0;
    ctx.app.log.info(
      {
        headers: {
          authorization: `Bearer ${SECRET}`,
          cookie: `session=${SECRET}`,
          'set-cookie': `session=${SECRET}`,
        },
        req: { headers: { authorization: SECRET, cookie: SECRET } },
        res: { headers: { 'set-cookie': SECRET } },
      },
      'a line written by hand',
    );
    const log = ctx.lines.join('');
    expect(log).not.toContain(SECRET);
    expect(log).toContain(REDACTED);
  });

  it('describes a request object by its method and route only, if one is logged', async () => {
    ctx.lines.length = 0;
    await ctx.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/test/whole/${SECRET}-path?token=${SECRET}`,
      headers: { authorization: `Bearer ${SECRET}`, cookie: SECRET },
    });
    const whole = ctx.records().find((record) => record.msg === 'logged whole');
    expect(whole).toMatchObject({
      req: { method: 'GET', route: `${API_PREFIX}/test/whole/:id` },
      res: { statusCode: 200 },
    });
    expect(Object.keys(whole!.req as object).sort()).toEqual([
      'method',
      'route',
    ]);
    expect(ctx.lines.join('')).not.toContain(SECRET);
  });
  it('does not repeat a URL that Fastify itself reports, query included', async () => {
    ctx.lines.length = 0;
    await ctx.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/test/twice?token=${SECRET}&page=2`,
    });
    // Fastify throws out of this one after it has logged its warning.
    await ctx.app
      .inject({
        method: 'GET',
        url: `${API_PREFIX}/test/headers-sent?token=${SECRET}&page=2`,
      })
      .catch(() => undefined);
    // Fastify did report both mistakes, so the check below is not vacuous.
    expect(ctx.lines.join('')).toMatch(/already sent|did you forget/i);
    expect(ctx.lines.join('')).not.toContain(SECRET);
  });

  it('masks token-named and credential keys in a line written by hand, whatever key it sits under', async () => {
    ctx.lines.length = 0;
    await ctx.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/test/by-hand?token=${SECRET}-q&api_token=${SECRET}-q2&page=2`,
      headers: {
        authorization: `Bearer ${SECRET}-auth`,
        cookie: `session=${SECRET}-cookie`,
        'x-auth-token': `${SECRET}-header`,
      },
    });
    const log = ctx.lines.join('');
    expect(log).not.toContain(SECRET);
    expect(log).not.toContain('Bearer');
    // The lines were written, and what is not secret is still there.
    expect(log).toContain('headers by hand');
    expect(log).toContain('kept-value');
    expect(log).toContain('page=2');
    expect(log).toContain(REDACTED);
  });
});
