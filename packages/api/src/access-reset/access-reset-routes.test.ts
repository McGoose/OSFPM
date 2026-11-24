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
import { seedUser } from '@osfpm/core/src/access/test-fixtures.js';
import { generateRecoveryCodes } from '@osfpm/core/src/auth/recovery.js';
import { createSession } from '@osfpm/core/src/auth/sessions.js';
import { AUTH_AUDIT, lockUser } from '@osfpm/core/src/auth/shared.js';
import {
  emailOf,
  everyRowAsText,
  markUserDeleted,
  seedMembership,
  seedPasskey,
  seedPassword,
  seedResetScene,
  seedTotp,
  setMembershipStatus,
  setMembershipTier,
  setUserStatus,
  type ResetScene,
} from '@osfpm/core/src/auth/test-support.js';
import { migrate } from '@osfpm/core/src/db/migrate.js';
import {
  accessReset,
  auditEvent,
  changeEvent,
  passkeyCredential,
  passwordCredential,
  recoveryCode,
  session,
  totpCredential,
} from '@osfpm/core/src/db/schema/index.js';
import {
  lockWaiters,
  testTargets,
  type TestTarget,
} from '@osfpm/core/src/db/test-support.js';
import { API_PREFIX } from '../api-version.js';
import { SESSION_COOKIE } from '../auth/cookie.js';
import { AUTH_RATE_LIMIT } from '../auth/rate-limit.js';
import {
  createTestApp,
  TEST_PUBLIC_ORIGIN,
  TEST_SERVER_KEYS,
} from '../test-support.js';

const HOUR = 60 * 60 * 1000;
const FOREIGN_ORIGIN = 'https://attacker.example.test';

// Invented passwords; none is real, and none holds a word of the fixture
// addresses or of the password policy's list.
const OLD_PASSWORD = 'meadow-lantern-slow-river';
const NEW_PASSWORD = 'harbour-lantern-quiet-river';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

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
  'the admin reset routes on $name',
  (target: TestTarget) => {
    let ctx: Awaited<ReturnType<typeof createTestApp>>;
    let scene: ResetScene;
    let ownerToken: string;
    let adminToken: string;
    let resetterToken: string;
    let plainToken: string;
    let strangerToken: string;
    let addresses = 0;

    /** Every reset token a flow below made, which must stay out of logs, events and error bodies. */
    const tokens: string[] = [];
    const errorBodies: string[] = [];
    /** The addresses of the people the flows reset, which must stay out of them too. */
    const emails: string[] = [];

    beforeAll(async () => {
      ctx = await createTestApp(target, { logLevel: 'trace' });
      await migrate(ctx.database);
      scene = await seedResetScene(ctx.database, new Date());
      ownerToken = await sessionOf(scene.ownerId);
      adminToken = await sessionOf(scene.adminId);
      resetterToken = await sessionOf(scene.resetterId);
      plainToken = await sessionOf(scene.plainId);
      strangerToken = await sessionOf(scene.strangerId);
    });
    afterAll(async () => {
      await ctx.close();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const db = () => ctx.database.db;
    const freshAddress = () =>
      `10.21.${Math.floor(addresses / 250)}.${(addresses++ % 250) + 1}`;

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

    const linkPath = (userId: string, org: string = scene.organisationId) =>
      `/organisations/${org}/members/${userId}/reset-link`;
    const createRoute = (
      userId: string,
      payload: unknown = {},
      options: { token?: string; org?: string; origin?: string | null } = {},
    ) =>
      send('POST', linkPath(userId, options.org), {
        token: options.token ?? ownerToken,
        payload,
        ...(options.origin === undefined ? {} : { origin: options.origin }),
      });
    const revokeRoute = (
      userId: string,
      options: { token?: string; org?: string; origin?: string | null } = {},
    ) =>
      send('DELETE', linkPath(userId, options.org), {
        token: options.token ?? ownerToken,
        ...(options.origin === undefined ? {} : { origin: options.origin }),
      });
    const inspectRoute = (
      token: unknown,
      options: {
        origin?: string | null;
        cookie?: string;
        address?: string;
      } = {},
    ) =>
      send('POST', '/access-reset/inspect', {
        payload: { token },
        ...(options.origin === undefined ? {} : { origin: options.origin }),
        ...(options.cookie === undefined ? {} : { token: options.cookie }),
        ...(options.address === undefined
          ? {}
          : { remoteAddress: options.address }),
      });
    const useRoute = (
      token: unknown,
      options: {
        origin?: string | null;
        cookie?: string;
        address?: string;
      } = {},
    ) =>
      send('POST', '/access-reset', {
        payload: { token },
        ...(options.origin === undefined ? {} : { origin: options.origin }),
        ...(options.cookie === undefined ? {} : { token: options.cookie }),
        ...(options.address === undefined
          ? {}
          : { remoteAddress: options.address }),
      });

    /** A member of the organisation holding `accounts:read`, whose address is kept for the scans. */
    async function makeTarget(
      options: {
        roleIds?: readonly string[];
        membershipStatus?: 'active' | 'invited' | 'removed';
      } = {},
    ) {
      const userId = await seedUser(ctx.database);
      await seedMembership(
        ctx.database,
        scene.organisationId,
        userId,
        'member',
        options.roleIds ?? [scene.roles.crew],
        options.membershipStatus === undefined
          ? {}
          : { status: options.membershipStatus },
      );
      const email = await emailOf(ctx.database, userId);
      emails.push(email);
      return { userId, email };
    }

    /** A member who is locked out: a password, an authenticator, recovery codes, two passkeys and a session. */
    async function lockedOut() {
      const person = await makeTarget();
      await seedPassword(ctx.database, person.userId, OLD_PASSWORD);
      await seedTotp(ctx.database, person.userId, {
        dataKeys: TEST_SERVER_KEYS.dataKeys,
      });
      await generateRecoveryCodes(db(), person.userId, { now: new Date() });
      const passkeys = [
        await seedPasskey(ctx.database, person.userId),
        await seedPasskey(ctx.database, person.userId),
      ];
      const oldSession = await sessionOf(person.userId);
      return { ...person, passkeys, oldSession };
    }

    /** Makes a link as `token`'s user, which must succeed, and keeps the token for the scans. */
    async function makeLink(
      userId: string,
      body: Record<string, unknown> = {},
      actorToken: string = ownerToken,
    ) {
      const response = await createRoute(userId, body, { token: actorToken });
      expect(response.statusCode, response.body).toBe(201);
      const json = response.json<{
        link: string;
        expiresAt: string;
        removePasskeys: boolean;
      }>();
      const token = json.link.split('#')[1]!;
      tokens.push(token);
      return { token, json };
    }

    const linkRowsOf = async (userId: string) =>
      (await db().select().from(accessReset)).filter(
        (found) => found.userId === userId,
      );
    const sessionCookieOf = (response: { headers: OutgoingHttpHeaders }) => {
      const line = setCookies(response.headers).find((found) =>
        found.startsWith(`${SESSION_COOKIE}=`),
      );
      return line === undefined ? null : line.split(';')[0]!.split('=')[1]!;
    };
    /** The events of one category, in the order they were written (ids are UUIDv7). */
    const eventsOf = async (category: string) =>
      (await db().select().from(auditEvent))
        .filter((event) => event.category === category)
        .sort((a, b) => a.id.localeCompare(b.id));

    describe('POST /organisations/:organisationId/members/:userId/reset-link', () => {
      it('is a 401 with no session', async () => {
        const person = await makeTarget();
        const response = await send('POST', linkPath(person.userId), {
          payload: {},
        });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toMatchObject({
          code: 'authentication-required',
        });
      });

      it('is a 403 origin-mismatch for a foreign Origin, and for none, with a cookie', async () => {
        const person = await makeTarget();
        for (const origin of [FOREIGN_ORIGIN, null]) {
          const response = await createRoute(person.userId, {}, { origin });
          expect(response.statusCode).toBe(403);
          expect(response.json()).toMatchObject({ code: 'origin-mismatch' });
        }
        expect(await linkRowsOf(person.userId)).toEqual([]);
      });

      it('is a 403 account-recovery-required for a recovery session', async () => {
        const person = await makeTarget();
        const token = await sessionOf(scene.ownerId, 'recovery');
        const response = await createRoute(person.userId, {}, { token });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({
          code: 'account-recovery-required',
        });
        expect(await linkRowsOf(person.userId)).toEqual([]);
      });

      it('is a 403 without members:reset-access, for a member without it, a stranger, an organisation that does not exist, a person who is not a member and a user that does not exist, with one and the same body', async () => {
        const person = await makeTarget();
        const unknown = '00000000-0000-7000-8000-000000000000';
        const answers = [
          await createRoute(person.userId, {}, { token: plainToken }),
          await createRoute(person.userId, {}, { token: strangerToken }),
          await createRoute(person.userId, {}, { org: unknown }),
          await createRoute(scene.strangerId, {}),
          await createRoute(unknown, {}),
        ];
        for (const response of answers) {
          expect(response.statusCode).toBe(403);
          expect(response.json()).toMatchObject({ code: 'access-denied' });
        }
        expect(
          new Set(answers.map((response) => sameness(response.json()))).size,
        ).toBe(1);
        expect(await linkRowsOf(person.userId)).toEqual([]);
      });

      it('is a 400 for an id that is not a UUID and for a body that is not acceptable', async () => {
        const person = await makeTarget();
        expect((await createRoute('not-a-uuid', {}, {})).statusCode).toBe(400);
        expect(
          (await createRoute(person.userId, {}, { org: 'not-a-uuid' }))
            .statusCode,
        ).toBe(400);
        for (const body of [
          { expiresInHours: 0 },
          { expiresInHours: 73 },
          { expiresInHours: 1.5 },
          { expiresInHours: '24' },
          { removePasskeys: 'yes' },
          { removePasskeys: 1 },
        ]) {
          const response = await createRoute(person.userId, body);
          expect(response.statusCode, JSON.stringify(body)).toBe(400);
          expect(response.json()).toMatchObject({ code: 'validation-failed' });
        }
        expect(await linkRowsOf(person.userId)).toEqual([]);
      });

      it('makes the link: 201 with the link, when it ends and whether passkeys go too, shown once, and nothing about the person', async () => {
        const person = await makeTarget();
        const before = Date.now();
        const response = await createRoute(person.userId, {});
        expect(response.statusCode).toBe(201);
        expect(response.headers['cache-control']).toBe('no-store');
        const json = response.json<Record<string, unknown>>();
        expect(Object.keys(json).sort()).toEqual([
          'expiresAt',
          'link',
          'removePasskeys',
        ]);
        expect(json.removePasskeys).toBe(false);
        // `<OSFPM_PUBLIC_URL>/reset#<token>`: the token is in the fragment.
        expect(json.link).toMatch(
          new RegExp(`^${TEST_PUBLIC_ORIGIN}/reset#[A-Za-z0-9_-]{43}$`),
        );
        tokens.push((json.link as string).split('#')[1]!);
        // A day from now, by default.
        const ends = Date.parse(json.expiresAt as string);
        expect(ends).toBeGreaterThanOrEqual(before + 24 * HOUR - 1000);
        expect(ends).toBeLessThanOrEqual(Date.now() + 24 * HOUR + 1000);
        // Nothing about the person, and no token or hash anywhere else in the body.
        const text = response.body;
        for (const secret of [person.email, person.userId]) {
          expect(text).not.toContain(secret);
        }
      });

      it('takes the hours and the passkey flag it is given', async () => {
        const person = await makeTarget();
        const made = await makeLink(person.userId, {
          expiresInHours: 1,
          removePasskeys: true,
        });
        expect(made.json.removePasskeys).toBe(true);
        const ends = Date.parse(made.json.expiresAt);
        expect(ends).toBeLessThanOrEqual(Date.now() + HOUR + 1000);
        expect(ends).toBeGreaterThan(Date.now() + HOUR - 5000);
        const [row] = await linkRowsOf(person.userId);
        expect(row).toMatchObject({
          removePasskeys: true,
          createdBy: scene.ownerId,
        });
      });

      it('takes a request with no body and no content type as {}: the same 201 with every default', async () => {
        const person = await makeTarget();
        const before = Date.now();
        // No payload at all, as `curl -X POST` sends it: not `{}`, and not JSON.
        const response = await send('POST', linkPath(person.userId), {
          token: ownerToken,
        });
        expect(response.statusCode).toBe(201);
        const json = response.json<Record<string, unknown>>();
        expect(Object.keys(json).sort()).toEqual([
          'expiresAt',
          'link',
          'removePasskeys',
        ]);
        expect(json.removePasskeys).toBe(false);
        tokens.push((json.link as string).split('#')[1]!);
        const ends = Date.parse(json.expiresAt as string);
        expect(ends).toBeGreaterThanOrEqual(before + 24 * HOUR - 1000);
        expect(ends).toBeLessThanOrEqual(Date.now() + 24 * HOUR + 1000);
        const [row] = await linkRowsOf(person.userId);
        expect(row).toMatchObject({
          removePasskeys: false,
          createdBy: scene.ownerId,
        });
      });

      it('still refuses a body that says it is JSON and is empty, and one that is not an object', async () => {
        const person = await makeTarget();
        for (const payload of ['', '[]', '"x"', '1']) {
          const response = await ctx.app.inject({
            method: 'POST',
            url: `${API_PREFIX}${linkPath(person.userId)}`,
            headers: {
              cookie: `${SESSION_COOKIE}=${ownerToken}`,
              origin: TEST_PUBLIC_ORIGIN,
              'content-type': 'application/json',
            },
            payload,
            remoteAddress: freshAddress(),
          });
          expect(response.statusCode, JSON.stringify(payload)).toBe(400);
        }
        expect(await linkRowsOf(person.userId)).toEqual([]);
      });

      it('lets a member who holds only the permission make a link, and shows them no more than the one answer, without any sensitive field', async () => {
        // This member has no sensitive:read of any kind.
        const nothing = await makeTarget({ roleIds: [] });
        const response = await createRoute(
          nothing.userId,
          {},
          { token: resetterToken },
        );
        expect(response.statusCode).toBe(201);
        expect(Object.keys(response.json<object>()).sort()).toEqual([
          'expiresAt',
          'link',
          'removePasskeys',
        ]);
        tokens.push(response.json<{ link: string }>().link.split('#')[1]!);
        expect(response.body).not.toContain(nothing.email);
      });

      it('is a 422 cannot-reset-self for the person asking', async () => {
        const response = await createRoute(scene.ownerId, {});
        expect(response.statusCode).toBe(422);
        expect(response.json()).toMatchObject({ code: 'cannot-reset-self' });
      });

      it('is a 422 user-in-other-organisations for a person who belongs to another organisation too', async () => {
        const person = await makeTarget();
        await seedMembership(
          ctx.database,
          scene.otherOrganisationId,
          person.userId,
          'member',
          [],
          { status: 'removed' },
        );
        const response = await createRoute(person.userId, {});
        expect(response.statusCode).toBe(422);
        expect(response.json()).toMatchObject({
          code: 'user-in-other-organisations',
        });
        expect(await linkRowsOf(person.userId)).toEqual([]);
      });

      it('is a 422 owner-reset-needs-owner for an administrator who is not an owner, and lets an owner through', async () => {
        const secondOwner = await seedUser(ctx.database);
        await seedMembership(
          ctx.database,
          scene.organisationId,
          secondOwner,
          'owner',
          [scene.roles.administrator],
        );
        const refused = await createRoute(
          secondOwner,
          {},
          { token: adminToken },
        );
        expect(refused.statusCode).toBe(422);
        expect(refused.json()).toMatchObject({
          code: 'owner-reset-needs-owner',
        });
        await makeLink(secondOwner, {}, ownerToken);
      });

      it('is a 422 reset-exceeds-own-access, listing the permission keys, for a person who holds more than the creator', async () => {
        const editor = await makeTarget({ roleIds: [scene.roles.editor] });
        const response = await createRoute(
          editor.userId,
          {},
          { token: resetterToken },
        );
        expect(response.statusCode).toBe(422);
        const body = response.json<{
          code: string;
          errors: { in: string; path: string; code: string }[];
        }>();
        expect(body.code).toBe('reset-exceeds-own-access');
        expect(body.errors).toEqual([
          { in: 'params', path: 'userId', code: 'accounts:edit' },
          { in: 'params', path: 'userId', code: 'accounts:read' },
        ]);
      });

      it('is a 422 user-not-active for a person whose account is disabled or deleted', async () => {
        const disabled = await makeTarget();
        await setUserStatus(ctx.database, disabled.userId, 'disabled');
        const deleted = await makeTarget();
        await markUserDeleted(ctx.database, deleted.userId);
        for (const person of [disabled, deleted]) {
          const response = await createRoute(person.userId, {});
          expect(response.statusCode).toBe(422);
          expect(response.json()).toMatchObject({ code: 'user-not-active' });
        }
      });

      it('is a 422 membership-not-active for a person whose membership was removed or is only an invitation', async () => {
        for (const membershipStatus of ['removed', 'invited'] as const) {
          const person = await makeTarget({ membershipStatus });
          const response = await createRoute(person.userId, {});
          expect(response.statusCode, membershipStatus).toBe(422);
          expect(response.json(), membershipStatus).toMatchObject({
            code: 'membership-not-active',
          });
          expect(await linkRowsOf(person.userId)).toEqual([]);
        }
      });

      it('replaces the earlier link for the person: the old link stops working and the new one works', async () => {
        const person = await makeTarget();
        const first = await makeLink(person.userId);
        const second = await makeLink(person.userId, {}, adminToken);
        expect((await inspectRoute(first.token)).statusCode).toBe(401);
        expect((await inspectRoute(second.token)).statusCode).toBe(200);
        const rows = await linkRowsOf(person.userId);
        expect(rows.filter((row) => row.revokedAt === null)).toHaveLength(1);
      });
    });

    describe('DELETE /organisations/:organisationId/members/:userId/reset-link', () => {
      it('is a 401 with no session, a 403 for a foreign Origin and for a recovery session', async () => {
        const person = await makeTarget();
        await makeLink(person.userId);
        const none = await send('DELETE', linkPath(person.userId));
        expect(none.statusCode).toBe(401);
        for (const origin of [FOREIGN_ORIGIN, null]) {
          const response = await revokeRoute(person.userId, { origin });
          expect(response.statusCode).toBe(403);
          expect(response.json()).toMatchObject({ code: 'origin-mismatch' });
        }
        const recovery = await sessionOf(scene.ownerId, 'recovery');
        const refused = await revokeRoute(person.userId, { token: recovery });
        expect(refused.statusCode).toBe(403);
        expect(refused.json()).toMatchObject({
          code: 'account-recovery-required',
        });
        // Still live after all of that.
        expect(
          (await linkRowsOf(person.userId)).filter(
            (row) => row.revokedAt === null,
          ),
        ).toHaveLength(1);
      });

      it('is a 403 without members:reset-access, with one and the same body for a member without it, a stranger and an organisation that does not exist', async () => {
        const person = await makeTarget();
        const made = await makeLink(person.userId);
        const unknown = '00000000-0000-7000-8000-000000000000';
        const answers = [
          await revokeRoute(person.userId, { token: plainToken }),
          await revokeRoute(person.userId, { token: strangerToken }),
          await revokeRoute(person.userId, { org: unknown }),
        ];
        for (const response of answers) {
          expect(response.statusCode).toBe(403);
          expect(response.json()).toMatchObject({ code: 'access-denied' });
        }
        expect(
          new Set(answers.map((response) => sameness(response.json()))).size,
        ).toBe(1);
        expect((await inspectRoute(made.token)).statusCode).toBe(200);
      });

      it('revokes the live link: 204 with no body, the link stops working, and a second revoke is a 404', async () => {
        const person = await makeTarget();
        const made = await makeLink(person.userId);
        const response = await revokeRoute(person.userId);
        expect(response.statusCode).toBe(204);
        expect(response.body).toBe('');
        expect((await inspectRoute(made.token)).statusCode).toBe(401);
        const again = await revokeRoute(person.userId);
        expect(again.statusCode).toBe(404);
        expect(again.json()).toMatchObject({ code: 'not-found' });
      });

      it('is a 404 when there is no live link: none made, one already used, and a person who is not a member', async () => {
        const none = await makeTarget();
        expect((await revokeRoute(none.userId)).statusCode).toBe(404);
        const spent = await lockedOut();
        const made = await makeLink(spent.userId);
        expect((await useRoute(made.token)).statusCode).toBe(200);
        expect((await revokeRoute(spent.userId)).statusCode).toBe(404);
        expect((await revokeRoute(scene.strangerId)).statusCode).toBe(404);
      });

      it('is a 400 for an id that is not a UUID', async () => {
        expect((await revokeRoute('not-a-uuid')).statusCode).toBe(400);
      });
    });

    describe('POST /access-reset/inspect', () => {
      it('says when a live link ends and nothing else: no name, no address, no organisation, and no session needed', async () => {
        const person = await makeTarget();
        const made = await makeLink(person.userId);
        const response = await inspectRoute(made.token);
        expect(response.statusCode).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        const json = response.json<Record<string, unknown>>();
        expect(Object.keys(json)).toEqual(['expiresAt']);
        expect(json.expiresAt).toBe(made.json.expiresAt);
        for (const text of [
          person.email,
          person.userId,
          scene.organisationId,
          'Demo Pictures',
        ]) {
          expect(response.body).not.toContain(text);
        }
        // Looking uses nothing up.
        expect((await inspectRoute(made.token)).statusCode).toBe(200);
        expect((await linkRowsOf(person.userId))[0]!.usedAt).toBeNull();
      });

      it('answers every link that does not work with one 401 reset-link-invalid, whatever the reason', async () => {
        const unknownToken = 'a-token-nobody-made';
        const revoked = await makeTarget();
        const revokedLink = await makeLink(revoked.userId);
        await revokeRoute(revoked.userId);
        const used = await lockedOut();
        const usedLink = await makeLink(used.userId);
        expect((await useRoute(usedLink.token)).statusCode).toBe(200);
        const short = await makeTarget();
        const expiredLink = await makeLink(short.userId, { expiresInHours: 1 });
        // A link a use would refuse now: the person joined another organisation.
        const moved = await makeTarget();
        const movedLink = await makeLink(moved.userId);
        await seedMembership(
          ctx.database,
          scene.otherOrganisationId,
          moved.userId,
          'member',
          [],
        );
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.now() + 2 * HOUR);
        const answers = [
          await inspectRoute(unknownToken),
          await inspectRoute(revokedLink.token),
          await inspectRoute(usedLink.token),
          await inspectRoute(expiredLink.token),
          await inspectRoute(movedLink.token),
        ];
        for (const response of answers) {
          expect(response.statusCode).toBe(401);
          expect(response.json()).toMatchObject({ code: 'reset-link-invalid' });
        }
        expect(
          new Set(answers.map((response) => sameness(response.json()))).size,
        ).toBe(1);
        // The cause is in the audit trail, and in nothing a caller sees.
        const reasons = (await eventsOf(AUTH_AUDIT.accessResetInspectFailed))
          .map((event) => (event.details as { reason: string }).reason)
          .slice(-5);
        expect(reasons).toEqual([
          'unknown',
          'revoked',
          'used',
          'expired',
          'target-in-other-organisations',
        ]);
      });

      it('is a 400 for a body with no token, an empty one and one that is far too long', async () => {
        for (const payload of [{}, { token: '' }, { token: 'x'.repeat(300) }]) {
          const response = await send('POST', '/access-reset/inspect', {
            payload,
          });
          expect(response.statusCode, JSON.stringify(payload)).toBe(400);
        }
      });

      it('is a 403 origin-mismatch for a foreign Origin and for none, with a cookie or without one', async () => {
        const person = await makeTarget();
        const made = await makeLink(person.userId);
        for (const cookie of [undefined, ownerToken]) {
          for (const origin of [FOREIGN_ORIGIN, null]) {
            const response = await inspectRoute(made.token, {
              origin,
              ...(cookie === undefined ? {} : { cookie }),
            });
            expect(response.statusCode).toBe(403);
            expect(response.json()).toMatchObject({ code: 'origin-mismatch' });
          }
        }
      });

      it('counts against the strict limit per address: the eleventh request in a minute is a 429', async () => {
        const address = '10.99.0.1';
        for (let i = 0; i < AUTH_RATE_LIMIT.max; i += 1) {
          const response = await inspectRoute('nobody-made-this', { address });
          expect(response.statusCode).toBe(401);
        }
        const limited = await inspectRoute('nobody-made-this', { address });
        expect(limited.statusCode).toBe(429);
        expect(limited.json()).toMatchObject({ code: 'rate-limited' });
        expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(
          1,
        );
      });
    });

    describe('POST /access-reset', () => {
      it('signs the person in with a recovery session that may only secure the account: 200 with the user, mustSecureAccount, and the cookie', async () => {
        const person = await lockedOut();
        const made = await makeLink(person.userId);
        const response = await useRoute(made.token);
        expect(response.statusCode).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        const body = response.json<{
          user: Record<string, unknown>;
          mustSecureAccount: boolean;
        }>();
        expect(Object.keys(body).sort()).toEqual(['mustSecureAccount', 'user']);
        expect(body.mustSecureAccount).toBe(true);
        expect(Object.keys(body.user).sort()).toEqual([
          'displayName',
          'email',
          'id',
          'status',
        ]);
        expect(body.user).toMatchObject({
          id: person.userId,
          email: person.email,
          status: 'active',
        });
        const cookie = sessionCookieOf(response);
        expect(cookie).not.toBeNull();
        const attributes = setCookies(response.headers).find((line) =>
          line.startsWith(`${SESSION_COOKIE}=`),
        )!;
        expect(attributes).toContain('HttpOnly');
        expect(attributes).toContain('Secure');
        expect(attributes).toContain('Path=/');
        expect(attributes).not.toContain('Domain');
        // A session of method reset, with the recovery scope.
        const sessions = (await db().select().from(session)).filter(
          (found) => found.userId === person.userId && found.revokedAt === null,
        );
        expect(sessions).toHaveLength(1);
        expect(sessions[0]).toMatchObject({
          method: 'reset',
          scope: 'recovery',
        });
        // It reads who it is, and nothing else but what lets it secure the account.
        const me = await send('GET', '/auth/me', { token: cookie! });
        expect(me.statusCode).toBe(200);
        expect(me.json()).toMatchObject({ id: person.userId });
        const closed = await send('GET', '/auth/sessions', { token: cookie! });
        expect(closed.statusCode).toBe(403);
        expect(closed.json()).toMatchObject({
          code: 'account-recovery-required',
        });
      });

      it('ends every session, clears the password, removes the authenticator and the recovery codes, and keeps the passkeys', async () => {
        const person = await lockedOut();
        const made = await makeLink(person.userId);
        expect(
          (await send('GET', '/auth/me', { token: person.oldSession }))
            .statusCode,
        ).toBe(200);
        const response = await useRoute(made.token);
        expect(response.statusCode).toBe(200);
        // The old session is over.
        expect(
          (await send('GET', '/auth/me', { token: person.oldSession }))
            .statusCode,
        ).toBe(401);
        // The old password no longer signs in.
        const signIn = await send('POST', '/auth/login/password', {
          payload: { email: person.email, password: OLD_PASSWORD },
        });
        expect(signIn.statusCode).toBe(401);
        expect(signIn.json()).toMatchObject({ code: 'sign-in-failed' });
        const passwords = await db().select().from(passwordCredential);
        expect(passwords.some((p) => p.userId === person.userId)).toBe(false);
        expect(
          (await db().select().from(totpCredential)).some(
            (t) => t.userId === person.userId,
          ),
        ).toBe(false);
        expect(
          (await db().select().from(recoveryCode)).some(
            (c) => c.userId === person.userId,
          ),
        ).toBe(false);
        // The passkeys are kept, and the person sees them with the reset session.
        const cookie = sessionCookieOf(response)!;
        const listed = await send('GET', '/auth/passkeys', { token: cookie });
        expect(listed.statusCode).toBe(200);
        expect(listed.json<{ id: string }[]>().map((p) => p.id)).toEqual(
          person.passkeys,
        );
      });

      it('removes the passkeys too when the link says so', async () => {
        const person = await lockedOut();
        const made = await makeLink(person.userId, { removePasskeys: true });
        const response = await useRoute(made.token);
        expect(response.statusCode).toBe(200);
        const cookie = sessionCookieOf(response)!;
        const listed = await send('GET', '/auth/passkeys', { token: cookie });
        expect(listed.statusCode).toBe(200);
        expect(listed.json()).toEqual([]);
        expect(
          (await db().select().from(passkeyCredential)).filter(
            (p) => p.userId === person.userId && p.revokedAt === null,
          ),
        ).toEqual([]);
      });

      it('lets the person remove a lost passkey with the reset session, set a password, and sign in with it', async () => {
        const person = await lockedOut();
        const made = await makeLink(person.userId);
        const response = await useRoute(made.token);
        const cookie = sessionCookieOf(response)!;
        // Two passkeys and no password: one may go, the last may not.
        const first = await send(
          'DELETE',
          `/auth/passkeys/${person.passkeys[0]}`,
          {
            token: cookie,
          },
        );
        expect(first.statusCode).toBe(204);
        const last = await send(
          'DELETE',
          `/auth/passkeys/${person.passkeys[1]}`,
          {
            token: cookie,
          },
        );
        expect(last.statusCode).toBe(409);
        expect(last.json()).toMatchObject({ code: 'last-sign-in-method' });
        // Setting a password makes the session full.
        const set = await send('PUT', '/auth/password', {
          token: cookie,
          payload: { newPassword: NEW_PASSWORD },
        });
        expect(set.statusCode).toBe(204);
        expect(
          (await send('GET', '/auth/sessions', { token: cookie })).statusCode,
        ).toBe(200);
        const signIn = await send('POST', '/auth/login/password', {
          payload: { email: person.email, password: NEW_PASSWORD },
        });
        expect(signIn.statusCode).toBe(200);
      });

      it('ignores a session cookie the browser already has, and replaces it', async () => {
        const person = await lockedOut();
        const made = await makeLink(person.userId);
        // The cookie of someone else: the administrator opens the link in their browser.
        const before = await send('GET', '/auth/me', { token: adminToken });
        expect(before.statusCode).toBe(200);
        const response = await useRoute(made.token, { cookie: adminToken });
        expect(response.statusCode).toBe(200);
        const fresh = sessionCookieOf(response)!;
        expect(fresh).not.toBe(adminToken);
        const me = await send('GET', '/auth/me', { token: fresh });
        expect(me.json()).toMatchObject({ id: person.userId });
        // The other session was ignored, not ended.
        expect(
          (await send('GET', '/auth/me', { token: adminToken })).statusCode,
        ).toBe(200);
        // A cookie that is no good is ignored too, not a 401.
        const second = await lockedOut();
        const again = await makeLink(second.userId);
        const junk = await useRoute(again.token, { cookie: 'not-a-session' });
        expect(junk.statusCode).toBe(200);
      });

      it('is used once: the second use is the same 401 as any other link that does not work, and changes nothing', async () => {
        const person = await lockedOut();
        const made = await makeLink(person.userId);
        expect((await useRoute(made.token)).statusCode).toBe(200);
        await seedPassword(ctx.database, person.userId, NEW_PASSWORD);
        const second = await useRoute(made.token);
        expect(second.statusCode).toBe(401);
        expect(second.json()).toMatchObject({ code: 'reset-link-invalid' });
        expect(sessionCookieOf(second)).toBeNull();
        // The password the person set since is still there.
        expect(
          (await db().select().from(passwordCredential)).some(
            (p) => p.userId === person.userId,
          ),
        ).toBe(true);
      });

      it('answers every link that does not work, and every link a rule now refuses, with one body and keeps the audit event', async () => {
        const unknownToken = 'a-token-nobody-made';
        const revoked = await makeTarget();
        const revokedLink = await makeLink(revoked.userId);
        await revokeRoute(revoked.userId);
        const short = await makeTarget();
        const expiredLink = await makeLink(short.userId, { expiresInHours: 1 });
        // Each rule that can change after the link was made.
        const moved = await lockedOut();
        const movedLink = await makeLink(moved.userId);
        await seedMembership(
          ctx.database,
          scene.otherOrganisationId,
          moved.userId,
          'member',
          [],
        );
        const disabled = await lockedOut();
        const disabledLink = await makeLink(disabled.userId);
        await setUserStatus(ctx.database, disabled.userId, 'disabled');
        const creator = await seedUser(ctx.database);
        await seedMembership(
          ctx.database,
          scene.organisationId,
          creator,
          'member',
          [scene.roles.resetter],
        );
        const bare = await makeTarget({ roleIds: [] });
        const fromCreator = await makeLink(
          bare.userId,
          {},
          await sessionOf(creator),
        );
        await setUserStatus(ctx.database, creator, 'disabled');
        const promoted = await lockedOut();
        const promotedLink = await makeLink(promoted.userId, {}, adminToken);
        await setMembershipTier(
          ctx.database,
          scene.organisationId,
          promoted.userId,
          'owner',
        );
        const left = await lockedOut();
        const leftLink = await makeLink(left.userId);
        await setMembershipStatus(
          ctx.database,
          scene.organisationId,
          left.userId,
          'removed',
        );
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.now() + 2 * HOUR);
        const refusedBefore = (await eventsOf(AUTH_AUDIT.accessResetUseRefused))
          .length;
        const answers = [
          await useRoute(unknownToken),
          await useRoute(revokedLink.token),
          await useRoute(expiredLink.token),
          await useRoute(movedLink.token),
          await useRoute(disabledLink.token),
          await useRoute(fromCreator.token),
          await useRoute(promotedLink.token),
          await useRoute(leftLink.token),
        ];
        for (const response of answers) {
          expect(response.statusCode).toBe(401);
          expect(response.json()).toMatchObject({ code: 'reset-link-invalid' });
          expect(sessionCookieOf(response)).toBeNull();
        }
        expect(
          new Set(answers.map((response) => sameness(response.json()))).size,
        ).toBe(1);
        // The reasons are in the audit trail, which the refusal kept.
        const reasons = (await eventsOf(AUTH_AUDIT.accessResetUseRefused))
          .slice(refusedBefore)
          .map((event) => (event.details as { reason: string }).reason);
        expect(reasons).toEqual([
          'unknown',
          'revoked',
          'expired',
          'target-in-other-organisations',
          'target-not-active',
          'creator-not-allowed',
          'target-is-owner',
          'target-membership-not-active',
        ]);
        // The people were left as they were.
        for (const person of [moved, disabled, promoted, left]) {
          expect(
            (await db().select().from(passwordCredential)).some(
              (p) => p.userId === person.userId,
            ),
          ).toBe(true);
        }
      });

      it('is a 403 origin-mismatch for a foreign Origin and for none, with a cookie or without one, and does not use the link up', async () => {
        const person = await lockedOut();
        const made = await makeLink(person.userId);
        for (const cookie of [undefined, ownerToken]) {
          for (const origin of [FOREIGN_ORIGIN, null]) {
            const response = await useRoute(made.token, {
              origin,
              ...(cookie === undefined ? {} : { cookie }),
            });
            expect(response.statusCode).toBe(403);
            expect(response.json()).toMatchObject({ code: 'origin-mismatch' });
            expect(sessionCookieOf(response)).toBeNull();
          }
        }
        expect((await linkRowsOf(person.userId))[0]!.usedAt).toBeNull();
        expect((await useRoute(made.token)).statusCode).toBe(200);
      });

      it('is a 400 for a body with no token, an empty one and one that is far too long', async () => {
        for (const payload of [{}, { token: '' }, { token: 'x'.repeat(300) }]) {
          const response = await send('POST', '/access-reset', { payload });
          expect(response.statusCode, JSON.stringify(payload)).toBe(400);
        }
      });

      it('counts against the strict limit per address, together with the inspect route', async () => {
        const address = '10.99.0.2';
        for (let i = 0; i < AUTH_RATE_LIMIT.max; i += 1) {
          const route = i % 2 === 0 ? useRoute : inspectRoute;
          expect(
            (await route('nobody-made-this', { address })).statusCode,
          ).toBe(401);
        }
        const limited = await useRoute('nobody-made-this', { address });
        expect(limited.statusCode).toBe(429);
        expect(limited.json()).toMatchObject({ code: 'rate-limited' });
      });

      it('audits a use once, from the person, with counts and no secret', async () => {
        const person = await lockedOut();
        const made = await makeLink(person.userId, { removePasskeys: true });
        const before = (await eventsOf(AUTH_AUDIT.accessResetUsed)).length;
        expect((await useRoute(made.token)).statusCode).toBe(200);
        const events = (await eventsOf(AUTH_AUDIT.accessResetUsed)).slice(
          before,
        );
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          actorId: person.userId,
          details: {
            userId: person.userId,
            sessionsRevoked: 1,
            passwordCleared: true,
            totpRemoved: true,
            recoveryCodesRemoved: 10,
            passkeysRemoved: 2,
          },
        });
      });
    });

    describe('what the reset flows keep out of logs, events and error bodies', () => {
      it('holds no reset token, hash, password or address in any log line, audit event, change event or error body', async () => {
        // Every flow above has run. A token is only ever in the response that made it.
        expect(tokens.length).toBeGreaterThan(20);
        const logs = ctx.lines.join('\n');
        const events = JSON.stringify(await db().select().from(auditEvent));
        const changes = JSON.stringify(await db().select().from(changeEvent));
        const errors = errorBodies.join('\n');
        const places = [
          ['log', logs],
          ['audit', events],
          ['change', changes],
          ['error body', errors],
        ] as const;
        for (const token of tokens) {
          for (const [where, text] of places) {
            expect(text, `${where}: ${token.slice(0, 4)}`).not.toContain(token);
          }
        }
        // The hashes are the ones the links' own rows hold, read from there.
        const hashes = (await db().select().from(accessReset)).map(
          (found) => found.tokenHash,
        );
        expect(hashes.length).toBeGreaterThan(20);
        for (const hash of hashes) {
          for (const [where, text] of places) {
            expect(text, `${where} hash: ${hash.slice(0, 4)}`).not.toContain(
              hash,
            );
          }
        }
        for (const value of [OLD_PASSWORD, NEW_PASSWORD, ...emails]) {
          for (const [where, text] of places) {
            expect(text, `${where}: ${value}`).not.toContain(value);
          }
        }
        // The cookie that signs the person in is in a header, never in a line.
        expect(logs).not.toContain(SESSION_COOKIE);
        // No token is stored, in any table: only hashes, in the link's own row.
        const stored = await everyRowAsText(ctx.database);
        for (const token of tokens) expect(stored).not.toContain(token);
      });
    });
  },
);

/** The PostgreSQL target, when `DATABASE_URL` names a server. PGlite has one connection, so it cannot run this. */
const postgres = testTargets.find((candidate) => candidate.name === 'postgres');

/** A promise that is settled from outside. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe.skipIf(postgres === undefined)(
  'reset links racing over HTTP, on PostgreSQL',
  () => {
    it('signs one in and answers the others with the 401 reset-link-invalid', async () => {
      const ctx = await createTestApp(postgres!, { logLevel: 'info' });
      try {
        await migrate(ctx.database);
        const scene = await seedResetScene(ctx.database, new Date());
        const owner = (
          await createSession(ctx.database.db, {
            userId: scene.ownerId,
            method: 'password',
            now: new Date(),
          })
        ).token;
        const person = await seedUser(ctx.database);
        await seedMembership(
          ctx.database,
          scene.organisationId,
          person,
          'member',
          [],
        );
        const created = await ctx.app.inject({
          method: 'POST',
          url: `${API_PREFIX}/organisations/${scene.organisationId}/members/${person}/reset-link`,
          headers: {
            origin: TEST_PUBLIC_ORIGIN,
            cookie: `${SESSION_COOKIE}=${owner}`,
          },
          remoteAddress: '10.22.0.1',
          payload: {},
        });
        expect(created.statusCode).toBe(201);
        const token = created.json<{ link: string }>().link.split('#')[1]!;
        const responses = await Promise.all(
          [2, 3, 4, 5].map((n) =>
            ctx.app.inject({
              method: 'POST',
              url: `${API_PREFIX}/access-reset`,
              headers: { origin: TEST_PUBLIC_ORIGIN },
              remoteAddress: `10.22.0.${n}`,
              payload: { token },
            }),
          ),
        );
        expect(responses.map((response) => response.statusCode).sort()).toEqual(
          [200, 401, 401, 401],
        );
        const sessions = (await ctx.database.db.select().from(session)).filter(
          (found) => found.userId === person && found.method === 'reset',
        );
        expect(sessions).toHaveLength(1);
      } finally {
        await ctx.close();
      }
    });

    it('answers a create that meets a link a use holds with the 409 reset-link-busy, and the use signs the person in', async () => {
      const ctx = await createTestApp(postgres!, { logLevel: 'info' });
      const holding = deferred();
      const released = deferred();
      try {
        await migrate(ctx.database);
        const scene = await seedResetScene(ctx.database, new Date());
        const owner = (
          await createSession(ctx.database.db, {
            userId: scene.ownerId,
            method: 'password',
            now: new Date(),
          })
        ).token;
        const person = await seedUser(ctx.database);
        await seedMembership(
          ctx.database,
          scene.organisationId,
          person,
          'member',
          [],
        );
        const makeLink = (address: string) =>
          ctx.app.inject({
            method: 'POST',
            url: `${API_PREFIX}/organisations/${scene.organisationId}/members/${person}/reset-link`,
            headers: {
              origin: TEST_PUBLIC_ORIGIN,
              cookie: `${SESSION_COOKIE}=${owner}`,
            },
            remoteAddress: address,
            payload: {},
          });
        const created = await makeLink('10.22.1.1');
        expect(created.statusCode).toBe(201);
        const token = created.json<{ link: string }>().link.split('#')[1]!;

        // A writer holds the person's row, so a second create queues for it. A use of
        // the first link then takes that link and queues behind the create. When the
        // writer lets go the create is first: it holds the person and meets a link the
        // use holds, and it must not wait for it, which would be a deadlock.
        const holder = ctx.database.db.transaction(async (tx) => {
          await lockUser(tx, person, { strength: 'update' });
          holding.resolve();
          await released.promise;
        });
        await Promise.race([holding.promise, holder]);
        const requestsWaiting = async (count: number) => {
          for (
            let waited = 0;
            (await lockWaiters(ctx.database.db)) < count;
            waited += 25
          ) {
            if (waited >= 10_000) {
              throw new Error(`Fewer than ${count} requests waited for a lock`);
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        };
        const creating = makeLink('10.22.1.2');
        await requestsWaiting(1);
        const using = ctx.app.inject({
          method: 'POST',
          url: `${API_PREFIX}/access-reset`,
          headers: { origin: TEST_PUBLIC_ORIGIN },
          remoteAddress: '10.22.1.3',
          payload: { token },
        });
        await requestsWaiting(2);
        released.resolve();
        await holder;
        const [busy, used] = await Promise.all([creating, using]);

        expect(busy.statusCode).toBe(409);
        expect(busy.json()).toMatchObject({
          status: 409,
          code: 'reset-link-busy',
          type: '/problems/reset-link-busy',
          detail:
            'A reset link for this person is being used or revoked right now; try again.',
        });
        expect(used.statusCode).toBe(200);
        // The first link was used, and the create left nothing behind.
        const links = (await ctx.database.db.select().from(accessReset)).filter(
          (found) => found.userId === person,
        );
        expect(links).toHaveLength(1);
        expect(links[0]!.usedAt).not.toBeNull();
      } finally {
        released.resolve();
        await ctx.close();
      }
    });
  },
);
