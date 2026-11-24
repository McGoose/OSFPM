import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSession } from '@osfpm/core/src/auth/sessions.js';
import {
  seedActiveUser,
  seedInstallation,
} from '@osfpm/core/src/auth/test-support.js';
import { migrate } from '@osfpm/core/src/db/migrate.js';
import {
  auditEvent,
  userPreferences,
} from '@osfpm/core/src/db/schema/index.js';
import {
  testTargets,
  type TestTarget,
} from '@osfpm/core/src/db/test-support.js';
import { PREFERENCE_DEFAULTS } from '@osfpm/core/src/preferences/schemas.js';
import { API_PREFIX } from '../api-version.js';
import { SESSION_COOKIE } from '../auth/cookie.js';
import { createTestApp, TEST_PUBLIC_ORIGIN } from '../test-support.js';

/** A value the tests look for in output. It must never appear in a response. */
const SECRET = 'secret-marker-4f9c';

const CHOICES = {
  emailFormat: 'plain-text',
  documentFormat: 'easy-read',
  textSize: 'large',
  preferredChannel: 'sms',
  notificationRhythm: 'daily-digest',
  quietHours: { start: '22:00', end: '07:00' },
} as const;

/**
 * The preferences routes (decision D-69, P-02l2): `GET` and `PUT /api/v1/me/preferences`.
 * They are self-service: each acts only on the signed-in person's own preferences, so there
 * is no permission to lack. A session only: no personal API token, and not a recovery
 * session. Preferences are ordinary settings, not sensitive data, but only the person reads
 * their own here, and the response is not cached.
 */
describe.each(testTargets)(
  'the preferences routes on $name',
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
      `10.9.${Math.floor(addresses / 250)}.${(addresses++ % 250) + 1}`;

    /** A signed-in account, with a session of `method`. */
    async function signedIn(method: 'password' | 'recovery' = 'password') {
      const userId = await seedActiveUser(ctx.database);
      const { token } = await createSession(db(), {
        userId,
        method,
        now: new Date(),
      });
      return { userId, token };
    }

    function send(
      method: 'GET' | 'PUT',
      options: {
        token?: string;
        origin?: string | null;
        payload?: unknown;
        headers?: Record<string, string>;
      } = {},
    ) {
      const headers: Record<string, string> = { ...options.headers };
      if (options.token !== undefined) {
        headers.cookie = `${SESSION_COOKIE}=${options.token}`;
      }
      const origin =
        options.origin === undefined ? TEST_PUBLIC_ORIGIN : options.origin;
      if (origin !== null) headers.origin = origin;
      return ctx.app.inject({
        method,
        url: `${API_PREFIX}/me/preferences`,
        headers,
        remoteAddress: freshAddress(),
        ...(options.payload === undefined
          ? {}
          : { payload: options.payload as Record<string, unknown> }),
      });
    }

    const rowsOf = async (userId: string) =>
      (await db().select().from(userPreferences)).filter(
        (row) => row.userId === userId,
      );

    describe('GET /api/v1/me/preferences', () => {
      it('answers the defaults, and nothing stored, for a person who chose nothing', async () => {
        const { token } = await signedIn();

        const response = await send('GET', { token });

        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toMatch(/^application\/json/);
        expect(response.json()).toEqual({
          stored: {},
          effective: PREFERENCE_DEFAULTS,
        });
      });

      it('answers what the person chose, and the defaults around it', async () => {
        const { token } = await signedIn();
        await send('PUT', {
          token,
          payload: { textSize: 'extra-large', documentFormat: 'large-print' },
        });

        const response = await send('GET', { token });

        expect(response.json()).toEqual({
          stored: { textSize: 'extra-large', documentFormat: 'large-print' },
          effective: {
            ...PREFERENCE_DEFAULTS,
            textSize: 'extra-large',
            documentFormat: 'large-print',
          },
        });
      });

      it('shows a person their own and nobody else’s', async () => {
        const one = await signedIn();
        const two = await signedIn();
        await send('PUT', { token: one.token, payload: { textSize: 'large' } });
        await send('PUT', {
          token: two.token,
          payload: { textSize: 'extra-large' },
        });

        expect(
          (await send('GET', { token: one.token })).json<{
            stored: unknown;
          }>().stored,
        ).toEqual({ textSize: 'large' });
        expect(
          (await send('GET', { token: two.token })).json<{
            stored: unknown;
          }>().stored,
        ).toEqual({ textSize: 'extra-large' });
      });

      it('is not cached, and is open to a request from another origin only as every safe request is', async () => {
        const { token } = await signedIn();

        const response = await send('GET', { token });

        expect(response.headers['cache-control']).toBe('no-store');
        // A safe method carries no origin check, as for every route.
        expect(
          (await send('GET', { token, origin: 'https://evil.example' }))
            .statusCode,
        ).toBe(200);
      });
    });

    describe('PUT /api/v1/me/preferences', () => {
      it('stores every choice and answers the same shape as GET, with every value of the design', async () => {
        const { userId, token } = await signedIn();

        const response = await send('PUT', { token, payload: CHOICES });

        expect(response.statusCode).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.json()).toEqual({
          stored: CHOICES,
          effective: CHOICES,
        });
        expect((await send('GET', { token })).json()).toEqual(response.json());
        const [row] = await rowsOf(userId);
        expect(row!.payload).toEqual(CHOICES);
      });

      it('replaces what was chosen: a field left out is cleared, and an empty body clears all', async () => {
        const { userId, token } = await signedIn();
        await send('PUT', { token, payload: CHOICES });

        const fewer = await send('PUT', {
          token,
          payload: { emailFormat: 'html' },
        });
        expect(fewer.json()).toEqual({
          stored: { emailFormat: 'html' },
          effective: PREFERENCE_DEFAULTS,
        });

        const none = await send('PUT', { token, payload: {} });
        expect(none.json()).toEqual({
          stored: {},
          effective: PREFERENCE_DEFAULTS,
        });
        expect((await rowsOf(userId))[0]!.payload).toEqual({});
      });

      it('accepts quiet hours that cross midnight', async () => {
        const { token } = await signedIn();

        const response = await send('PUT', {
          token,
          payload: { quietHours: { start: '23:30', end: '06:15' } },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json<{ effective: unknown }>().effective).toEqual({
          ...PREFERENCE_DEFAULTS,
          quietHours: { start: '23:30', end: '06:15' },
        });
      });

      it.each([
        ['a field it does not know', { fontName: 'Comic' }, ['']],
        [
          'a field that would name another account',
          { userId: '0199a3c4-0000-7000-8000-00000000dead' },
          [''],
        ],
        ['a value it does not allow', { textSize: SECRET }, ['textSize']],
        ['a value of the wrong kind', { emailFormat: 5 }, ['emailFormat']],
        [
          'a time that is not a time',
          { quietHours: { start: '25:00', end: '07:00' } },
          ['quietHours.start'],
        ],
        [
          'quiet hours that start and end together',
          { quietHours: { start: '22:00', end: '22:00' } },
          ['quietHours.end'],
        ],
        [
          'a field it does not know in the quiet hours',
          { quietHours: { start: '22:00', end: '07:00', days: 'weekdays' } },
          ['quietHours'],
        ],
        ['no object', [CHOICES], ['']],
      ])(
        'is a 400, lists where and never a value or a name the caller chose, and stores nothing, for %s',
        async (_label, payload, paths) => {
          const { userId, token } = await signedIn();

          const response = await send('PUT', { token, payload });

          expect(response.statusCode).toBe(400);
          expect(response.headers['content-type']).toMatch(
            /^application\/problem\+json/,
          );
          const body = response.json<{
            status: number;
            code: string;
            errors: { in: string; path: string; code: string }[];
          }>();
          expect(body).toMatchObject({
            status: 400,
            code: 'validation-failed',
          });
          // A field the schema does not know is reported on its parent, by code, and not by
          // name: the name is what the caller sent.
          expect(
            body.errors.map((error) => `${error.in}:${error.path}`),
          ).toEqual(paths.map((path) => `body:${path}`));
          for (const sent of [
            SECRET,
            'fontName',
            'Comic',
            'dead',
            'weekdays',
          ]) {
            expect(response.body).not.toContain(sent);
          }
          expect(await rowsOf(userId)).toEqual([]);
        },
      );

      it('is a 400 with no body at all', async () => {
        const { token } = await signedIn();

        const response = await send('PUT', { token });

        expect(response.statusCode).toBe(400);
      });

      it('writes an audit event of the names of the fields that changed, and no value', async () => {
        const { userId, token } = await signedIn();

        await send('PUT', { token, payload: CHOICES });

        const events = (await db().select().from(auditEvent)).filter(
          (event) =>
            event.category === 'preferences.saved' && event.targetId === userId,
        );
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          action: 'create',
          actorType: 'user',
          actorId: userId,
          details: {
            changedFields: [
              'documentFormat',
              'emailFormat',
              'notificationRhythm',
              'preferredChannel',
              'quietHours',
              'textSize',
            ],
          },
        });
        const text = JSON.stringify(events);
        for (const word of ['plain-text', 'easy-read', 'sms', '22:00']) {
          expect(text).not.toContain(word);
        }
      });

      it('logs no choice: no log line holds a value the person sent', async () => {
        const { token } = await signedIn();
        ctx.lines.length = 0;

        await send('PUT', { token, payload: CHOICES });
        await send('PUT', { token, payload: { textSize: SECRET } });

        const logged = ctx.lines.join('\n');
        for (const word of [
          'easy-read',
          'plain-text',
          'daily-digest',
          SECRET,
        ]) {
          expect(logged).not.toContain(word);
        }
      });
    });

    describe.each([
      ['GET' as const, undefined],
      ['PUT' as const, { textSize: 'large' }],
    ])('%s, as a self-service route', (method, payload) => {
      it('is a 401 without a session, the same whether the cookie is missing or no good', async () => {
        const missing = await send(method, { payload, origin: null });
        const unknown = await send(method, {
          token: 'not-a-session-token',
          payload,
        });

        for (const response of [missing, unknown]) {
          expect(response.statusCode).toBe(401);
          expect(response.json()).toMatchObject({
            status: 401,
            code: 'authentication-required',
          });
        }
      });

      it('is a 403 account-recovery-required for a recovery session, and stores nothing', async () => {
        const { userId, token } = await signedIn('recovery');

        const response = await send(method, { token, payload });

        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({
          status: 403,
          code: 'account-recovery-required',
        });
        expect(await rowsOf(userId)).toEqual([]);
      });

      it('is a 403 for a personal API token: a route refuses a token unless it says it takes one', async () => {
        const response = await send(method, {
          payload,
          origin: null,
          headers: {
            authorization: `Bearer osfpm_pat_${'a'.repeat(43)}`,
          },
        });

        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({
          status: 403,
          code: 'token-not-accepted',
        });
      });
    });

    it('is a 403 origin-mismatch for a PUT with a cookie and a foreign or missing Origin, and stores nothing', async () => {
      const { userId, token } = await signedIn();

      for (const origin of ['https://evil.example', 'null', null]) {
        const response = await send('PUT', {
          token,
          origin,
          payload: { textSize: 'large' },
        });
        expect(response.statusCode, String(origin)).toBe(403);
        expect(response.json()).toMatchObject({
          status: 403,
          code: 'origin-mismatch',
        });
      }
      expect(await rowsOf(userId)).toEqual([]);
    });
  },
);
