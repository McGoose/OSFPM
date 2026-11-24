import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTH_AUDIT } from '@osfpm/core/src/auth/shared.js';
import { createSession } from '@osfpm/core/src/auth/sessions.js';
import {
  emailOf,
  everyRowAsText,
  seedActiveUser,
  seedInstallation,
  seedPassword,
  setStoredTotpSecret,
  storedTotpSecret,
  totpCodeAt,
} from '@osfpm/core/src/auth/test-support.js';
import { migrate } from '@osfpm/core/src/db/migrate.js';
import { auditEvent } from '@osfpm/core/src/db/schema/index.js';
import {
  testTargets,
  type TestTarget,
} from '@osfpm/core/src/db/test-support.js';
import { API_PREFIX } from '../api-version.js';
import {
  createTestApp,
  TEST_PUBLIC_ORIGIN,
  TEST_SERVER_KEYS,
} from '../test-support.js';
import { SESSION_COOKIE } from './cookie.js';

// An invented password, free of any word of the fixture addresses.
const PASSWORD = 'harbour-warehouse-night-shoot';

describe.each(testTargets)(
  'authenticator secrets sealed at rest, through the routes, on $name',
  (target: TestTarget) => {
    let ctx: Awaited<ReturnType<typeof createTestApp>>;
    let addresses = 0;

    beforeAll(async () => {
      ctx = await createTestApp(target, { logLevel: 'trace' });
      await migrate(ctx.database);
      await seedInstallation(ctx.database);
    });
    afterAll(async () => {
      await ctx.close();
    });

    const db = () => ctx.database.db;
    const freshAddress = () =>
      `10.8.${Math.floor(addresses / 250)}.${(addresses++ % 250) + 1}`;

    const post = (
      path: string,
      payload: unknown,
      headers: Record<string, string> = {},
    ) =>
      ctx.app.inject({
        method: 'POST',
        url: `${API_PREFIX}${path}`,
        payload: payload as Record<string, unknown>,
        headers: { origin: TEST_PUBLIC_ORIGIN, ...headers },
        remoteAddress: freshAddress(),
      });

    /** A user with a password and a session, as the password route would have made it. */
    async function signedIn() {
      const userId = await seedActiveUser(ctx.database);
      await seedPassword(ctx.database, userId, PASSWORD);
      const created = await createSession(db(), {
        userId,
        method: 'password',
        now: new Date(),
      });
      return {
        userId,
        email: await emailOf(ctx.database, userId),
        cookie: `${SESSION_COOKIE}=${created.token}`,
      };
    }

    /** Enrols and confirms through the routes; answers the base32 secret shown once. */
    async function enrolAndConfirm(who: Awaited<ReturnType<typeof signedIn>>) {
      const enrol = await post('/auth/totp/enrol', {}, { cookie: who.cookie });
      expect(enrol.statusCode).toBe(200);
      const { secret } = enrol.json<{ secret: string }>();
      // The code of the step before this one, which the window allows. Confirming
      // uses its step up, so the code of the current step still signs in.
      const confirm = await post(
        '/auth/totp/confirm',
        { code: totpCodeAt(secret, new Date(Date.now() - 30_000)) },
        { cookie: who.cookie },
      );
      expect(confirm.statusCode).toBeLessThan(300);
      return { secret, enrolBody: enrol.body, confirmBody: confirm.body };
    }

    it('stores the enrolled secret sealed, and shows the base32 secret only in the response that gives it', async () => {
      const who = await signedIn();
      ctx.lines.length = 0;

      const { secret, confirmBody } = await enrolAndConfirm(who);

      const stored = await storedTotpSecret(ctx.database, who.userId);
      expect(stored).toMatch(
        new RegExp(`^v1\\.${TEST_SERVER_KEYS.dataKeys.currentKeyId}\\.`),
      );
      expect(stored).not.toContain(secret);
      // Nowhere else: no table, no event, no log line, no later response.
      expect((await everyRowAsText(ctx.database)).split(secret)).toHaveLength(
        1,
      );
      expect(
        JSON.stringify(await db().select().from(auditEvent)),
      ).not.toContain(secret);
      const written = ctx.lines.join('\n');
      expect(written).not.toContain(secret);
      expect(written).not.toContain(stored);
      expect(confirmBody).not.toContain(secret);
      expect(confirmBody).not.toContain(stored);
    });

    it('signs in with the password and a code of the sealed secret', async () => {
      const who = await signedIn();
      const { secret } = await enrolAndConfirm(who);

      const first = await post('/auth/login/password', {
        email: who.email,
        password: PASSWORD,
      });
      const { challenge } = first.json<{ challenge: string }>();
      const second = await post('/auth/login/totp', {
        challenge,
        code: totpCodeAt(secret, new Date()),
      });

      expect(second.statusCode).toBe(200);
      expect(second.headers['set-cookie']).toBeDefined();
    });

    it('answers a secret the server cannot open exactly as it answers a wrong code, and says why only in the audit trail', async () => {
      const who = await signedIn();
      const { secret } = await enrolAndConfirm(who);

      const challengeFor = async () =>
        (
          await post('/auth/login/password', {
            email: who.email,
            password: PASSWORD,
          })
        ).json<{ challenge: string }>().challenge;

      const wrong = await post('/auth/login/totp', {
        challenge: await challengeFor(),
        code: '000000',
      });
      await setStoredTotpSecret(
        ctx.database,
        who.userId,
        'v1.broken.broken.broken',
      );
      const unopenable = await post('/auth/login/totp', {
        challenge: await challengeFor(),
        code: totpCodeAt(secret, new Date()),
      });

      expect(wrong.statusCode).toBe(401);
      expect(unopenable.statusCode).toBe(401);
      const strip = (text: string) =>
        JSON.stringify({
          ...JSON.parse(text),
          requestId: undefined,
          instance: undefined,
        });
      expect(strip(unopenable.body)).toBe(strip(wrong.body));
      expect(unopenable.json<{ code: string }>().code).toBe('sign-in-failed');
      expect(unopenable.headers['set-cookie']).toBeUndefined();
      const reasons = (await db().select().from(auditEvent))
        .filter(
          (event) =>
            event.category === AUTH_AUDIT.loginStepFailed &&
            event.targetId === who.userId,
        )
        .map((event) => (event.details as { reason: string }).reason);
      expect(reasons).toEqual(['wrong-secret', 'totp-undecryptable']);
    });
  },
);
