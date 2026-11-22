import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normaliseHumanCode } from '@osfpm/core/src/auth/tokens.js';
import {
  emailOf,
  everyRowAsText,
  seedActiveUser,
  seedInstallation,
  seedPassword,
  seedTotp,
  totpCodeAt,
} from '@osfpm/core/src/auth/test-support.js';
import { LOGIN_THROTTLE } from '@osfpm/core/src/auth/throttle.js';
import { migrate } from '@osfpm/core/src/db/migrate.js';
import { auditEvent, changeEvent } from '@osfpm/core/src/db/schema/index.js';
import {
  testTargets,
  type TestTarget,
} from '@osfpm/core/src/db/test-support.js';
import { API_PREFIX } from '../api-version.js';
import { createTestApp, TEST_PUBLIC_ORIGIN } from '../test-support.js';
import { SESSION_COOKIE } from './cookie.js';

// Invented passwords; none is a real credential, and none holds a word of the
// fixture addresses or of the policy's list.
const PASSWORD_A = 'harbour-warehouse-night-shoot';
const PASSWORD_B = 'copper-meadow-slow-thunder';
const NEW_PASSWORD_A = 'lantern-crane-quiet-morning';
const NEWER_PASSWORD_A = 'velvet-ferry-orchard-signal';
const WRONG_PASSWORD = 'quiet-lantern-wrong-answer';
const REFUSED_PASSWORD = 'abcdefghijklmnop';
const TYPED_UNKNOWN_EMAIL = 'nobody.here@demopictures.example';

/**
 * One value that must stay out of logs, audit events, change events and error
 * bodies. `shownOnce` values are in the response that makes them and nowhere
 * else; the rest are in no response body at all. `wholeWord` is for a short
 * code, which is looked for as a word so it is not found inside a number.
 */
type Secret = {
  readonly label: string;
  readonly value: string;
  readonly shownOnce?: boolean;
  readonly wholeWord?: boolean;
};

describe.each(testTargets)(
  'what the sign-in flows keep secret on $name',
  (target: TestTarget) => {
    let ctx: Awaited<ReturnType<typeof createTestApp>>;
    let addresses = 0;
    const secrets: Secret[] = [];
    /** Every response body, and the ones of failed requests apart. */
    const bodies: string[] = [];
    const errorBodies: string[] = [];

    beforeAll(async () => {
      // Every level, so a line written at any of them is in `ctx.lines`.
      ctx = await createTestApp(target, { logLevel: 'trace' });
      await migrate(ctx.database);
      await seedInstallation(ctx.database);
    });
    afterAll(async () => {
      await ctx.close();
    });

    const db = () => ctx.database.db;
    const freshAddress = () =>
      `10.5.${Math.floor(addresses / 250)}.${(addresses++ % 250) + 1}`;

    const know = (secret: Secret) => {
      if (!secrets.some((known) => known.value === secret.value)) {
        secrets.push(secret);
      }
    };

    /** One request. Notes every session token it sets, and keeps its body for the scans. */
    async function call(
      method: 'GET' | 'POST' | 'PUT' | 'DELETE',
      path: string,
      options: { token?: string; payload?: unknown } = {},
    ) {
      const headers: Record<string, string> = {};
      if (options.token !== undefined) {
        headers.cookie = `${SESSION_COOKIE}=${options.token}`;
        if (method !== 'GET') headers.origin = TEST_PUBLIC_ORIGIN;
      }
      const response = await ctx.app.inject({
        method,
        url: `${API_PREFIX}/auth${path}`,
        headers,
        remoteAddress: freshAddress(),
        ...(options.payload === undefined
          ? {}
          : { payload: options.payload as Record<string, unknown> }),
      });
      bodies.push(response.body);
      if (response.statusCode >= 400) errorBodies.push(response.body);
      const setCookie = response.headers['set-cookie'];
      for (const line of Array.isArray(setCookie)
        ? setCookie
        : setCookie === undefined
          ? []
          : [String(setCookie)]) {
        if (line.startsWith(`${SESSION_COOKIE}=`)) {
          const token = line.slice(SESSION_COOKIE.length + 1).split(';', 1)[0]!;
          if (token !== '') know({ label: 'a session token', value: token });
        }
      }
      return response;
    }

    const found = (secret: Secret, text: string) =>
      secret.wholeWord === true
        ? new RegExp(`\\b${secret.value}\\b`).test(text)
        : text.includes(secret.value);

    /**
     * Looks for every secret known so far in every place one must not be: the
     * log lines, the audit events, the change events, the bodies of failed
     * requests, and, for a value that is never returned, every body.
     */
    async function sweep(flow: string) {
      const places: [string, string][] = [
        ['a log line', ctx.lines.join('\n')],
        [
          'an audit event',
          JSON.stringify(await db().select().from(auditEvent)),
        ],
        [
          'a change event',
          JSON.stringify(await db().select().from(changeEvent)),
        ],
        ['an error body', errorBodies.join('\n')],
      ];
      for (const secret of secrets) {
        for (const [place, text] of places) {
          expect(
            found(secret, text),
            `${flow}: ${secret.label} is in ${place}`,
          ).toBe(false);
        }
        if (secret.shownOnce !== true) {
          expect(
            found(secret, bodies.join('\n')),
            `${flow}: ${secret.label} is in a response body`,
          ).toBe(false);
        }
      }
    }

    const body = <T>(response: { json: <R>() => R }) => response.json<T>();

    it('keeps passwords, codes, secrets, challenges and tokens out of logs, events and error bodies, flow after flow', async () => {
      const a = await seedActiveUser(ctx.database);
      await seedPassword(ctx.database, a, PASSWORD_A);
      const emailA = await emailOf(ctx.database, a);
      const b = await seedActiveUser(ctx.database);
      await seedPassword(ctx.database, b, PASSWORD_B);
      const emailB = await emailOf(ctx.database, b);
      const secretB = await seedTotp(ctx.database, b);
      for (const [label, value] of [
        ['a password', PASSWORD_A],
        ['a password', PASSWORD_B],
        ['a new password', NEW_PASSWORD_A],
        ['a newer password', NEWER_PASSWORD_A],
        ['a wrong password', WRONG_PASSWORD],
        ['a refused password', REFUSED_PASSWORD],
        ['a typed address', TYPED_UNKNOWN_EMAIL],
        ['an authenticator secret', secretB],
      ] as const) {
        know({ label, value });
      }
      await sweep('set-up');

      // Flow 1: failed password sign-ins, one of them for an address no one has. They
      // are the second account's: the first has five wrong guesses to spend over all
      // its flows, and the sixth would close it.
      for (const email of [emailB, TYPED_UNKNOWN_EMAIL]) {
        const failed = await call('POST', '/login/password', {
          payload: { email, password: WRONG_PASSWORD },
        });
        expect(failed.statusCode).toBe(401);
      }
      await sweep('failed password sign-ins');

      // Flow 2: a good password sign-in.
      const first = await call('POST', '/login/password', {
        payload: { email: emailA, password: PASSWORD_A },
      });
      expect(first.statusCode).toBe(200);
      const tokenA = (first.headers['set-cookie'] as string)
        .slice(SESSION_COOKIE.length + 1)
        .split(';', 1)[0]!;
      await sweep('a password sign-in');

      // Flow 3: set up an authenticator app and confirm it.
      const enrol = await call('POST', '/totp/enrol', { token: tokenA });
      expect(enrol.statusCode).toBe(200);
      const { secret: secretA, otpauthUri } = body<{
        secret: string;
        otpauthUri: string;
      }>(enrol);
      know({
        label: 'an authenticator secret',
        value: secretA,
        shownOnce: true,
      });
      know({ label: 'an otpauth address', value: otpauthUri, shownOnce: true });
      const confirmCode = totpCodeAt(secretA, new Date());
      know({
        label: 'an authenticator code',
        value: confirmCode,
        wholeWord: true,
      });
      const wrongConfirm = confirmCode === '000000' ? '000001' : '000000';
      know({ label: 'a wrong code', value: wrongConfirm, wholeWord: true });
      expect(
        (
          await call('POST', '/totp/confirm', {
            token: tokenA,
            payload: { code: wrongConfirm },
          })
        ).statusCode,
      ).toBe(422);
      expect(
        (
          await call('POST', '/totp/confirm', {
            token: tokenA,
            payload: { code: confirmCode },
          })
        ).statusCode,
      ).toBe(204);
      await sweep('setting up an authenticator');

      // Flow 4: the two-step sign-in, with a wrong code first.
      const step = await call('POST', '/login/password', {
        payload: { email: emailA, password: PASSWORD_A },
      });
      const { challenge } = body<{ next: string; challenge: string }>(step);
      know({ label: 'a challenge', value: challenge, shownOnce: true });
      const secondCode = totpCodeAt(secretA, new Date(Date.now() + 30_000));
      know({
        label: 'an authenticator code',
        value: secondCode,
        wholeWord: true,
      });
      expect(
        (
          await call('POST', '/login/totp', {
            payload: { challenge, code: wrongConfirm },
          })
        ).statusCode,
      ).toBe(401);
      const second = await call('POST', '/login/totp', {
        payload: { challenge, code: secondCode },
      });
      expect(second.statusCode).toBe(200);
      await sweep('the two-step sign-in');

      // Flow 5: recovery codes, a recovery sign-in, and the refusal of a closed route.
      const tokenA2 = (second.headers['set-cookie'] as string)
        .slice(SESSION_COOKIE.length + 1)
        .split(';', 1)[0]!;
      const made = await call('POST', '/recovery-codes', { token: tokenA2 });
      expect(made.statusCode).toBe(200);
      const { codes } = body<{ codes: string[] }>(made);
      for (const code of codes) {
        know({ label: 'a recovery code', value: code, shownOnce: true });
        know({
          label: 'a recovery code',
          value: normaliseHumanCode(code)!,
          shownOnce: true,
        });
      }
      expect(
        (
          await call('POST', '/login/recovery', {
            payload: { email: emailA, code: 'AAAA-AAAA-AAAA-AAAA' },
          })
        ).statusCode,
      ).toBe(401);
      const recovery = await call('POST', '/login/recovery', {
        payload: { email: emailA, code: codes[0] },
      });
      expect(recovery.statusCode).toBe(200);
      const tokenR = (recovery.headers['set-cookie'] as string)
        .slice(SESSION_COOKIE.length + 1)
        .split(';', 1)[0]!;
      const closed = await call('GET', '/sessions', { token: tokenR });
      expect(closed.statusCode).toBe(403);
      await sweep('recovery sign-in');

      // Flow 6: from the recovery session, a refused password and then a good one.
      expect(
        (
          await call('PUT', '/password', {
            token: tokenR,
            payload: { newPassword: REFUSED_PASSWORD },
          })
        ).statusCode,
      ).toBe(422);
      expect(
        (
          await call('PUT', '/password', {
            token: tokenR,
            payload: { newPassword: NEW_PASSWORD_A },
          })
        ).statusCode,
      ).toBe(204);
      await sweep('a new password from a recovery session');

      // Flow 7: a wrong current password, then a change, then removing the authenticator.
      expect(
        (
          await call('PUT', '/password', {
            token: tokenR,
            payload: {
              currentPassword: WRONG_PASSWORD,
              newPassword: NEWER_PASSWORD_A,
            },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await call('PUT', '/password', {
            token: tokenR,
            payload: {
              currentPassword: NEW_PASSWORD_A,
              newPassword: NEWER_PASSWORD_A,
            },
          })
        ).statusCode,
      ).toBe(204);
      expect(
        (
          await call('DELETE', '/totp', {
            token: tokenR,
            payload: { password: WRONG_PASSWORD },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await call('DELETE', '/totp', {
            token: tokenR,
            payload: { password: NEWER_PASSWORD_A },
          })
        ).statusCode,
      ).toBe(204);
      await sweep('changing the password and removing the authenticator');

      // Flow 8: guesses at a second account's authenticator step until it is closed.
      const stepB = await call('POST', '/login/password', {
        payload: { email: emailB, password: PASSWORD_B },
      });
      const challengeB = body<{ challenge: string }>(stepB).challenge;
      know({ label: 'a challenge', value: challengeB, shownOnce: true });
      for (let i = 0; i < LOGIN_THROTTLE.maxFailures; i += 1) {
        expect(
          (
            await call('POST', '/login/totp', {
              payload: { challenge: challengeB, code: wrongConfirm },
            })
          ).statusCode,
        ).toBe(401);
      }
      const rightB = totpCodeAt(secretB, new Date());
      know({ label: 'an authenticator code', value: rightB, wholeWord: true });
      expect(
        (
          await call('POST', '/login/totp', {
            payload: { challenge: challengeB, code: rightB },
          })
        ).statusCode,
      ).toBe(401);
      await sweep('guessing at an authenticator step');

      // At the end, in every table. A session token, a recovery code, a
      // challenge and a password are in none. The one authenticator secret still
      // set up (the second account's) is in its own column and nowhere else; the
      // first account's was removed, so it is in no table.
      const everything = await everyRowAsText(ctx.database);
      for (const secret of secrets) {
        if (secret.value === secretB) continue;
        expect(
          found(secret, everything) && secret.wholeWord !== true,
          `a table holds ${secret.label}`,
        ).toBe(false);
      }
      expect(everything.split(secretB)).toHaveLength(2);
    });
  },
);
