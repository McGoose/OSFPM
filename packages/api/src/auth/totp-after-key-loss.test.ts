import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateRecoveryCodes } from '@osfpm/core/src/auth/recovery.js';
import { validateSession } from '@osfpm/core/src/auth/sessions.js';
import { AUTH_AUDIT } from '@osfpm/core/src/auth/shared.js';
import {
  emailOf,
  seedActiveUser,
  seedInstallation,
  seedPassword,
  seedTotp,
  totpCodeAt,
} from '@osfpm/core/src/auth/test-support.js';
import { migrate } from '@osfpm/core/src/db/migrate.js';
import { auditEvent } from '@osfpm/core/src/db/schema/index.js';
import {
  testTargets,
  type TestTarget,
} from '@osfpm/core/src/db/test-support.js';
import { loadServerKeys } from '@osfpm/core/src/keys/server-keys.js';
import { createTestKeyDirectory } from '@osfpm/core/src/keys/test-support.js';
import { API_PREFIX } from '../api-version.js';
import {
  createTestApp,
  TEST_PUBLIC_ORIGIN,
  TEST_SERVER_KEYS,
} from '../test-support.js';
import { SESSION_COOKIE } from './cookie.js';

// An invented password; no real credential.
const PASSWORD = 'harbour-warehouse-night-shoot';

/**
 * What a person whose authenticator secret can no longer be opened goes through
 * (the data keys were lost and the loss was accepted, P-09a1): the password step is
 * answered with the code step as always, and the code step fails with the same 401 as
 * a wrong code. They sign in another way, set up an authenticator app again, and it
 * works. A secret the server can open still blocks a second setup.
 */
describe.each(testTargets)(
  'an authenticator whose secret cannot be opened, over HTTP, on $name',
  (target: TestTarget) => {
    let ctx: Awaited<ReturnType<typeof createTestApp>>;
    const lost = createTestKeyDirectory();
    let addresses = 0;

    beforeAll(async () => {
      ctx = await createTestApp(target);
      await migrate(ctx.database);
      await seedInstallation(ctx.database);
    });
    afterAll(async () => {
      await ctx.close();
      lost.remove();
    });

    const db = () => ctx.database.db;
    const freshAddress = () =>
      `10.7.${Math.floor(addresses / 250)}.${(addresses++ % 250) + 1}`;
    const post = (
      path: string,
      payload: unknown,
      options: { token?: string } = {},
    ) =>
      ctx.app.inject({
        method: 'POST',
        url: `${API_PREFIX}/auth${path}`,
        payload: payload as Record<string, unknown>,
        headers: {
          origin: TEST_PUBLIC_ORIGIN,
          ...(options.token === undefined
            ? {}
            : { cookie: `${SESSION_COOKIE}=${options.token}` }),
        },
        remoteAddress: freshAddress(),
      });
    const cookieOf = (response: Awaited<ReturnType<typeof post>>) => {
      const set = response.cookies.find(
        (cookie) => cookie.name === SESSION_COOKIE,
      );
      return set!.value;
    };
    const visible = (response: Awaited<ReturnType<typeof post>>) => ({
      status: response.statusCode,
      body: {
        ...response.json<Record<string, unknown>>(),
        requestId: undefined,
      },
    });

    /** A person with a password and a confirmed authenticator sealed with `ring`. */
    async function person(ring = TEST_SERVER_KEYS.dataKeys) {
      const userId = await seedActiveUser(ctx.database);
      await seedPassword(ctx.database, userId, PASSWORD);
      const secret = await seedTotp(ctx.database, userId, {
        dataKeys: ring,
        now: new Date(),
      });
      return { userId, secret, email: await emailOf(ctx.database, userId) };
    }

    it('gets the one failure for a wrong code at the code step, signs in with a recovery code, sets up again, and signs in with the new app', async () => {
      const keys = loadServerKeys(lost.dir).dataKeys;
      const bob = await person(keys);
      const [recoveryCode] = await generateRecoveryCodes(db(), bob.userId, {
        now: new Date(),
      });

      // The password step asks for the code, as it does for everyone with an authenticator.
      const password = await post('/login/password', {
        email: bob.email,
        password: PASSWORD,
      });
      expect(password.statusCode).toBe(200);
      const { challenge } = password.json<{ challenge: string }>();

      // The right code of his old secret is refused, with the answer for a wrong code.
      const refused = await post('/login/totp', {
        challenge,
        code: totpCodeAt(bob.secret, new Date()),
      });
      const control = await person();
      const controlPassword = await post('/login/password', {
        email: control.email,
        password: PASSWORD,
      });
      const wrong = await post('/login/totp', {
        challenge: controlPassword.json<{ challenge: string }>().challenge,
        code: '000000',
      });
      expect(refused.statusCode).toBe(401);
      expect(visible(refused)).toEqual({
        ...visible(wrong),
        body: {
          ...visible(wrong).body,
          instance: expect.any(String) as string,
        },
      });
      expect(refused.cookies).toEqual([]);
      // The trail says why, which is not counted as a wrong guess.
      const reasons = (await db().select().from(auditEvent))
        .filter(
          (event) =>
            event.category === AUTH_AUDIT.loginStepFailed &&
            event.targetId === bob.userId,
        )
        .map((event) => (event.details as { reason: string }).reason);
      expect(reasons).toEqual(['totp-undecryptable']);

      // He signs in another way: a recovery code opens a session that may only secure the account.
      const recovery = await post('/login/recovery', {
        email: bob.email,
        code: recoveryCode,
      });
      expect(recovery.statusCode).toBe(200);
      expect(
        recovery.json<{ mustSecureAccount: boolean }>().mustSecureAccount,
      ).toBe(true);
      const token = cookieOf(recovery);

      // He sets the authenticator app up again: the old secret does not stand in the way.
      const enrol = await post('/totp/enrol', undefined, { token });
      expect(enrol.statusCode).toBe(200);
      const { secret } = enrol.json<{ secret: string }>();
      expect(secret).not.toBe(bob.secret);
      const confirm = await post(
        '/totp/confirm',
        { code: totpCodeAt(secret, new Date()) },
        { token },
      );
      expect(confirm.statusCode).toBe(204);
      const found = await validateSession(db(), token, new Date());
      expect(found!.session.scope).toBe('full');

      // And the new app works at the next sign-in.
      const again = await post('/login/password', {
        email: bob.email,
        password: PASSWORD,
      });
      const later = new Date(Date.now() + 30_000);
      const signedIn = await post('/login/totp', {
        challenge: again.json<{ challenge: string }>().challenge,
        code: totpCodeAt(secret, later),
      });
      expect(signedIn.statusCode).toBe(200);
      expect(cookieOf(signedIn)).toBeTruthy();
      // The replacement is in the trail, with its reason and no secret.
      const enrolled = (await db().select().from(auditEvent)).filter(
        (event) =>
          event.category === AUTH_AUDIT.totpEnrolled &&
          event.targetId === bob.userId,
      );
      expect(enrolled).toHaveLength(1);
      expect(enrolled[0]!.details).toEqual({
        replacedPending: false,
        reason: 'totp-undecryptable',
      });
      expect(JSON.stringify(enrolled)).not.toContain(secret);
    });

    it('still answers a 409 totp-already-enrolled to a person whose confirmed secret opens', async () => {
      const alice = await person();
      const password = await post('/login/password', {
        email: alice.email,
        password: PASSWORD,
      });
      const signedIn = await post('/login/totp', {
        challenge: password.json<{ challenge: string }>().challenge,
        code: totpCodeAt(alice.secret, new Date()),
      });
      expect(signedIn.statusCode).toBe(200);

      const enrol = await post('/totp/enrol', undefined, {
        token: cookieOf(signedIn),
      });

      expect(enrol.statusCode).toBe(409);
      expect(enrol.json<{ code: string }>().code).toBe('totp-already-enrolled');
    });
  },
);
