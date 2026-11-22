import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normaliseHumanCode } from '@osfpm/core/src/auth/tokens.js';
import {
  DEMO_ADMIN_EMAIL,
  DEMO_ADMIN_PASSWORD,
  demoSetupInput,
  everyRowAsText,
  seedFirstRun,
} from '@osfpm/core/src/auth/test-support.js';
import { migrate } from '@osfpm/core/src/db/migrate.js';
import { auditEvent, changeEvent } from '@osfpm/core/src/db/schema/index.js';
import {
  testTargets,
  type TestTarget,
} from '@osfpm/core/src/db/test-support.js';
import { API_PREFIX } from '../api-version.js';
import { SESSION_COOKIE } from '../auth/cookie.js';
import { createTestApp, TEST_PUBLIC_ORIGIN } from '../test-support.js';

// Invented values; none is a real credential.
const REFUSED_PASSWORD = 'abcdefghijklmnop';
const TYPED_BAD_CODE = 'ZZZZ-YYYY-XXXX-WWWW';

/**
 * What first-run setup keeps secret (CLAUDE.md, Privacy rule; SC-10): the setup
 * code, the password and the session token. Each must stay out of the JSON log
 * at every level, out of every audit event and change event, and out of every
 * error body; the password and the code are in no response body at all, and the
 * token is only in the cookie. The one place the code is ever shown is the
 * server's standard error at start-up, which `first-run-startup.test.ts` covers.
 */
describe.each(testTargets)(
  'what first-run setup keeps secret on $name',
  (target: TestTarget) => {
    let ctx: Awaited<ReturnType<typeof createTestApp>>;
    let code: string;
    let token: string;
    const bodies: string[] = [];
    const errorBodies: string[] = [];

    beforeAll(async () => {
      // Every level, so a line written at any of them is in `ctx.lines`.
      ctx = await createTestApp(target, {
        setupComplete: false,
        logLevel: 'trace',
      });
      await migrate(ctx.database);
      code = await seedFirstRun(ctx.database);

      let address = 0;
      const post = async (path: string, payload: unknown) => {
        const response = await ctx.app.inject({
          method: 'POST',
          url: `${API_PREFIX}${path}`,
          headers: { origin: TEST_PUBLIC_ORIGIN },
          remoteAddress: `10.6.0.${(address += 1)}`,
          payload: payload as Record<string, unknown>,
        });
        bodies.push(response.body);
        if (response.statusCode >= 400) errorBodies.push(response.body);
        return response;
      };

      // A code that does not work, checked and used.
      await post('/setup/check', { code: TYPED_BAD_CODE });
      await post('/setup', demoSetupInput(TYPED_BAD_CODE));
      // A password the policy refuses, with the live code.
      await post(
        '/setup',
        demoSetupInput(code, { password: REFUSED_PASSWORD }),
      );
      // The setup itself, with a password.
      const done = await post('/setup', demoSetupInput(code));
      expect(done.statusCode).toBe(201);
      const cookie = String(done.headers['set-cookie']);
      token = cookie.slice(SESSION_COOKIE.length + 1).split(';', 1)[0]!;
      // The session is used, and the closed routes are asked again with the code.
      const me = await ctx.app.inject({
        method: 'GET',
        url: `${API_PREFIX}/auth/me`,
        headers: { cookie: `${SESSION_COOKIE}=${token}` },
        remoteAddress: '10.6.1.1',
      });
      bodies.push(me.body);
      await post('/setup', demoSetupInput(code));
      await post('/setup/check', { code });
    });
    afterAll(async () => {
      await ctx.close();
    });

    const db = () => ctx.database.db;

    /** Every secret, in every spelling a log or an event might hold it in. */
    const secrets = () => [
      ['the setup code', code],
      ['the setup code, normalised', normaliseHumanCode(code)!],
      ['the setup code, without hyphens', code.replaceAll('-', '')],
      ['a code typed wrongly', TYPED_BAD_CODE],
      ['the password', DEMO_ADMIN_PASSWORD],
      ['a refused password', REFUSED_PASSWORD],
      ['the session token', token],
    ];

    it('has really run the flows it checks', () => {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(errorBodies.length).toBeGreaterThanOrEqual(4);
      // The log was read at all: a log that said nothing would pass for nothing.
      expect(ctx.lines.length).toBeGreaterThan(8);
    });

    it('keeps the code, the passwords and the token out of the log, at every level', () => {
      const log = ctx.lines.join('\n');
      for (const [label, value] of secrets()) {
        expect(log, label).not.toContain(value);
      }
      // Nor the address, which is the user's own and kept on the user.
      expect(log).not.toContain(DEMO_ADMIN_EMAIL);
    });

    it('keeps them out of every audit event and every change event', async () => {
      const trail = JSON.stringify(await db().select().from(auditEvent));
      const changes = JSON.stringify(await db().select().from(changeEvent));
      for (const [label, value] of secrets()) {
        expect(trail, label).not.toContain(value);
        expect(changes, label).not.toContain(value);
      }
      expect(trail).not.toContain(DEMO_ADMIN_EMAIL);
      expect(changes).not.toContain(DEMO_ADMIN_EMAIL);
    });

    it('keeps them out of every error body', () => {
      const text = errorBodies.join('\n');
      for (const [label, value] of secrets()) {
        expect(text, label).not.toContain(value);
      }
      expect(text).not.toContain(DEMO_ADMIN_EMAIL);
    });

    it('returns no code and no password in any response, and the token only in the cookie', () => {
      const text = bodies.join('\n');
      for (const [label, value] of secrets()) {
        expect(text, label).not.toContain(value);
      }
    });

    it('stores none of them in any table, only their hashes', async () => {
      const everything = await everyRowAsText(ctx.database);
      for (const [label, value] of secrets()) {
        expect(everything, label).not.toContain(value);
      }
    });
  },
);
