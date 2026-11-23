import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '@osfpm/core/src/db/migrate.js';
import {
  testTargets,
  type TestTarget,
} from '@osfpm/core/src/db/test-support.js';
import { API_PREFIX } from '../api-version.js';
import { assertTokenAccessDeclaration } from '../auth/plugin.js';
import { createTestApp } from '../test-support.js';

/**
 * Which routes accept a personal API token (SC-10, decision D-68; CLAUDE.md, Code
 * rules): routes refuse tokens unless they say `tokenAccess`, and the routes that sign
 * people in, secure an account, hand out access or manage tokens never do. This walks
 * every route the app registers.
 */

type Walked = {
  readonly method: string;
  readonly url: string;
  readonly tokenAccess: unknown;
};

/**
 * What must never accept a token, as patterns on the route's own path: the credential
 * and account routes (`/auth/*`, setup, the two that make a session from an invite or a
 * reset link), the routes that hand out access (invites, reset links), and the routes
 * that manage tokens and their switches. A token must never reach any of them, even if a
 * later change says it may: this list is what stops that.
 */
const NEVER_ACCEPT_A_TOKEN: readonly { why: string; pattern: RegExp }[] = [
  { why: 'sign-in and account routes', pattern: /^\/api\/v1\/auth(\/|$)/ },
  { why: 'first-run setup', pattern: /^\/api\/v1\/setup(\/|$)/ },
  { why: 'invite inspect and accept', pattern: /^\/api\/v1\/invites(\/|$)/ },
  {
    why: 'reset link inspect and use',
    pattern: /^\/api\/v1\/access-reset(\/|$)/,
  },
  {
    why: 'making, listing and revoking invites',
    pattern: /^\/api\/v1\/organisations\/:organisationId\/invites(\/|$)/,
  },
  {
    why: 'making and revoking reset links',
    pattern: /\/members\/:userId\/reset-link$/,
  },
  {
    why: 'the personal API token routes',
    pattern: /^\/api\/v1\/organisations\/:organisationId\/api-tokens(\/|$)/,
  },
  {
    why: 'the switches for personal API tokens',
    pattern: /^\/api\/v1\/organisations\/:organisationId\/api-settings$/,
  },
  {
    why: 'a person’s own delivery preferences, which only the person signed in sets',
    pattern: /^\/api\/v1\/me(\/|$)/,
  },
];

/**
 * The routes that accept a token today, by method and pattern. A list that is pinned, so
 * a new one is a deliberate change here, in the commit that adds it, and a reviewer sees
 * it: a route may say `tokenAccess` only when every service it calls takes the credential
 * and passes it to its permission checks.
 */
const ACCEPTING: readonly { method: string; url: string; access: string }[] = [
  { method: 'GET', url: `${API_PREFIX}/meta`, access: 'read' },
  { method: 'HEAD', url: `${API_PREFIX}/meta`, access: 'read' },
  {
    method: 'GET',
    url: `${API_PREFIX}/organisations/:organisationId/members`,
    access: 'read',
  },
  {
    method: 'HEAD',
    url: `${API_PREFIX}/organisations/:organisationId/members`,
    access: 'read',
  },
];

describe.each(testTargets)(
  'the routes that accept a personal API token on $name',
  (target: TestTarget) => {
    let ctx: Awaited<ReturnType<typeof createTestApp>>;
    const walked: Walked[] = [];

    beforeAll(async () => {
      ctx = await createTestApp(target);
      await migrate(ctx.database);
      // Added before the app is ready, so every plugin the app registers inherits it.
      ctx.app.addHook('onRoute', (route) => {
        const methods = Array.isArray(route.method)
          ? route.method
          : [route.method];
        for (const method of methods) {
          walked.push({
            method,
            url: route.url,
            tokenAccess: route.config?.tokenAccess,
          });
        }
      });
      await ctx.app.ready();
    });
    afterAll(async () => {
      await ctx.close();
    });

    it('walks every route the app registers, which is a good many', () => {
      // Guards against the hook seeing nothing and every check below passing for nothing.
      expect(walked.length).toBeGreaterThan(40);
      const urls = new Set(walked.map((route) => route.url));
      for (const url of [
        `${API_PREFIX}/meta`,
        `${API_PREFIX}/auth/login/password`,
        `${API_PREFIX}/setup`,
        `${API_PREFIX}/organisations/:organisationId/members`,
        `${API_PREFIX}/organisations/:organisationId/api-tokens/:tokenId`,
      ]) {
        expect(urls, url).toContain(url);
      }
    });

    it('lets no credential, account, invite, reset link or token management route accept a token', () => {
      for (const { why, pattern } of NEVER_ACCEPT_A_TOKEN) {
        const matching = walked.filter((route) => pattern.test(route.url));
        // Each pattern names routes that exist, so none of them is dead.
        expect(matching.length, `${why}: no route matches`).toBeGreaterThan(0);
        for (const route of matching) {
          expect(
            route.tokenAccess,
            `${route.method} ${route.url} (${why}) accepts a token`,
          ).toBeUndefined();
        }
      }
    });

    it('accepts a token on exactly the routes that were decided: the server information and the member list, both read', () => {
      const accepting = walked
        .filter((route) => route.tokenAccess !== undefined)
        .map((route) => ({
          method: route.method,
          url: route.url,
          access: route.tokenAccess,
        }))
        .sort(
          (a, b) =>
            a.url.localeCompare(b.url) || a.method.localeCompare(b.method),
        );
      expect(accepting).toEqual(
        [...ACCEPTING].sort(
          (a, b) =>
            a.url.localeCompare(b.url) || a.method.localeCompare(b.method),
        ),
      );
    });

    it('declares tokenAccess only in the way the plugin allows: read, on a safe method, or write', () => {
      for (const route of walked) {
        expect(() =>
          assertTokenAccessDeclaration({
            url: route.url,
            method: route.method,
            config: { tokenAccess: route.tokenAccess },
          }),
        ).not.toThrow();
      }
    });

    it('finds a route that accepts a token where it should not, which is what the check is for', () => {
      // The same check, on throwaway routes: a pattern from the list above matched by a
      // route that says `tokenAccess` is found.
      const offenders = (routes: Walked[]) =>
        NEVER_ACCEPT_A_TOKEN.flatMap(({ pattern }) =>
          routes.filter(
            (route) =>
              pattern.test(route.url) && route.tokenAccess !== undefined,
          ),
        );
      expect(
        offenders([
          { method: 'GET', url: `${API_PREFIX}/auth/me`, tokenAccess: 'read' },
          {
            method: 'DELETE',
            url: `${API_PREFIX}/organisations/:organisationId/api-tokens/:tokenId`,
            tokenAccess: 'write',
          },
          { method: 'GET', url: `${API_PREFIX}/meta`, tokenAccess: 'read' },
        ]),
      ).toHaveLength(2);
      expect(
        offenders([
          {
            method: 'GET',
            url: `${API_PREFIX}/auth/me`,
            tokenAccess: undefined,
          },
        ]),
      ).toEqual([]);
    });
  },
);
