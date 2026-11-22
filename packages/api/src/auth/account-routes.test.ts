import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD_POLICY } from '@osfpm/core/src/auth/password-policy.js';
import { generateRecoveryCodes } from '@osfpm/core/src/auth/recovery.js';
import {
  createSession,
  validateSession,
} from '@osfpm/core/src/auth/sessions.js';
import { AUTH_AUDIT } from '@osfpm/core/src/auth/shared.js';
import {
  emailOf,
  seedActiveUser,
  seedInstallation,
  seedPassword,
  seedTotp,
  totpCodeAt,
} from '@osfpm/core/src/auth/test-support.js';
import { LOGIN_THROTTLE } from '@osfpm/core/src/auth/throttle.js';
import { migrate } from '@osfpm/core/src/db/migrate.js';
import { auditEvent, totpCredential } from '@osfpm/core/src/db/schema/index.js';
import {
  testTargets,
  type TestTarget,
} from '@osfpm/core/src/db/test-support.js';
import { API_PREFIX } from '../api-version.js';
import { createTestApp, TEST_PUBLIC_ORIGIN } from '../test-support.js';
import { SESSION_COOKIE } from './cookie.js';

// Invented passwords; no real credential, and no word of the fixture addresses.
const PASSWORD = 'harbour-warehouse-night-shoot';
const NEW_PASSWORD = 'lantern-crane-quiet-morning';
const WRONG_PASSWORD = 'quiet-lantern-wrong-answer';

describe.each(testTargets)(
  'the account security routes on $name',
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

    const db = () => ctx.database.db;
    const freshAddress = () =>
      `10.6.${Math.floor(addresses / 250)}.${(addresses++ % 250) + 1}`;

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
      method: 'PUT' | 'POST' | 'DELETE',
      path: string,
      options: {
        token?: string;
        origin?: string | null;
        payload?: unknown;
      } = {},
    ) {
      const headers: Record<string, string> = {};
      if (options.token !== undefined) {
        headers.cookie = `${SESSION_COOKIE}=${options.token}`;
      }
      const origin =
        options.origin === undefined ? TEST_PUBLIC_ORIGIN : options.origin;
      if (origin !== null) headers.origin = origin;
      return ctx.app.inject({
        method,
        url: `${API_PREFIX}/auth${path}`,
        headers,
        remoteAddress: freshAddress(),
        ...(options.payload === undefined
          ? {}
          : { payload: options.payload as Record<string, unknown> }),
      });
    }

    const signInWithPassword = (email: string, password: string) =>
      ctx.app.inject({
        method: 'POST',
        url: `${API_PREFIX}/auth/login/password`,
        payload: { email, password },
        remoteAddress: freshAddress(),
      });

    const stillValid = async (token: string) =>
      (await validateSession(db(), token, new Date())) !== null;

    const eventsOf = async (category: string, userId: string) =>
      (await db().select().from(auditEvent)).filter(
        (event) =>
          event.category === category &&
          (event.actorId === userId || event.targetId === userId),
      );

    /** What every account route answers without a session, and to a forged request. */
    function sharedRefusals(
      method: 'PUT' | 'POST' | 'DELETE',
      path: string,
      payload?: unknown,
    ) {
      it('is a 401 without a session', async () => {
        const response = await send(method, path, {
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
          const response = await send(method, path, {
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

    describe('PUT /auth/password', () => {
      sharedRefusals('PUT', '/password', {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      });

      it('changes the password with the current one: 204, other sessions ended, this one kept', async () => {
        const { userId, email } = await account();
        const mine = await sessionOf(userId);
        const other = await sessionOf(userId);
        const response = await send('PUT', '/password', {
          token: mine.token,
          payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
        });
        expect(response.statusCode).toBe(204);
        expect(response.body).toBe('');
        expect(await stillValid(mine.token)).toBe(true);
        expect(await stillValid(other.token)).toBe(false);
        // The new password signs in; the old one does not.
        expect((await signInWithPassword(email, NEW_PASSWORD)).statusCode).toBe(
          200,
        );
        expect((await signInWithPassword(email, PASSWORD)).statusCode).toBe(
          401,
        );
        expect(await eventsOf(AUTH_AUDIT.passwordSet, userId)).toHaveLength(1);
      });

      it('needs the current password, and answers the same 403 whether it is missing, wrong or the account is closed', async () => {
        const { userId } = await account();
        const { token } = await sessionOf(userId);
        const bodies = new Set<string>();
        for (const payload of [
          { newPassword: NEW_PASSWORD },
          { currentPassword: WRONG_PASSWORD, newPassword: NEW_PASSWORD },
          { currentPassword: '', newPassword: NEW_PASSWORD },
        ]) {
          const response = await send('PUT', '/password', { token, payload });
          expect(response.statusCode).toBe(403);
          const body = response.json<Record<string, unknown>>();
          expect(body.code).toBe('current-password-incorrect');
          bodies.add(JSON.stringify({ ...body, requestId: undefined }));
        }
        expect(bodies.size).toBe(1);
        // Nothing changed: the old password still signs in.
        expect(
          (
            await signInWithPassword(
              await emailOf(ctx.database, userId),
              PASSWORD,
            )
          ).statusCode,
        ).toBe(200);
      });

      it('counts wrong current passwords toward the throttle, so a stolen session cannot guess it', async () => {
        const { userId } = await account();
        const { token } = await sessionOf(userId);
        for (let i = 0; i < LOGIN_THROTTLE.maxFailures; i += 1) {
          await send('PUT', '/password', {
            token,
            payload: {
              currentPassword: WRONG_PASSWORD,
              newPassword: NEW_PASSWORD,
            },
          });
        }
        const response = await send('PUT', '/password', {
          token,
          payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
        });
        expect(response.statusCode).toBe(403);
        expect(await stillValid(token)).toBe(true);
      });

      it('sets a first password with no current one', async () => {
        const { userId, email } = await account({ password: false });
        const { token } = await sessionOf(userId);
        const response = await send('PUT', '/password', {
          token,
          payload: { newPassword: NEW_PASSWORD },
        });
        expect(response.statusCode).toBe(204);
        expect((await signInWithPassword(email, NEW_PASSWORD)).statusCode).toBe(
          200,
        );
      });

      it('needs no current password when the user must change it', async () => {
        const userId = await seedActiveUser(ctx.database);
        await seedPassword(ctx.database, userId, PASSWORD, {
          mustChange: true,
        });
        const { token } = await sessionOf(userId);
        const response = await send('PUT', '/password', {
          token,
          payload: { newPassword: NEW_PASSWORD },
        });
        expect(response.statusCode).toBe(204);
      });

      it('refuses a password the policy refuses with a 422, the reason, and nothing that was typed', async () => {
        const { userId, email } = await account();
        const { token } = await sessionOf(userId);
        const local = email.slice(0, email.indexOf('@'));
        const cases: [string, string][] = [
          ['brief-pw', 'too-short'],
          ['x'.repeat(PASSWORD_POLICY.maxLength + 1), 'too-long'],
          ['correct horse battery staple', 'too-common'],
          ['abcdefghijklmnop', 'too-predictable'],
          [`my-${local}-secret-door`, 'contains-email'],
          ['we love osfpm so very much', 'contains-product-name'],
        ];
        for (const [newPassword, reason] of cases) {
          const response = await send('PUT', '/password', {
            token,
            payload: { currentPassword: PASSWORD, newPassword },
          });
          expect(response.statusCode, reason).toBe(422);
          const body = response.json<Record<string, unknown>>();
          expect(body).toMatchObject({
            code: 'password-refused',
            errors: [{ in: 'body', path: 'newPassword', code: reason }],
          });
          expect(typeof body.detail).toBe('string');
          expect(response.body).not.toContain(newPassword);
          expect(response.body).not.toContain(PASSWORD);
        }
        expect(await eventsOf(AUTH_AUDIT.passwordSet, userId)).toEqual([]);
      });

      it('is a 400 when the request is not shaped right', async () => {
        const { userId } = await account();
        const { token } = await sessionOf(userId);
        for (const payload of [
          {},
          { currentPassword: PASSWORD },
          { newPassword: '' },
          { newPassword: 7 },
          { newPassword: NEW_PASSWORD, currentPassword: 7 },
          { newPassword: 'x'.repeat(5000) },
        ]) {
          expect(
            (await send('PUT', '/password', { token, payload })).statusCode,
            JSON.stringify(payload).slice(0, 40),
          ).toBe(400);
        }
      });

      it('lets a recovery session set one with no current password, and makes it full', async () => {
        const { userId, email } = await account();
        const recovery = await sessionOf(userId, 'recovery');
        const other = await sessionOf(userId);
        const response = await send('PUT', '/password', {
          token: recovery.token,
          payload: { newPassword: NEW_PASSWORD },
        });
        expect(response.statusCode).toBe(204);
        const found = await validateSession(db(), recovery.token, new Date());
        expect(found!.session.scope).toBe('full');
        expect(await stillValid(other.token)).toBe(false);
        expect((await signInWithPassword(email, NEW_PASSWORD)).statusCode).toBe(
          200,
        );
        // Full now: a route closed to a recovery session works.
        const sessions = await ctx.app.inject({
          method: 'GET',
          url: `${API_PREFIX}/auth/sessions`,
          headers: { cookie: `${SESSION_COOKIE}=${recovery.token}` },
          remoteAddress: freshAddress(),
        });
        expect(sessions.statusCode).toBe(200);
      });
    });

    describe('POST /auth/totp/enrol', () => {
      sharedRefusals('POST', '/totp/enrol');

      it('returns a new secret and the address for an app, once, uncached', async () => {
        const { userId } = await account();
        const { token } = await sessionOf(userId);
        const response = await send('POST', '/totp/enrol', { token });
        expect(response.statusCode).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        const body = response.json<{ secret: string; otpauthUri: string }>();
        expect(Object.keys(body).sort()).toEqual(['otpauthUri', 'secret']);
        expect(body.secret).toMatch(/^[A-Z2-7]{32}$/);
        const uri = new URL(body.otpauthUri);
        expect(uri.protocol).toBe('otpauth:');
        expect(uri.searchParams.get('secret')).toBe(body.secret);

        // It is not shown again by any route that reads the account.
        for (const path of ['/me', '/sessions']) {
          const later = await ctx.app.inject({
            method: 'GET',
            url: `${API_PREFIX}/auth${path}`,
            headers: { cookie: `${SESSION_COOKIE}=${token}` },
            remoteAddress: freshAddress(),
          });
          expect(later.body).not.toContain(body.secret);
        }
        // Setting up again gives a different secret: the first was never confirmed.
        const again = await send('POST', '/totp/enrol', { token });
        expect(again.json<{ secret: string }>().secret).not.toBe(body.secret);
      });

      it('is a 409 once an authenticator is confirmed', async () => {
        const { userId } = await account();
        await seedTotp(ctx.database, userId);
        const { token } = await sessionOf(userId);
        const response = await send('POST', '/totp/enrol', { token });
        expect(response.statusCode).toBe(409);
        expect(response.json<{ code: string }>().code).toBe(
          'totp-already-enrolled',
        );
      });
    });

    describe('POST /auth/totp/confirm', () => {
      sharedRefusals('POST', '/totp/confirm', { code: '123456' });

      it('confirms with the right code: 204, and the password step then asks for the code', async () => {
        const { userId, email } = await account();
        const { token } = await sessionOf(userId);
        const enrol = await send('POST', '/totp/enrol', { token });
        const { secret } = enrol.json<{ secret: string }>();
        const response = await send('POST', '/totp/confirm', {
          token,
          payload: { code: totpCodeAt(secret, new Date()) },
        });
        expect(response.statusCode).toBe(204);
        const signIn = await signInWithPassword(email, PASSWORD);
        expect(signIn.statusCode).toBe(200);
        expect(signIn.json<{ next: string }>().next).toBe('totp');
        expect(await eventsOf(AUTH_AUDIT.totpConfirmed, userId)).toHaveLength(
          1,
        );
      });

      it('is a 422 for a wrong code, and leaves the setup pending', async () => {
        const { userId } = await account();
        const { token } = await sessionOf(userId);
        const { secret } = (await send('POST', '/totp/enrol', { token })).json<{
          secret: string;
        }>();
        const right = totpCodeAt(secret, new Date());
        const wrong = right === '000000' ? '000001' : '000000';
        for (const code of [wrong, 'abcdef', '12']) {
          const response = await send('POST', '/totp/confirm', {
            token,
            payload: { code },
          });
          expect(response.statusCode, code).toBe(422);
          expect(response.json<{ code: string }>().code).toBe(
            'totp-code-incorrect',
          );
        }
        expect(
          (
            await send('POST', '/totp/confirm', {
              token,
              payload: { code: right },
            })
          ).statusCode,
        ).toBe(204);
      });

      it('is a 409 when nothing is being set up, and when it is already confirmed', async () => {
        const none = await account();
        const noneToken = (await sessionOf(none.userId)).token;
        const first = await send('POST', '/totp/confirm', {
          token: noneToken,
          payload: { code: '123456' },
        });
        expect(first.statusCode).toBe(409);
        expect(first.json<{ code: string }>().code).toBe('totp-not-set-up');

        const done = await account();
        const secret = await seedTotp(ctx.database, done.userId);
        const doneToken = (await sessionOf(done.userId)).token;
        const second = await send('POST', '/totp/confirm', {
          token: doneToken,
          payload: { code: totpCodeAt(secret, new Date()) },
        });
        expect(second.statusCode).toBe(409);
        expect(second.json<{ code: string }>().code).toBe(
          'totp-already-enrolled',
        );
      });

      it('makes a recovery session full', async () => {
        const { userId } = await account();
        const recovery = await sessionOf(userId, 'recovery');
        const { secret } = (
          await send('POST', '/totp/enrol', { token: recovery.token })
        ).json<{ secret: string }>();
        const response = await send('POST', '/totp/confirm', {
          token: recovery.token,
          payload: { code: totpCodeAt(secret, new Date()) },
        });
        expect(response.statusCode).toBe(204);
        const found = await validateSession(db(), recovery.token, new Date());
        expect(found!.session.scope).toBe('full');
      });

      it('is a 400 when the request is not shaped right', async () => {
        const { userId } = await account();
        const { token } = await sessionOf(userId);
        for (const payload of [
          {},
          { code: '' },
          { code: 123456 },
          { code: '1'.repeat(40) },
        ]) {
          expect(
            (await send('POST', '/totp/confirm', { token, payload }))
              .statusCode,
            JSON.stringify(payload),
          ).toBe(400);
        }
      });
    });

    describe('DELETE /auth/totp', () => {
      sharedRefusals('DELETE', '/totp', { password: PASSWORD });

      it('needs the password: a wrong one is a 403 and removes nothing', async () => {
        const { userId } = await account();
        await seedTotp(ctx.database, userId);
        const { token } = await sessionOf(userId);
        const response = await send('DELETE', '/totp', {
          token,
          payload: { password: WRONG_PASSWORD },
        });
        expect(response.statusCode).toBe(403);
        expect(response.json<{ code: string }>().code).toBe(
          'current-password-incorrect',
        );
        const rows = await db().select().from(totpCredential);
        expect(rows.some((row) => row.userId === userId)).toBe(true);
      });

      it('removes it with the right password, ends the other sessions, and the sign-in stops asking for a code', async () => {
        const { userId, email } = await account();
        await seedTotp(ctx.database, userId);
        const mine = await sessionOf(userId);
        const other = await sessionOf(userId);
        const response = await send('DELETE', '/totp', {
          token: mine.token,
          payload: { password: PASSWORD },
        });
        expect(response.statusCode).toBe(204);
        expect(await stillValid(mine.token)).toBe(true);
        expect(await stillValid(other.token)).toBe(false);
        const signIn = await signInWithPassword(email, PASSWORD);
        expect(signIn.statusCode).toBe(200);
        expect(signIn.json<Record<string, unknown>>()).toHaveProperty('user');
        expect(await eventsOf(AUTH_AUDIT.totpRemoved, userId)).toHaveLength(1);
      });

      it('is a 409 when there is nothing to remove', async () => {
        const { userId } = await account();
        const { token } = await sessionOf(userId);
        const response = await send('DELETE', '/totp', {
          token,
          payload: { password: PASSWORD },
        });
        expect(response.statusCode).toBe(409);
        expect(response.json<{ code: string }>().code).toBe('totp-not-set-up');
      });

      it('is a 400 when the request is not shaped right', async () => {
        const { userId } = await account();
        const { token } = await sessionOf(userId);
        for (const payload of [
          {},
          { password: 7 },
          { password: 'x'.repeat(5000) },
        ]) {
          expect(
            (await send('DELETE', '/totp', { token, payload })).statusCode,
            JSON.stringify(payload).slice(0, 40),
          ).toBe(400);
        }
      });
    });

    describe('POST /auth/recovery-codes', () => {
      sharedRefusals('POST', '/recovery-codes');

      it('returns ten codes once, uncached, and each works once at the recovery sign-in', async () => {
        const { userId, email } = await account();
        const { token } = await sessionOf(userId);
        const response = await send('POST', '/recovery-codes', { token });
        expect(response.statusCode).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        const { codes } = response.json<{ codes: string[] }>();
        expect(codes).toHaveLength(10);
        expect(new Set(codes).size).toBe(10);
        for (const code of codes) {
          expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
        }
        const signIn = await ctx.app.inject({
          method: 'POST',
          url: `${API_PREFIX}/auth/login/recovery`,
          payload: { email, code: codes[0] },
          remoteAddress: freshAddress(),
        });
        expect(signIn.statusCode).toBe(200);
        expect(
          await eventsOf(AUTH_AUDIT.recoveryCodesGenerated, userId),
        ).toHaveLength(1);
      });

      it('replaces an earlier set: the old codes stop working', async () => {
        const { userId, email } = await account();
        const [old] = await generateRecoveryCodes(db(), userId, {
          now: new Date(),
        });
        const { token } = await sessionOf(userId);
        await send('POST', '/recovery-codes', { token });
        const signIn = await ctx.app.inject({
          method: 'POST',
          url: `${API_PREFIX}/auth/login/recovery`,
          payload: { email, code: old },
          remoteAddress: freshAddress(),
        });
        expect(signIn.statusCode).toBe(401);
      });
    });

    describe('a recovery session', () => {
      it('may call each of the five routes that secure the account', async () => {
        const { userId } = await account();
        const recovery = await sessionOf(userId, 'recovery');
        const calls: [string, 'PUT' | 'POST' | 'DELETE', string, unknown][] = [
          ['password', 'PUT', '/password', { newPassword: 'x' }],
          ['enrol', 'POST', '/totp/enrol', undefined],
          ['confirm', 'POST', '/totp/confirm', { code: '000000' }],
          ['remove', 'DELETE', '/totp', { password: WRONG_PASSWORD }],
          ['codes', 'POST', '/recovery-codes', undefined],
        ];
        for (const [name, method, path, payload] of calls) {
          const response = await send(method, path, {
            token: recovery.token,
            payload,
          });
          // Whatever the answer, it is not the refusal of a recovery session.
          expect(response.json<{ code?: string }>().code ?? '', name).not.toBe(
            'account-recovery-required',
          );
        }
      });
    });

    describe('the limit per session', () => {
      it('counts every account route: the 121st request in a minute is a 429', async () => {
        const { userId } = await account();
        const { token } = await sessionOf(userId);
        for (let i = 0; i < 120; i += 1) {
          // A body that fails validation: the cheapest request the route sees.
          const response = await send('POST', '/totp/confirm', {
            token,
            payload: {},
          });
          expect(response.statusCode).toBe(400);
        }
        const limited = await send('POST', '/totp/confirm', {
          token,
          payload: {},
        });
        expect(limited.statusCode).toBe(429);
      });
    });
  },
);
