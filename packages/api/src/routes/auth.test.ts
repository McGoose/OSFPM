import type { OutgoingHttpHeaders } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createSession,
  disableUser,
  revokeSession,
  SESSION_DEFAULTS,
} from '@osfpm/core/src/auth/sessions.js';
import { AUTH_AUDIT } from '@osfpm/core/src/auth/shared.js';
import {
  everyRowAsText,
  seedActiveUser,
  seedInstallation,
} from '@osfpm/core/src/auth/test-support.js';
import { hashToken } from '@osfpm/core/src/auth/tokens.js';
import { migrate } from '@osfpm/core/src/db/migrate.js';
import { auditEvent, session, user } from '@osfpm/core/src/db/schema/index.js';
import {
  testTargets,
  type TestTarget,
} from '@osfpm/core/src/db/test-support.js';
import { API_PREFIX } from '../api-version.js';
import { SESSION_COOKIE } from '../auth/cookie.js';
import { SESSION_RATE_LIMIT } from '../auth/rate-limit.js';
import { createTestApp, TEST_PUBLIC_ORIGIN, UUID_V7 } from '../test-support.js';

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

/** The `Set-Cookie` lines of a response. */
function setCookies(headers: OutgoingHttpHeaders): string[] {
  const value = headers['set-cookie'];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [String(value)];
}

/** An answer with the parts that differ between two requests taken out. */
function sameness(body: Record<string, unknown>) {
  return JSON.stringify({ ...body, requestId: undefined, instance: undefined });
}

describe.each(testTargets)('the auth routes on $name', (target: TestTarget) => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  /** Raw tokens and their hashes, so every test can check they never leave the database. */
  const tokens: string[] = [];
  let addresses = 0;

  beforeAll(async () => {
    ctx = await createTestApp(target);
    await migrate(ctx.database);
    await seedInstallation(ctx.database);
  });
  afterAll(async () => {
    await ctx.close();
  });

  /** An address of its own for each request group, so the rate limit is not what a test measures. */
  const freshAddress = () =>
    `10.8.${Math.floor(addresses / 250)}.${(addresses++ % 250) + 1}`;

  async function login(
    options: {
      userId?: string;
      now?: Date;
      method?: 'password' | 'passkey';
      userAgentSummary?: string;
    } = {},
  ) {
    const userId = options.userId ?? (await seedActiveUser(ctx.database));
    const { session: created, token } = await createSession(ctx.database.db, {
      userId,
      method: options.method ?? 'password',
      ...(options.userAgentSummary === undefined
        ? {}
        : { userAgentSummary: options.userAgentSummary }),
      now: options.now ?? new Date(),
    });
    tokens.push(token, hashToken(token));
    return { userId, sessionId: created.id, token };
  }

  /**
   * One request. Carries the session cookie when `token` is given, and the
   * right `Origin` for a request that changes data unless told otherwise.
   */
  function send(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    options: {
      token?: string;
      origin?: string | null;
      remoteAddress?: string;
    } = {},
  ) {
    const headers: Record<string, string> = {};
    if (options.token !== undefined) {
      headers.cookie = `${SESSION_COOKIE}=${options.token}`;
    }
    const origin =
      options.origin === undefined ? TEST_PUBLIC_ORIGIN : options.origin;
    if (origin !== null && method !== 'GET') headers.origin = origin;
    return ctx.app.inject({
      method,
      url: `${API_PREFIX}/auth${path}`,
      headers,
      remoteAddress: options.remoteAddress ?? freshAddress(),
    });
  }

  const sessionRow = async (id: string) =>
    (await ctx.database.db.select().from(session)).find(
      (row) => row.id === id,
    )!;

  const revokeEvents = async (sessionId: string) =>
    (await ctx.database.db.select().from(auditEvent)).filter(
      (event) =>
        event.category === AUTH_AUDIT.sessionRevoked &&
        event.targetId === sessionId,
    );

  // Whatever a test did, no raw token or token hash may be in the log, and no
  // token may be in any row of any table.
  afterEach(async () => {
    const log = ctx.lines.join('');
    for (const secret of tokens) expect(log).not.toContain(secret);
    const stored = await everyRowAsText(ctx.database);
    for (const token of tokens.filter((_, index) => index % 2 === 0)) {
      expect(stored).not.toContain(token);
    }
  });

  describe('GET /api/v1/auth/me', () => {
    it('answers with the signed-in user: id, display name, email and status, and nothing else', async () => {
      const { userId, token } = await login();
      const response = await send('GET', '/me', { token });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      expect(response.headers['x-request-id']).toMatch(UUID_V7);
      const rows = await ctx.database.db.select().from(user);
      const row = rows.find((candidate) => candidate.id === userId)!;
      expect(response.json()).toEqual({
        id: userId,
        displayName: row.displayName,
        email: row.email,
        status: 'active',
      });
    });

    it('is a 401 without a session, with the same problem as any other unusable one', async () => {
      const response = await send('GET', '/me');
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        type: '/problems/authentication-required',
        code: 'authentication-required',
        status: 401,
        instance: `${API_PREFIX}/auth/me`,
      });
    });

    it('does not set a cookie for a good session', async () => {
      const { token } = await login();
      const response = await send('GET', '/me', { token });
      expect(setCookies(response.headers)).toEqual([]);
    });
  });

  describe('every route here, for a session that cannot be used', () => {
    const routes = [
      ['GET', '/me'],
      ['GET', '/sessions'],
      ['POST', '/logout'],
      ['DELETE', '/sessions/01900000-0000-7000-8000-000000000001'],
    ] as const;

    async function unusableTokens() {
      const expired = await login({
        now: new Date(Date.now() - SESSION_DEFAULTS.absoluteMs - HOUR),
      });
      const idle = await login({
        now: new Date(Date.now() - SESSION_DEFAULTS.idleMs - HOUR),
      });
      const revoked = await login();
      await revokeSession(ctx.database.db, revoked.sessionId, {
        reason: 'logout',
        now: new Date(),
      });
      const disabled = await login();
      await disableUser(ctx.database.db, disabled.userId, { now: new Date() });
      return [
        undefined,
        'a-token-nobody-has',
        expired.token,
        idle.token,
        revoked.token,
        disabled.token,
      ];
    }

    it.each(routes)(
      '%s %s answers one and the same 401, whatever the reason',
      async (method, path) => {
        const bodies = new Set<string>();
        for (const token of await unusableTokens()) {
          const response = await send(method, path, {
            ...(token === undefined ? {} : { token }),
          });
          expect(response.statusCode).toBe(401);
          bodies.add(sameness(response.json<Record<string, unknown>>()));
        }
        expect(bodies.size).toBe(1);
      },
    );
  });

  describe('GET /api/v1/auth/sessions', () => {
    it('lists the live sessions of the user, most recently seen first, and marks the one asking', async () => {
      const first = await login({
        method: 'passkey',
        userAgentSummary: 'Firefox on Windows',
        now: new Date(Date.now() - 30 * MINUTE),
      });
      const second = await login({
        userId: first.userId,
        userAgentSummary: 'Safari on iPhone',
        now: new Date(Date.now() - 20 * MINUTE),
      });
      const third = await login({
        userId: first.userId,
        now: new Date(Date.now() - 10 * MINUTE),
      });

      const response = await send('GET', '/sessions', { token: second.token });
      expect(response.statusCode).toBe(200);
      const list = response.json<
        {
          id: string;
          method: string;
          createdAt: string;
          lastSeenAt: string;
          idleExpiresAt: string;
          absoluteExpiresAt: string;
          userAgentSummary: string | null;
          current: boolean;
        }[]
      >();
      // The session asking has just been seen, so it leads.
      expect(list.map((item) => item.id)).toEqual([
        second.sessionId,
        third.sessionId,
        first.sessionId,
      ]);
      expect(list.map((item) => item.current)).toEqual([true, false, false]);
      const byId = new Map(list.map((item) => [item.id, item]));
      expect(byId.get(first.sessionId)).toMatchObject({
        method: 'passkey',
        userAgentSummary: 'Firefox on Windows',
      });
      expect(byId.get(third.sessionId)!.userAgentSummary).toBeNull();
    });

    it('has exactly these fields, with dates as ISO strings, and never a token or a hash', async () => {
      const mine = await login({ userAgentSummary: 'Firefox on Windows' });
      const response = await send('GET', '/sessions', { token: mine.token });
      const [item] = response.json<Record<string, unknown>[]>();
      expect(Object.keys(item!).sort()).toEqual(
        [
          'absoluteExpiresAt',
          'createdAt',
          'current',
          'id',
          'idleExpiresAt',
          'lastSeenAt',
          'method',
          'userAgentSummary',
        ].sort(),
      );
      for (const field of [
        'createdAt',
        'lastSeenAt',
        'idleExpiresAt',
        'absoluteExpiresAt',
      ]) {
        const text = item![field] as string;
        expect(new Date(text).toISOString()).toBe(text);
      }
      expect(response.body).not.toContain(mine.token);
      expect(response.body).not.toContain(hashToken(mine.token));
      expect(response.body).not.toMatch(/token|hash|userId/i);
    });

    it('leaves out sessions that are revoked, past their idle or absolute end, or another user’s', async () => {
      const mine = await login();
      const stranger = await login();
      const revoked = await login({ userId: mine.userId });
      await revokeSession(ctx.database.db, revoked.sessionId, {
        reason: 'logout',
        now: new Date(),
      });
      const idle = await login({
        userId: mine.userId,
        now: new Date(Date.now() - SESSION_DEFAULTS.idleMs - HOUR),
      });
      const old = await login({
        userId: mine.userId,
        now: new Date(Date.now() - SESSION_DEFAULTS.absoluteMs - HOUR),
      });

      const response = await send('GET', '/sessions', { token: mine.token });
      const ids = response.json<{ id: string }[]>().map((item) => item.id);
      expect(ids).toEqual([mine.sessionId]);
      for (const gone of [stranger, revoked, idle, old]) {
        expect(ids).not.toContain(gone.sessionId);
      }
    });

    it('needs a session', async () => {
      expect((await send('GET', '/sessions')).statusCode).toBe(401);
    });
  });

  describe('DELETE /api/v1/auth/sessions/:id', () => {
    it('ends another of the user’s own sessions: 204, gone from the list, its cookie dead, audited as user-revoked', async () => {
      const mine = await login();
      const other = await login({ userId: mine.userId, method: 'passkey' });

      const response = await send('DELETE', `/sessions/${other.sessionId}`, {
        token: mine.token,
      });
      expect(response.statusCode).toBe(204);
      expect(response.body).toBe('');

      const row = await sessionRow(other.sessionId);
      expect(row.revokedReason).toBe('user-revoked');
      expect(row.revokedAt).not.toBeNull();
      const [event] = await revokeEvents(other.sessionId);
      expect(event).toMatchObject({
        action: 'revoke',
        actorType: 'user',
        actorId: mine.userId,
        details: { reason: 'user-revoked' },
      });

      expect(
        (await send('GET', '/me', { token: other.token })).statusCode,
      ).toBe(401);
      const list = await send('GET', '/sessions', { token: mine.token });
      expect(list.json<{ id: string }[]>().map((item) => item.id)).toEqual([
        mine.sessionId,
      ]);
      // The session that asked is untouched.
      expect((await sessionRow(mine.sessionId)).revokedAt).toBeNull();
    });

    it('can end the session it is made on', async () => {
      const mine = await login();
      const response = await send('DELETE', `/sessions/${mine.sessionId}`, {
        token: mine.token,
      });
      expect(response.statusCode).toBe(204);
      expect((await send('GET', '/me', { token: mine.token })).statusCode).toBe(
        401,
      );
    });

    it('answers the very same 404 for another user’s session, an unknown id, and one already ended or expired', async () => {
      const mine = await login();
      const stranger = await login();
      const ended = await login({ userId: mine.userId });
      await revokeSession(ctx.database.db, ended.sessionId, {
        reason: 'logout',
        now: new Date(),
      });
      const expired = await login({
        userId: mine.userId,
        now: new Date(Date.now() - SESSION_DEFAULTS.idleMs - HOUR),
      });
      const unknown = '01900000-0000-7000-8000-00000000abcd';

      const bodies = new Set<string>();
      for (const id of [
        stranger.sessionId,
        unknown,
        ended.sessionId,
        expired.sessionId,
      ]) {
        const response = await send('DELETE', `/sessions/${id}`, {
          token: mine.token,
        });
        expect(response.statusCode, id).toBe(404);
        expect(response.headers['content-type']).toMatch(
          /^application\/problem\+json/,
        );
        const body = response.json<Record<string, unknown>>();
        expect(body).toMatchObject({
          type: '/problems/not-found',
          code: 'not-found',
          instance: `${API_PREFIX}/auth/sessions/${id}`,
        });
        bodies.add(sameness(body));
        // It never says whose the session is, or that it exists.
        expect(response.body).not.toContain(stranger.userId);
      }
      expect(bodies.size).toBe(1);

      // Another user's session was not touched.
      expect((await sessionRow(stranger.sessionId)).revokedAt).toBeNull();
      expect(await revokeEvents(stranger.sessionId)).toEqual([]);
      expect(
        (await send('GET', '/me', { token: stranger.token })).statusCode,
      ).toBe(200);
    });

    it('is a 400 for an id that is not a UUID, and says which part, not what was sent', async () => {
      const mine = await login();
      const response = await send('DELETE', '/sessions/not-a-uuid-secret-1', {
        token: mine.token,
      });
      expect(response.statusCode).toBe(400);
      const body = response.json<Record<string, unknown>>();
      expect(body).toMatchObject({
        code: 'validation-failed',
        errors: [{ in: 'params', path: 'id' }],
      });
      // The `instance` repeats the path the caller asked for, as it does for any
      // problem; what the validator reports does not repeat the value.
      expect(JSON.stringify({ ...body, instance: undefined })).not.toContain(
        'secret-1',
      );
    });

    it('needs a session, and a session needs the right Origin', async () => {
      const mine = await login();
      const other = await login({ userId: mine.userId });
      const path = `/sessions/${other.sessionId}`;
      expect((await send('DELETE', path)).statusCode).toBe(401);
      expect(
        (await send('DELETE', path, { token: mine.token, origin: null }))
          .statusCode,
      ).toBe(403);
      expect(
        (
          await send('DELETE', path, {
            token: mine.token,
            origin: 'https://attacker.example.test',
          })
        ).statusCode,
      ).toBe(403);
      // Refused, so nothing was revoked.
      expect((await sessionRow(other.sessionId)).revokedAt).toBeNull();
    });
  });

  describe('POST /api/v1/auth/logout', () => {
    it('ends the session, clears the cookie, answers 204, and the old cookie stops working', async () => {
      const mine = await login();
      const response = await send('POST', '/logout', { token: mine.token });
      expect(response.statusCode).toBe(204);
      expect(response.body).toBe('');

      const cookies = setCookies(response.headers);
      expect(cookies).toHaveLength(1);
      expect(cookies[0]).toMatch(/^__Host-osfpm_session=;/);
      expect(cookies[0]).toContain('Max-Age=0');
      expect(cookies[0]).toContain('Secure');
      expect(cookies[0]).toContain('HttpOnly');
      expect(cookies[0]).toContain('Path=/');

      const row = await sessionRow(mine.sessionId);
      expect(row.revokedReason).toBe('logout');
      const [event] = await revokeEvents(mine.sessionId);
      expect(event).toMatchObject({
        actorType: 'user',
        actorId: mine.userId,
        details: { reason: 'logout' },
      });

      for (const [method, path] of [
        ['GET', '/me'],
        ['GET', '/sessions'],
        ['POST', '/logout'],
      ] as const) {
        expect(
          (await send(method, path, { token: mine.token })).statusCode,
          `${method} ${path}`,
        ).toBe(401);
      }
    });

    it('ends only the session it is made on', async () => {
      const mine = await login();
      const other = await login({ userId: mine.userId });
      await send('POST', '/logout', { token: mine.token });
      expect(
        (await send('GET', '/me', { token: other.token })).statusCode,
      ).toBe(200);
    });

    it('needs a session and the right Origin', async () => {
      const mine = await login();
      expect((await send('POST', '/logout')).statusCode).toBe(401);
      expect(
        (await send('POST', '/logout', { token: mine.token, origin: null }))
          .statusCode,
      ).toBe(403);
      expect((await sessionRow(mine.sessionId)).revokedAt).toBeNull();
    });
  });

  describe('the rate limit on these routes: 120 a minute per session', () => {
    const SESSION_ID = '01900000-0000-7000-8000-000000000001';

    it('refuses the 121st request in a minute on one session with a 429 problem and Retry-After', async () => {
      const { token } = await login();
      for (let n = 1; n <= SESSION_RATE_LIMIT.max; n += 1) {
        expect(
          (await send('GET', '/me', { token })).statusCode,
          `request ${n}`,
        ).toBe(200);
      }
      const refused = await send('GET', '/me', { token });
      expect(refused.statusCode).toBe(429);
      expect(refused.headers['content-type']).toMatch(
        /^application\/problem\+json/,
      );
      expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(refused.json()).toMatchObject({
        type: '/problems/rate-limited',
        code: 'rate-limited',
      });
    });

    it('is shared by the four routes, counted per session', async () => {
      const mine = await login();
      const own = await login({ userId: mine.userId });
      // 118 + 1 + 1 requests of the three read routes and a revoke: 120.
      for (let n = 0; n < 100; n += 1)
        await send('GET', '/me', { token: mine.token });
      for (let n = 0; n < 19; n += 1) {
        await send('GET', '/sessions', { token: mine.token });
      }
      const revoke = await send('DELETE', `/sessions/${own.sessionId}`, {
        token: mine.token,
      });
      expect(revoke.statusCode).toBe(204);

      for (const [method, path] of [
        ['GET', '/me'],
        ['GET', '/sessions'],
        ['POST', '/logout'],
        ['DELETE', `/sessions/${SESSION_ID}`],
      ] as const) {
        expect(
          (await send(method, path, { token: mine.token })).statusCode,
          `${method} ${path}`,
        ).toBe(429);
      }
      // The refused logout did not sign the session out: it is only held back.
      expect((await sessionRow(mine.sessionId)).revokedAt).toBeNull();
    });

    it('is the session that counts: another session, the same user or the same address, has all of its own', async () => {
      const first = await login();
      const second = await login({ userId: first.userId });
      const sameAddress = freshAddress();
      for (let n = 0; n <= SESSION_RATE_LIMIT.max; n += 1) {
        await send('GET', '/me', {
          token: first.token,
          remoteAddress: sameAddress,
        });
      }
      expect(
        (await send('GET', '/me', { token: first.token })).statusCode,
      ).toBe(429);
      expect(
        (
          await send('GET', '/me', {
            token: second.token,
            remoteAddress: sameAddress,
          })
        ).statusCode,
      ).toBe(200);
    });

    it('does not count a caller with no session: any number of 401s, from one address', async () => {
      const remoteAddress = freshAddress();
      for (let n = 0; n < SESSION_RATE_LIMIT.max + 20; n += 1) {
        expect((await send('GET', '/me', { remoteAddress })).statusCode).toBe(
          401,
        );
      }
    });
  });

  describe('what reaches the log and the database', () => {
    it('holds no token and no cookie in any flow above, in the log or in any row', async () => {
      ctx.lines.length = 0;
      const mine = await login();
      const other = await login({ userId: mine.userId });
      await send('GET', '/me', { token: mine.token });
      await send('GET', '/sessions', { token: mine.token });
      await send('DELETE', `/sessions/${other.sessionId}`, {
        token: mine.token,
      });
      await send('POST', '/logout', { token: mine.token });
      await send('GET', '/me', { token: mine.token });
      const log = ctx.lines.join('');
      expect(log).not.toContain(mine.token);
      expect(log).not.toContain(other.token);
      expect(log).not.toContain(`${SESSION_COOKIE}=`);
      // The requests were logged, by route pattern and not by what was in them.
      const completed = ctx
        .records()
        .filter((record) => record.msg === 'request completed');
      expect(completed.map((record) => record.route)).toEqual([
        `${API_PREFIX}/auth/me`,
        `${API_PREFIX}/auth/sessions`,
        `${API_PREFIX}/auth/sessions/:id`,
        `${API_PREFIX}/auth/logout`,
        `${API_PREFIX}/auth/me`,
      ]);
      expect(log).not.toContain(other.sessionId);
    });
  });

  describe('the OpenAPI document', () => {
    it('lists the four routes', async () => {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `${API_PREFIX}/openapi.json`,
      });
      const { paths } = response.json<{
        paths: Record<string, Record<string, unknown>>;
      }>();
      expect(Object.keys(paths[`${API_PREFIX}/auth/me`]!)).toEqual(['get']);
      expect(Object.keys(paths[`${API_PREFIX}/auth/sessions`]!)).toEqual([
        'get',
      ]);
      expect(Object.keys(paths[`${API_PREFIX}/auth/logout`]!)).toEqual([
        'post',
      ]);
      expect(Object.keys(paths[`${API_PREFIX}/auth/sessions/{id}`]!)).toEqual([
        'delete',
      ]);
    });
  });
});
