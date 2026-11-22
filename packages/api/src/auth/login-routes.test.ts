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
import {
  consumeLoginChallenge,
  createLoginChallenge,
} from '@osfpm/core/src/auth/login-challenge.js';
import { generateRecoveryCodes } from '@osfpm/core/src/auth/recovery.js';
import { validateSession } from '@osfpm/core/src/auth/sessions.js';
import { AUTH_AUDIT } from '@osfpm/core/src/auth/shared.js';
import {
  emailOf,
  markUserDeleted,
  seedActiveUser,
  seedInstallation,
  seedPassword,
  seedTotp,
  setUserStatus,
  totpCodeAt,
} from '@osfpm/core/src/auth/test-support.js';
import { LOGIN_THROTTLE } from '@osfpm/core/src/auth/throttle.js';
import { migrate } from '@osfpm/core/src/db/migrate.js';
import { auditEvent, session } from '@osfpm/core/src/db/schema/index.js';
import {
  testTargets,
  type TestTarget,
} from '@osfpm/core/src/db/test-support.js';
import { API_PREFIX } from '../api-version.js';
import { createTestApp } from '../test-support.js';
import { AUTH_RATE_LIMIT } from './rate-limit.js';
import { SESSION_COOKIE } from './cookie.js';

// Invented passwords; no real credential, and no word of the fixture addresses.
const PASSWORD = 'harbour-warehouse-night-shoot';
const WRONG_PASSWORD = 'quiet-lantern-wrong-answer';

const MINUTE = 60 * 1000;

/** The `Set-Cookie` lines of a response. */
function setCookies(headers: OutgoingHttpHeaders): string[] {
  const value = headers['set-cookie'];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [String(value)];
}

/** An error body with the parts that differ between two requests taken out. */
function sameness(body: Record<string, unknown>) {
  return JSON.stringify({ ...body, requestId: undefined });
}

describe.each(testTargets)(
  'the login routes on $name',
  (target: TestTarget) => {
    let ctx: Awaited<ReturnType<typeof createTestApp>>;
    let addresses = 0;

    beforeAll(async () => {
      ctx = await createTestApp(target);
      await migrate(ctx.database);
      await seedInstallation(ctx.database);
    });
    afterAll(async () => {
      await ctx.close();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const db = () => ctx.database.db;

    /** An address of its own for each request, so the strict rate limit is not what a test measures. */
    const freshAddress = () =>
      `10.9.${Math.floor(addresses / 250)}.${(addresses++ % 250) + 1}`;

    function post(
      path: string,
      payload: unknown,
      options: {
        remoteAddress?: string;
        headers?: Record<string, string>;
      } = {},
    ) {
      return ctx.app.inject({
        method: 'POST',
        url: `${API_PREFIX}/auth/login/${path}`,
        payload: payload as Record<string, unknown>,
        headers: options.headers ?? {},
        remoteAddress: options.remoteAddress ?? freshAddress(),
      });
    }

    /** An active user with a password, and their address. */
    async function userWithPassword() {
      const userId = await seedActiveUser(ctx.database);
      await seedPassword(ctx.database, userId, PASSWORD);
      return { userId, email: await emailOf(ctx.database, userId) };
    }

    /** The raw session token a response set, or null when it set none. */
    function tokenIn(
      response: Awaited<ReturnType<typeof post>>,
    ): string | null {
      const cookie = setCookies(response.headers).find((line) =>
        line.startsWith(`${SESSION_COOKIE}=`),
      );
      if (cookie === undefined) return null;
      return cookie.slice(SESSION_COOKIE.length + 1).split(';', 1)[0]!;
    }

    const failuresFor = async (userId: string | null) =>
      (await db().select().from(auditEvent)).filter(
        (event) =>
          event.category === AUTH_AUDIT.loginStepFailed &&
          event.targetId === userId,
      );

    const sessionsOf = async (userId: string) =>
      (await db().select().from(session)).filter(
        (row) => row.userId === userId,
      );

    /** A failed sign-in: a 401 `sign-in-failed`, which sets no cookie. */
    function expectSignInFailed(response: Awaited<ReturnType<typeof post>>) {
      expect(response.statusCode).toBe(401);
      expect(response.headers['content-type']).toMatch(
        /^application\/problem\+json/,
      );
      expect(response.json<Record<string, unknown>>()).toMatchObject({
        status: 401,
        code: 'sign-in-failed',
        type: '/problems/sign-in-failed',
      });
      expect(setCookies(response.headers)).toEqual([]);
    }

    describe('POST /auth/login/password', () => {
      it('signs in the right password: 200 with the user, a session cookie, and nothing cached', async () => {
        const { userId, email } = await userWithPassword();
        const response = await post(
          'password',
          { email, password: PASSWORD },
          { headers: { 'user-agent': 'Firefox on Windows' } },
        );
        expect(response.statusCode).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        const body = response.json<Record<string, unknown>>();
        expect(body).toEqual({
          user: {
            id: userId,
            email,
            displayName: expect.any(String) as string,
            status: 'active',
          },
        });
        const [cookie] = setCookies(response.headers);
        expect(cookie).toMatch(
          new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}; `),
        );
        for (const attribute of [
          'Path=/',
          'HttpOnly',
          'Secure',
          'SameSite=Lax',
        ]) {
          expect(cookie).toContain(attribute);
        }
        expect(cookie).toContain('Expires=');
        expect(cookie).not.toMatch(/Domain=/i);

        const token = tokenIn(response)!;
        const found = await validateSession(db(), token, new Date());
        expect(found).toMatchObject({
          user: { id: userId },
          session: { method: 'password', scope: 'full' },
        });
        const [stored] = await sessionsOf(userId);
        expect(stored!.userAgentSummary).toBe('Firefox on Windows');
      });

      it('audits the step and the session, and returns no token in the body', async () => {
        const { userId, email } = await userWithPassword();
        const response = await post('password', { email, password: PASSWORD });
        const token = tokenIn(response)!;
        expect(response.body).not.toContain(token);
        const mine = (await db().select().from(auditEvent)).filter(
          (event) => event.actorId === userId,
        );
        const categories = mine.map((event) => event.category).sort();
        expect(categories).toEqual(
          [AUTH_AUDIT.loginStepPassed, AUTH_AUDIT.sessionCreated].sort(),
        );
      });

      it('takes the address in any case with spaces round it', async () => {
        const { email } = await userWithPassword();
        const response = await post('password', {
          email: `  ${email.toUpperCase()}  `,
          password: PASSWORD,
        });
        expect(response.statusCode).toBe(200);
      });

      it('with a confirmed authenticator, makes no session and returns a challenge to finish with', async () => {
        const { userId, email } = await userWithPassword();
        const secret = await seedTotp(ctx.database, userId);
        const response = await post('password', { email, password: PASSWORD });
        expect(response.statusCode).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(setCookies(response.headers)).toEqual([]);
        const body = response.json<{ next: string; challenge: string }>();
        expect(body).toEqual({
          next: 'totp',
          challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as string,
        });
        expect(await sessionsOf(userId)).toEqual([]);

        // The challenge is good for the second step.
        const second = await post('totp', {
          challenge: body.challenge,
          code: totpCodeAt(secret, new Date()),
        });
        expect(second.statusCode).toBe(200);
      });

      it('answers every failure with the same 401 body, and sets no cookie', async () => {
        const wrong = await userWithPassword();
        const noPassword = await seedActiveUser(ctx.database);
        const disabled = await userWithPassword();
        await setUserStatus(ctx.database, disabled.userId, 'disabled');
        const deleted = await userWithPassword();
        await markUserDeleted(ctx.database, deleted.userId);
        const throttled = await userWithPassword();
        for (let i = 0; i < LOGIN_THROTTLE.maxFailures; i += 1) {
          await post('password', {
            email: throttled.email,
            password: WRONG_PASSWORD,
          });
        }
        const attempts = [
          { email: 'nobody@demopictures.example', password: PASSWORD },
          { email: wrong.email, password: WRONG_PASSWORD },
          {
            email: await emailOf(ctx.database, noPassword),
            password: PASSWORD,
          },
          { email: disabled.email, password: PASSWORD },
          { email: deleted.email, password: PASSWORD },
          { email: throttled.email, password: PASSWORD },
        ];
        const bodies = new Set<string>();
        for (const attempt of attempts) {
          const response = await post('password', attempt);
          expectSignInFailed(response);
          bodies.add(sameness(response.json<Record<string, unknown>>()));
        }
        expect(bodies.size).toBe(1);
      });

      it('audits each failure with its reason, and an unknown address with no target', async () => {
        const wrong = await userWithPassword();
        const before = (await db().select().from(auditEvent)).length;
        await post('password', {
          email: 'someone.unknown@demopictures.example',
          password: WRONG_PASSWORD,
        });
        await post('password', {
          email: wrong.email,
          password: WRONG_PASSWORD,
        });
        const events = (await db().select().from(auditEvent)).slice(before);
        expect(events.map((event) => event.details)).toEqual([
          { method: 'password', reason: 'unknown-account' },
          { method: 'password', reason: 'wrong-secret' },
        ]);
        expect(events[0]).toMatchObject({ actorId: null, targetId: null });
        expect(events[1]).toMatchObject({ targetId: wrong.userId });
        expect((await failuresFor(wrong.userId)).length).toBe(1);
      });

      it('refuses the sixth guess in fifteen minutes even with the right password, and signs in again after', async () => {
        const { userId, email } = await userWithPassword();
        for (let i = 0; i < LOGIN_THROTTLE.maxFailures; i += 1) {
          expectSignInFailed(
            await post('password', { email, password: WRONG_PASSWORD }),
          );
        }
        expectSignInFailed(
          await post('password', { email, password: PASSWORD }),
        );
        expect(await sessionsOf(userId)).toEqual([]);
        const reasons = (await failuresFor(userId))
          .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
          .map((event) => (event.details as { reason: string }).reason);
        expect(reasons.at(-1)).toBe('throttled');

        // Let the window pass: only the clock moves, and the audit trail is not touched.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.now() + LOGIN_THROTTLE.windowMs + MINUTE);
        expect(
          (await post('password', { email, password: PASSWORD })).statusCode,
        ).toBe(200);
      });

      it('is a 400, not a sign-in failure, when the request is not shaped right', async () => {
        const { email } = await userWithPassword();
        for (const payload of [
          {},
          { email },
          { password: PASSWORD },
          { email: '', password: PASSWORD },
          { email, password: '' },
          { email: 42, password: PASSWORD },
          { email, password: 'x'.repeat(5000) },
          { email: 'x'.repeat(400), password: PASSWORD },
          [],
        ]) {
          const response = await post('password', payload);
          expect(
            response.statusCode,
            JSON.stringify(payload).slice(0, 40),
          ).toBe(400);
          expect(response.json<{ code: string }>().code).toMatch(
            /^(validation-failed|bad-request)$/,
          );
        }
      });

      it('is limited to ten requests a minute per address, counted with the other login routes', async () => {
        const address = freshAddress();
        for (let i = 0; i < AUTH_RATE_LIMIT.max; i += 1) {
          const response = await post(
            i % 2 === 0 ? 'password' : 'totp',
            { email: 'nobody@demopictures.example', password: WRONG_PASSWORD },
            { remoteAddress: address },
          );
          expect(response.statusCode).not.toBe(429);
        }
        const limited = await post(
          'password',
          { email: 'nobody@demopictures.example', password: WRONG_PASSWORD },
          { remoteAddress: address },
        );
        expect(limited.statusCode).toBe(429);
        expect(limited.json<{ code: string }>().code).toBe('rate-limited');
        expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(
          1,
        );
      });
    });

    describe('POST /auth/login/totp', () => {
      async function waiting() {
        const { userId, email } = await userWithPassword();
        const secret = await seedTotp(ctx.database, userId);
        const { challenge } = await createLoginChallenge(db(), userId, {
          kind: 'totp',
          now: new Date(),
        });
        return { userId, email, secret, challenge };
      }

      it('signs in the right code: 200 with the user and a session of method password+totp', async () => {
        const { userId, email, secret, challenge } = await waiting();
        const response = await post('totp', {
          challenge,
          code: totpCodeAt(secret, new Date()),
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(
          response.json<{ user: { id: string; email: string } }>().user,
        ).toMatchObject({ id: userId, email });
        const token = tokenIn(response)!;
        const found = await validateSession(db(), token, new Date());
        expect(found!.session).toMatchObject({
          method: 'password+totp',
          scope: 'full',
        });
      });

      it('answers every failure with the same 401 body, and sets no cookie', async () => {
        const wrongCode = await waiting();
        const reused = await waiting();
        await consumeLoginChallenge(db(), {
          challenge: reused.challenge,
          code: totpCodeAt(reused.secret, new Date()),
          now: new Date(),
        });
        const disabled = await waiting();
        await setUserStatus(ctx.database, disabled.userId, 'disabled');
        const expired = await userWithPassword();
        const expiredSecret = await seedTotp(ctx.database, expired.userId);
        const old = await createLoginChallenge(db(), expired.userId, {
          kind: 'totp',
          now: new Date(Date.now() - 6 * MINUTE),
        });
        const exhausted = await waiting();
        for (let i = 0; i < 5; i += 1) {
          await post('totp', {
            challenge: exhausted.challenge,
            code: '000000',
          });
        }
        const attempts = [
          { challenge: 'not-a-real-challenge-token', code: '123456' },
          { challenge: wrongCode.challenge, code: '000000' },
          { challenge: wrongCode.challenge, code: 'abcdef' },
          {
            challenge: reused.challenge,
            code: totpCodeAt(reused.secret, new Date(Date.now() + 30_000)),
          },
          {
            challenge: disabled.challenge,
            code: totpCodeAt(disabled.secret, new Date()),
          },
          {
            challenge: old.challenge,
            code: totpCodeAt(expiredSecret, new Date()),
          },
          {
            challenge: exhausted.challenge,
            code: totpCodeAt(exhausted.secret, new Date()),
          },
        ];
        const bodies = new Set<string>();
        for (const attempt of attempts) {
          const response = await post('totp', attempt);
          expectSignInFailed(response);
          bodies.add(sameness(response.json<Record<string, unknown>>()));
        }
        expect(bodies.size).toBe(1);
        // The same body as a failed password step.
        const password = await post('password', {
          email: 'nobody@demopictures.example',
          password: WRONG_PASSWORD,
        });
        expect(
          bodies.has(sameness(password.json<Record<string, unknown>>())),
        ).toBe(false);
      });

      it('can be used once', async () => {
        const { secret, challenge } = await waiting();
        const first = await post('totp', {
          challenge,
          code: totpCodeAt(secret, new Date()),
        });
        expect(first.statusCode).toBe(200);
        expectSignInFailed(
          await post('totp', {
            challenge,
            code: totpCodeAt(secret, new Date(Date.now() + 30_000)),
          }),
        );
      });

      it('is a 400 when the request is not shaped right', async () => {
        for (const payload of [
          {},
          { challenge: 'x' },
          { code: '123456' },
          { challenge: '', code: '123456' },
          { challenge: 'x', code: '' },
          { challenge: 'x'.repeat(300), code: '123456' },
          { challenge: 'x', code: '1'.repeat(40) },
          { challenge: 7, code: '123456' },
        ]) {
          expect(
            (await post('totp', payload)).statusCode,
            JSON.stringify(payload).slice(0, 40),
          ).toBe(400);
        }
      });
    });

    describe('POST /auth/login/recovery', () => {
      it('signs in a right code: 200 with the user, mustSecureAccount, and a recovery-scope session', async () => {
        const { userId, email } = await userWithPassword();
        const [code] = await generateRecoveryCodes(db(), userId, {
          now: new Date(),
        });
        const response = await post('recovery', { email, code });
        expect(response.statusCode).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.json<Record<string, unknown>>()).toEqual({
          user: {
            id: userId,
            email,
            displayName: expect.any(String) as string,
            status: 'active',
          },
          mustSecureAccount: true,
        });
        const token = tokenIn(response)!;
        const found = await validateSession(db(), token, new Date());
        expect(found!.session).toMatchObject({
          method: 'recovery',
          scope: 'recovery',
        });
      });

      it('uses a code up: it works once', async () => {
        const { email, userId } = await userWithPassword();
        const [code] = await generateRecoveryCodes(db(), userId, {
          now: new Date(),
        });
        expect((await post('recovery', { email, code })).statusCode).toBe(200);
        expectSignInFailed(await post('recovery', { email, code }));
      });

      it('answers every failure with the same 401 body, and sets no cookie', async () => {
        const { userId, email } = await userWithPassword();
        const [code] = await generateRecoveryCodes(db(), userId, {
          now: new Date(),
        });
        const disabled = await userWithPassword();
        const [disabledCode] = await generateRecoveryCodes(
          db(),
          disabled.userId,
          { now: new Date() },
        );
        await setUserStatus(ctx.database, disabled.userId, 'disabled');
        const throttled = await userWithPassword();
        const [throttledCode] = await generateRecoveryCodes(
          db(),
          throttled.userId,
          { now: new Date() },
        );
        for (let i = 0; i < LOGIN_THROTTLE.maxFailures; i += 1) {
          await post('recovery', {
            email: throttled.email,
            code: 'AAAA-AAAA-AAAA-AAAA',
          });
        }
        const attempts = [
          { email: 'nobody@demopictures.example', code: code! },
          { email, code: 'AAAA-AAAA-AAAA-AAAA' },
          { email, code: 'not a code' },
          { email: disabled.email, code: disabledCode! },
          { email: throttled.email, code: throttledCode! },
        ];
        const bodies = new Set<string>();
        for (const attempt of attempts) {
          const response = await post('recovery', attempt);
          expectSignInFailed(response);
          bodies.add(sameness(response.json<Record<string, unknown>>()));
        }
        expect(bodies.size).toBe(1);
      });

      it('is a 400 when the request is not shaped right', async () => {
        for (const payload of [
          {},
          { email: 'a@b.example' },
          { code: 'AAAA-AAAA-AAAA-AAAA' },
          { email: '', code: 'AAAA' },
          { email: 'a@b.example', code: '' },
          { email: 'a@b.example', code: 'x'.repeat(100) },
        ]) {
          expect(
            (await post('recovery', payload)).statusCode,
            JSON.stringify(payload).slice(0, 40),
          ).toBe(400);
        }
      });
    });
  },
);
