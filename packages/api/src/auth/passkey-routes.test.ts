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
import { AUTH_AUDIT } from '@osfpm/core/src/auth/shared.js';
import {
  emailOf,
  markUserDeleted,
  seedActiveUser,
  seedInstallation,
  seedPassword,
  setUserStatus,
  softwareAuthenticator,
  type AuthenticationTweaks,
  type RegistrationTweaks,
  type SoftwareAuthenticator,
} from '@osfpm/core/src/auth/test-support.js';
import { newId } from '@osfpm/core/src/db/ids.js';
import { migrate } from '@osfpm/core/src/db/migrate.js';
import {
  auditEvent,
  passkeyCredential,
  session,
} from '@osfpm/core/src/db/schema/index.js';
import {
  testTargets,
  type TestTarget,
} from '@osfpm/core/src/db/test-support.js';
import { API_PREFIX } from '../api-version.js';
import { createTestApp, TEST_PUBLIC_ORIGIN } from '../test-support.js';
import { SESSION_COOKIE } from './cookie.js';
import { AUTH_RATE_LIMIT, SESSION_RATE_LIMIT } from './rate-limit.js';

// Invented password; no real credential, and no word of the fixture addresses.
const PASSWORD = 'harbour-warehouse-night-shoot';

type CreationOptions = Parameters<SoftwareAuthenticator['register']>[0];
type RequestOptions = Parameters<SoftwareAuthenticator['authenticate']>[0];
type Summary = {
  id: string;
  deviceName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  transports: string[];
};

/** The `Set-Cookie` lines of a response. */
function setCookies(headers: OutgoingHttpHeaders): string[] {
  const value = headers['set-cookie'];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [String(value)];
}

describe.each(testTargets)(
  'the passkey routes on $name',
  (target: TestTarget) => {
    let ctx: Awaited<ReturnType<typeof createTestApp>>;
    let addresses = 0;

    beforeAll(async () => {
      // Every level, so the privacy checks below see every line the app writes.
      ctx = await createTestApp(target, { logLevel: 'trace' });
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
    /** An address of its own for each request, so the strict limit is not what a test measures. */
    const freshAddress = () =>
      `10.8.${Math.floor(addresses / 250)}.${(addresses++ % 250) + 1}`;

    /** A user, with a password unless told otherwise. */
    async function account(options: { password?: boolean } = {}) {
      const userId = await seedActiveUser(ctx.database);
      if (options.password !== false) {
        await seedPassword(ctx.database, userId, PASSWORD);
      }
      return { userId, email: await emailOf(ctx.database, userId) };
    }

    /** A session of `userId`, as the login routes would have made it. */
    async function sessionOf(
      userId: string,
      method: 'password' | 'recovery' = 'password',
    ) {
      const created = await createSession(db(), {
        userId,
        method,
        now: new Date(),
      });
      return { token: created.token, id: created.session.id };
    }

    function send(
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
      path: string,
      options: {
        token?: string;
        origin?: string | null;
        payload?: unknown;
        remoteAddress?: string;
        headers?: Record<string, string>;
      } = {},
    ) {
      const headers: Record<string, string> = { ...options.headers };
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
        ...(options.payload === undefined
          ? {}
          : { payload: options.payload as Record<string, unknown> }),
      });
    }

    type Response = Awaited<ReturnType<typeof send>>;

    /** What a client can see of a response, minus what differs between two requests: the request ID and the date. */
    const visible = (response: Response) => ({
      status: response.statusCode,
      headers: Object.fromEntries(
        Object.entries(response.headers).filter(
          ([name]) => name !== 'x-request-id' && name !== 'date',
        ),
      ),
      body: {
        ...response.json<Record<string, unknown>>(),
        requestId: undefined,
      },
    });

    /** `visible` without the path of the request and the length that follows from it. */
    const withoutPath = (response: Response) => {
      const seen = visible(response);
      return {
        ...seen,
        headers: Object.fromEntries(
          Object.entries(seen.headers).filter(
            ([name]) => name !== 'content-length',
          ),
        ),
        body: { ...seen.body, instance: undefined },
      };
    };

    /** Adds a passkey through the API, which must succeed. */
    async function addPasskey(
      token: string,
      options: {
        authenticator?: SoftwareAuthenticator;
        deviceName?: string;
      } = {},
    ) {
      const authenticator = options.authenticator ?? softwareAuthenticator();
      const started = await send('POST', '/passkeys/register/options', {
        token,
      });
      expect(started.statusCode).toBe(200);
      const { challenge, options: creation } = started.json<{
        challenge: string;
        options: CreationOptions;
      }>();
      const verified = await send('POST', '/passkeys/register/verify', {
        token,
        payload: {
          challenge,
          response: authenticator.register(creation),
          ...(options.deviceName === undefined
            ? {}
            : { deviceName: options.deviceName }),
        },
      });
      expect(verified.statusCode).toBe(201);
      return { authenticator, passkey: verified.json<Summary>() };
    }

    /** A user with a session and one passkey. */
    async function userWithPasskey(options: { password?: boolean } = {}) {
      const user = await account(options);
      const { token } = await sessionOf(user.userId);
      const added = await addPasskey(token);
      return { ...user, token, ...added };
    }

    /** What the browser gets to start a sign-in. */
    async function startSignIn(remoteAddress = freshAddress()) {
      const started = await send('POST', '/login/passkey/options', {
        remoteAddress,
      });
      expect(started.statusCode).toBe(200);
      return started.json<{ challenge: string; options: RequestOptions }>();
    }

    const verifySignIn = (payload: unknown, remoteAddress = freshAddress()) =>
      send('POST', '/login/passkey/verify', { payload, remoteAddress });

    /** A whole sign-in with `authenticator`: options, then the response. */
    async function signIn(
      authenticator: SoftwareAuthenticator,
      tweaks?: AuthenticationTweaks,
    ) {
      const { challenge, options } = await startSignIn();
      return verifySignIn({
        challenge,
        response: authenticator.authenticate(options, tweaks),
      });
    }

    /** A failed sign-in: a 401 `sign-in-failed`, which sets no cookie. */
    function expectSignInFailed(response: Response) {
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

    const tokenIn = (response: Response): string => {
      const cookie = setCookies(response.headers).find((line) =>
        line.startsWith(`${SESSION_COOKIE}=`),
      )!;
      return cookie.slice(SESSION_COOKIE.length + 1).split(';', 1)[0]!;
    };

    const passkeysOf = async (userId: string) =>
      (await db().select().from(passkeyCredential)).filter(
        (row) => row.userId === userId,
      );
    const scopeOf = async (sessionId: string) =>
      (await db().select().from(session)).find((row) => row.id === sessionId)!
        .scope;
    const eventsOf = async (category: string, userId: string) =>
      (await db().select().from(auditEvent)).filter(
        (event) =>
          event.category === category &&
          (event.actorId === userId || event.targetId === userId),
      );
    /** Lets six minutes pass, which is past the five a challenge lasts and well within a session's twelve hours. */
    const letChallengesRunOut = () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 6 * 60 * 1000);
    };

    /** What every route for a signed-in user answers without a session, and to a forged request. */
    function sharedRefusals(
      method: 'POST' | 'PATCH' | 'DELETE',
      path: () => string,
      payload?: unknown,
    ) {
      it('is a 401 without a session', async () => {
        const response = await send(method, path(), {
          payload,
          origin: null,
        });
        expect(response.statusCode).toBe(401);
        expect(response.json<{ code: string }>().code).toBe(
          'authentication-required',
        );
      });

      it('is a 403 for a cross-site request, whatever the session', async () => {
        const { userId } = await account();
        const { token } = await sessionOf(userId);
        for (const origin of ['https://evil.example', null]) {
          const response = await send(method, path(), {
            token,
            payload,
            origin,
          });
          expect(response.statusCode).toBe(403);
          expect(response.json<{ code: string }>().code).toBe(
            'origin-mismatch',
          );
        }
      });
    }

    /** What a route that a recovery session may not call answers it. */
    function refusesRecoverySessions(
      method: 'GET' | 'PATCH' | 'DELETE',
      path: () => string,
      payload?: unknown,
    ) {
      it('is a 403 account-recovery-required for a recovery session', async () => {
        const { userId } = await account();
        const { token } = await sessionOf(userId, 'recovery');
        const response = await send(method, path(), { token, payload });
        expect(response.statusCode).toBe(403);
        expect(response.json<{ code: string }>().code).toBe(
          'account-recovery-required',
        );
      });
    }

    describe('POST /auth/passkeys/register/options', () => {
      sharedRefusals('POST', () => '/passkeys/register/options');

      it('returns the challenge and the options for a discoverable passkey, and is not to be cached', async () => {
        const { userId, email } = await account();
        const { token } = await sessionOf(userId);
        const response = await send('POST', '/passkeys/register/options', {
          token,
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        const body = response.json<{
          challenge: string;
          options: CreationOptions;
        }>();
        expect(Object.keys(body).sort()).toEqual(['challenge', 'options']);
        expect(body.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(body.options.challenge).toBe(body.challenge);
        expect(body.options.rp).toEqual({
          id: 'osfpm.example.test',
          name: 'OSFPM',
        });
        expect(body.options.user.name).toBe(email);
        expect(body.options.attestation).toBe('none');
        expect(body.options.authenticatorSelection).toMatchObject({
          residentKey: 'required',
          userVerification: 'required',
        });
        expect(body.options.pubKeyCredParams.map((one) => one.alg)).toEqual([
          -7, -257,
        ]);
        expect(body.options.excludeCredentials ?? []).toEqual([]);
      });

      it('excludes the passkeys the user already has', async () => {
        const { token, authenticator } = await userWithPasskey();
        const response = await send('POST', '/passkeys/register/options', {
          token,
        });
        const { options } = response.json<{ options: CreationOptions }>();
        expect(options.excludeCredentials).toEqual([
          {
            id: authenticator.credentialId,
            transports: ['internal'],
            type: 'public-key',
          },
        ]);
      });

      it('is open to a recovery session: it is how that user sets a new way to sign in', async () => {
        const { userId } = await account({ password: false });
        const { token } = await sessionOf(userId, 'recovery');
        const response = await send('POST', '/passkeys/register/options', {
          token,
        });
        expect(response.statusCode).toBe(200);
      });
    });

    describe('POST /auth/passkeys/register/verify', () => {
      sharedRefusals('POST', () => '/passkeys/register/verify', {
        challenge: 'x',
        response: {},
      });

      it('registers the passkey: 201 with its summary and no key material', async () => {
        const { userId } = await account();
        const { token } = await sessionOf(userId);
        const authenticator = softwareAuthenticator();
        const { challenge, options } = (
          await send('POST', '/passkeys/register/options', { token })
        ).json<{ challenge: string; options: CreationOptions }>();
        const response = await send('POST', '/passkeys/register/verify', {
          token,
          payload: {
            challenge,
            response: authenticator.register(options),
            deviceName: '  Production office laptop  ',
          },
        });
        expect(response.statusCode).toBe(201);
        const passkey = response.json<Summary>();
        expect(passkey).toEqual({
          id: expect.any(String) as string,
          deviceName: 'Production office laptop',
          createdAt: expect.any(String) as string,
          lastUsedAt: null,
          transports: ['internal'],
        });
        for (const material of [
          authenticator.credentialId,
          Buffer.from(authenticator.publicKey).toString('base64url'),
          Buffer.from(authenticator.publicKey).toString('hex'),
        ]) {
          expect(response.body).not.toContain(material);
        }
        const [row] = await passkeysOf(userId);
        expect(row).toMatchObject({
          id: passkey.id,
          credentialId: authenticator.credentialId,
        });
        expect(
          await eventsOf(AUTH_AUDIT.passkeyRegistered, userId),
        ).toHaveLength(1);
      });

      it('leaves the name empty when none is given', async () => {
        const { userId } = await account();
        const { token } = await sessionOf(userId);
        expect((await addPasskey(token)).passkey.deviceName).toBeNull();
      });

      it('lets a recovery session become a full one', async () => {
        const { userId } = await account({ password: false });
        const { token, id } = await sessionOf(userId, 'recovery');
        const closed = await send('GET', '/sessions', { token });
        expect(closed.statusCode).toBe(403);
        await addPasskey(token);
        expect(await scopeOf(id)).toBe('full');
        // The same cookie now opens the routes a recovery session may not call.
        expect((await send('GET', '/sessions', { token })).statusCode).toBe(
          200,
        );
      });

      const refusals: [string, RegistrationTweaks | 'eddsa'][] = [
        ['another origin', { origin: 'https://evil.example.test' }],
        ['another relying party id', { rpId: 'evil.example.test' }],
        ['no user verification', { userVerified: false }],
        ['no user presence', { userPresent: false }],
        ['another challenge in the client data', { challenge: 'bm90LXRoZQ' }],
        ['a key type the server does not accept', 'eddsa'],
      ];
      it('answers one 422 for every refusal, stores nothing, and leaves a recovery session as it was', async () => {
        const { userId } = await account({ password: false });
        const { token, id } = await sessionOf(userId, 'recovery');
        const seen = new Set<string>();
        for (const [, refusal] of refusals) {
          const authenticator =
            refusal === 'eddsa'
              ? softwareAuthenticator({ algorithm: 'EdDSA' })
              : softwareAuthenticator();
          const { challenge, options } = (
            await send('POST', '/passkeys/register/options', { token })
          ).json<{ challenge: string; options: CreationOptions }>();
          const response = await send('POST', '/passkeys/register/verify', {
            token,
            payload: {
              challenge,
              response: authenticator.register(
                options,
                refusal === 'eddsa' ? {} : refusal,
              ),
            },
          });
          expect(response.statusCode).toBe(422);
          expect(response.headers['content-type']).toMatch(
            /^application\/problem\+json/,
          );
          expect(response.json<{ code: string }>().code).toBe(
            'passkey-registration-failed',
          );
          seen.add(JSON.stringify(withoutPath(response)));
        }
        expect(seen.size).toBe(1);
        expect(await passkeysOf(userId)).toEqual([]);
        expect(await scopeOf(id)).toBe('recovery');
      });

      it('refuses a challenge that was used, one that ran out, and one made for another user, with the same 422', async () => {
        const mine = await account();
        const other = await account();
        const { token } = await sessionOf(mine.userId);
        const otherSession = await sessionOf(other.userId);
        const authenticator = softwareAuthenticator();
        const start = async (sessionToken: string) =>
          (
            await send('POST', '/passkeys/register/options', {
              token: sessionToken,
            })
          ).json<{ challenge: string; options: CreationOptions }>();
        const bodies = new Set<string>();

        // Used: the second request with the same challenge.
        const used = await start(token);
        const payload = {
          challenge: used.challenge,
          response: authenticator.register(used.options),
        };
        expect(
          (await send('POST', '/passkeys/register/verify', { token, payload }))
            .statusCode,
        ).toBe(201);
        const replay = await send('POST', '/passkeys/register/verify', {
          token,
          payload,
        });
        expect(replay.statusCode).toBe(422);
        bodies.add(JSON.stringify(withoutPath(replay)));

        // Ran out.
        const late = await start(token);
        letChallengesRunOut();
        const expired = await send('POST', '/passkeys/register/verify', {
          token,
          payload: {
            challenge: late.challenge,
            response: softwareAuthenticator().register(late.options),
          },
        });
        expect(expired.statusCode).toBe(422);
        bodies.add(JSON.stringify(withoutPath(expired)));

        // Someone else's: made for `mine`, presented by `other`.
        const theirs = await start(token);
        const stolen = await send('POST', '/passkeys/register/verify', {
          token: otherSession.token,
          payload: {
            challenge: theirs.challenge,
            response: softwareAuthenticator().register(theirs.options),
          },
        });
        expect(stolen.statusCode).toBe(422);
        bodies.add(JSON.stringify(withoutPath(stolen)));
        expect(bodies.size).toBe(1);
        expect(await passkeysOf(other.userId)).toEqual([]);
        // The owner's challenge was not touched, so they can still finish.
        const finished = await send('POST', '/passkeys/register/verify', {
          token,
          payload: {
            challenge: theirs.challenge,
            response: softwareAuthenticator().register(theirs.options),
          },
        });
        expect(finished.statusCode).toBe(201);
      });

      it('refuses a credential that is already registered, however the authenticator got to it', async () => {
        const { token, authenticator } = await userWithPasskey();
        const again = (
          await send('POST', '/passkeys/register/options', { token })
        ).json<{ challenge: string; options: CreationOptions }>();
        const response = await send('POST', '/passkeys/register/verify', {
          token,
          payload: {
            challenge: again.challenge,
            // An authenticator that ignores `excludeCredentials`.
            response: authenticator.register(again.options),
          },
        });
        expect(response.statusCode).toBe(422);
      });

      it('is a 400, not a refusal, when the request is not shaped right', async () => {
        const { userId } = await account();
        const { token } = await sessionOf(userId);
        const { challenge, options } = (
          await send('POST', '/passkeys/register/options', { token })
        ).json<{ challenge: string; options: CreationOptions }>();
        const good = softwareAuthenticator().register(options);
        const payloads: unknown[] = [
          undefined,
          {},
          { challenge },
          { response: good },
          { challenge: '', response: good },
          { challenge: 'x'.repeat(300), response: good },
          { challenge, response: 'text' },
          { challenge, response: {} },
          { challenge, response: { ...good, type: 'password' } },
          { challenge, response: { ...good, id: '' } },
          { challenge, response: { ...good, id: 'not base64url!' } },
          { challenge, response: { ...good, response: {} } },
          {
            challenge,
            response: {
              ...good,
              response: { ...good.response, clientDataJSON: 'x'.repeat(5000) },
            },
          },
          { challenge, response: good, deviceName: 'x'.repeat(101) },
          { challenge, response: good, deviceName: 7 },
        ];
        for (const payload of payloads) {
          const response = await send('POST', '/passkeys/register/verify', {
            token,
            payload,
          });
          expect(response.statusCode, JSON.stringify(payload)).toBe(400);
          expect(response.json<{ code: string }>().code).toBe(
            'validation-failed',
          );
        }
        // None of them used the challenge up or stored anything.
        expect(await passkeysOf(userId)).toEqual([]);
        expect(
          (
            await send('POST', '/passkeys/register/verify', {
              token,
              payload: { challenge, response: good },
            })
          ).statusCode,
        ).toBe(201);
      });

      it('is a 400 for a name with a control character, which the service refuses', async () => {
        const { userId } = await account();
        const { token } = await sessionOf(userId);
        const { challenge, options } = (
          await send('POST', '/passkeys/register/options', { token })
        ).json<{ challenge: string; options: CreationOptions }>();
        const response = await send('POST', '/passkeys/register/verify', {
          token,
          payload: {
            challenge,
            response: softwareAuthenticator().register(options),
            deviceName: `line${String.fromCodePoint(10)}break`,
          },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json<{ code: string }>().code).toBe('bad-request');
      });
    });

    describe('POST /auth/login/passkey/options', () => {
      it('needs no session and no address: 200 with the challenge and the options, and is not to be cached', async () => {
        const response = await send('POST', '/login/passkey/options');
        expect(response.statusCode).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        const body = response.json<{
          challenge: string;
          options: RequestOptions;
        }>();
        expect(Object.keys(body).sort()).toEqual(['challenge', 'options']);
        expect(body.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(body.options.challenge).toBe(body.challenge);
        expect(body.options.rpId).toBe('osfpm.example.test');
        expect(body.options.userVerification).toBe('required');
        // No credential is named, so the answer says nothing about who has one.
        expect(body.options.allowCredentials ?? []).toEqual([]);
        expect(setCookies(response.headers)).toEqual([]);
      });

      it('ignores cookies, and a cross-site Origin: it uses no session, so there is nothing to borrow', async () => {
        const response = await send('POST', '/login/passkey/options', {
          token: 'not-a-session-token',
          origin: 'https://evil.example',
        });
        expect(response.statusCode).toBe(200);
        // Not looked up, so not cleared either.
        expect(setCookies(response.headers)).toEqual([]);
      });

      it('makes a new challenge each time', async () => {
        const first = await startSignIn();
        const second = await startSignIn();
        expect(first.challenge).not.toBe(second.challenge);
      });

      it('is limited to ten requests a minute per address, counted with the other sign-in routes', async () => {
        const address = freshAddress();
        for (let i = 0; i < AUTH_RATE_LIMIT.max; i += 1) {
          const response = await send(
            'POST',
            i % 2 === 0 ? '/login/passkey/options' : '/login/passkey/verify',
            {
              remoteAddress: address,
              ...(i % 2 === 0
                ? {}
                : { payload: { challenge: 'x', response: {} } }),
            },
          );
          expect(response.statusCode).not.toBe(429);
        }
        const limited = await send('POST', '/login/passkey/options', {
          remoteAddress: address,
        });
        expect(limited.statusCode).toBe(429);
        expect(limited.json<{ code: string }>().code).toBe('rate-limited');
        expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(
          1,
        );
        // Counted with the password routes too.
        const password = await send('POST', '/login/password', {
          remoteAddress: address,
          payload: { email: 'a@b.example', password: 'x' },
        });
        expect(password.statusCode).toBe(429);
      });
    });

    describe('POST /auth/login/passkey/verify', () => {
      it('signs in with no address: 200 with the user, a session cookie of method passkey, and nothing cached', async () => {
        const { userId, email, authenticator, passkey } =
          await userWithPasskey();
        const response = await signIn(authenticator);
        expect(response.statusCode).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.json()).toEqual({
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
        expect(cookie).not.toMatch(/Domain=/i);
        // The cookie is a live session of that user.
        const me = await ctx.app.inject({
          method: 'GET',
          url: `${API_PREFIX}/auth/me`,
          headers: { cookie: `${SESSION_COOKIE}=${tokenIn(response)}` },
          remoteAddress: freshAddress(),
        });
        expect(me.statusCode).toBe(200);
        expect(me.json<{ id: string }>().id).toBe(userId);
        const made = (await db().select().from(session)).filter(
          (row) => row.userId === userId && row.method === 'passkey',
        );
        expect(made).toHaveLength(1);
        expect(made[0]).toMatchObject({ scope: 'full', revokedAt: null });
        // The session is tied to the passkey that opened it.
        expect(made[0]!.passkeyCredentialId).toBe(passkey.id);
        expect(
          await eventsOf(AUTH_AUDIT.sessionCreated, userId),
        ).toContainEqual(
          expect.objectContaining({ details: { method: 'passkey' } }),
        );
      });

      it('is a 403 origin-mismatch with no Origin or a wrong one, whatever the cookie, and leaves the challenge unspent', async () => {
        const { authenticator, userId } = await userWithPasskey();
        const { challenge, options } = await startSignIn();
        const payload = {
          challenge,
          response: authenticator.authenticate(options),
        };
        for (const origin of [null, 'https://attacker.example.test', 'null']) {
          const response = await send('POST', '/login/passkey/verify', {
            payload,
            origin,
          });
          expect(response.statusCode, String(origin)).toBe(403);
          expect(response.json<{ code: string }>().code).toBe(
            'origin-mismatch',
          );
          expect(setCookies(response.headers)).toEqual([]);
        }
        const before = (await db().select().from(session)).filter(
          (row) => row.userId === userId && row.method === 'passkey',
        );
        expect(before).toHaveLength(0);
        // Not used up, and nothing was made: the same answer from the site itself signs in.
        expect((await verifySignIn(payload)).statusCode).toBe(200);
      });

      it('takes a device that never counts, again and again, and a count that goes up', async () => {
        const counting = await userWithPasskey();
        const never = await account();
        const neverSession = await sessionOf(never.userId);
        const flat = await addPasskey(neverSession.token, {
          authenticator: softwareAuthenticator({ counts: false }),
        });
        for (let i = 0; i < 3; i += 1) {
          expect((await signIn(counting.authenticator)).statusCode).toBe(200);
          expect((await signIn(flat.authenticator)).statusCode).toBe(200);
        }
        const [row] = await passkeysOf(never.userId);
        expect(row).toMatchObject({ signCount: 0 });
        expect((await passkeysOf(counting.userId))[0]).toMatchObject({
          signCount: 3,
        });
      });

      /** What goes wrong, set up the same way for every cause. */
      type Cause = [
        name: string,
        reason: string,
        run: () => Promise<{ response: Response; userId: string | null }>,
      ];
      const causes: Cause[] = [
        [
          'a credential the server does not have',
          'unknown-credential',
          async () => ({
            response: await signIn(softwareAuthenticator()),
            userId: null,
          }),
        ],
        [
          'a revoked credential',
          'revoked',
          async () => {
            const { userId, token, authenticator, passkey } =
              await userWithPasskey();
            const revoked = await send('DELETE', `/passkeys/${passkey.id}`, {
              token,
            });
            expect(revoked.statusCode).toBe(204);
            return { response: await signIn(authenticator), userId };
          },
        ],
        [
          'a disabled user',
          'disabled',
          async () => {
            const { userId, authenticator } = await userWithPasskey();
            await setUserStatus(ctx.database, userId, 'disabled');
            return { response: await signIn(authenticator), userId };
          },
        ],
        [
          'a deleted user',
          'unknown-credential',
          async () => {
            const { userId, authenticator } = await userWithPasskey();
            await markUserDeleted(ctx.database, userId);
            return { response: await signIn(authenticator), userId: null };
          },
        ],
        [
          'a wrong signature',
          'verification-failed',
          async () => {
            const { userId, authenticator } = await userWithPasskey();
            return {
              response: await signIn(authenticator, { wrongSignature: true }),
              userId,
            };
          },
        ],
        [
          'another origin',
          'verification-failed',
          async () => {
            const { userId, authenticator } = await userWithPasskey();
            return {
              response: await signIn(authenticator, {
                origin: 'https://evil.example.test',
              }),
              userId,
            };
          },
        ],
        [
          'a user handle that is not the credential owner’s',
          'verification-failed',
          async () => {
            const { userId, authenticator } = await userWithPasskey();
            return {
              response: await signIn(authenticator, {
                userHandle: 'bm90LXRoZS1oYW5kbGU',
              }),
              userId,
            };
          },
        ],
        [
          'no user verification',
          'verification-failed',
          async () => {
            const { userId, authenticator } = await userWithPasskey();
            return {
              response: await signIn(authenticator, { userVerified: false }),
              userId,
            };
          },
        ],
        [
          'a challenge that ran out',
          'challenge-invalid',
          async () => {
            const { userId, authenticator } = await userWithPasskey();
            const { challenge, options } = await startSignIn();
            letChallengesRunOut();
            return {
              response: await verifySignIn({
                challenge,
                response: authenticator.authenticate(options),
              }),
              userId,
            };
          },
        ],
        [
          'a challenge that was already used',
          'challenge-invalid',
          async () => {
            const { userId, authenticator } = await userWithPasskey();
            const { challenge, options } = await startSignIn();
            const payload = {
              challenge,
              response: authenticator.authenticate(options),
            };
            expect((await verifySignIn(payload)).statusCode).toBe(200);
            return { response: await verifySignIn(payload), userId };
          },
        ],
        [
          'a challenge for adding a passkey',
          'challenge-invalid',
          async () => {
            const { userId, token, authenticator } = await userWithPasskey();
            const registering = (
              await send('POST', '/passkeys/register/options', { token })
            ).json<{ challenge: string; options: CreationOptions }>();
            return {
              response: await verifySignIn({
                challenge: registering.challenge,
                response: authenticator.authenticate({
                  challenge: registering.challenge,
                  rpId: 'osfpm.example.test',
                }),
              }),
              userId,
            };
          },
        ],
        [
          'a signature counter that did not go up',
          'counter-regressed',
          async () => {
            const { userId, authenticator } = await userWithPasskey();
            expect((await signIn(authenticator)).statusCode).toBe(200);
            expect((await signIn(authenticator)).statusCode).toBe(200);
            return {
              response: await signIn(authenticator, { signCount: 1 }),
              userId,
            };
          },
        ],
      ];

      it.each(causes)(
        'answers 401 sign-in-failed for %s, and the audit trail names a reason class',
        async (_name, reason, run) => {
          const { response, userId } = await run();
          expectSignInFailed(response);
          const failures = (await db().select().from(auditEvent)).filter(
            (event) =>
              event.category === AUTH_AUDIT.loginStepFailed &&
              event.targetId === userId &&
              (event.details as { method?: string }).method === 'passkey' &&
              (event.details as { reason?: string }).reason === reason,
          );
          expect(failures.length).toBeGreaterThanOrEqual(1);
        },
      );

      it('gives one answer, in every part a client can see, whatever went wrong', async () => {
        const seen = new Set<string>();
        for (const [, , run] of causes) {
          const { response } = await run();
          seen.add(JSON.stringify(visible(response)));
        }
        expect(seen.size).toBe(1);
      });

      it('is a 400, not a sign-in failure, when the request is not shaped right', async () => {
        const { authenticator } = await userWithPasskey();
        const { challenge, options } = await startSignIn();
        const good = authenticator.authenticate(options);
        const payloads: unknown[] = [
          undefined,
          {},
          { challenge },
          { response: good },
          { challenge: '', response: good },
          { challenge: 'x'.repeat(300), response: good },
          { challenge, response: 'text' },
          { challenge, response: {} },
          { challenge, response: { ...good, type: 'password' } },
          { challenge, response: { ...good, response: {} } },
          { challenge, response: { ...good, id: 7 } },
          {
            challenge,
            response: {
              ...good,
              response: { ...good.response, signature: 'not base64url!' },
            },
          },
        ];
        for (const payload of payloads) {
          const response = await verifySignIn(payload);
          expect(response.statusCode, JSON.stringify(payload)).toBe(400);
          expect(response.json<{ code: string }>().code).toBe(
            'validation-failed',
          );
          expect(setCookies(response.headers)).toEqual([]);
        }
        // None of them used the challenge up.
        expect(
          (await verifySignIn({ challenge, response: good })).statusCode,
        ).toBe(200);
      });
    });

    describe('GET /auth/passkeys', () => {
      it('is a 401 without a session', async () => {
        const response = await send('GET', '/passkeys');
        expect(response.statusCode).toBe(401);
      });

      it('is open to a recovery session: a user who came in with a recovery code or a reset link sees their own passkeys', async () => {
        const mine = await userWithPasskey({ password: false });
        await userWithPasskey();
        const { token } = await sessionOf(mine.userId, 'recovery');
        const response = await send('GET', '/passkeys', { token });
        expect(response.statusCode).toBe(200);
        expect(response.json<Summary[]>()).toEqual([mine.passkey]);
      });

      it('lists the user’s live passkeys, with no key material, and none of anyone else’s', async () => {
        const { userId } = await account();
        const { token } = await sessionOf(userId);
        const first = await addPasskey(token, { deviceName: 'Laptop' });
        const second = await addPasskey(token);
        const revoked = await addPasskey(token, { deviceName: 'Gone' });
        const stranger = await userWithPasskey();
        const removed = await send(
          'DELETE',
          `/passkeys/${revoked.passkey.id}`,
          {
            token,
          },
        );
        expect(removed.statusCode).toBe(204);
        const response = await send('GET', '/passkeys', { token });
        expect(response.statusCode).toBe(200);
        expect(response.json<Summary[]>()).toEqual([
          first.passkey,
          second.passkey,
        ]);
        for (const item of response.json<Summary[]>()) {
          expect(Object.keys(item).sort()).toEqual([
            'createdAt',
            'deviceName',
            'id',
            'lastUsedAt',
            'transports',
          ]);
        }
        for (const material of [
          first.authenticator.credentialId,
          second.authenticator.credentialId,
          stranger.authenticator.credentialId,
          Buffer.from(first.authenticator.publicKey).toString('base64url'),
          Buffer.from(first.authenticator.publicKey).toString('hex'),
        ]) {
          expect(response.body).not.toContain(material);
        }
      });

      it('shows when a passkey was last used', async () => {
        const { token, authenticator, passkey } = await userWithPasskey();
        expect(passkey.lastUsedAt).toBeNull();
        await signIn(authenticator);
        const [listed] = (await send('GET', '/passkeys', { token })).json<
          Summary[]
        >();
        expect(listed!.lastUsedAt).toEqual(expect.any(String));
      });

      it('counts against the limit per session, 120 a minute', async () => {
        const { userId } = await account();
        const { token } = await sessionOf(userId);
        for (let n = 0; n < SESSION_RATE_LIMIT.max; n += 1) {
          expect((await send('GET', '/passkeys', { token })).statusCode).toBe(
            200,
          );
        }
        const limited = await send('GET', '/passkeys', { token });
        expect(limited.statusCode).toBe(429);
        expect(limited.json<{ code: string }>().code).toBe('rate-limited');
      });
    });

    describe('PATCH /auth/passkeys/:id', () => {
      sharedRefusals('PATCH', () => `/passkeys/${newId()}`, {
        deviceName: 'Name',
      });
      refusesRecoverySessions('PATCH', () => `/passkeys/${newId()}`, {
        deviceName: 'Name',
      });

      it('renames the passkey and returns it', async () => {
        const { userId } = await account();
        const { token } = await sessionOf(userId);
        const { passkey } = await addPasskey(token, { deviceName: 'Old' });
        const response = await send('PATCH', `/passkeys/${passkey.id}`, {
          token,
          payload: { deviceName: '  Camera trailer tablet  ' },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          ...passkey,
          deviceName: 'Camera trailer tablet',
        });
        expect(
          (await send('GET', '/passkeys', { token })).json<Summary[]>()[0]!
            .deviceName,
        ).toBe('Camera trailer tablet');
        expect(await eventsOf(AUTH_AUDIT.passkeyRenamed, userId)).toHaveLength(
          1,
        );
      });

      it('answers the same 404 for another user’s passkey, an id that is not there and a revoked passkey', async () => {
        const mine = await userWithPasskey();
        const other = await userWithPasskey();
        const revoked = await addPasskey(mine.token);
        await send('DELETE', `/passkeys/${revoked.passkey.id}`, {
          token: mine.token,
        });
        const answers = new Set<string>();
        for (const id of [other.passkey.id, newId(), revoked.passkey.id]) {
          const response = await send('PATCH', `/passkeys/${id}`, {
            token: mine.token,
            payload: { deviceName: 'Taken' },
          });
          expect(response.statusCode).toBe(404);
          expect(response.json<{ code: string }>().code).toBe('not-found');
          answers.add(JSON.stringify(withoutPath(response)));
        }
        expect(answers.size).toBe(1);
        // Nothing of the other user's was touched.
        const theirs = (
          await send('GET', '/passkeys', { token: other.token })
        ).json<Summary[]>();
        expect(theirs[0]!.deviceName).toBeNull();
      });

      it('is a 400 when the id or the name is not shaped right', async () => {
        const { userId } = await account();
        const { token } = await sessionOf(userId);
        const { passkey } = await addPasskey(token);
        for (const [id, payload] of [
          ['not-a-uuid', { deviceName: 'Name' }],
          [passkey.id, undefined],
          [passkey.id, {}],
          [passkey.id, { deviceName: '' }],
          [passkey.id, { deviceName: '   ' }],
          [passkey.id, { deviceName: 'x'.repeat(101) }],
          [passkey.id, { deviceName: 7 }],
          [passkey.id, { deviceName: `tab${String.fromCodePoint(9)}name` }],
        ] as const) {
          const response = await send('PATCH', `/passkeys/${id}`, {
            token,
            payload,
          });
          expect(response.statusCode, JSON.stringify([id, payload])).toBe(400);
        }
        expect(
          (await send('GET', '/passkeys', { token })).json<Summary[]>()[0]!
            .deviceName,
        ).toBeNull();
      });
    });

    describe('DELETE /auth/passkeys/:id', () => {
      sharedRefusals('DELETE', () => `/passkeys/${newId()}`);

      it('is open to a recovery session: the user removes the passkey of a lost device, and keeps the other', async () => {
        const lost = await userWithPasskey({ password: false });
        const kept = await addPasskey(lost.token);
        const { token } = await sessionOf(lost.userId, 'recovery');
        const response = await send('DELETE', `/passkeys/${lost.passkey.id}`, {
          token,
        });
        expect(response.statusCode).toBe(204);
        expect(
          (await send('GET', '/passkeys', { token })).json<Summary[]>(),
        ).toEqual([kept.passkey]);
      });

      it('still refuses a recovery session the user’s last way to sign in, so removing a passkey cannot lock anyone out', async () => {
        const only = await userWithPasskey({ password: false });
        const { token } = await sessionOf(only.userId, 'recovery');
        const response = await send('DELETE', `/passkeys/${only.passkey.id}`, {
          token,
        });
        expect(response.statusCode).toBe(409);
        expect(response.json<{ code: string }>().code).toBe(
          'last-sign-in-method',
        );
        expect(await passkeysOf(only.userId)).toHaveLength(1);
      });

      it('revokes the passkey: 204, no longer listed, and it signs no one in', async () => {
        const { userId, token, authenticator, passkey } =
          await userWithPasskey();
        const response = await send('DELETE', `/passkeys/${passkey.id}`, {
          token,
        });
        expect(response.statusCode).toBe(204);
        expect(response.body).toBe('');
        expect(
          (await send('GET', '/passkeys', { token })).json<Summary[]>(),
        ).toEqual([]);
        expectSignInFailed(await signIn(authenticator));
        expect(await eventsOf(AUTH_AUDIT.passkeyRevoked, userId)).toHaveLength(
          1,
        );
      });

      it('ends the sessions that passkey opened, and no other, including the one that made the request', async () => {
        const user = await userWithPasskey();
        const second = await addPasskey(user.token);
        const viaFirst = tokenIn(await signIn(user.authenticator));
        const alsoViaFirst = tokenIn(await signIn(user.authenticator));
        const viaSecond = tokenIn(await signIn(second.authenticator));
        const me = async (token: string) =>
          (await send('GET', '/me', { token })).statusCode;
        expect(await me(viaFirst)).toBe(200);

        // Revoked from a session the passkey did not open.
        const revoked = await send('DELETE', `/passkeys/${user.passkey.id}`, {
          token: user.token,
        });
        expect(revoked.statusCode).toBe(204);
        expect(await me(viaFirst)).toBe(401);
        expect(await me(alsoViaFirst)).toBe(401);
        expect(await me(user.token)).toBe(200);
        expect(await me(viaSecond)).toBe(200);

        // Revoked from the very session it opened: that one ends too.
        const third = await addPasskey(user.token);
        const viaThird = tokenIn(await signIn(third.authenticator));
        expect(
          (
            await send('DELETE', `/passkeys/${third.passkey.id}`, {
              token: viaThird,
            })
          ).statusCode,
        ).toBe(204);
        expect(await me(viaThird)).toBe(401);
        expect(await me(user.token)).toBe(200);
        expect(await me(viaSecond)).toBe(200);
      });

      it('answers the same 404 for another user’s passkey, an id that is not there and one already revoked', async () => {
        const mine = await userWithPasskey();
        const other = await userWithPasskey();
        const second = await addPasskey(mine.token);
        expect(
          (
            await send('DELETE', `/passkeys/${second.passkey.id}`, {
              token: mine.token,
            })
          ).statusCode,
        ).toBe(204);
        const answers = new Set<string>();
        for (const id of [other.passkey.id, newId(), second.passkey.id]) {
          const response = await send('DELETE', `/passkeys/${id}`, {
            token: mine.token,
          });
          expect(response.statusCode).toBe(404);
          expect(response.json<{ code: string }>().code).toBe('not-found');
          answers.add(JSON.stringify(withoutPath(response)));
        }
        expect(answers.size).toBe(1);
        // The other user's passkey still works.
        expect((await signIn(other.authenticator)).statusCode).toBe(200);
      });

      it('refuses the last way to sign in with a 409 last-sign-in-method, and keeps the passkey', async () => {
        const { token, passkey, authenticator } = await userWithPasskey({
          password: false,
        });
        const response = await send('DELETE', `/passkeys/${passkey.id}`, {
          token,
        });
        expect(response.statusCode).toBe(409);
        expect(response.headers['content-type']).toMatch(
          /^application\/problem\+json/,
        );
        expect(response.json<Record<string, unknown>>()).toMatchObject({
          status: 409,
          code: 'last-sign-in-method',
          type: '/problems/last-sign-in-method',
        });
        expect(
          (await send('GET', '/passkeys', { token })).json<Summary[]>(),
        ).toHaveLength(1);
        expect((await signIn(authenticator)).statusCode).toBe(200);
      });

      it('allows it when there is a password, or another passkey, and then refuses the last', async () => {
        const withPassword = await userWithPasskey();
        expect(
          (
            await send('DELETE', `/passkeys/${withPassword.passkey.id}`, {
              token: withPassword.token,
            })
          ).statusCode,
        ).toBe(204);

        const two = await userWithPasskey({ password: false });
        const second = await addPasskey(two.token);
        expect(
          (
            await send('DELETE', `/passkeys/${two.passkey.id}`, {
              token: two.token,
            })
          ).statusCode,
        ).toBe(204);
        const last = await send('DELETE', `/passkeys/${second.passkey.id}`, {
          token: two.token,
        });
        expect(last.statusCode).toBe(409);
      });

      it('is a 400 when the id is not a UUID', async () => {
        const { userId } = await account();
        const { token } = await sessionOf(userId);
        const response = await send('DELETE', '/passkeys/not-a-uuid', {
          token,
        });
        expect(response.statusCode).toBe(400);
      });
    });
  },
);
