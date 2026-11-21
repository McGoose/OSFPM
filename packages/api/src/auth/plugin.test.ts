import type { OutgoingHttpHeaders } from 'node:http';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createSession,
  disableUser,
  revokeSession,
  SESSION_DEFAULTS,
} from '@osfpm/core/src/auth/sessions.js';
import {
  seedActiveUser,
  seedInstallation,
  setUserStatus,
} from '@osfpm/core/src/auth/test-support.js';
import { migrate } from '@osfpm/core/src/db/migrate.js';
import { session } from '@osfpm/core/src/db/schema/index.js';
import {
  testTargets,
  type TestTarget,
} from '@osfpm/core/src/db/test-support.js';
import { API_PREFIX } from '../api-version.js';
import { createTestApp, TEST_PUBLIC_ORIGIN, UUID_V7 } from '../test-support.js';
import {
  clearSessionCookie,
  SESSION_COOKIE,
  setSessionCookie,
} from './cookie.js';
import { requireAuthenticated } from './plugin.js';

const HOUR = 60 * 60 * 1000;

/** What a route that reads the acting user says about the request. */
function describeRequest(request: FastifyRequest) {
  if (request.auth === null) return { signedIn: false };
  const { context, user, session } = request.auth;
  return {
    signedIn: true,
    userId: user.id,
    sessionId: session.id,
    actor: context.actor,
    originServer: context.originServer,
    requestId: context.requestId,
    hasClock: typeof context.clock() === 'object',
  };
}

/**
 * Routes that exist only in these tests, one for each way a route can declare
 * `auth`. `/test/required` declares nothing: the default must be `required`.
 */
const testRoutes: FastifyPluginAsync = (app) => {
  app.get('/test/required', (request) => describeRequest(request));
  app.get('/test/optional', { config: { auth: 'optional' } }, (request) =>
    describeRequest(request),
  );
  app.get('/test/odd', { config: { auth: 'sometimes' as never } }, (request) =>
    describeRequest(request),
  );
  // A handler that asks for a user on a route that does not guarantee one.
  app.get(
    '/test/optional-needs-user',
    { config: { auth: 'optional' } },
    (request) => requireAuthenticated(request).user.id,
  );
  app.get('/test/none', { config: { auth: 'none' } }, (request) =>
    describeRequest(request),
  );
  app.post('/test/changes', (request) => describeRequest(request));
  app.put('/test/changes', (request) => describeRequest(request));
  app.patch('/test/changes', (request) => describeRequest(request));
  app.delete('/test/changes', (request) => describeRequest(request));
  app.post(
    '/test/changes-optional',
    { config: { auth: 'optional' } },
    (request) => describeRequest(request),
  );
  app.post('/test/changes-none', { config: { auth: 'none' } }, (request) =>
    describeRequest(request),
  );
  app.get(
    '/test/set-cookie',
    { config: { auth: 'none' } },
    (_request, reply) => {
      setSessionCookie(
        reply,
        'abc-token',
        new Date('2031-01-02T03:04:05.678Z'),
      );
      return { ok: true };
    },
  );
  app.get(
    '/test/clear-cookie',
    { config: { auth: 'none' } },
    (_request, reply) => {
      clearSessionCookie(reply);
      return { ok: true };
    },
  );
  return Promise.resolve();
};

/** The `Set-Cookie` header lines of a response. */
function setCookies(headers: OutgoingHttpHeaders): string[] {
  const value = headers['set-cookie'];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [String(value)];
}

/** A `Set-Cookie` line split into its name, value and attributes (names in lower case). */
function parseSetCookie(line: string) {
  const [pair, ...rest] = line.split('; ');
  const separator = pair!.indexOf('=');
  const attributes = new Map<string, string | true>();
  for (const part of rest) {
    const at = part.indexOf('=');
    if (at === -1) attributes.set(part.toLowerCase(), true);
    else attributes.set(part.slice(0, at).toLowerCase(), part.slice(at + 1));
  }
  return {
    name: pair!.slice(0, separator),
    value: pair!.slice(separator + 1),
    attributes,
  };
}

describe.each(testTargets)('the auth plugin on $name', (target: TestTarget) => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let installationId: string;
  /** Every raw token made in this file, so the log check below can look for each. */
  const tokens: string[] = [];

  beforeAll(async () => {
    ctx = await createTestApp(target);
    await migrate(ctx.database);
    installationId = await seedInstallation(ctx.database);
    await ctx.app.register(testRoutes, { prefix: API_PREFIX });
  });
  afterAll(async () => {
    await ctx.close();
  });

  /** A user with a live session, made with the core's `createSession`. */
  async function login(options: { userId?: string; now?: Date } = {}) {
    const userId = options.userId ?? (await seedActiveUser(ctx.database));
    const { session, token } = await createSession(ctx.database.db, {
      userId,
      method: 'password',
      now: options.now ?? new Date(),
    });
    tokens.push(token);
    return { userId, sessionId: session.id, token };
  }

  const cookieOf = (token: string) => `${SESSION_COOKIE}=${token}`;

  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS',
    path: string,
    headers: Record<string, string> = {},
  ) =>
    ctx.app.inject({
      method,
      url: `${API_PREFIX}${path}`,
      headers,
    });

  // Whatever a test did, no raw token or cookie value may be in the log.
  afterEach(() => {
    const text = ctx.lines.join('');
    for (const token of tokens) expect(text).not.toContain(token);
    expect(text).not.toContain(`${SESSION_COOKIE}=`);
  });

  describe('a valid session', () => {
    it('puts the acting user on the request as a core WriteContext', async () => {
      const { userId, sessionId, token } = await login();
      const response = await call('GET', '/test/required', {
        cookie: cookieOf(token),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        signedIn: true,
        userId,
        sessionId,
        actor: { type: 'user', id: userId },
        originServer: installationId,
        requestId: response.headers['x-request-id'],
        hasClock: true,
      });
      expect(response.headers['x-request-id']).toMatch(UUID_V7);
    });

    it('sets no cookie in its answer', async () => {
      const { token } = await login();
      const response = await call('GET', '/test/required', {
        cookie: cookieOf(token),
      });
      expect(setCookies(response.headers)).toEqual([]);
    });

    it('is found among several cookies', async () => {
      const { userId, token } = await login();
      const response = await call('GET', '/test/required', {
        cookie: `theme=dark; ${cookieOf(token)}; other=1`,
      });
      expect(response.json<{ userId: string }>().userId).toBe(userId);
    });

    it('slides the session: a request moves the idle end', async () => {
      const { sessionId, token } = await login({
        now: new Date(Date.now() - 10 * 60 * 1000),
      });
      const idleEnd = async () => {
        const rows = await ctx.database.db
          .select({ id: session.id, idle: session.idleExpiresAt })
          .from(session);
        return rows.find((row) => row.id === sessionId)!.idle.getTime();
      };
      const before = await idleEnd();
      await call('GET', '/test/required', { cookie: cookieOf(token) });
      expect(await idleEnd()).toBeGreaterThan(before);
    });
  });

  describe('every way a session can be unusable', () => {
    /** One cookie header for each reason, and the same answer expected for all. */
    async function unusableSessions(): Promise<
      { reason: string; headers: Record<string, string> }[]
    > {
      const expiredAbsolute = await login({
        now: new Date(Date.now() - SESSION_DEFAULTS.absoluteMs - HOUR),
      });
      const expiredIdle = await login({
        now: new Date(Date.now() - SESSION_DEFAULTS.idleMs - HOUR),
      });
      const revoked = await login();
      await revokeSession(ctx.database.db, revoked.sessionId, {
        reason: 'logout',
        now: new Date(),
      });
      const disabledByService = await login();
      await disableUser(ctx.database.db, disabledByService.userId, {
        now: new Date(),
      });
      // The status changed without the service, so the session row is live and
      // only the user check can refuse it.
      const disabledOnly = await login();
      await setUserStatus(ctx.database, disabledOnly.userId, 'disabled');
      return [
        { reason: 'no cookie', headers: {} },
        {
          reason: 'an empty cookie',
          headers: { cookie: `${SESSION_COOKIE}=` },
        },
        {
          reason: 'a token nobody has',
          headers: { cookie: cookieOf('not-a-real-token') },
        },
        {
          reason: 'a token far too long to be one',
          headers: { cookie: cookieOf('x'.repeat(5000)) },
        },
        {
          reason: 'a session past its absolute end',
          headers: { cookie: cookieOf(expiredAbsolute.token) },
        },
        {
          reason: 'a session past its idle end',
          headers: { cookie: cookieOf(expiredIdle.token) },
        },
        {
          reason: 'a revoked session',
          headers: { cookie: cookieOf(revoked.token) },
        },
        {
          reason: 'a disabled user, sessions revoked by the service',
          headers: { cookie: cookieOf(disabledByService.token) },
        },
        {
          reason: 'a disabled user with a live session row',
          headers: { cookie: cookieOf(disabledOnly.token) },
        },
      ];
    }

    it('all get the same 401 problem, word for word', async () => {
      const bodies = new Set<string>();
      for (const { reason, headers } of await unusableSessions()) {
        const response = await call('GET', '/test/required', headers);
        expect(response.statusCode, reason).toBe(401);
        expect(response.headers['content-type'], reason).toMatch(
          /^application\/problem\+json/,
        );
        const body = response.json<Record<string, unknown>>();
        expect(body, reason).toMatchObject({
          type: '/problems/authentication-required',
          code: 'authentication-required',
          status: 401,
          instance: `${API_PREFIX}/test/required`,
        });
        // Everything but the request ID, which is new for each request.
        bodies.add(JSON.stringify({ ...body, requestId: undefined }));
        expect(response.body, reason).not.toMatch(
          /expired|revoked|disabled|unknown|invalid|idle|absolute/i,
        );
      }
      expect(bodies.size).toBe(1);
    });

    it('a cookie that is not valid is cleared in the answer', async () => {
      for (const { reason, headers } of await unusableSessions()) {
        const response = await call('GET', '/test/required', headers);
        const cookies = setCookies(response.headers);
        if (headers.cookie === undefined) {
          // Nothing was sent, so there is nothing to clear.
          expect(cookies, reason).toEqual([]);
          continue;
        }
        expect(cookies, reason).toHaveLength(1);
        const cleared = parseSetCookie(cookies[0]!);
        expect(cleared.name, reason).toBe(SESSION_COOKIE);
        expect(cleared.value, reason).toBe('');
        expect(cleared.attributes.get('max-age'), reason).toBe('0');
      }
    });

    it('is not an error on an optional route: the request goes on without a user, and the cookie is cleared', async () => {
      for (const { reason, headers } of await unusableSessions()) {
        const response = await call('GET', '/test/optional', headers);
        expect(response.statusCode, reason).toBe(200);
        expect(response.json(), reason).toEqual({ signedIn: false });
        expect(setCookies(response.headers).length > 0, reason).toBe(
          headers.cookie !== undefined,
        );
      }
    });
  });

  describe('the auth route option', () => {
    it('is required when a route says nothing', async () => {
      expect((await call('GET', '/test/required')).statusCode).toBe(401);
    });

    it('is required by default for every method that changes data', async () => {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
        const response = await call(method, '/test/changes');
        expect(response.statusCode, method).toBe(401);
      }
    });

    it('lets an optional route through with no session, and with one', async () => {
      expect((await call('GET', '/test/optional')).json()).toEqual({
        signedIn: false,
      });
      const { userId, token } = await login();
      const response = await call('GET', '/test/optional', {
        cookie: cookieOf(token),
      });
      expect(response.json<{ userId: string }>().userId).toBe(userId);
    });

    it('makes a none route ignore cookies: no user, no clearing, no origin check', async () => {
      const { token } = await login();
      const withSession = await call('GET', '/test/none', {
        cookie: cookieOf(token),
      });
      expect(withSession.json()).toEqual({ signedIn: false });

      const withJunk = await call('GET', '/test/none', {
        cookie: cookieOf('junk'),
      });
      expect(withJunk.statusCode).toBe(200);
      expect(setCookies(withJunk.headers)).toEqual([]);

      // A cookie and a foreign Origin: this route does not use the session, so
      // the cross-site check has nothing to protect.
      const foreign = await call('POST', '/test/changes-none', {
        cookie: cookieOf(token),
        origin: 'https://attacker.example.test',
      });
      expect(foreign.statusCode).toBe(200);
    });

    it('applies the same plugin to HEAD routes that Fastify adds for GET', async () => {
      expect((await call('HEAD', '/test/required')).statusCode).toBe(401);
    });

    it('answers an unknown route with the 404 problem, whatever the cookie', async () => {
      const response = await call('GET', '/nowhere', {
        cookie: cookieOf('junk'),
      });
      expect(response.statusCode).toBe(404);
      expect(response.json<{ code: string }>().code).toBe('route-not-found');
      expect(setCookies(response.headers)).toEqual([]);
    });

    it('makes a handler that asks for a user on a route with none a generic 500, not a leak', async () => {
      const response = await call('GET', '/test/optional-needs-user');
      expect(response.statusCode).toBe(500);
      expect(response.json<{ code: string }>().code).toBe('internal-error');
      expect(response.body).not.toContain('auth: none');
      const { userId, token } = await login();
      const signedIn = await call('GET', '/test/optional-needs-user', {
        cookie: cookieOf(token),
      });
      expect(signedIn.statusCode).toBe(200);
      expect(signedIn.body).toBe(userId);
    });

    it('treats a value it does not know as required', async () => {
      // A cast, or a JavaScript caller, can pass anything. It must not open the route.
      expect((await call('GET', '/test/odd')).statusCode).toBe(401);
      const { token } = await login();
      expect(
        (await call('GET', '/test/odd', { cookie: cookieOf(token) }))
          .statusCode,
      ).toBe(200);
    });
  });

  describe('the cross-site check on requests that change data', () => {
    const CHANGING = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

    it.each(CHANGING)(
      '%s with a session and the right Origin goes through',
      async (method) => {
        const { userId, token } = await login();
        const response = await call(method, '/test/changes', {
          cookie: cookieOf(token),
          origin: TEST_PUBLIC_ORIGIN,
        });
        expect(response.statusCode).toBe(200);
        expect(response.json<{ userId: string }>().userId).toBe(userId);
      },
    );

    it.each(CHANGING)(
      '%s with a session and no Origin is a 403',
      async (method) => {
        const { token } = await login();
        const response = await call(method, '/test/changes', {
          cookie: cookieOf(token),
        });
        expect(response.statusCode).toBe(403);
        expect(response.headers['content-type']).toMatch(
          /^application\/problem\+json/,
        );
        expect(response.json()).toMatchObject({
          type: '/problems/origin-mismatch',
          code: 'origin-mismatch',
          status: 403,
          instance: `${API_PREFIX}/test/changes`,
        });
      },
    );

    it.each([
      ['another site', 'https://attacker.example.test'],
      ['the same host on another port', 'https://osfpm.example.test:8443'],
      ['the same host over http', 'http://osfpm.example.test'],
      ['a sub-domain', 'https://evil.osfpm.example.test'],
      [
        'a host that only starts the same way',
        'https://osfpm.example.test.evil.example',
      ],
      ['the origin with a path', `${TEST_PUBLIC_ORIGIN}/`],
      ['the origin in another case', TEST_PUBLIC_ORIGIN.toUpperCase()],
      ['an opaque origin', 'null'],
      ['an empty Origin', ''],
    ])(
      'a POST with a session and Origin of %s is a 403',
      async (_label, origin) => {
        const { token } = await login();
        const response = await call('POST', '/test/changes', {
          cookie: cookieOf(token),
          origin,
        });
        expect(response.statusCode).toBe(403);
      },
    );

    it('says nothing about the expected or the sent origin', async () => {
      const { token } = await login();
      const sent = 'https://attacker.example.test';
      const response = await call('POST', '/test/changes', {
        cookie: cookieOf(token),
        origin: sent,
      });
      expect(response.body).not.toContain(sent);
      expect(response.body).not.toContain('osfpm.example.test');
    });

    it('is checked before the session, so a foreign Origin gets the same 403 whether the cookie is good or not', async () => {
      const { token } = await login();
      const good = await call('POST', '/test/changes', {
        cookie: cookieOf(token),
        origin: 'https://attacker.example.test',
      });
      const bad = await call('POST', '/test/changes', {
        cookie: cookieOf('junk'),
        origin: 'https://attacker.example.test',
      });
      expect(good.statusCode).toBe(403);
      expect(bad.statusCode).toBe(403);
      expect(JSON.stringify({ ...good.json<object>(), requestId: 0 })).toBe(
        JSON.stringify({ ...bad.json<object>(), requestId: 0 }),
      );
      // The refused request did not touch the cookie.
      expect(setCookies(bad.headers)).toEqual([]);
    });

    it('applies to an optional route too', async () => {
      const { token } = await login();
      const response = await call('POST', '/test/changes-optional', {
        cookie: cookieOf(token),
      });
      expect(response.statusCode).toBe(403);
    });

    it('does not apply to GET, HEAD or OPTIONS, with or without an Origin', async () => {
      const { token } = await login();
      for (const method of ['GET', 'HEAD'] as const) {
        const none = await call(method, '/test/required', {
          cookie: cookieOf(token),
        });
        expect(none.statusCode, method).toBe(200);
        const foreign = await call(method, '/test/required', {
          cookie: cookieOf(token),
          origin: 'https://attacker.example.test',
        });
        expect(foreign.statusCode, method).toBe(200);
      }
      const options = await call('OPTIONS', '/test/changes', {
        cookie: cookieOf(token),
      });
      expect(options.statusCode).not.toBe(403);
    });

    it('is skipped when there is no session cookie, so the answer is the 401 or the 200 of the route', async () => {
      const required = await call('POST', '/test/changes', {
        origin: 'https://attacker.example.test',
      });
      expect(required.statusCode).toBe(401);
      const optional = await call('POST', '/test/changes-optional', {
        origin: 'https://attacker.example.test',
      });
      expect(optional.statusCode).toBe(200);
      const missing = await call('POST', '/test/changes-optional');
      expect(missing.statusCode).toBe(200);
    });

    it('lets a cookie of another name through without an Origin', async () => {
      const response = await call('POST', '/test/changes-optional', {
        cookie: 'theme=dark',
      });
      expect(response.statusCode).toBe(200);
    });
  });

  describe('the session cookie as it is set and cleared', () => {
    it('is __Host-, HttpOnly, Secure, SameSite=Lax, Path=/, with no Domain and the absolute expiry', async () => {
      const response = await call('GET', '/test/set-cookie');
      const cookies = setCookies(response.headers);
      expect(cookies).toHaveLength(1);
      const cookie = parseSetCookie(cookies[0]!);
      expect(cookie.name).toBe('__Host-osfpm_session');
      expect(cookie.value).toBe('abc-token');
      expect([...cookie.attributes.keys()].sort()).toEqual(
        ['expires', 'httponly', 'path', 'samesite', 'secure'].sort(),
      );
      expect(cookie.attributes.get('httponly')).toBe(true);
      expect(cookie.attributes.get('secure')).toBe(true);
      expect(cookie.attributes.get('samesite')).toBe('Lax');
      expect(cookie.attributes.get('path')).toBe('/');
      expect(cookie.attributes.has('domain')).toBe(false);
      expect(cookie.attributes.has('max-age')).toBe(false);
      // An HTTP date has no milliseconds.
      expect(
        new Date(cookie.attributes.get('expires') as string).toISOString(),
      ).toBe('2031-01-02T03:04:05.000Z');
    });

    it('is cleared with the same name and attributes, which a __Host- cookie needs to be accepted', async () => {
      const response = await call('GET', '/test/clear-cookie');
      const cookies = setCookies(response.headers);
      expect(cookies).toHaveLength(1);
      const cookie = parseSetCookie(cookies[0]!);
      expect(cookie.name).toBe('__Host-osfpm_session');
      expect(cookie.value).toBe('');
      expect(cookie.attributes.get('max-age')).toBe('0');
      expect(
        new Date(cookie.attributes.get('expires') as string).getTime(),
      ).toBe(0);
      expect(cookie.attributes.get('httponly')).toBe(true);
      expect(cookie.attributes.get('secure')).toBe(true);
      expect(cookie.attributes.get('samesite')).toBe('Lax');
      expect(cookie.attributes.get('path')).toBe('/');
      expect(cookie.attributes.has('domain')).toBe(false);
    });
  });

  describe('what reaches the log', () => {
    it('holds no token or cookie value for any flow above, and none of the 401s names a reason', async () => {
      ctx.lines.length = 0;
      const { token } = await login();
      await call('GET', '/test/required', { cookie: cookieOf(token) });
      await call('GET', '/test/required', { cookie: cookieOf('junk-value-1') });
      await call('POST', '/test/changes', {
        cookie: cookieOf(token),
        origin: 'https://attacker.example.test',
      });
      await call('GET', '/test/optional', { cookie: cookieOf('junk-value-2') });
      const text = ctx.lines.join('');
      expect(text).not.toContain(token);
      expect(text).not.toContain('junk-value');
      expect(text).not.toContain('attacker.example.test');
      // The refusals are logged by class name.
      const refused = ctx
        .records()
        .filter((record) => record.msg === 'request refused');
      expect(
        refused.map((record) => (record.err as { type: string }).type),
      ).toEqual(['AuthenticationRequiredError', 'OriginMismatchError']);
    });
  });
});
