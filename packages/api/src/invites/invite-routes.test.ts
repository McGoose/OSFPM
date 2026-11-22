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
  base,
  grantOnOrganisation,
  seedOrganisation,
  seedUser,
} from '@osfpm/core/src/access/test-fixtures.js';
import { completeFirstRunSetup } from '@osfpm/core/src/auth/first-run-setup.js';
import { createSession } from '@osfpm/core/src/auth/sessions.js';
import { AUTH_AUDIT } from '@osfpm/core/src/auth/shared.js';
import {
  demoSetupInput,
  everyRowAsText,
  seedFirstRun,
  seedActiveUserWithEmail,
} from '@osfpm/core/src/auth/test-support.js';
import { migrate } from '@osfpm/core/src/db/migrate.js';
import {
  auditEvent,
  changeEvent,
  invite,
  orgMembership,
  orgMembershipRole,
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
import { createTestApp, TEST_PUBLIC_ORIGIN } from '../test-support.js';

const DAY = 24 * 60 * 60 * 1000;
const FOREIGN_ORIGIN = 'https://attacker.example.test';

// Invented passwords and addresses; none is real, and none holds a word of the
// fixture addresses or of the password policy's list.
const PASSWORD = 'harbour-lantern-quiet-river';
const SAM = 'sam.demo@demopictures.example';
const ALEX = 'alex.demo@demopictures.example';

type Method = 'GET' | 'POST' | 'DELETE';

/** The `Set-Cookie` lines of a response. */
function setCookies(headers: OutgoingHttpHeaders): string[] {
  const value = headers['set-cookie'];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [String(value)];
}

/** An error body with the parts that differ between two requests taken out. */
function sameness(body: unknown) {
  return JSON.stringify({
    ...(body as Record<string, unknown>),
    requestId: undefined,
    instance: undefined,
  });
}

describe.each(testTargets)(
  'the member and invite routes on $name',
  (target: TestTarget) => {
    let ctx: Awaited<ReturnType<typeof createTestApp>>;
    let organisationId: string;
    let adminId: string;
    let adminToken: string;
    let administratorRoleId: string;
    let crewRoleId: string;
    let editorRoleId: string;
    let wideRoleId: string;
    let inviterId: string;
    let inviterToken: string;
    let memberToken: string;
    let strangerToken: string;
    let addresses = 0;

    /** Every value a flow below must keep out of logs, audit events, change events and error bodies. */
    const tokens: string[] = [];
    const errorBodies: string[] = [];

    beforeAll(async () => {
      ctx = await createTestApp(target, { logLevel: 'trace' });
      await migrate(ctx.database);
      const code = await seedFirstRun(ctx.database);
      const done = await completeFirstRunSetup(
        ctx.database.db,
        demoSetupInput(code),
        new Date(),
      );
      if (!done.ok) throw new Error('the setup was refused');
      organisationId = done.organisation.id;
      adminId = done.user.id;
      adminToken = await sessionOf(adminId);
      const [administrator] = await db().select().from(role);
      administratorRoleId = administrator!.id;

      const makeRole = async (
        key: string,
        grants: readonly (readonly [string, 'own-scope' | 'all-projects'])[],
      ) => {
        const [created] = await db()
          .insert(role)
          .values({ ...base(organisationId), projectId: null, key, name: key })
          .returning();
        for (const [permissionKey, reach] of grants) {
          await db()
            .insert(rolePermission)
            .values({
              ...base(organisationId),
              roleId: created!.id,
              permissionKey,
              reach,
            });
        }
        return created!.id;
      };
      crewRoleId = await makeRole('crew', [['accounts:read', 'own-scope']]);
      editorRoleId = await makeRole('editor', [
        ['accounts:read', 'own-scope'],
        ['accounts:edit', 'own-scope'],
      ]);
      wideRoleId = await makeRole('wide', [['accounts:read', 'all-projects']]);

      inviterId = await seedUser(ctx.database);
      await grantOnOrganisation(
        ctx.database,
        organisationId,
        inviterId,
        'member',
        ['members:invite', 'accounts:read'],
        { reach: 'own-scope' },
      );
      inviterToken = await sessionOf(inviterId);
      const plain = await seedUser(ctx.database);
      await grantOnOrganisation(ctx.database, organisationId, plain, 'guest', [
        'accounts:read',
      ]);
      memberToken = await sessionOf(plain);
      strangerToken = await sessionOf(await seedUser(ctx.database));
    });
    afterAll(async () => {
      await ctx.close();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const db = () => ctx.database.db;
    const freshAddress = () =>
      `10.11.${Math.floor(addresses / 250)}.${(addresses++ % 250) + 1}`;

    /** A session of `userId`, as the login routes would have made it; answers the token. */
    async function sessionOf(
      userId: string,
      scope: 'full' | 'recovery' = 'full',
    ) {
      const created = await createSession(db(), {
        userId,
        method: scope === 'recovery' ? 'recovery' : 'password',
        now: new Date(),
      });
      return created.token;
    }

    /** One request. A request that changes data comes from the site itself unless `origin` says otherwise (`null` sends none). */
    async function send(
      method: Method,
      path: string,
      options: {
        token?: string;
        origin?: string | null;
        payload?: unknown;
        remoteAddress?: string;
      } = {},
    ) {
      const headers: Record<string, string> = {};
      if (options.token !== undefined) {
        headers.cookie = `${SESSION_COOKIE}=${options.token}`;
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

    const members = (token?: string, org: string = organisationId) =>
      send('GET', `/organisations/${org}/members`, {
        ...(token === undefined ? {} : { token }),
      });
    const listInvitesRoute = (token?: string, org: string = organisationId) =>
      send('GET', `/organisations/${org}/invites`, {
        ...(token === undefined ? {} : { token }),
      });
    const createRoute = (
      payload: unknown,
      options: { token?: string; org?: string; origin?: string | null } = {},
    ) =>
      send('POST', `/organisations/${options.org ?? organisationId}/invites`, {
        token: options.token ?? adminToken,
        payload,
        ...(options.origin === undefined ? {} : { origin: options.origin }),
      });
    const revokeRoute = (
      inviteId: string,
      options: { token?: string; org?: string; origin?: string | null } = {},
    ) =>
      send(
        'DELETE',
        `/organisations/${options.org ?? organisationId}/invites/${inviteId}`,
        {
          token: options.token ?? adminToken,
          ...(options.origin === undefined ? {} : { origin: options.origin }),
        },
      );
    const inspectRoute = (
      token: string,
      options: {
        remoteAddress?: string;
        origin?: string | null;
        cookie?: string;
      } = {},
    ) =>
      send('POST', '/invites/inspect', {
        payload: { token },
        ...(options.origin === undefined ? {} : { origin: options.origin }),
        ...(options.remoteAddress === undefined
          ? {}
          : { remoteAddress: options.remoteAddress }),
        ...(options.cookie === undefined ? {} : { token: options.cookie }),
      });
    const acceptRoute = (
      token: string,
      options: {
        account?: unknown;
        cookie?: string;
        origin?: string | null;
        remoteAddress?: string;
      } = {},
    ) =>
      send('POST', '/invites/accept', {
        payload: {
          token,
          ...(options.account === undefined
            ? {}
            : { account: options.account }),
        },
        ...(options.cookie === undefined ? {} : { token: options.cookie }),
        ...(options.origin === undefined ? {} : { origin: options.origin }),
        ...(options.remoteAddress === undefined
          ? {}
          : { remoteAddress: options.remoteAddress }),
      });

    /** Makes an invite as the administrator and answers its id and token, which is also kept for the scans. */
    async function make(
      body: Record<string, unknown> = {},
      actorToken: string = adminToken,
    ) {
      const response = await createRoute(
        { tier: 'member', roleIds: [crewRoleId], ...body },
        { token: actorToken },
      );
      expect(response.statusCode, response.body).toBe(201);
      const json = response.json<{ invite: { id: string }; link: string }>();
      const token = json.link.split('#')[1]!;
      tokens.push(token);
      return { id: json.invite.id, token, link: json.link, json };
    }

    const inviteRow = async (id: string) =>
      (await db().select().from(invite)).find((found) => found.id === id)!;
    const sessionCookieOf = (response: { headers: OutgoingHttpHeaders }) => {
      const line = setCookies(response.headers).find((found) =>
        found.startsWith(`${SESSION_COOKIE}=`),
      );
      return line === undefined ? null : line.split(';')[0]!.split('=')[1]!;
    };
    const newAccount = (
      email: string,
      extra: Record<string, unknown> = {},
    ) => ({
      email,
      displayName: 'Sam Demo',
      ...extra,
    });

    describe('GET /organisations/:organisationId/members', () => {
      it('is a 401 with no session', async () => {
        const response = await members();
        expect(response.statusCode).toBe(401);
        expect(response.json()).toMatchObject({
          code: 'authentication-required',
        });
      });

      it('is a 403 without members:read, for a member without it, a stranger and an organisation that does not exist, with one and the same body', async () => {
        const unknown = '00000000-0000-7000-8000-000000000000';
        const answers = [
          await members(memberToken),
          await members(strangerToken),
          await members(adminToken, unknown),
          await members(inviterToken),
        ];
        for (const response of answers) {
          expect(response.statusCode).toBe(403);
          expect(response.json()).toMatchObject({ code: 'access-denied' });
        }
        expect(
          new Set(answers.map((response) => sameness(response.json()))).size,
        ).toBe(1);
      });

      it('is a 403 account-recovery-required for a recovery session', async () => {
        const token = await sessionOf(adminId, 'recovery');
        const response = await members(token);
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({
          code: 'account-recovery-required',
        });
      });

      it('lists this organisation’s members, with six fields and no sign-in detail', async () => {
        const response = await members(adminToken);
        expect(response.statusCode).toBe(200);
        const list = response.json<Record<string, unknown>[]>();
        const ada = list.find((member) => member.userId === adminId)!;
        expect(ada).toMatchObject({
          tier: 'owner',
          status: 'active',
          roleKeys: ['administrator'],
        });
        for (const member of list) {
          expect(Object.keys(member).sort()).toEqual([
            'displayName',
            'email',
            'roleKeys',
            'status',
            'tier',
            'userId',
          ]);
        }
        const text = response.body.toLowerCase();
        for (const word of [
          'password',
          'totp',
          'passkey',
          'recovery',
          'hash',
          'secret',
        ]) {
          expect(text, word).not.toContain(word);
        }
      });

      it('lists no member of another organisation', async () => {
        const other = await seedOrganisation(ctx.database);
        const stranger = await seedUser(ctx.database);
        await grantOnOrganisation(
          ctx.database,
          other.organisationId,
          stranger,
          'member',
          [],
        );
        const list = (await members(adminToken)).json<{ userId: string }[]>();
        expect(list.some((member) => member.userId === stranger)).toBe(false);
      });

      it('is a 400 for an organisation id that is not a UUID', async () => {
        expect((await members(adminToken, 'not-a-uuid')).statusCode).toBe(400);
      });
    });

    describe('POST /organisations/:organisationId/invites', () => {
      it('is a 401 with no session', async () => {
        const response = await send(
          'POST',
          `/organisations/${organisationId}/invites`,
          {
            payload: { tier: 'member', roleIds: [] },
          },
        );
        expect(response.statusCode).toBe(401);
      });

      it('is a 403 origin-mismatch for a foreign Origin, and for none, with a cookie', async () => {
        for (const origin of [FOREIGN_ORIGIN, null]) {
          const response = await createRoute(
            { tier: 'member', roleIds: [] },
            { origin },
          );
          expect(response.statusCode).toBe(403);
          expect(response.json()).toMatchObject({ code: 'origin-mismatch' });
        }
      });

      it('is a 403 account-recovery-required for a recovery session', async () => {
        const token = await sessionOf(adminId, 'recovery');
        const response = await createRoute(
          { tier: 'member', roleIds: [] },
          { token },
        );
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({
          code: 'account-recovery-required',
        });
      });

      it('is a 403 without members:invite, for a member without it, a stranger and an unknown organisation, with one and the same body', async () => {
        const unknown = '00000000-0000-7000-8000-000000000000';
        const invitesBefore = (await db().select().from(invite)).length;
        const answers = [
          await createRoute(
            { tier: 'member', roleIds: [] },
            { token: memberToken },
          ),
          await createRoute(
            { tier: 'member', roleIds: [] },
            { token: strangerToken },
          ),
          await createRoute({ tier: 'member', roleIds: [] }, { org: unknown }),
        ];
        for (const response of answers) {
          expect(response.statusCode).toBe(403);
          expect(response.json()).toMatchObject({ code: 'access-denied' });
        }
        expect(
          new Set(answers.map((response) => sameness(response.json()))).size,
        ).toBe(1);
        // Nothing was made.
        expect((await db().select().from(invite)).length).toBe(invitesBefore);
      });

      it('makes the invite and shows the link once: the token is after the # of <OSFPM_PUBLIC_URL>/invite, and the response is not cached', async () => {
        const email = '  Sam.Demo@DemoPictures.example ';
        const response = await createRoute({
          email,
          tier: 'supervisor',
          roleIds: [crewRoleId, editorRoleId],
          expiresInDays: 3,
        });
        expect(response.statusCode).toBe(201);
        expect(response.headers['cache-control']).toBe('no-store');
        const body = response.json<{
          invite: Record<string, unknown>;
          link: string;
        }>();
        const [url, fragment] = body.link.split('#');
        expect(url).toBe(`${TEST_PUBLIC_ORIGIN}/invite`);
        expect(fragment).toMatch(/^[A-Za-z0-9_-]{43}$/);
        tokens.push(fragment!);
        expect(body.invite).toMatchObject({
          organisationId,
          email: SAM,
          tier: 'supervisor',
          createdBy: adminId,
        });
        expect((body.invite.roleIds as string[]).sort()).toEqual(
          [crewRoleId, editorRoleId].sort(),
        );
        const created = new Date(body.invite.createdAt as string).getTime();
        const expires = new Date(body.invite.expiresAt as string).getTime();
        expect(expires - created).toBe(3 * DAY);
        // No token, no hash, no link in the invite.
        expect(Object.keys(body.invite).sort()).toEqual(
          [
            'createdAt',
            'createdBy',
            'email',
            'expiresAt',
            'id',
            'organisationId',
            'roleIds',
            'tier',
          ].sort(),
        );
        // Only the hash is stored: the token is in no table.
        expect(await everyRowAsText(ctx.database)).not.toContain(fragment);
      });

      it('lasts seven days when it says nothing, and one to thirty when asked', async () => {
        const days = async (expiresInDays?: number) => {
          const response = await createRoute({
            tier: 'member',
            roleIds: [],
            ...(expiresInDays === undefined ? {} : { expiresInDays }),
          });
          expect(response.statusCode, response.body).toBe(201);
          const { invite: made, link } = response.json<{
            invite: { createdAt: string; expiresAt: string };
            link: string;
          }>();
          tokens.push(link.split('#')[1]!);
          return (
            (new Date(made.expiresAt).getTime() -
              new Date(made.createdAt).getTime()) /
            DAY
          );
        };
        expect(await days()).toBe(7);
        expect(await days(1)).toBe(1);
        expect(await days(30)).toBe(30);
      });

      it('is a 400 for a body the route does not take, and names the fields, never the values', async () => {
        const bad: [string, unknown][] = [
          ['the owner tier', { tier: 'owner', roleIds: [] }],
          ['an unknown tier', { tier: 'superuser', roleIds: [] }],
          ['no tier', { roleIds: [] }],
          ['no roles list', { tier: 'member' }],
          ['a role id that is not a UUID', { tier: 'member', roleIds: ['x'] }],
          ['zero days', { tier: 'member', roleIds: [], expiresInDays: 0 }],
          [
            'thirty-one days',
            { tier: 'member', roleIds: [], expiresInDays: 31 },
          ],
          [
            'part of a day',
            { tier: 'member', roleIds: [], expiresInDays: 1.5 },
          ],
          [
            'an address that is not one',
            { tier: 'member', roleIds: [], email: 'not an address' },
          ],
        ];
        for (const [name, payload] of bad) {
          const response = await createRoute(payload);
          expect(response.statusCode, name).toBe(400);
          expect(response.json(), name).toMatchObject({
            code: 'validation-failed',
          });
        }
        const secret = 'a.secret.address@demopictures.example';
        const refused = await createRoute({
          tier: 'owner',
          roleIds: [],
          email: secret,
        });
        expect(refused.body).not.toContain(secret);
      });

      it('is a 400 for a role of another organisation, a deleted role and one that is not there', async () => {
        const other = await seedOrganisation(ctx.database);
        const [foreign] = await db()
          .insert(role)
          .values({
            ...base(other.organisationId),
            projectId: null,
            key: 'crew',
            name: 'Crew',
          })
          .returning();
        const [deleted] = await db()
          .insert(role)
          .values({
            ...base(organisationId),
            projectId: null,
            key: 'gone',
            name: 'Gone',
            deletedAt: new Date(),
          })
          .returning();
        for (const roleId of [
          foreign!.id,
          deleted!.id,
          '00000000-0000-7000-8000-000000000001',
        ]) {
          const response = await createRoute({
            tier: 'member',
            roleIds: [roleId],
          });
          expect(response.statusCode, roleId).toBe(400);
          expect(response.json(), roleId).toMatchObject({
            code: 'bad-request',
          });
        }
      });

      it('is a 422 invite-exceeds-own-access, listing the permission keys, when a role holds what the person making it lacks', async () => {
        const response = await createRoute(
          { tier: 'member', roleIds: [crewRoleId, editorRoleId] },
          { token: inviterToken },
        );
        expect(response.statusCode).toBe(422);
        const body = response.json<{
          code: string;
          errors: { in: string; path: string; code: string }[];
        }>();
        expect(body.code).toBe('invite-exceeds-own-access');
        expect(body.errors).toEqual([
          { in: 'body', path: 'roleIds', code: 'accounts:edit' },
        ]);
      });

      it('is a 422 for an all-projects grant when the person holds the permission for the organisation only', async () => {
        const response = await createRoute(
          { tier: 'member', roleIds: [wideRoleId] },
          { token: inviterToken },
        );
        expect(response.statusCode).toBe(422);
        expect(response.json<{ errors: { code: string }[] }>().errors).toEqual([
          { in: 'body', path: 'roleIds', code: 'accounts:read' },
        ]);
      });

      it('lets the person give what they hold, at the same reach, and the administrator give any role', async () => {
        const mine = await make({ roleIds: [crewRoleId] }, inviterToken);
        expect(mine.json.invite).toMatchObject({ createdBy: inviterId });
        await make({
          roleIds: [administratorRoleId, wideRoleId, editorRoleId],
        });
      });

      it('audits it with the ids, tier, roles, expiry and whether an address is set, and never the address or the token', async () => {
        const made = await make({ email: ALEX });
        const [event] = (await db().select().from(auditEvent)).filter(
          (found) =>
            found.category === AUTH_AUDIT.inviteCreated &&
            found.targetId === made.id,
        );
        expect(event).toMatchObject({
          actorId: adminId,
          organisationId,
          details: { tier: 'member', roleIds: crewRoleId, hasEmail: true },
        });
        expect(JSON.stringify(event)).not.toContain(ALEX);
        expect(JSON.stringify(event)).not.toContain(made.token);
      });
    });

    describe('GET and DELETE /organisations/:organisationId/invites', () => {
      it('GET is a 401 with no session, a 403 for a recovery session, and a 403 without members:invite, with one body for a stranger, a member and an unknown organisation', async () => {
        expect((await listInvitesRoute()).statusCode).toBe(401);
        const recovery = await listInvitesRoute(
          await sessionOf(adminId, 'recovery'),
        );
        expect(recovery.json()).toMatchObject({
          code: 'account-recovery-required',
        });
        const unknown = '00000000-0000-7000-8000-000000000000';
        const answers = [
          await listInvitesRoute(memberToken),
          await listInvitesRoute(strangerToken),
          await listInvitesRoute(adminToken, unknown),
        ];
        for (const response of answers) expect(response.statusCode).toBe(403);
        expect(
          new Set(answers.map((response) => sameness(response.json()))).size,
        ).toBe(1);
      });

      it('GET lists the invites that can still be used and no token, hash or link; one used, one revoked and one expired are not listed', async () => {
        const live = await make();
        const revoked = await make();
        expect((await revokeRoute(revoked.id)).statusCode).toBe(204);
        const used = await make();
        expect(
          (
            await acceptRoute(used.token, {
              account: newAccount('listed.used@demopictures.example'),
            })
          ).statusCode,
        ).toBe(201);
        const response = await listInvitesRoute(adminToken);
        expect(response.statusCode).toBe(200);
        const ids = response.json<{ id: string }[]>().map((found) => found.id);
        expect(ids).toContain(live.id);
        expect(ids).not.toContain(revoked.id);
        expect(ids).not.toContain(used.id);
        for (const secret of [
          live.token,
          revoked.token,
          used.token,
          'tokenHash',
          'token_hash',
          '#',
        ]) {
          expect(response.body, secret).not.toContain(secret);
        }
        // An invite past its end is not listed either.
        const short = await make({ expiresInDays: 1 });
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.now() + 2 * DAY);
        // The administrator's own session has ended by then, so a new one is made.
        const later = await sessionOf(adminId);
        const after = (await listInvitesRoute(later))
          .json<{ id: string }[]>()
          .map((found) => found.id);
        expect(after).not.toContain(short.id);
      });

      it('DELETE is a 401 with no session, a 403 for a foreign Origin, for a recovery session and without the permission', async () => {
        const made = await make();
        expect(
          (
            await send(
              'DELETE',
              `/organisations/${organisationId}/invites/${made.id}`,
            )
          ).statusCode,
        ).toBe(401);
        const wrong = await revokeRoute(made.id, { origin: FOREIGN_ORIGIN });
        expect(wrong.json()).toMatchObject({ code: 'origin-mismatch' });
        expect((await revokeRoute(made.id, { origin: null })).statusCode).toBe(
          403,
        );
        const recovery = await revokeRoute(made.id, {
          token: await sessionOf(adminId, 'recovery'),
        });
        expect(recovery.json()).toMatchObject({
          code: 'account-recovery-required',
        });
        for (const token of [memberToken, strangerToken]) {
          const refused = await revokeRoute(made.id, { token });
          expect(refused.statusCode).toBe(403);
          expect(refused.json()).toMatchObject({ code: 'access-denied' });
        }
        expect((await inviteRow(made.id)).revokedAt).toBeNull();
      });

      it('DELETE revokes with a 204, audits it, and the link stops working', async () => {
        const made = await make();
        const response = await revokeRoute(made.id);
        expect(response.statusCode).toBe(204);
        expect((await inviteRow(made.id)).revokedBy).toBe(adminId);
        expect(
          (await db().select().from(auditEvent)).some(
            (found) =>
              found.category === AUTH_AUDIT.inviteRevoked &&
              found.targetId === made.id,
          ),
        ).toBe(true);
        expect((await inspectRoute(made.token)).statusCode).toBe(401);
        expect(
          (
            await acceptRoute(made.token, {
              account: newAccount('revoked.then@demopictures.example'),
            })
          ).statusCode,
        ).toBe(401);
      });

      it('DELETE is a 404 for an invite that is not live, another organisation’s, or not there, with one body', async () => {
        const done = await make();
        await revokeRoute(done.id);
        const other = await seedOrganisation(ctx.database);
        const [foreign] = await db()
          .insert(invite)
          .values({
            originServer: base(other.organisationId).originServer,
            organisationId: other.organisationId,
            tokenHash: `foreign-${Math.random()}`,
            tier: 'member',
            createdAt: new Date(Date.now() - DAY),
            expiresAt: new Date(Date.now() + DAY),
          })
          .returning();
        const answers = [
          await revokeRoute(done.id),
          await revokeRoute(foreign!.id),
          await revokeRoute('00000000-0000-7000-8000-000000000002'),
        ];
        for (const response of answers) {
          expect(response.statusCode).toBe(404);
          expect(response.json()).toMatchObject({ code: 'not-found' });
        }
        expect(
          new Set(answers.map((response) => sameness(response.json()))).size,
        ).toBe(1);
        expect((await inviteRow(foreign!.id)).revokedAt).toBeNull();
      });
    });

    describe('POST /invites/inspect', () => {
      it('is a 403 origin-mismatch for a foreign Origin and for none, with a cookie or without', async () => {
        const made = await make();
        for (const origin of [FOREIGN_ORIGIN, null]) {
          for (const cookie of [undefined, adminToken]) {
            const response = await inspectRoute(made.token, {
              origin,
              ...(cookie === undefined ? {} : { cookie }),
            });
            expect(response.statusCode).toBe(403);
            expect(response.json()).toMatchObject({ code: 'origin-mismatch' });
          }
        }
      });

      it('tells the holder of a live token the organisation, the end and whether an address is needed, and not which address', async () => {
        const open = await make();
        const named = await make({ email: SAM });
        const response = await inspectRoute(open.token);
        expect(response.statusCode).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.json()).toEqual({
          organisationName: 'Demo Pictures',
          expiresAt: expect.any(String) as string,
          emailRequired: false,
        });
        const withEmail = await inspectRoute(named.token);
        expect(withEmail.json()).toMatchObject({ emailRequired: true });
        expect(withEmail.body).not.toContain(SAM);
      });

      it('uses no session: a cookie that is no good changes nothing', async () => {
        const made = await make();
        const response = await inspectRoute(made.token, {
          cookie: 'not-a-session',
        });
        expect(response.statusCode).toBe(200);
      });

      it('answers an unknown, expired, revoked and used token with one and the same 401, and writes an audit event for each', async () => {
        const used = await make();
        await acceptRoute(used.token, {
          account: newAccount('inspect.used@demopictures.example'),
        });
        const revoked = await make();
        await revokeRoute(revoked.id);
        const expiring = await make({ expiresInDays: 1 });
        const before = (await db().select().from(auditEvent)).filter(
          (found) => found.category === AUTH_AUDIT.inviteInspectFailed,
        ).length;
        const answers = [
          await inspectRoute('a-token-nobody-made'),
          await inspectRoute(used.token),
          await inspectRoute(revoked.token),
        ];
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.now() + 2 * DAY);
        answers.push(await inspectRoute(expiring.token));
        for (const response of answers) {
          expect(response.statusCode).toBe(401);
          expect(response.json()).toMatchObject({ code: 'invite-invalid' });
        }
        expect(
          new Set(answers.map((response) => sameness(response.json()))).size,
        ).toBe(1);
        const events = (await db().select().from(auditEvent)).filter(
          (found) => found.category === AUTH_AUDIT.inviteInspectFailed,
        );
        expect(events.length - before).toBe(4);
        expect(
          events
            .slice(before)
            .map((found) => (found.details as { reason: string }).reason)
            .sort(),
        ).toEqual(['expired', 'revoked', 'unknown', 'used']);
      });

      it('is a 400 for no token, an empty one and one that is too long', async () => {
        for (const payload of [{}, { token: '' }, { token: 'x'.repeat(257) }]) {
          const response = await send('POST', '/invites/inspect', { payload });
          expect(response.statusCode).toBe(400);
        }
      });

      it('counts against the strict limit per address: the eleventh request is a 429 with Retry-After, and another address is not limited', async () => {
        const address = '10.99.1.1';
        const statuses: number[] = [];
        for (let i = 0; i < AUTH_RATE_LIMIT.max; i += 1) {
          statuses.push(
            (await inspectRoute('nobody-made-this', { remoteAddress: address }))
              .statusCode,
          );
        }
        expect(statuses).toEqual(Array(AUTH_RATE_LIMIT.max).fill(401));
        const limited = await inspectRoute('nobody-made-this', {
          remoteAddress: address,
        });
        expect(limited.statusCode).toBe(429);
        expect(limited.json()).toMatchObject({ code: 'rate-limited' });
        expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(
          1,
        );
        const fresh = await make();
        expect((await inspectRoute(fresh.token)).statusCode).toBe(200);
      });
    });

    describe('POST /invites/accept with no session', () => {
      it('is a 403 origin-mismatch for a foreign Origin and for none', async () => {
        const made = await make();
        for (const origin of [FOREIGN_ORIGIN, null]) {
          const response = await acceptRoute(made.token, {
            origin,
            account: newAccount('origin.check@demopictures.example'),
          });
          expect(response.statusCode).toBe(403);
          expect(response.json()).toMatchObject({ code: 'origin-mismatch' });
        }
        // The invite was not used by either.
        expect((await inviteRow(made.id)).usedAt).toBeNull();
      });

      it('makes the account, the membership with the tier and roles, and a signed-in session, and answers 201', async () => {
        const made = await make({
          tier: 'guest',
          roleIds: [crewRoleId, editorRoleId],
        });
        const response = await acceptRoute(made.token, {
          account: newAccount('Newcomer.One@DemoPictures.example', {
            password: PASSWORD,
          }),
        });
        expect(response.statusCode, response.body).toBe(201);
        expect(response.headers['cache-control']).toBe('no-store');
        const body = response.json<{
          user: { id: string; email: string };
          organisation: { id: string; name: string };
          mustSecureAccount: boolean;
        }>();
        expect(body).toMatchObject({
          user: {
            email: 'newcomer.one@demopictures.example',
            displayName: 'Sam Demo',
            status: 'active',
          },
          organisation: { id: organisationId, name: 'Demo Pictures' },
          mustSecureAccount: false,
        });
        const [membership] = (await db().select().from(orgMembership)).filter(
          (found) => found.userId === body.user.id,
        );
        expect(membership).toMatchObject({
          organisationId,
          orgRole: 'guest',
          status: 'active',
        });
        expect(
          (await db().select().from(orgMembershipRole))
            .filter((link) => link.membershipId === membership!.id)
            .map((link) => link.roleId)
            .sort(),
        ).toEqual([crewRoleId, editorRoleId].sort());
        expect((await inviteRow(made.id)).usedBy).toBe(body.user.id);
        // The cookie is a full session: it works on a route a recovery session may not call.
        const cookie = sessionCookieOf(response);
        expect(cookie).not.toBeNull();
        const sessions = await send('GET', '/auth/sessions', {
          token: cookie!,
        });
        expect(sessions.statusCode).toBe(200);
        expect(sessions.json<{ method: string }[]>()[0]).toMatchObject({
          method: 'invite',
        });
        // No secret reached a body: the password is in no response.
        expect(response.body).not.toContain(PASSWORD);
      });

      it('with no password answers mustSecureAccount and a recovery session that may only secure the account', async () => {
        const made = await make();
        const response = await acceptRoute(made.token, {
          account: newAccount('no.password@demopictures.example'),
        });
        expect(response.statusCode).toBe(201);
        expect(response.json()).toMatchObject({ mustSecureAccount: true });
        const cookie = sessionCookieOf(response)!;
        expect(
          (await send('GET', '/auth/me', { token: cookie })).statusCode,
        ).toBe(200);
        const blocked = await send('GET', '/auth/sessions', { token: cookie });
        expect(blocked.statusCode).toBe(403);
        expect(blocked.json()).toMatchObject({
          code: 'account-recovery-required',
        });
        // ... and a recovery session cannot accept another invite.
        const another = await make();
        const refused = await acceptRoute(another.token, { cookie });
        expect(refused.statusCode).toBe(403);
        expect(refused.json()).toMatchObject({
          code: 'account-recovery-required',
        });
        expect((await inviteRow(another.id)).usedAt).toBeNull();
      });

      it('is a 400 with no account, and for an account that is not shaped as the route takes', async () => {
        const made = await make();
        expect((await acceptRoute(made.token)).statusCode).toBe(400);
        for (const account of [
          { email: 'not an address', displayName: 'X' },
          { email: 'ok@demopictures.example', displayName: '' },
          { email: 'ok@demopictures.example' },
        ]) {
          expect((await acceptRoute(made.token, { account })).statusCode).toBe(
            400,
          );
        }
        expect((await inviteRow(made.id)).usedAt).toBeNull();
      });

      it('is a 422 invite-email-mismatch for another address, makes nothing and leaves the invite usable', async () => {
        const made = await make({ email: 'named.only@demopictures.example' });
        const users = (await db().select().from(user)).length;
        const response = await acceptRoute(made.token, {
          account: newAccount('someone.else@demopictures.example'),
        });
        expect(response.statusCode).toBe(422);
        expect(response.json()).toMatchObject({
          code: 'invite-email-mismatch',
        });
        expect(response.body).not.toContain('someone.else');
        expect(response.body).not.toContain('named.only');
        expect((await db().select().from(user)).length).toBe(users);
        expect((await inviteRow(made.id)).usedAt).toBeNull();
        // The address it names works.
        expect(
          (
            await acceptRoute(made.token, {
              account: newAccount('NAMED.only@demopictures.example'),
            })
          ).statusCode,
        ).toBe(201);
      });

      it('is a 409 account-exists for an address that has an account, and leaves the invite usable', async () => {
        const made = await make();
        const users = (await db().select().from(user)).length;
        const response = await acceptRoute(made.token, {
          account: newAccount('ada.demo@demopictures.example'),
        });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ code: 'account-exists' });
        expect((await db().select().from(user)).length).toBe(users);
        expect((await inviteRow(made.id)).usedAt).toBeNull();
        expect(
          (await db().select().from(auditEvent)).some(
            (found) =>
              found.category === AUTH_AUDIT.inviteAcceptRefused &&
              found.targetId === made.id &&
              (found.details as { reason: string }).reason === 'account-exists',
          ),
        ).toBe(true);
      });

      it('is a 422 password-refused for a password the policy refuses, with the reason at account.password, and the invite is usable again', async () => {
        const made = await make();
        const users = (await db().select().from(user)).length;
        const response = await acceptRoute(made.token, {
          account: newAccount('short.password@demopictures.example', {
            password: 'short',
          }),
        });
        expect(response.statusCode).toBe(422);
        expect(response.json()).toMatchObject({
          code: 'password-refused',
          errors: [{ in: 'body', path: 'account.password', code: 'too-short' }],
        });
        expect(response.body).not.toContain('short.password');
        expect((await db().select().from(user)).length).toBe(users);
        expect((await inviteRow(made.id)).usedAt).toBeNull();
        expect(
          (
            await acceptRoute(made.token, {
              account: newAccount('short.password@demopictures.example', {
                password: PASSWORD,
              }),
            })
          ).statusCode,
        ).toBe(201);
      });

      it('answers an unknown, used, revoked and expired token with one and the same 401', async () => {
        const used = await make();
        await acceptRoute(used.token, {
          account: newAccount('same.used@demopictures.example'),
        });
        const revoked = await make();
        await revokeRoute(revoked.id);
        const expiring = await make({ expiresInDays: 1 });
        const answers = [
          await acceptRoute('a-token-nobody-made', {
            account: newAccount('x1@demopictures.example'),
          }),
          await acceptRoute(used.token, {
            account: newAccount('x2@demopictures.example'),
          }),
          await acceptRoute(revoked.token, {
            account: newAccount('x3@demopictures.example'),
          }),
        ];
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.now() + 2 * DAY);
        answers.push(
          await acceptRoute(expiring.token, {
            account: newAccount('x4@demopictures.example'),
          }),
        );
        for (const response of answers) {
          expect(response.statusCode).toBe(401);
          expect(response.json()).toMatchObject({ code: 'invite-invalid' });
        }
        expect(
          new Set(answers.map((response) => sameness(response.json()))).size,
        ).toBe(1);
      });

      it('counts against the strict limit per address', async () => {
        const address = '10.99.2.1';
        const statuses: number[] = [];
        for (let i = 0; i < AUTH_RATE_LIMIT.max; i += 1) {
          statuses.push(
            (
              await acceptRoute('nobody-made-this', {
                account: newAccount('limit@demopictures.example'),
                remoteAddress: address,
              })
            ).statusCode,
          );
        }
        expect(statuses).toEqual(Array(AUTH_RATE_LIMIT.max).fill(401));
        const limited = await acceptRoute('nobody-made-this', {
          account: newAccount('limit@demopictures.example'),
          remoteAddress: address,
        });
        expect(limited.statusCode).toBe(429);
        expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(
          1,
        );
      });

      it('undoes the account, the membership and the used mark when a step fails, and the invite is usable again', async () => {
        const made = await make();
        const users = (await db().select().from(user)).length;
        const sessions = (await db().select().from(session)).length;
        await db().execute(
          `create function osfpm_test_refuse_membership() returns trigger language plpgsql as $$ begin raise exception 'forced failure'; end; $$`,
        );
        await db().execute(
          `create trigger osfpm_test_refuse_membership before insert on org_membership for each row execute function osfpm_test_refuse_membership()`,
        );
        try {
          const response = await acceptRoute(made.token, {
            account: newAccount('rolled.back@demopictures.example', {
              password: PASSWORD,
            }),
          });
          expect(response.statusCode).toBe(500);
          expect(response.body).not.toContain('forced failure');
        } finally {
          await db().execute(
            'drop trigger osfpm_test_refuse_membership on org_membership',
          );
          await db().execute('drop function osfpm_test_refuse_membership()');
        }
        expect((await db().select().from(user)).length).toBe(users);
        expect((await db().select().from(session)).length).toBe(sessions);
        expect((await inviteRow(made.id)).usedAt).toBeNull();
        expect(
          (
            await acceptRoute(made.token, {
              account: newAccount('rolled.back@demopictures.example', {
                password: PASSWORD,
              }),
            })
          ).statusCode,
        ).toBe(201);
      });
    });

    describe('POST /invites/accept with a session', () => {
      /** A signed-in user with an invented address, and the session cookie they would have. */
      async function signedInUser(email: string) {
        const userId = await seedActiveUserWithEmail(ctx.database, email);
        return { userId, cookie: await sessionOf(userId) };
      }

      it('makes the signed-in user a member with the tier and roles, makes no new session, and answers 201', async () => {
        const { userId, cookie } = await signedInUser(
          'joiner.one@demopictures.example',
        );
        const made = await make({ tier: 'supervisor', roleIds: [crewRoleId] });
        const sessions = (await db().select().from(session)).length;
        const response = await acceptRoute(made.token, { cookie });
        expect(response.statusCode, response.body).toBe(201);
        expect(response.json()).toMatchObject({
          user: { id: userId, email: 'joiner.one@demopictures.example' },
          organisation: { id: organisationId },
          mustSecureAccount: false,
        });
        expect(sessionCookieOf(response)).toBeNull();
        expect((await db().select().from(session)).length).toBe(sessions);
        const [membership] = (await db().select().from(orgMembership)).filter(
          (found) => found.userId === userId,
        );
        expect(membership).toMatchObject({
          orgRole: 'supervisor',
          status: 'active',
        });
        expect((await inviteRow(made.id)).usedBy).toBe(userId);
      });

      it('is a 400 when an account is sent with a session, and the invite is not used', async () => {
        const { cookie } = await signedInUser(
          'joiner.two@demopictures.example',
        );
        const made = await make();
        const response = await acceptRoute(made.token, {
          cookie,
          account: newAccount('joiner.three@demopictures.example'),
        });
        expect(response.statusCode).toBe(400);
        expect((await inviteRow(made.id)).usedAt).toBeNull();
      });

      it('is a 409 already-member for a user who already belongs, and leaves the invite usable', async () => {
        const made = await make();
        const response = await acceptRoute(made.token, {
          cookie: inviterToken,
        });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ code: 'already-member' });
        expect((await inviteRow(made.id)).usedAt).toBeNull();
      });

      it('is a 422 invite-email-mismatch for a user whose address is not the one named, and accepts the one that is', async () => {
        const made = await make({ email: 'named.member@demopictures.example' });
        const wrong = await signedInUser('wrong.member@demopictures.example');
        const refused = await acceptRoute(made.token, { cookie: wrong.cookie });
        expect(refused.statusCode).toBe(422);
        expect(refused.json()).toMatchObject({ code: 'invite-email-mismatch' });
        expect((await inviteRow(made.id)).usedAt).toBeNull();
        const right = await signedInUser('named.member@demopictures.example');
        expect(
          (await acceptRoute(made.token, { cookie: right.cookie })).statusCode,
        ).toBe(201);
      });

      it('is a 403 account-recovery-required for a recovery session, and a 401 for a cookie that is no good', async () => {
        const made = await make();
        const recovery = await signedInUser('recovering@demopictures.example');
        const token = await sessionOf(recovery.userId, 'recovery');
        const refused = await acceptRoute(made.token, { cookie: token });
        expect(refused.statusCode).toBe(403);
        expect(refused.json()).toMatchObject({
          code: 'account-recovery-required',
        });
        // No account made as a way round: a cookie that is no good is a 401, not "no session".
        const bad = await acceptRoute(made.token, {
          cookie: 'not-a-session',
          account: newAccount('around@demopictures.example'),
        });
        expect(bad.statusCode).toBe(401);
        expect(bad.json()).toMatchObject({ code: 'authentication-required' });
        expect((await inviteRow(made.id)).usedAt).toBeNull();
      });

      it('is a 401 for a session that was revoked', async () => {
        const made = await make();
        const gone = await signedInUser('signed.out@demopictures.example');
        expect(
          (await send('POST', '/auth/logout', { token: gone.cookie }))
            .statusCode,
        ).toBe(204);
        const response = await acceptRoute(made.token, { cookie: gone.cookie });
        expect(response.statusCode).toBe(401);
        expect((await inviteRow(made.id)).usedAt).toBeNull();
      });
    });

    describe('what the invite flows keep out of logs, events and error bodies', () => {
      it('holds no token, password, hash or address an invite carried in any log line, audit event, change event or error body', async () => {
        // Every flow above has run. The tokens are only ever in the response that made them.
        expect(tokens.length).toBeGreaterThan(20);
        const logs = ctx.lines.join('\n');
        const events = JSON.stringify(await db().select().from(auditEvent));
        const changes = JSON.stringify(await db().select().from(changeEvent));
        const errors = errorBodies.join('\n');
        for (const token of tokens) {
          for (const [where, text] of [
            ['log', logs],
            ['audit', events],
            ['change', changes],
            ['error body', errors],
          ] as const) {
            expect(text, `${where}: ${token.slice(0, 4)}`).not.toContain(token);
          }
        }
        const typed = [
          PASSWORD,
          SAM,
          ALEX,
          'newcomer.one@demopictures.example',
          'no.password@demopictures.example',
          'named.only@demopictures.example',
          'someone.else@demopictures.example',
          'short.password@demopictures.example',
          'rolled.back@demopictures.example',
        ];
        for (const value of typed) {
          for (const [where, text] of [
            ['log', logs],
            ['audit', events],
            ['change', changes],
            ['error body', errors],
          ] as const) {
            expect(text, `${where}: ${value}`).not.toContain(value);
          }
        }
        // The cookie that signs a new account in is in a header, never in a line.
        expect(logs).not.toContain(SESSION_COOKIE);
        // No token is stored, in any table: only hashes.
        const stored = await everyRowAsText(ctx.database);
        for (const token of tokens) expect(stored).not.toContain(token);
      });
    });
  },
);

/** The PostgreSQL target, when `DATABASE_URL` names a server. PGlite has one connection, so it cannot run this. */
const postgres = testTargets.find((target) => target.name === 'postgres');

describe.skipIf(postgres === undefined)(
  'two accepts of one invite at once over HTTP, on PostgreSQL',
  () => {
    it('makes one membership and answers the other with the 401 invite-invalid', async () => {
      const ctx = await createTestApp(postgres!, { logLevel: 'info' });
      try {
        await migrate(ctx.database);
        const code = await seedFirstRun(ctx.database);
        const done = await completeFirstRunSetup(
          ctx.database.db,
          demoSetupInput(code),
          new Date(),
        );
        if (!done.ok) throw new Error('the setup was refused');
        const admin = (
          await createSession(ctx.database.db, {
            userId: done.user.id,
            method: 'password',
            now: new Date(),
          })
        ).token;
        const created = await ctx.app.inject({
          method: 'POST',
          url: `${API_PREFIX}/organisations/${done.organisation.id}/invites`,
          headers: {
            origin: TEST_PUBLIC_ORIGIN,
            cookie: `${SESSION_COOKIE}=${admin}`,
          },
          remoteAddress: '10.12.0.1',
          payload: { tier: 'member', roleIds: [] },
        });
        expect(created.statusCode).toBe(201);
        const token = created.json<{ link: string }>().link.split('#')[1]!;
        const before = (await ctx.database.db.select().from(orgMembership))
          .length;
        const responses = await Promise.all(
          ['one', 'two', 'three', 'four'].map((name, index) =>
            ctx.app.inject({
              method: 'POST',
              url: `${API_PREFIX}/invites/accept`,
              headers: { origin: TEST_PUBLIC_ORIGIN },
              remoteAddress: `10.12.0.${index + 2}`,
              payload: {
                token,
                account: {
                  email: `${name}.race@demopictures.example`,
                  displayName: name,
                },
              },
            }),
          ),
        );
        expect(responses.map((response) => response.statusCode).sort()).toEqual(
          [201, 401, 401, 401],
        );
        expect(
          (await ctx.database.db.select().from(orgMembership)).length,
        ).toBe(before + 1);
      } finally {
        await ctx.close();
      }
    });
  },
);
