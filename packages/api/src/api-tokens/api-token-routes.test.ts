import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setApiTokenSwitches } from '@osfpm/core/src/auth/api-tokens.js';
import { createSession } from '@osfpm/core/src/auth/sessions.js';
import {
  everyRowAsText,
  seedTokenScene,
  setMemberRolesEnded,
  type TokenScene,
} from '@osfpm/core/src/auth/test-support.js';
import { migrate } from '@osfpm/core/src/db/migrate.js';
import {
  apiToken,
  auditEvent,
  changeEvent,
} from '@osfpm/core/src/db/schema/index.js';
import {
  testTargets,
  type TestTarget,
} from '@osfpm/core/src/db/test-support.js';
import { API_PREFIX } from '../api-version.js';
import { SESSION_COOKIE } from '../auth/cookie.js';
import { SESSION_RATE_LIMIT } from '../auth/rate-limit.js';
import { createTestApp, TEST_PUBLIC_ORIGIN } from '../test-support.js';

/**
 * The routes that switch personal API tokens on and off, and make, list and revoke them
 * (SC-10, decisions D-17 and D-68). Every one is session-only: a token never manages
 * tokens or their switches.
 */

const DAY = 24 * 60 * 60 * 1000;
const FOREIGN_ORIGIN = 'https://attacker.example.test';
const TOKEN_SHAPE = /^osfpm_pat_[A-Za-z0-9_-]{43}$/;

type Method = 'GET' | 'PUT' | 'POST' | 'DELETE';

/** An error body with the parts that differ between two requests taken out. */
function sameness(body: unknown) {
  return JSON.stringify({
    ...(body as Record<string, unknown>),
    requestId: undefined,
    instance: undefined,
  });
}

describe.each(testTargets)(
  'the personal API token routes on $name',
  (target: TestTarget) => {
    let ctx: Awaited<ReturnType<typeof createTestApp>>;
    let scene: TokenScene;
    let owner: string;
    let tokensUser: string;
    let manager: string;
    let medical: string;
    let plain: string;
    let stranger: string;
    let addresses = 0;
    /** Every token a flow below made, which must stay out of logs, events, tables and error bodies. */
    const tokens: string[] = [];
    const errorBodies: string[] = [];

    beforeAll(async () => {
      ctx = await createTestApp(target, { logLevel: 'trace' });
      await migrate(ctx.database);
      scene = await seedTokenScene(ctx.database, new Date());
      owner = await sessionOf(scene.ownerId);
      tokensUser = await sessionOf(scene.tokensId);
      manager = await sessionOf(scene.managerId);
      medical = await sessionOf(scene.medicalId);
      plain = await sessionOf(scene.plainId);
      stranger = await sessionOf(scene.strangerId);
    });
    afterAll(async () => {
      await ctx.close();
    });

    const db = () => ctx.database.db;
    const freshAddress = () =>
      `10.31.${Math.floor(addresses / 250)}.${(addresses++ % 250) + 1}`;
    const org = () => scene.organisationId;

    /** A session of `userId`, as the login routes would have made it; answers its token. */
    async function sessionOf(
      userId: string,
      method: 'password' | 'recovery' = 'password',
    ) {
      const created = await createSession(db(), {
        userId,
        method,
        now: new Date(),
      });
      return created.token;
    }

    /** One request. A request that changes data comes from the site itself unless `origin` says otherwise (`null` sends none). */
    async function send(
      method: Method,
      path: string,
      options: {
        session?: string;
        bearer?: string;
        origin?: string | null;
        payload?: unknown;
        remoteAddress?: string;
      } = {},
    ) {
      const headers: Record<string, string> = {};
      if (options.session !== undefined) {
        headers.cookie = `${SESSION_COOKIE}=${options.session}`;
      }
      if (options.bearer !== undefined) {
        headers.authorization = `Bearer ${options.bearer}`;
      }
      const origin =
        options.origin === undefined ? TEST_PUBLIC_ORIGIN : options.origin;
      if (origin !== null && method !== 'GET') headers.origin = origin;
      const response = await ctx.app.inject({
        method,
        url: `${API_PREFIX}${path}`,
        headers,
        remoteAddress: options.remoteAddress ?? freshAddress(),
        ...(options.payload === undefined
          ? {}
          : { payload: options.payload as Record<string, unknown> }),
      });
      if (response.statusCode >= 400) errorBodies.push(response.body);
      return response;
    }

    const settings = `/organisations/${'ORG'}/api-settings`;
    const settingsPath = (id: string = org()) => settings.replace('ORG', id);
    const tokensPath = (id: string = org()) =>
      `/organisations/${id}/api-tokens`;
    const getSettings = (session?: string) =>
      send('GET', settingsPath(), session === undefined ? {} : { session });
    const putSettings = (
      session: string,
      payload: unknown,
      options: { origin?: string | null } = {},
    ) =>
      send('PUT', settingsPath(), {
        session,
        payload,
        ...(options.origin === undefined ? {} : { origin: options.origin }),
      });
    const createToken = (
      session: string,
      payload: Record<string, unknown> = {},
      options: { origin?: string | null; org?: string } = {},
    ) =>
      send('POST', tokensPath(options.org), {
        session,
        payload: { name: 'Call sheet export', access: 'read', ...payload },
        ...(options.origin === undefined ? {} : { origin: options.origin }),
      });
    const switchesNow = (personalTokens: boolean, sensitive: boolean) =>
      db().transaction((tx) =>
        setApiTokenSwitches(
          tx,
          { userId: scene.ownerId },
          scene.organisationId,
          { personalTokens, sensitive },
          new Date(),
        ),
      );
    /** A token made through the route, which is how a person gets one. */
    async function made(
      session: string,
      payload: Record<string, unknown> = {},
    ) {
      const response = await createToken(session, payload);
      expect(response.statusCode).toBe(201);
      const body = response.json<{
        token: string;
        apiToken: { id: string; prefix: string };
      }>();
      tokens.push(body.token);
      return body;
    }

    describe('the settings', () => {
      it('are off for an organisation that has never set them, for the people who may see them', async () => {
        for (const session of [manager, owner]) {
          const response = await getSettings(session);
          expect(response.statusCode).toBe(200);
          expect(response.json()).toEqual({
            personalTokens: false,
            sensitive: false,
          });
        }
      });

      it('are for api:manage only, and the same 403 for a member without it, a stranger and an organisation that does not exist', async () => {
        const bodies = new Set<string>();
        for (const [session, id] of [
          [tokensUser, org()],
          [plain, org()],
          [stranger, org()],
          [manager, scene.otherOrganisationId],
          [owner, '00000000-0000-7000-8000-000000000000'],
        ] as const) {
          const read = await send('GET', settingsPath(id), { session });
          expect(read.statusCode).toBe(403);
          expect(read.json<{ code: string }>().code).toBe('access-denied');
          bodies.add(sameness(read.json()));
          const write = await send('PUT', settingsPath(id), {
            session,
            payload: { personalTokens: true, sensitive: false },
          });
          expect(write.statusCode).toBe(403);
          bodies.add(sameness(write.json()));
        }
        expect(bodies.size).toBe(1);
        // Nothing was switched on.
        expect((await getSettings(manager)).json()).toEqual({
          personalTokens: false,
          sensitive: false,
        });
      });

      it('need a session: 401 without one, and 403 for a recovery session, whatever the method', async () => {
        const recovery = await sessionOf(scene.managerId, 'recovery');
        for (const method of ['GET', 'PUT'] as const) {
          const none = await send(method, settingsPath(), {
            payload: { personalTokens: true, sensitive: false },
          });
          expect(none.statusCode).toBe(401);
          const limited = await send(method, settingsPath(), {
            session: recovery,
            payload: { personalTokens: true, sensitive: false },
          });
          expect(limited.statusCode).toBe(403);
          expect(limited.json<{ code: string }>().code).toBe(
            'account-recovery-required',
          );
        }
      });

      it('are changed only by a request from the site itself: a foreign or missing Origin is a 403', async () => {
        for (const origin of [FOREIGN_ORIGIN, null]) {
          const response = await putSettings(
            manager,
            { personalTokens: true, sensitive: false },
            { origin },
          );
          expect(response.statusCode).toBe(403);
          expect(response.json<{ code: string }>().code).toBe(
            'origin-mismatch',
          );
        }
        expect((await getSettings(manager)).json()).toEqual({
          personalTokens: false,
          sensitive: false,
        });
      });

      it('refuse a body that is not shaped right, and the sensitive switch on with tokens off', async () => {
        for (const payload of [
          {},
          { personalTokens: true },
          { personalTokens: 'yes', sensitive: false },
          { personalTokens: true, sensitive: 1 },
          { personalTokens: false, sensitive: true },
          null,
        ]) {
          const response = await putSettings(manager, payload);
          expect(response.statusCode, JSON.stringify(payload)).toBe(400);
          expect(response.json<{ code: string }>().code).toBe(
            'validation-failed',
          );
        }
        const contradiction = await putSettings(manager, {
          personalTokens: false,
          sensitive: true,
        });
        expect(
          contradiction.json<{ errors: { path: string }[] }>().errors[0]!.path,
        ).toBe('sensitive');
      });

      it('are turned on and off by api:manage, and the answer says how many tokens it ended', async () => {
        const on = await putSettings(manager, {
          personalTokens: true,
          sensitive: true,
        });
        expect(on.statusCode).toBe(200);
        expect(on.json()).toEqual({
          personalTokens: true,
          sensitive: true,
          revoked: 0,
        });
        expect((await getSettings(manager)).json()).toEqual({
          personalTokens: true,
          sensitive: true,
        });
        // Two tokens, one with a sensitive scope.
        const plainToken = await made(owner, { name: 'Plain' });
        const scoped = await made(owner, {
          name: 'Scoped',
          sensitivePermissions: ['sensitive:read:medical'],
        });
        const sensitiveOff = await putSettings(manager, {
          personalTokens: true,
          sensitive: false,
        });
        expect(sensitiveOff.json()).toEqual({
          personalTokens: true,
          sensitive: false,
          revoked: 1,
        });
        // The scoped one ended; the plain one still works.
        expect(
          (
            await send('GET', `/organisations/${org()}/members`, {
              bearer: scoped.token,
            })
          ).statusCode,
        ).toBe(401);
        expect(
          (
            await send('GET', `/organisations/${org()}/members`, {
              bearer: plainToken.token,
            })
          ).statusCode,
        ).toBe(200);
        const off = await putSettings(manager, {
          personalTokens: false,
          sensitive: false,
        });
        expect(off.json()).toEqual({
          personalTokens: false,
          sensitive: false,
          revoked: 1,
        });
        expect(
          (
            await send('GET', `/organisations/${org()}/members`, {
              bearer: plainToken.token,
            })
          ).statusCode,
        ).toBe(401);
        // Turned back on, nothing is restored.
        await putSettings(manager, { personalTokens: true, sensitive: false });
        expect(
          (
            await send('GET', `/organisations/${org()}/members`, {
              bearer: plainToken.token,
            })
          ).statusCode,
        ).toBe(401);
      });

      it('leave an audit event and a change event for each switch, with no token in them', async () => {
        await putSettings(manager, { personalTokens: false, sensitive: false });
        await putSettings(manager, { personalTokens: true, sensitive: true });
        const audits = (await db().select().from(auditEvent)).filter(
          (event) => event.category === 'auth.api-token-switch-changed',
        );
        expect(audits.length).toBeGreaterThanOrEqual(4);
        for (const event of audits) {
          expect(event.organisationId).toBe(scene.organisationId);
          expect(event.actorId).toBe(scene.managerId);
        }
        const settingChanges = (await db().select().from(changeEvent)).filter(
          (event) => event.entityType === 'setting_value',
        );
        expect(settingChanges.length).toBeGreaterThanOrEqual(2);
        expect(
          settingChanges.every(
            (event) => event.organisationId === scene.organisationId,
          ),
        ).toBe(true);
      });
    });

    describe('making a token', () => {
      it('is for api:tokens only, and the same 403 for a manager, a stranger and an organisation that does not exist', async () => {
        await switchesNow(true, true);
        const bodies = new Set<string>();
        for (const [session, id] of [
          [manager, org()],
          [plain, org()],
          [stranger, org()],
          [tokensUser, scene.otherOrganisationId],
          [tokensUser, '00000000-0000-7000-8000-000000000000'],
        ] as const) {
          const response = await createToken(session, {}, { org: id });
          expect(response.statusCode).toBe(403);
          expect(response.json<{ code: string }>().code).toBe('access-denied');
          bodies.add(sameness(response.json()));
        }
        expect(bodies.size).toBe(1);
      });

      it('needs a session and the right Origin, and refuses a recovery session', async () => {
        await switchesNow(true, true);
        expect(
          (
            await send('POST', tokensPath(), {
              payload: { name: 'x', access: 'read' },
            })
          ).statusCode,
        ).toBe(401);
        for (const origin of [FOREIGN_ORIGIN, null]) {
          const response = await createToken(tokensUser, {}, { origin });
          expect(response.statusCode).toBe(403);
          expect(response.json<{ code: string }>().code).toBe(
            'origin-mismatch',
          );
        }
        const recovery = await sessionOf(scene.tokensId, 'recovery');
        const limited = await createToken(recovery);
        expect(limited.statusCode).toBe(403);
        expect(limited.json<{ code: string }>().code).toBe(
          'account-recovery-required',
        );
      });

      it('is a 422 api-tokens-disabled while the organisation has not allowed them', async () => {
        await switchesNow(false, false);
        const response = await createToken(tokensUser);
        expect(response.statusCode).toBe(422);
        expect(response.json<{ code: string }>().code).toBe(
          'api-tokens-disabled',
        );
      });

      it('makes one and shows it once: 201, uncached, the token and its metadata, no hash', async () => {
        await switchesNow(true, false);
        const response = await createToken(tokensUser, {
          name: '  Call sheet export ',
          access: 'write',
        });
        expect(response.statusCode).toBe(201);
        expect(response.headers['cache-control']).toBe('no-store');
        const body = response.json<{
          token: string;
          apiToken: Record<string, unknown>;
        }>();
        tokens.push(body.token);
        expect(body.token).toMatch(TOKEN_SHAPE);
        expect(Object.keys(body).sort()).toEqual(['apiToken', 'token']);
        expect(body.apiToken).toMatchObject({
          organisationId: scene.organisationId,
          userId: scene.tokensId,
          projectId: null,
          name: 'Call sheet export',
          prefix: body.token.slice(0, 18),
          access: 'write',
          sensitivePermissions: [],
          neverExpires: false,
          lastUsedAt: null,
        });
        const days =
          (Date.parse(String(body.apiToken.expiresAt)) -
            Date.parse(String(body.apiToken.createdAt))) /
          DAY;
        expect(days).toBeCloseTo(365, 3);
        expect(JSON.stringify(body.apiToken)).not.toMatch(/hash/i);
        // The token is not in any list, and the list says what it is.
        const listed = await send('GET', tokensPath(), { session: tokensUser });
        expect(listed.statusCode).toBe(200);
        expect(listed.body).not.toContain(body.token);
        expect(listed.json<{ id: string }[]>().map((row) => row.id)).toContain(
          (body.apiToken as { id: string }).id,
        );
      });

      it('refuses a body that is not shaped right, with the fields and never the values', async () => {
        await switchesNow(true, true);
        const before = (await db().select().from(apiToken)).length;
        for (const [payload, field] of [
          [{ access: 'read' }, 'name'],
          [{ name: '', access: 'read' }, 'name'],
          [{ name: 'x'.repeat(101), access: 'read' }, 'name'],
          [{ name: 'x', access: 'admin' }, 'access'],
          [{ name: 'x', access: 'read', expiresInDays: 0 }, 'expiresInDays'],
          [{ name: 'x', access: 'read', expiresInDays: 3651 }, 'expiresInDays'],
          [{ name: 'x', access: 'read', expiresInDays: 1.5 }, 'expiresInDays'],
          [{ name: 'x', access: 'read', projectId: 'not-an-id' }, 'projectId'],
          [
            {
              name: 'x',
              access: 'read',
              sensitivePermissions: 'sensitive:read:medical',
            },
            'sensitivePermissions',
          ],
          [
            { name: 'x', access: 'read', noExpiry: true, expiresInDays: 30 },
            'noExpiry',
          ],
        ] as const) {
          const response = await send('POST', tokensPath(), {
            session: tokensUser,
            payload,
          });
          expect(response.statusCode, JSON.stringify(payload)).toBe(400);
          const body = response.json<{
            code: string;
            errors: { path: string }[];
          }>();
          expect(body.code).toBe('validation-failed');
          expect(body.errors.map((e) => e.path)).toContain(field);
        }
        expect((await db().select().from(apiToken)).length).toBe(before);
      });

      it('takes the bounds of the expiry, and a token that never expires', async () => {
        await switchesNow(true, false);
        for (const expiresInDays of [1, 3650]) {
          const response = await createToken(tokensUser, { expiresInDays });
          expect(response.statusCode).toBe(201);
          const body = response.json<{ token: string }>();
          tokens.push(body.token);
        }
        const never = await createToken(tokensUser, { noExpiry: true });
        expect(never.statusCode).toBe(201);
        tokens.push(never.json<{ token: string }>().token);
        expect(
          never.json<{ apiToken: Record<string, unknown> }>().apiToken,
        ).toMatchObject({
          expiresAt: null,
          neverExpires: true,
        });
      });

      it('says a project that the person cannot reach, that is not the organisation’s or that does not exist is a 422 project-not-available, with one body', async () => {
        await switchesNow(true, false);
        const bodies = new Set<string>();
        for (const projectId of [
          // Another organisation’s.
          scene.foreignProjectId,
          // The organisation’s own, but the member holds no membership of it and no
          // grant for all of them.
          scene.projectId,
          // Not there at all.
          '00000000-0000-7000-8000-000000000000',
        ]) {
          const response = await createToken(tokensUser, { projectId });
          expect(response.statusCode, projectId).toBe(422);
          expect(response.json()).toMatchObject({
            code: 'project-not-available',
            errors: [
              {
                in: 'body',
                path: 'projectId',
                code: 'project-not-available',
              },
            ],
          });
          // Nothing in the answer names the project the caller asked about.
          expect(response.body).not.toContain(projectId);
          bodies.add(sameness(response.json()));
        }
        // The same answer whichever it was, so a caller learns nothing about projects
        // that are not theirs.
        expect(bodies.size).toBe(1);
        // A value that is not an id never reaches the service: a plain bad request.
        const malformed = await createToken(tokensUser, {
          projectId: 'not-an-id',
        });
        expect(malformed.statusCode).toBe(400);
        // The owner holds ordinary permissions for every project of the organisation.
        const own = await createToken(owner, { projectId: scene.projectId });
        expect(own.statusCode).toBe(201);
        tokens.push(own.json<{ token: string }>().token);
        expect(
          own.json<{ apiToken: { projectId: string } }>().apiToken.projectId,
        ).toBe(scene.projectId);
      });

      it('answers the sensitive scope with its own codes: switch off, not sensitive, more than you hold, and a read token asking for a permission that writes', async () => {
        await switchesNow(true, false);
        const off = await createToken(medical, {
          sensitivePermissions: ['sensitive:read:medical'],
        });
        expect(off.statusCode).toBe(422);
        expect(off.json<{ code: string }>().code).toBe(
          'api-sensitive-tokens-disabled',
        );
        await switchesNow(true, true);
        const notSensitive = await createToken(medical, {
          sensitivePermissions: ['sensitive:read:medical', 'members:read'],
        });
        expect(notSensitive.statusCode).toBe(422);
        expect(notSensitive.json()).toMatchObject({
          code: 'not-a-sensitive-permission',
          errors: [
            {
              in: 'body',
              path: 'sensitivePermissions.1',
              code: 'not-a-sensitive-permission',
            },
          ],
        });
        // Not the key the caller sent.
        expect(notSensitive.body).not.toContain('members:read');
        const exceeds = await createToken(tokensUser, {
          sensitivePermissions: ['sensitive:read:medical'],
        });
        expect(exceeds.statusCode).toBe(422);
        expect(exceeds.json()).toMatchObject({
          code: 'token-exceeds-own-access',
          errors: [
            {
              in: 'body',
              path: 'sensitivePermissions',
              code: 'sensitive:read:medical',
            },
          ],
        });
        const write = await createToken(medical, {
          access: 'read',
          sensitivePermissions: [
            'sensitive:read:medical',
            'sensitive:edit:medical',
          ],
        });
        expect(write.statusCode).toBe(422);
        expect(write.json()).toMatchObject({
          code: 'token-read-only-scope',
          errors: [
            {
              in: 'body',
              path: 'sensitivePermissions.1',
              code: 'token-read-only-scope',
            },
          ],
        });
        // The place in the list, not the key the caller sent.
        expect(write.body).not.toContain('sensitive:edit:medical');
        const ok = await createToken(medical, {
          access: 'write',
          sensitivePermissions: [
            'sensitive:read:medical',
            'sensitive:edit:medical',
          ],
        });
        expect(ok.statusCode).toBe(201);
        tokens.push(ok.json<{ token: string }>().token);
        expect(
          ok.json<{ apiToken: { sensitivePermissions: string[] } }>().apiToken
            .sensitivePermissions,
        ).toEqual(['sensitive:read:medical', 'sensitive:edit:medical']);
      });
    });

    describe('listing tokens', () => {
      it('shows a person their own, and api:manage everyone’s with the owner’s name, and nobody else the second', async () => {
        await switchesNow(true, true);
        const mine = await made(tokensUser, { name: 'Mine', noExpiry: true });
        const theirs = await made(medical, {
          name: 'Theirs',
          sensitivePermissions: ['sensitive:read:medical'],
        });
        const own = await send('GET', tokensPath(), { session: tokensUser });
        expect(own.statusCode).toBe(200);
        const ownRows =
          own.json<{ id: string; name: string; neverExpires: boolean }[]>();
        expect(ownRows.map((row) => row.id)).toContain(mine.apiToken.id);
        expect(ownRows.map((row) => row.id)).not.toContain(theirs.apiToken.id);
        expect(
          ownRows.find((row) => row.id === mine.apiToken.id),
        ).toMatchObject({
          neverExpires: true,
        });
        expect(JSON.stringify(ownRows)).not.toMatch(/ownerDisplayName/);

        const all = await send('GET', `${tokensPath()}?scope=all`, {
          session: manager,
        });
        expect(all.statusCode).toBe(200);
        const allRows = all.json<
          {
            id: string;
            userId: string;
            ownerDisplayName: string;
            sensitivePermissions: string[];
            expiresAt: string | null;
          }[]
        >();
        const row = allRows.find((r) => r.id === theirs.apiToken.id)!;
        expect(row).toMatchObject({
          userId: scene.medicalId,
          sensitivePermissions: ['sensitive:read:medical'],
        });
        expect(row.ownerDisplayName).toMatch(/Fixture User/);
        expect(row.expiresAt).not.toBeNull();
        expect(all.body).not.toMatch(/hash/i);
        for (const session of [tokensUser, plain, stranger]) {
          const refused = await send('GET', `${tokensPath()}?scope=all`, {
            session,
          });
          expect(refused.statusCode).toBe(403);
        }
        // `own` is the default and needs no permission: a person who may only manage, one
        // who holds nothing and a stranger list their own, which is none, and learn
        // nothing else. A value that is neither is a bad request.
        expect(
          (
            await send('GET', `${tokensPath()}?scope=own`, {
              session: tokensUser,
            })
          ).statusCode,
        ).toBe(200);
        for (const session of [manager, plain, stranger]) {
          const own = await send('GET', tokensPath(), { session });
          expect(own.statusCode).toBe(200);
          expect(own.json()).toEqual([]);
        }
        expect(
          (
            await send('GET', `${tokensPath()}?scope=everyone`, {
              session: manager,
            })
          ).statusCode,
        ).toBe(400);
        expect((await send('GET', tokensPath())).statusCode).toBe(401);
      });

      it('is a self-service route for your own: 401 without a session and 403 for a recovery session, with no permission to lack', async () => {
        const recovery = await sessionOf(scene.tokensId, 'recovery');
        for (const query of ['', '?scope=own', '?scope=all']) {
          const none = await send('GET', `${tokensPath()}${query}`);
          expect(none.statusCode, query).toBe(401);
          const limited = await send('GET', `${tokensPath()}${query}`, {
            session: recovery,
          });
          expect(limited.statusCode, query).toBe(403);
          expect(limited.json<{ code: string }>().code).toBe(
            'account-recovery-required',
          );
        }
      });
    });

    describe('revoking a token', () => {
      it('ends the person’s own at once: 204, then the token is refused and a second revoke is a 404', async () => {
        await switchesNow(true, false);
        const token = await made(tokensUser);
        expect(
          (
            await send('GET', `/organisations/${org()}/members`, {
              bearer: token.token,
            })
          ).statusCode,
        ).toBe(403);
        const revoked = await send(
          'DELETE',
          `${tokensPath()}/${token.apiToken.id}`,
          { session: tokensUser },
        );
        expect(revoked.statusCode).toBe(204);
        expect(revoked.body).toBe('');
        const refused = await send('GET', `/organisations/${org()}/members`, {
          bearer: token.token,
        });
        expect(refused.statusCode).toBe(401);
        expect(refused.json<{ code: string }>().code).toBe('invalid-token');
        const again = await send(
          'DELETE',
          `${tokensPath()}/${token.apiToken.id}`,
          { session: tokensUser },
        );
        expect(again.statusCode).toBe(404);
      });

      it('is a 404 for another person’s token to a member who may only make their own, and a 204 to api:manage', async () => {
        await switchesNow(true, false);
        const theirs = await made(medical);
        const refused = await send(
          'DELETE',
          `${tokensPath()}/${theirs.apiToken.id}`,
          { session: tokensUser },
        );
        expect(refused.statusCode).toBe(404);
        const unknown = await send(
          'DELETE',
          `${tokensPath()}/00000000-0000-7000-8000-000000000000`,
          { session: tokensUser },
        );
        expect(unknown.statusCode).toBe(404);
        expect(sameness(refused.json())).toBe(sameness(unknown.json()));
        for (const session of [plain, stranger]) {
          // Revoking your own needs no permission, so a person with none is no
          // different from one who holds api:tokens: the token is not theirs.
          const denied = await send(
            'DELETE',
            `${tokensPath()}/${theirs.apiToken.id}`,
            { session },
          );
          expect(denied.statusCode).toBe(404);
          expect(sameness(denied.json())).toBe(sameness(unknown.json()));
        }
        const ended = await send(
          'DELETE',
          `${tokensPath()}/${theirs.apiToken.id}`,
          { session: manager },
        );
        expect(ended.statusCode).toBe(204);
        expect(
          (
            await send('DELETE', `${tokensPath()}/not-an-id`, {
              session: manager,
            })
          ).statusCode,
        ).toBe(400);
      });

      it('stops a token whose owner lost api:tokens, who can still list and end it, and starts it again when they hold the permission again', async () => {
        await switchesNow(true, false);
        const token = await made(tokensUser, { name: 'Left behind' });
        const meta = () => send('GET', '/meta', { bearer: token.token });
        expect((await meta()).statusCode).toBe(200);
        const lose = () =>
          setMemberRolesEnded(ctx.database, org(), scene.tokensId, true);
        const regain = () =>
          setMemberRolesEnded(ctx.database, org(), scene.tokensId, false);
        await lose();
        try {
          const refused = await meta();
          expect(refused.statusCode).toBe(401);
          expect(refused.json<{ code: string }>().code).toBe('invalid-token');
          // Listing and revoking your own need no permission, making one does.
          const own = await send('GET', tokensPath(), { session: tokensUser });
          expect(own.statusCode).toBe(200);
          expect(own.json<{ id: string }[]>().map((row) => row.id)).toContain(
            token.apiToken.id,
          );
          expect((await createToken(tokensUser)).statusCode).toBe(403);
        } finally {
          await regain();
        }
        // Nothing was revoked: the token works again.
        expect((await meta()).statusCode).toBe(200);
        await lose();
        try {
          const ended = await send(
            'DELETE',
            `${tokensPath()}/${token.apiToken.id}`,
            { session: tokensUser },
          );
          expect(ended.statusCode).toBe(204);
        } finally {
          await regain();
        }
        expect((await meta()).statusCode).toBe(401);
      });

      it('needs the right Origin and a session, as every route that changes data', async () => {
        await switchesNow(true, false);
        const token = await made(tokensUser);
        for (const origin of [FOREIGN_ORIGIN, null]) {
          const response = await send(
            'DELETE',
            `${tokensPath()}/${token.apiToken.id}`,
            { session: tokensUser, origin },
          );
          expect(response.statusCode).toBe(403);
          expect(response.json<{ code: string }>().code).toBe(
            'origin-mismatch',
          );
        }
        expect(
          (await send('DELETE', `${tokensPath()}/${token.apiToken.id}`, {}))
            .statusCode,
        ).toBe(401);
        // Your own needs no permission, so this is a self-service route: a session that
        // may only secure the account is refused all the same, and nothing is revoked.
        const recovery = await sessionOf(scene.tokensId, 'recovery');
        const limited = await send(
          'DELETE',
          `${tokensPath()}/${token.apiToken.id}`,
          { session: recovery },
        );
        expect(limited.statusCode).toBe(403);
        expect(limited.json<{ code: string }>().code).toBe(
          'account-recovery-required',
        );
        expect(
          (await send('GET', '/meta', { bearer: token.token })).statusCode,
        ).toBe(200);
      });
    });

    describe('a token on the token routes', () => {
      it('is a 403 token-not-accepted on every one of them, the settings too: a token never manages tokens', async () => {
        await switchesNow(true, true);
        const token = await made(owner, { access: 'write' });
        const other = await made(medical);
        for (const [method, path, payload] of [
          ['GET', settingsPath(), undefined],
          ['PUT', settingsPath(), { personalTokens: true, sensitive: true }],
          ['POST', tokensPath(), { name: 'x', access: 'read' }],
          ['GET', tokensPath(), undefined],
          ['DELETE', `${tokensPath()}/${other.apiToken.id}`, undefined],
        ] as const) {
          const response = await send(method, path, {
            bearer: token.token,
            ...(payload === undefined ? {} : { payload }),
          });
          expect(response.statusCode, `${method} ${path}`).toBe(403);
          expect(response.json<{ code: string }>().code).toBe(
            'token-not-accepted',
          );
        }
        // Nothing happened: the other token is still live.
        expect(
          (await send('GET', `${tokensPath()}?scope=all`, { session: manager }))
            .json<{ id: string }[]>()
            .map((row) => row.id),
        ).toContain(other.apiToken.id);
      });
    });

    describe('the routes that accept a token', () => {
      it('lets a token list the members, as its owner’s session does, and nothing else', async () => {
        await switchesNow(true, false);
        const reader = await made(owner, { access: 'read' });
        const writer = await made(owner, { access: 'write' });
        const asSession = await send('GET', `/organisations/${org()}/members`, {
          session: owner,
        });
        expect(asSession.statusCode).toBe(200);
        for (const token of [reader, writer]) {
          const response = await send(
            'GET',
            `/organisations/${org()}/members`,
            {
              bearer: token.token,
            },
          );
          expect(response.statusCode).toBe(200);
          expect(response.json()).toEqual(asSession.json());
        }
        // The routes that make invites and reset links never take a token.
        for (const [method, path] of [
          ['GET', `/organisations/${org()}/invites`],
          ['POST', `/organisations/${org()}/invites`],
          [
            'DELETE',
            `/organisations/${org()}/members/${scene.tokensId}/reset-link`,
          ],
          ['GET', '/auth/me'],
        ] as const) {
          const response = await send(method, path, { bearer: writer.token });
          expect(response.statusCode, `${method} ${path}`).toBe(403);
          expect(response.json<{ code: string }>().code).toBe(
            'token-not-accepted',
          );
        }
      });

      it('is the same 401 for a token on another organisation’s members as for any token that does not work', async () => {
        await switchesNow(true, false);
        const token = await made(owner);
        const wrongOrg = await send(
          'GET',
          `/organisations/${scene.otherOrganisationId}/members`,
          { bearer: token.token },
        );
        const unknown = await send('GET', `/organisations/${org()}/members`, {
          bearer: `osfpm_pat_${'Q'.repeat(43)}`,
        });
        expect(wrongOrg.statusCode).toBe(401);
        expect(unknown.statusCode).toBe(401);
        expect(sameness(wrongOrg.json())).toBe(sameness(unknown.json()));
      });

      it('refuses a token whose owner may not list the members, as the session of that owner is refused', async () => {
        await switchesNow(true, false);
        const token = await made(tokensUser);
        const asToken = await send('GET', `/organisations/${org()}/members`, {
          bearer: token.token,
        });
        const asSession = await send('GET', `/organisations/${org()}/members`, {
          session: tokensUser,
        });
        expect(asToken.statusCode).toBe(403);
        expect(asSession.statusCode).toBe(403);
        expect(sameness(asToken.json())).toBe(sameness(asSession.json()));
      });

      it('refuses a project token, which has no access to the organisation’s members', async () => {
        await switchesNow(true, false);
        const created = await createToken(owner, {
          projectId: scene.projectId,
        });
        expect(created.statusCode).toBe(201);
        const token = created.json<{ token: string }>().token;
        tokens.push(token);
        const response = await send('GET', `/organisations/${org()}/members`, {
          bearer: token,
        });
        expect(response.statusCode).toBe(403);
        expect(response.json<{ code: string }>().code).toBe('access-denied');
      });

      it('is checked on /meta, which answers as it always does', async () => {
        await switchesNow(true, false);
        const token = await made(tokensUser);
        const plainMeta = await send('GET', '/meta');
        const withToken = await send('GET', '/meta', { bearer: token.token });
        expect(withToken.statusCode).toBe(200);
        expect(withToken.json()).toEqual(plainMeta.json());
        const bad = await send('GET', '/meta', {
          bearer: `osfpm_pat_${'R'.repeat(43)}`,
        });
        expect(bad.statusCode).toBe(401);
        expect(bad.json<{ code: string }>().code).toBe('invalid-token');
        const both = await send('GET', '/meta', {
          bearer: token.token,
          session: owner,
        });
        expect(both.statusCode).toBe(400);
        expect(both.json<{ code: string }>().code).toBe(
          'ambiguous-credentials',
        );
      });

      it('writes one api.call event for each of those requests, with the route pattern', async () => {
        await switchesNow(true, false);
        const token = await made(owner);
        await send('GET', `/organisations/${org()}/members`, {
          bearer: token.token,
        });
        await send('GET', '/meta', { bearer: token.token });
        for (let i = 0; i < 40; i += 1) {
          const calls = (await db().select().from(auditEvent)).filter(
            (event) =>
              event.category === 'api.call' &&
              event.actorId === token.apiToken.id,
          );
          if (calls.length >= 2) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const calls = (await db().select().from(auditEvent)).filter(
          (event) =>
            event.category === 'api.call' &&
            event.actorId === token.apiToken.id,
        );
        expect(calls.map((event) => event.details?.route).sort()).toEqual(
          [
            `${API_PREFIX}/meta`,
            `${API_PREFIX}/organisations/:organisationId/members`,
          ].sort(),
        );
        for (const event of calls) {
          expect(event.details?.status).toBe(200);
          // The pattern, not the path that was asked for: the id in the URL is not in it.
          expect(JSON.stringify(event.details)).not.toContain(org());
        }
      });
    });

    describe('the limit per session', () => {
      it('counts the settings routes against the session, 120 a minute', async () => {
        const session = await sessionOf(scene.managerId);
        const address = '10.32.0.1';
        let last = 0;
        for (let i = 0; i <= SESSION_RATE_LIMIT.max; i += 1) {
          last = (
            await send('GET', settingsPath(), {
              session,
              remoteAddress: address,
            })
          ).statusCode;
        }
        expect(last).toBe(429);
      });
    });

    describe('what is kept out of logs, events, tables and answers', () => {
      it('holds no token, no hash of one and nothing after a prefix', async () => {
        expect(tokens.length).toBeGreaterThan(10);
        const stored = await db().select().from(apiToken);
        const hashes = stored.map((row) => row.tokenHash);
        expect(hashes.length).toBeGreaterThan(0);
        const logs = ctx.lines.join('');
        const events = JSON.stringify(await db().select().from(auditEvent));
        const changes = JSON.stringify(await db().select().from(changeEvent));
        const bodies = errorBodies.join('');
        const tables = await everyRowAsText(ctx.database);
        for (const token of tokens) {
          const secret = token.slice('osfpm_pat_'.length);
          for (const [where, text] of [
            ['logs', logs],
            ['audit events', events],
            ['change events', changes],
            ['error bodies', bodies],
            ['tables', tables],
          ] as const) {
            expect(text, `${where} hold a token`).not.toContain(token);
            expect(
              text,
              `${where} hold the secret part of a token`,
            ).not.toContain(secret);
          }
        }
        // The hashes are stored on purpose, in the table; nowhere else.
        for (const hash of hashes) {
          for (const [where, text] of [
            ['logs', logs],
            ['audit events', events],
            ['change events', changes],
            ['error bodies', bodies],
          ] as const) {
            expect(text, `${where} hold a hash`).not.toContain(hash);
          }
        }
        expect(logs.toLowerCase()).not.toContain('authorization');
      });
    });
  },
);

/** The PostgreSQL target, when `DATABASE_URL` names a server. PGlite has one connection, so it cannot run this. */
const postgres = testTargets.find((target) => target.name === 'postgres');

describe.skipIf(postgres === undefined)(
  'several revokes of one token at once over HTTP, on PostgreSQL',
  () => {
    it('ends the token once: one 204, and the same 404 for the others, with one revocation audited', async () => {
      const ctx = await createTestApp(postgres!);
      try {
        await migrate(ctx.database);
        const now = new Date();
        const scene = await seedTokenScene(ctx.database, now);
        await ctx.database.db.transaction((tx) =>
          setApiTokenSwitches(
            tx,
            { userId: scene.ownerId },
            scene.organisationId,
            { personalTokens: true, sensitive: false },
            now,
          ),
        );
        const session = (
          await createSession(ctx.database.db, {
            userId: scene.ownerId,
            method: 'password',
            now,
          })
        ).token;
        const headers = {
          origin: TEST_PUBLIC_ORIGIN,
          cookie: `${SESSION_COOKIE}=${session}`,
        };
        const created = await ctx.app.inject({
          method: 'POST',
          url: `${API_PREFIX}/organisations/${scene.organisationId}/api-tokens`,
          headers,
          remoteAddress: '10.32.0.1',
          payload: { name: 'Call sheet export', access: 'read' },
        });
        expect(created.statusCode).toBe(201);
        const tokenId = created.json<{ apiToken: { id: string } }>().apiToken
          .id;
        const responses = await Promise.all(
          [2, 3, 4, 5].map((host) =>
            ctx.app.inject({
              method: 'DELETE',
              url: `${API_PREFIX}/organisations/${scene.organisationId}/api-tokens/${tokenId}`,
              headers,
              remoteAddress: `10.32.0.${host}`,
            }),
          ),
        );
        expect(responses.map((response) => response.statusCode).sort()).toEqual(
          [204, 404, 404, 404],
        );
        // The losers got the answer of a token that is not there, with nothing of the race.
        const refused = responses.filter(
          (response) => response.statusCode === 404,
        );
        expect(
          new Set(refused.map((response) => sameness(response.json()))),
        ).toHaveProperty('size', 1);
        const revocations = (
          await ctx.database.db.select().from(auditEvent)
        ).filter(
          (event) =>
            event.category === 'auth.api-token-revoked' &&
            event.targetId === tokenId,
        );
        expect(revocations).toHaveLength(1);
      } finally {
        await ctx.close();
      }
    });
  },
);
