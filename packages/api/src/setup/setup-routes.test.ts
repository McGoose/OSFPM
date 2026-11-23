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
import { PERMISSION_LISTS } from '@osfpm/core/src/access/permission-lists.js';
import { describePasswordRefusal } from '@osfpm/core/src/auth/password-policy.js';
import {
  consumeSetupCode,
  issueSetupCode,
} from '@osfpm/core/src/auth/setup-code.js';
import { AUTH_AUDIT } from '@osfpm/core/src/auth/shared.js';
import {
  DEMO_ADMIN_EMAIL,
  DEMO_ADMIN_PASSWORD,
  demoSetupInput,
  seedFirstRun,
} from '@osfpm/core/src/auth/test-support.js';
import { migrate } from '@osfpm/core/src/db/migrate.js';
import {
  auditEvent,
  changeEvent,
  installation,
  organisation,
  orgMembership,
  role,
  rolePermission,
  session,
  user,
} from '@osfpm/core/src/db/schema/index.js';
import {
  testTargets,
  type TestTarget,
} from '@osfpm/core/src/db/test-support.js';
import { API_PREFIX } from '../api-version.js';
import { SESSION_COOKIE } from '../auth/cookie.js';
import { AUTH_RATE_LIMIT } from '../auth/rate-limit.js';
import { createTestApp, TEST_PUBLIC_ORIGIN, UUID_V7 } from '../test-support.js';

const HOUR = 60 * 60 * 1000;
const FOREIGN_ORIGIN = 'https://attacker.example.test';

/** The `Set-Cookie` lines of a response. */
function setCookies(headers: OutgoingHttpHeaders): string[] {
  const value = headers['set-cookie'];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [String(value)];
}

/** An error body with the parts that differ between two requests taken out. */
function sameness(body: Record<string, unknown>) {
  return JSON.stringify({ ...body, requestId: undefined, instance: undefined });
}

describe.each(testTargets)(
  'the setup routes on $name',
  (target: TestTarget) => {
    let addresses = 0;
    /** An address of its own for each request, so the strict rate limit is not what a test measures. */
    const freshAddress = () =>
      `10.8.${Math.floor(addresses / 250)}.${(addresses++ % 250) + 1}`;

    /** An app and a database where setup is still to do and one setup code is live. */
    async function freshInstall() {
      const ctx = await createTestApp(target, {
        setupComplete: false,
        logLevel: 'trace',
      });
      await migrate(ctx.database);
      const code = await seedFirstRun(ctx.database);
      /**
       * A request to the app. A `POST` comes from the site itself unless `origin`
       * says otherwise (`null` sends none): a browser always sends an `Origin`,
       * and both setup routes refuse a request without the right one.
       */
      const call = (
        method: 'GET' | 'POST' | 'PUT',
        path: string,
        options: {
          payload?: unknown;
          headers?: Record<string, string>;
          remoteAddress?: string;
          origin?: string | null;
        } = {},
      ) => {
        const origin =
          options.origin === undefined ? TEST_PUBLIC_ORIGIN : options.origin;
        return ctx.app.inject({
          method,
          url: `${API_PREFIX}${path}`,
          headers: {
            ...(origin === null || method !== 'POST' ? {} : { origin }),
            ...options.headers,
          },
          remoteAddress: options.remoteAddress ?? freshAddress(),
          ...(options.payload === undefined
            ? {}
            : { payload: options.payload as Record<string, unknown> }),
        });
      };
      const post = (
        path: string,
        payload: unknown,
        headers: Record<string, string> = {},
        remoteAddress?: string,
      ) =>
        call('POST', path, {
          payload,
          headers,
          ...(remoteAddress === undefined ? {} : { remoteAddress }),
        });
      /** The raw session token a response set, or null when it set none. */
      const tokenIn = (response: { headers: OutgoingHttpHeaders }) => {
        const line = setCookies(response.headers).find((found) =>
          found.startsWith(`${SESSION_COOKIE}=`),
        );
        return line === undefined
          ? null
          : line.slice(SESSION_COOKIE.length + 1).split(';', 1)[0]!;
      };
      const withCookie = (
        token: string,
        extra: Record<string, string> = {},
      ) => ({
        cookie: `${SESSION_COOKIE}=${token}`,
        ...extra,
      });
      const rows = async () => ({
        organisations: (await ctx.database.db.select().from(organisation))
          .length,
        users: (await ctx.database.db.select().from(user)).length,
        roles: (await ctx.database.db.select().from(role)).length,
        grants: (await ctx.database.db.select().from(rolePermission)).length,
        members: (await ctx.database.db.select().from(orgMembership)).length,
        sessions: (await ctx.database.db.select().from(session)).length,
        changes: (await ctx.database.db.select().from(changeEvent)).length,
      });
      return {
        ctx,
        code,
        call,
        post,
        tokenIn,
        withCookie,
        rows,
        close: () => ctx.close(),
      };
    }

    type Install = Awaited<ReturnType<typeof freshInstall>>;

    const NOTHING = {
      organisations: 0,
      users: 0,
      roles: 0,
      grants: 0,
      members: 0,
      sessions: 0,
      changes: 0,
    };

    afterEach(() => {
      vi.useRealTimers();
    });

    describe('POST /setup/check', () => {
      let install: Install;
      let live: string;
      beforeAll(async () => {
        install = await freshInstall();
        live = install.code;
      });
      afterAll(async () => {
        await install.close();
      });

      const failedChecks = async () =>
        (await install.ctx.database.db.select().from(auditEvent)).filter(
          (event) => event.category === AUTH_AUDIT.setupCheckFailed,
        );

      /** A refused check: the one 401, with no cookie, and the same body whatever was wrong. */
      function expectInvalid(response: Awaited<ReturnType<Install['post']>>) {
        expect(response.statusCode).toBe(401);
        expect(response.headers['content-type']).toMatch(
          /^application\/problem\+json/,
        );
        expect(response.headers['x-request-id']).toMatch(UUID_V7);
        expect(response.json<Record<string, unknown>>()).toMatchObject({
          type: '/problems/setup-code-invalid',
          code: 'setup-code-invalid',
          status: 401,
          instance: `${API_PREFIX}/setup/check`,
        });
        expect(setCookies(response.headers)).toEqual([]);
        return sameness(response.json<Record<string, unknown>>());
      }

      it('says 204 for the live code, with no body, and does not use it up', async () => {
        const first = await install.post('/setup/check', { code: live });
        expect(first.statusCode).toBe(204);
        expect(first.body).toBe('');
        expect(
          (await install.post('/setup/check', { code: live })).statusCode,
        ).toBe(204);
        // Still unused: setup can use it.
        expect(
          await consumeSetupCode(install.ctx.database.db, live, new Date()),
        ).toBe(true);
        // Put a live code back for the tests that follow.
        live = await issueSetupCode(install.ctx.database.db, new Date());
        expect((await failedChecks()).length).toBe(0);
      });

      it('accepts any spelling of the code', async () => {
        const typed = live.toLowerCase().replaceAll('-', ' ');
        expect(
          (await install.post('/setup/check', { code: typed })).statusCode,
        ).toBe(204);
      });

      it('answers the same 401 for an unknown, a malformed, an expired, a replaced and a used code', async () => {
        const answers = new Set<string>();

        // Unknown, and not shaped like a code at all.
        answers.add(
          expectInvalid(
            await install.post('/setup/check', { code: 'AAAA-AAAA-AAAA-AAAA' }),
          ),
        );
        answers.add(
          expectInvalid(
            await install.post('/setup/check', { code: 'nonsense' }),
          ),
        );

        // Expired: the live code, 25 hours on.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.now() + 25 * HOUR);
        answers.add(
          expectInvalid(await install.post('/setup/check', { code: live })),
        );
        vi.useRealTimers();

        // Replaced by a newer code.
        const replaced = live;
        live = await issueSetupCode(install.ctx.database.db, new Date());
        answers.add(
          expectInvalid(await install.post('/setup/check', { code: replaced })),
        );

        // Used.
        const used = live;
        expect(
          await consumeSetupCode(install.ctx.database.db, used, new Date()),
        ).toBe(true);
        answers.add(
          expectInvalid(await install.post('/setup/check', { code: used })),
        );
        live = await issueSetupCode(install.ctx.database.db, new Date());

        // One answer for all five causes.
        expect(answers.size).toBe(1);
      });

      it('audits each refusal as a check, with no code in the event', async () => {
        const events = await failedChecks();
        // The five refusals above: unknown, malformed, expired, replaced, used.
        expect(events).toHaveLength(5);
        for (const event of events) {
          expect(event).toMatchObject({
            actorType: 'system',
            details: { purpose: 'check' },
          });
        }
        const text = JSON.stringify(events);
        for (const typed of ['AAAA-AAAA-AAAA-AAAA', 'nonsense']) {
          expect(text).not.toContain(typed);
        }
      });

      it('refuses a body that is not shaped right with a 400 that lists the field and not its value', async () => {
        for (const payload of [
          {},
          { code: 12 },
          { code: '' },
          { code: 'x'.repeat(65) },
        ]) {
          const response = await install.post('/setup/check', payload);
          expect(response.statusCode).toBe(400);
          expect(response.json()).toMatchObject({
            code: 'validation-failed',
            errors: [{ in: 'body' }],
          });
        }
        expect(
          (await install.post('/setup/check', { code: 'x'.repeat(65) })).body,
        ).not.toContain('xxxxx');
      });

      it('refuses a foreign Origin and no Origin with a 403, and lets the right one through', async () => {
        const foreign = await install.post(
          '/setup/check',
          { code: live },
          { origin: FOREIGN_ORIGIN },
        );
        expect(foreign.statusCode).toBe(403);
        expect(foreign.json()).toMatchObject({ code: 'origin-mismatch' });
        const none = await install.call('POST', '/setup/check', {
          payload: { code: live },
          origin: null,
        });
        expect(none.statusCode).toBe(403);
        expect(none.json()).toMatchObject({ code: 'origin-mismatch' });
        expect(
          (
            await install.post(
              '/setup/check',
              { code: live },
              { origin: TEST_PUBLIC_ORIGIN },
            )
          ).statusCode,
        ).toBe(204);
      });

      it('is never cached or shared: the answer is the same 401 whether or not a cookie is sent, and a cookie is ignored', async () => {
        const bare = await install.post('/setup/check', {
          code: 'AAAA-AAAA-AAAA-AAAA',
        });
        const cookie = await install.post(
          '/setup/check',
          { code: 'AAAA-AAAA-AAAA-AAAA' },
          { cookie: `${SESSION_COOKIE}=junk-token` },
        );
        expect(cookie.statusCode).toBe(401);
        expect(setCookies(cookie.headers)).toEqual([]);
        expect(sameness(cookie.json())).toBe(sameness(bare.json()));
      });
    });

    describe('the strict rate limit', () => {
      let install: Install;
      beforeAll(async () => {
        install = await freshInstall();
      });
      afterAll(async () => {
        await install.close();
      });

      it('counts both routes together, per address: the eleventh request is a 429 with Retry-After', async () => {
        const address = '10.99.0.1';
        const statuses: number[] = [];
        for (let i = 0; i < AUTH_RATE_LIMIT.max; i += 1) {
          // Alternate the two routes, each with a code that does not work.
          const response =
            i % 2 === 0
              ? await install.post(
                  '/setup/check',
                  { code: 'AAAA-AAAA-AAAA-AAAA' },
                  {},
                  address,
                )
              : await install.post(
                  '/setup',
                  demoSetupInput('AAAA-AAAA-AAAA-AAAA'),
                  {},
                  address,
                );
          statuses.push(response.statusCode);
        }
        expect(statuses).toEqual(Array(AUTH_RATE_LIMIT.max).fill(401));
        const limited = await install.post(
          '/setup/check',
          { code: install.code },
          {},
          address,
        );
        expect(limited.statusCode).toBe(429);
        expect(limited.json()).toMatchObject({ code: 'rate-limited' });
        expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(
          1,
        );
        // Another address is not limited.
        expect(
          (await install.post('/setup/check', { code: install.code }))
            .statusCode,
        ).toBe(204);
      });
    });

    describe('POST /setup with a password', () => {
      let install: Install;
      let response: Awaited<ReturnType<Install['post']>>;
      let token: string;

      beforeAll(async () => {
        install = await freshInstall();
        response = await install.post('/setup', demoSetupInput(install.code), {
          origin: TEST_PUBLIC_ORIGIN,
          'user-agent': 'Firefox on Windows',
        });
        token = install.tokenIn(response)!;
      });
      afterAll(async () => {
        await install.close();
      });

      it('answers 201 with the user, the organisation and that nothing more is needed, uncached', () => {
        expect(response.statusCode).toBe(201);
        expect(response.headers['content-type']).toMatch(/^application\/json/);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.json()).toEqual({
          user: {
            id: expect.any(String) as string,
            displayName: 'Ada Demo',
            email: DEMO_ADMIN_EMAIL,
            status: 'active',
          },
          organisation: {
            id: expect.any(String) as string,
            slug: 'demo-pictures',
            name: 'Demo Pictures',
            country: 'GB',
            baseCurrency: 'GBP',
            locale: 'en-GB',
            timeZone: 'Europe/London',
          },
          mustSecureAccount: false,
        });
      });

      it('sets the session cookie, with the attributes every session cookie has, and puts the token in no body', () => {
        const [line, ...rest] = setCookies(response.headers);
        expect(rest).toEqual([]);
        expect(line).toMatch(/^__Host-osfpm_session=[A-Za-z0-9_-]{43};/);
        expect(line).toMatch(/Path=\//);
        expect(line).toMatch(/HttpOnly/);
        expect(line).toMatch(/Secure/);
        expect(line).toMatch(/SameSite=Lax/);
        expect(line).not.toMatch(/Domain=/);
        expect(response.body).not.toContain(token);
      });

      it('makes a full session of method setup for the new user, with the browser noted', async () => {
        const [made] = await install.ctx.database.db.select().from(session);
        const [admin] = await install.ctx.database.db.select().from(user);
        expect(made).toMatchObject({
          userId: admin!.id,
          method: 'setup',
          scope: 'full',
          userAgentSummary: 'Firefox on Windows',
        });
      });

      it('signs the administrator in: the cookie works on a route that needs a full session', async () => {
        const me = await install.call('GET', '/auth/me', {
          headers: install.withCookie(token),
        });
        expect(me.statusCode).toBe(200);
        expect(me.json()).toMatchObject({
          email: DEMO_ADMIN_EMAIL,
          displayName: 'Ada Demo',
        });
        // A route a recovery session may not call: this session is full.
        const sessions = await install.call('GET', '/auth/sessions', {
          headers: install.withCookie(token),
        });
        expect(sessions.statusCode).toBe(200);
        expect(sessions.json<{ method: string }[]>()[0]).toMatchObject({
          method: 'setup',
        });
      });

      it('set the password: the administrator can sign in with it', async () => {
        const login = await install.post('/auth/login/password', {
          email: DEMO_ADMIN_EMAIL,
          password: DEMO_ADMIN_PASSWORD,
        });
        expect(login.statusCode).toBe(200);
      });

      it('has created the organisation, the Administrator role with every permission, and one owner', async () => {
        expect(await install.rows()).toMatchObject({
          organisations: 1,
          users: 1,
          roles: 1,
          members: 1,
          grants: PERMISSION_LISTS.reduce(
            (total, list) => total + list.length,
            0,
          ),
        });
        const [server] = await install.ctx.database.db
          .select()
          .from(installation);
        expect(server!.setupCompletedAt).toBeInstanceOf(Date);
      });

      it('writes the audit events of the setup and of the session, with no code, password or token', async () => {
        const events = await install.ctx.database.db.select().from(auditEvent);
        const categories = new Set(events.map((event) => event.category));
        for (const category of [
          AUTH_AUDIT.setupCodeUsed,
          AUTH_AUDIT.userCreated,
          AUTH_AUDIT.passwordSet,
          AUTH_AUDIT.organisationCreated,
          AUTH_AUDIT.roleCreated,
          AUTH_AUDIT.membershipCreated,
          AUTH_AUDIT.setupCompleted,
          AUTH_AUDIT.sessionCreated,
        ]) {
          expect(categories, category).toContain(category);
        }
        const created = events.find(
          (event) =>
            event.category === AUTH_AUDIT.sessionCreated &&
            (event.details as { method?: string } | null)?.method === 'setup',
        );
        expect(created).toBeDefined();
        const text = JSON.stringify(events);
        for (const secret of [install.code, DEMO_ADMIN_PASSWORD, token]) {
          expect(text).not.toContain(secret);
        }
      });

      it('opens the API at once, with no restart: /meta no longer says setup is required, and a route that needs a session is a 401, not a 503', async () => {
        const meta = await install.call('GET', '/meta');
        expect(meta.json<{ setupRequired: boolean }>().setupRequired).toBe(
          false,
        );
        expect((await install.call('GET', '/auth/me')).statusCode).toBe(401);
      });

      it('closes both setup routes: a second setup, even with the same code, is a 404, as a path that is no route is', async () => {
        const again = await install.post(
          '/setup',
          demoSetupInput(install.code, {
            email: 'second.person@demopictures.example',
          }),
        );
        expect(again.statusCode).toBe(404);
        const check = await install.post('/setup/check', {
          code: install.code,
        });
        expect(check.statusCode).toBe(404);
        const nowhere = await install.call('POST', '/nowhere');
        expect(nowhere.statusCode).toBe(404);
        expect(sameness(again.json())).toBe(sameness(nowhere.json()));
        expect(sameness(check.json())).toBe(sameness(nowhere.json()));
        expect(again.json()).toMatchObject({ code: 'route-not-found' });
        expect((await install.rows()).organisations).toBe(1);
      });
    });

    describe('POST /setup without a password', () => {
      let install: Install;
      let response: Awaited<ReturnType<Install['post']>>;
      let token: string;

      beforeAll(async () => {
        install = await freshInstall();
        response = await install.post(
          '/setup',
          demoSetupInput(install.code, { password: null }),
          { origin: TEST_PUBLIC_ORIGIN },
        );
        token = install.tokenIn(response)!;
      });
      afterAll(async () => {
        await install.close();
      });

      it('answers 201 and says the account must be secured', () => {
        expect(response.statusCode).toBe(201);
        expect(response.json()).toMatchObject({ mustSecureAccount: true });
      });

      it('opens a session of method setup with the recovery scope', async () => {
        const [made] = await install.ctx.database.db.select().from(session);
        expect(made).toMatchObject({ method: 'setup', scope: 'recovery' });
      });

      it('lets that session read who it is, sign out and see its passkeys, and nothing else until a password or a passkey is added', async () => {
        const headers = install.withCookie(token, {
          origin: TEST_PUBLIC_ORIGIN,
        });
        expect(
          (await install.call('GET', '/auth/me', { headers })).statusCode,
        ).toBe(200);
        // The list of passkeys is open to a recovery session, so a person can see
        // which are theirs and remove a lost one; there are none yet.
        const passkeys = await install.call('GET', '/auth/passkeys', {
          headers,
        });
        expect(passkeys.statusCode).toBe(200);
        expect(passkeys.json()).toEqual([]);
        const closed = await install.call('GET', '/auth/sessions', { headers });
        expect(closed.statusCode).toBe(403);
        expect(closed.json()).toMatchObject({
          code: 'account-recovery-required',
        });
      });

      it('lets that session add a passkey (the registration routes are open to it)', async () => {
        const started = await install.call(
          'POST',
          '/auth/passkeys/register/options',
          {
            headers: install.withCookie(token, { origin: TEST_PUBLIC_ORIGIN }),
          },
        );
        expect(started.statusCode).toBe(200);
      });

      it('becomes a full session once a password is set, and the administrator can then sign in with it', async () => {
        const headers = install.withCookie(token, {
          origin: TEST_PUBLIC_ORIGIN,
        });
        const set = await install.call('PUT', '/auth/password', {
          headers,
          payload: { newPassword: DEMO_ADMIN_PASSWORD },
        });
        expect(set.statusCode).toBe(204);
        const [made] = await install.ctx.database.db.select().from(session);
        expect(made).toMatchObject({ scope: 'full' });
        expect(
          (await install.call('GET', '/auth/sessions', { headers })).statusCode,
        ).toBe(200);
        expect(
          (
            await install.post('/auth/login/password', {
              email: DEMO_ADMIN_EMAIL,
              password: DEMO_ADMIN_PASSWORD,
            })
          ).statusCode,
        ).toBe(200);
      });
    });

    describe('POST /setup refused', () => {
      let install: Install;
      beforeAll(async () => {
        install = await freshInstall();
      });
      afterAll(async () => {
        await install.close();
      });

      /** The code is still the live one, and nothing was made. */
      async function expectNothingMade() {
        expect(await install.rows()).toEqual(NOTHING);
        expect(
          (await install.post('/setup/check', { code: install.code }))
            .statusCode,
        ).toBe(204);
      }

      it.each([
        ['too-short', 'short'],
        ['too-common', 'correcthorsebatterystaple'],
        ['too-predictable', 'abcdefghijklmnop'],
        ['contains-email', 'riverside-demopictures-fan-club'],
        ['contains-product-name', 'we love osfpm so very much'],
      ])(
        'a password that is %s is a 422 with the reason, as on the account routes, and leaves nothing behind',
        async (reason, password) => {
          const response = await install.post(
            '/setup',
            demoSetupInput(install.code, { password }),
            { origin: TEST_PUBLIC_ORIGIN },
          );
          expect(response.statusCode).toBe(422);
          expect(response.headers['content-type']).toMatch(
            /^application\/problem\+json/,
          );
          expect(response.json()).toMatchObject({
            type: '/problems/password-refused',
            code: 'password-refused',
            status: 422,
            detail: describePasswordRefusal(reason as 'too-short'),
            errors: [{ in: 'body', path: 'admin.password', code: reason }],
          });
          expect(setCookies(response.headers)).toEqual([]);
          // Nothing that was typed comes back (a short word may be in the reason's text).
          if (password.length >= 15)
            expect(response.body).not.toContain(password);
          expect(response.body).not.toContain(DEMO_ADMIN_EMAIL);
          await expectNothingMade();
        },
      );

      it.each([
        ['organisation.country', { country: 'gb' }],
        ['organisation.country', { country: 'GBR' }],
        ['organisation.country', { country: 'G' }],
        ['organisation.baseCurrency', { baseCurrency: 'gbp' }],
        ['organisation.baseCurrency', { baseCurrency: 'GB' }],
        ['organisation.baseCurrency', { baseCurrency: 'POUNDS' }],
        ['organisation.name', { name: '   ' }],
        ['organisation.locale', { locale: 'en_GB' }],
        ['organisation.timeZone', { timeZone: 'Mars/Olympus' }],
      ])(
        'a bad %s (%j) is a 400 that names the field and not the value',
        async (path, change) => {
          const input = demoSetupInput(install.code);
          const response = await install.post(
            '/setup',
            { ...input, organisation: { ...input.organisation, ...change } },
            { origin: TEST_PUBLIC_ORIGIN },
          );
          expect(response.statusCode).toBe(400);
          expect(response.json()).toMatchObject({
            code: 'validation-failed',
            errors: [{ in: 'body', path }],
          });
          for (const value of Object.values(change)) {
            if (value.trim() !== '') expect(response.body).not.toContain(value);
          }
          await expectNothingMade();
        },
      );

      it.each([
        ['admin.email', { email: 'not an address' }],
        ['admin.displayName', { displayName: '' }],
        ['admin.password', { password: '' }],
      ])('a bad %s (%j) is a 400 too', async (path, change) => {
        const input = demoSetupInput(install.code);
        const response = await install.post(
          '/setup',
          { ...input, admin: { ...input.admin, ...change } },
          { origin: TEST_PUBLIC_ORIGIN },
        );
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({
          code: 'validation-failed',
          errors: [{ in: 'body', path }],
        });
        await expectNothingMade();
      });

      it('a body without a part of it, or with no body at all, is a 400', async () => {
        for (const payload of [{}, { code: install.code }, undefined]) {
          const response = await install.call('POST', '/setup', {
            headers: { origin: TEST_PUBLIC_ORIGIN },
            ...(payload === undefined ? {} : { payload }),
          });
          expect(response.statusCode).toBe(400);
        }
        await expectNothingMade();
      });

      it('a foreign Origin, or none, is a 403, and nothing is made or spent', async () => {
        const foreign = await install.post(
          '/setup',
          demoSetupInput(install.code),
          { origin: FOREIGN_ORIGIN },
        );
        const none = await install.call('POST', '/setup', {
          payload: demoSetupInput(install.code),
          origin: null,
        });
        for (const response of [foreign, none]) {
          expect(response.statusCode).toBe(403);
          expect(response.json()).toMatchObject({ code: 'origin-mismatch' });
          expect(setCookies(response.headers)).toEqual([]);
        }
        await expectNothingMade();
      });

      it('a code that does not work is the one 401, whatever is wrong, and is audited as a setup', async () => {
        const answers = new Set<string>();
        const live = install.code;
        for (const typed of ['AAAA-AAAA-AAAA-AAAA', 'nonsense']) {
          const response = await install.post('/setup', demoSetupInput(typed), {
            origin: TEST_PUBLIC_ORIGIN,
          });
          expect(response.statusCode).toBe(401);
          expect(response.json()).toMatchObject({
            code: 'setup-code-invalid',
            instance: `${API_PREFIX}/setup`,
          });
          expect(setCookies(response.headers)).toEqual([]);
          answers.add(sameness(response.json()));
        }
        // Expired.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.now() + 25 * HOUR);
        const expired = await install.post('/setup', demoSetupInput(live), {
          origin: TEST_PUBLIC_ORIGIN,
        });
        vi.useRealTimers();
        expect(expired.statusCode).toBe(401);
        answers.add(sameness(expired.json()));
        // The answer of the check route, for the same cause, is the same body.
        const check = await install.post('/setup/check', {
          code: 'AAAA-AAAA-AAAA-AAAA',
        });
        answers.add(sameness(check.json()));
        expect(answers.size).toBe(1);

        const audited = (
          await install.ctx.database.db.select().from(auditEvent)
        ).filter(
          (event) =>
            event.category === AUTH_AUDIT.setupCheckFailed &&
            (event.details as { purpose: string }).purpose === 'setup',
        );
        expect(audited).toHaveLength(3);
        expect(JSON.stringify(audited)).not.toContain('nonsense');
        await expectNothingMade();
      });

      it('a code a newer one replaced, and a code that was used, are the same 401', async () => {
        const replaced = install.code;
        const newer = await issueSetupCode(install.ctx.database.db, new Date());
        const first = await install.post('/setup', demoSetupInput(replaced), {
          origin: TEST_PUBLIC_ORIGIN,
        });
        expect(first.statusCode).toBe(401);
        expect(
          await consumeSetupCode(install.ctx.database.db, newer, new Date()),
        ).toBe(true);
        const second = await install.post('/setup', demoSetupInput(newer), {
          origin: TEST_PUBLIC_ORIGIN,
        });
        expect(second.statusCode).toBe(401);
        expect(sameness(first.json())).toBe(sameness(second.json()));
        expect(await install.rows()).toEqual(NOTHING);
        // Give the next tests a live code again.
        install = {
          ...install,
          code: await issueSetupCode(install.ctx.database.db, new Date()),
        };
      });
    });

    describe('when a step of the setup fails', () => {
      let install: Install;
      beforeAll(async () => {
        install = await freshInstall();
      });
      afterAll(async () => {
        await install.close();
      });

      /** Makes every insert into `table` fail, until the returned function is called. Plain SQL, as this package has no drizzle. */
      async function refuseInserts(table: string) {
        const { db } = install.ctx.database;
        await db.execute(
          `create function osfpm_test_refuse() returns trigger
         language plpgsql as $$
         begin
           raise exception 'refused' using errcode = 'P0001';
         end $$`,
        );
        await db.execute(
          `create trigger osfpm_test_refuse before insert on ${table}
         for each row execute function osfpm_test_refuse()`,
        );
        return async () => {
          await db.execute(`drop trigger osfpm_test_refuse on ${table}`);
          await db.execute('drop function osfpm_test_refuse()');
        };
      }

      it.each([
        ['the membership, after the organisation exists', 'org_membership'],
        ['the session, which is the last step', 'session'],
      ])(
        'failing to write %s answers a generic 500 and leaves nothing: no organisation, no user, no session, and the code still works',
        async (_what, table) => {
          const restore = await refuseInserts(table);
          let response: Awaited<ReturnType<Install['post']>>;
          try {
            response = await install.post(
              '/setup',
              demoSetupInput(install.code),
              {
                origin: TEST_PUBLIC_ORIGIN,
              },
            );
          } finally {
            await restore();
          }
          expect(response.statusCode).toBe(500);
          expect(response.json()).toMatchObject({ code: 'internal-error' });
          // The answer says nothing of what failed or of what was sent.
          for (const text of [
            DEMO_ADMIN_EMAIL,
            DEMO_ADMIN_PASSWORD,
            install.code,
            'P0001',
            table,
          ]) {
            expect(response.body).not.toContain(text);
          }
          expect(setCookies(response.headers)).toEqual([]);
          expect(await install.rows()).toEqual(NOTHING);
          expect(
            (await install.post('/setup/check', { code: install.code }))
              .statusCode,
          ).toBe(204);
          // The app was not told setup is complete: the gate is still closed.
          expect((await install.call('GET', '/auth/me')).statusCode).toBe(503);
        },
      );

      it('then completes with the same code once the fault is gone', async () => {
        const response = await install.post(
          '/setup',
          demoSetupInput(install.code),
          {
            origin: TEST_PUBLIC_ORIGIN,
          },
        );
        expect(response.statusCode).toBe(201);
        expect(await install.rows()).toMatchObject({
          organisations: 1,
          users: 1,
          sessions: 1,
        });
      });
    });
  },
);
