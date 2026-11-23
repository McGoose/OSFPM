import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  inspectAccessReset,
  useAccessReset,
} from '@osfpm/core/src/auth/access-reset.js';
import { createSession } from '@osfpm/core/src/auth/sessions.js';
import { setSessionCookie } from '../auth/cookie.js';
import { deviceOf } from '../auth/login-routes.js';
import { assertOriginRequired } from '../auth/plugin.js';
import { problemResponse } from '../errors.js';
import { withRefusalsCommitted } from '../invites/refusals.js';
import {
  badRequest,
  tooManyFromAddress,
  wrongOrigin,
} from '../invites/schemas.js';
import { meSchema } from '../routes/auth.js';

const resetLinkInvalid = problemResponse(
  'The reset link does not work. The answer is the same whether the token is unknown, expired, revoked or already used, or a rule for who may reset whom no longer holds, so it never says which.',
);

/**
 * The reset token: 43 characters from a real link. A bound, above that, so a body is
 * never a reason to do a lot of work.
 */
const tokenSchema = z
  .string()
  .min(1)
  .max(256)
  .describe(
    'The token from the fragment of the reset link, the part after `#`.',
  );

/**
 * What both routes say about themselves. They count against the strict limit per
 * address, because a caller may be guessing a token, and they say `requireOrigin`:
 * using a link makes a session, and inspecting is its first step, so a request from
 * another site, or with no `Origin` at all, is refused whether or not it carries a
 * cookie (see `FastifyContextConfig.requireOrigin`). `auth: 'none'`: the token is the
 * capability, and the session cookie the browser may already have is ignored.
 */
const publicConfig = {
  auth: 'none',
  authRateLimit: true,
  requireOrigin: true,
} as const;

/**
 * The routes under `/api/v1/access-reset` that the holder of an admin reset link
 * uses: look at the link, and use it (SC-10, decision D-57). The web app, which comes
 * later, reads the token from the fragment of the link and sends it in a body, so the
 * token never travels in an address. Both count against the strict limit per address
 * (`AUTH_RATE_LIMIT`, together with the login and invite routes) and need the right
 * `Origin` with a cookie or without one.
 *
 * Neither takes a session (`auth: 'none'`): the token is the capability, and a
 * session cookie the browser already has is ignored, not read, not cleared. Using the
 * link answers with a new session, and the new cookie replaces the old one. Every
 * failure is the same 401 `reset-link-invalid`, with one body for every cause: a
 * token that is unknown, expired, revoked or used, and a link that is refused because
 * a rule for who may reset whom no longer holds (the person joined another
 * organisation, the person who made the link lost the permission or can no longer
 * sign in, the person became an owner or holds more than that person, is not active
 * or is no longer a member). The cause goes into the audit trail only.
 *
 * A refusal is committed before it is answered, so its audit event is kept. The
 * token and the session token are never logged, never in an error body and never in
 * an audit event; the session token goes only into the cookie. These routes check no
 * permission: the token is the capability.
 */
export const publicAccessResetRoutes: FastifyPluginAsyncZod = (app) => {
  app.post(
    '/inspect',
    {
      config: publicConfig,
      schema: {
        summary: 'Look at a reset link',
        description:
          'Says when a live reset link ends, and nothing else: not the name or the email address of the person it is for, since anyone who holds the link could read them. Uses nothing up. A token that is unknown, expired, revoked or already used, or a link that using it would refuse because a rule for who may reset whom no longer holds, is the same 401 `reset-link-invalid`, whatever the reason.',
        body: z.object({ token: tokenSchema }),
        response: {
          200: z.object({ expiresAt: z.iso.datetime() }),
          400: badRequest,
          401: resetLinkInvalid,
          403: wrongOrigin,
          429: tooManyFromAddress,
        },
      },
    },
    async (request, reply) => {
      const inspection = await withRefusalsCommitted(app, (tx) =>
        inspectAccessReset(tx, request.body.token, new Date()),
      );
      reply.header('cache-control', 'no-store');
      return { expiresAt: inspection.expiresAt.toISOString() };
    },
  );

  app.post(
    '',
    {
      config: publicConfig,
      schema: {
        summary: 'Use a reset link',
        description:
          'Signs the person the link is for back in, in one transaction: a failure at any step leaves nothing, and the link stays usable. The rules for who may reset whom are checked again first. Then every session of the person is revoked, their password is cleared, their authenticator app and their recovery codes are removed, their passkeys are revoked if the link said so, and the link is used up. The answer sets a session cookie (method `reset`, recovery scope) that replaces any cookie the browser had, and says `mustSecureAccount: true`: any route but `GET /auth/me`, `POST /auth/logout`, `PUT /auth/password`, the passkey list, registration and revocation, and the authenticator and recovery code routes answers 403 `account-recovery-required` until a password is set, a passkey added or an authenticator confirmed. A token that does not work is the same 401 `reset-link-invalid` for every cause, and so is the loser of two uses of one token at once.',
        body: z.object({ token: tokenSchema }),
        response: {
          200: z.object({
            user: meSchema,
            mustSecureAccount: z
              .literal(true)
              .describe(
                'Always true: the session may only set a new way to sign in.',
              ),
          }),
          400: badRequest,
          401: resetLinkInvalid,
          403: wrongOrigin,
          429: tooManyFromAddress,
        },
      },
    },
    async (request, reply) => {
      // This route makes a session, so it must say so (`requireOrigin`).
      assertOriginRequired(request);
      const now = new Date();
      const { used, created } = await withRefusalsCommitted(app, async (tx) => {
        const done = await useAccessReset(tx, request.body.token, now);
        // The session is made in the same transaction, so a failure of it undoes
        // the use, and the link stays usable. The core makes a session of method
        // `reset` a `recovery`-scope one, which may only secure the account.
        const made = await createSession(tx, {
          userId: done.user.id,
          method: 'reset',
          now,
          ...deviceOf(request),
        });
        return { used: done, created: made };
      });
      setSessionCookie(reply, created.token, created.session.absoluteExpiresAt);
      reply.header('cache-control', 'no-store');
      return reply.code(200).send({
        user: {
          id: used.user.id,
          displayName: used.user.displayName,
          email: used.user.email,
          status: used.user.status,
        },
        mustSecureAccount: true,
      });
    },
  );

  return Promise.resolve();
};
