import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  ACCESS_RESET_LIFETIME,
  createAccessReset,
  revokeAccessReset,
} from '@osfpm/core/src/auth/access-reset.js';
import { requireAuthenticated } from '../auth/plugin.js';
import { problemResponse } from '../errors.js';
import {
  accessDenied,
  badRequest,
  notSignedIn,
  tooManyRequests,
} from '../invites/schemas.js';

const memberParams = z.object({
  organisationId: z.uuid().describe('The organisation.'),
  userId: z.uuid().describe('The member the link is for.'),
});

/** What the person making a reset link may send: a JSON object, `{}` for every default. Each field may be left out. */
const createBody = z.object({
  expiresInHours: z
    .number()
    .int()
    .min(ACCESS_RESET_LIFETIME.minHours)
    .max(ACCESS_RESET_LIFETIME.maxHours)
    .optional()
    .describe(
      `How many hours the link works, from ${ACCESS_RESET_LIFETIME.minHours} to ${ACCESS_RESET_LIFETIME.maxHours}. ${ACCESS_RESET_LIFETIME.defaultHours} when left out.`,
    ),
  removePasskeys: z
    .boolean()
    .optional()
    .describe(
      'Whether using the link also revokes every passkey of the person, for a device that was lost or stolen. False when left out: the passkeys stay.',
    ),
});

/**
 * The routes under `/api/v1/organisations/:organisationId/members/:userId` that let
 * an administrator help a member who is locked out (a forgotten password, a lost
 * authenticator device, a lost passkey): make a one-time reset link for them, and
 * revoke it (SC-10, decision D-57). OSFPM sends nothing: the administrator passes the
 * link on by any channel. Each needs a session (a recovery session is refused),
 * counts against the limit per session, and a request that changes data needs the
 * right `Origin` (see `authPlugin`). The permission is checked in the core service,
 * in the organisation: `members:reset-access`. Whoever is not allowed, whether they
 * are a member without the permission, a stranger, or the organisation does not
 * exist, and whoever names a person who is not a member of the organisation or not a
 * user, gets the same 403.
 *
 * The link is in the response that makes it, once: `<OSFPM_PUBLIC_URL>/reset#<token>`.
 * The token is after the `#`, the fragment of the address, which a browser never
 * sends to a server, a proxy or in a `Referer` header, so it reaches OSFPM only when
 * the page that reads it calls `POST /api/v1/access-reset/inspect` or
 * `POST /api/v1/access-reset`. The response is not cached. No other response holds a
 * token or its hash, and neither is ever logged or audited (CLAUDE.md, Privacy
 * rule). The response says nothing about the person.
 */
export const memberResetRoutes: FastifyPluginAsyncZod = (app) => {
  app.post(
    '/:organisationId/members/:userId/reset-link',
    {
      config: { sessionRateLimit: true },
      schema: {
        summary: 'Make a reset link for a member who is locked out',
        description:
          'Makes a one-time link that signs the member in with a recovery session, where they must set a new password or add a passkey, and shows it once: the `link` is in this response only, and only a hash of its token is kept. Pass it on by any channel; OSFPM sends nothing. Using it ends every session of the member, clears their password, removes their authenticator app and their recovery codes, and, when `removePasskeys` is true, revokes their passkeys. Needs `members:reset-access` in the organisation. The member must belong to this organisation and to no other (in any status), must not be the person asking (people reset themselves with their recovery codes), must not be an owner unless the person asking is one, must hold no permission the person asking does not hold in the organisation, at the same reach or wider, and must have an active account; each is a 422 with a code of its own. The same rules are checked again when the link is used. Any earlier live link for the member is revoked. The token is after the `#` of the link, which a browser never sends to a server.',
        params: memberParams,
        body: createBody,
        response: {
          201: z.object({
            link: z
              .string()
              .describe(
                'The link to pass on, `<OSFPM_PUBLIC_URL>/reset#<token>`. Shown once.',
              ),
            expiresAt: z.iso.datetime(),
            removePasskeys: z
              .boolean()
              .describe('Whether using the link also revokes the passkeys.'),
          }),
          400: badRequest,
          401: notSignedIn,
          403: accessDenied,
          422: problemResponse(
            '`cannot-reset-self`: the member is the person asking. `user-in-other-organisations`: the member belongs to another organisation too, in any status; they can use their own recovery codes, or ask whoever runs this server. `owner-reset-needs-owner`: the member is an owner and the person asking is not. `reset-exceeds-own-access`: the member holds permissions the person asking does not hold, or holds only for the organisation where the member holds them for every project; `errors` lists the permission keys. `user-not-active`: the member’s account is disabled, only invited or deleted. Nothing was made.',
          ),
          429: tooManyRequests,
        },
      },
    },
    async (request, reply) => {
      const { user } = requireAuthenticated(request);
      const { body } = request;
      const made = await app.db.db.transaction((tx) =>
        createAccessReset(
          tx,
          { userId: user.id },
          request.params.organisationId,
          request.params.userId,
          {
            ...(body.expiresInHours === undefined
              ? {}
              : { expiresInHours: body.expiresInHours }),
            ...(body.removePasskeys === undefined
              ? {}
              : { removePasskeys: body.removePasskeys }),
          },
          new Date(),
        ),
      );
      // The token is in the fragment, so no server, proxy or Referer header ever
      // sees it; the page that opens the link reads it and sends it in a body.
      reply.header('cache-control', 'no-store');
      return reply.code(201).send({
        link: `${app.publicOrigin}/reset#${made.token}`,
        expiresAt: made.reset.expiresAt.toISOString(),
        removePasskeys: made.reset.removePasskeys,
      });
    },
  );

  app.delete(
    '/:organisationId/members/:userId/reset-link',
    {
      config: { sessionRateLimit: true },
      schema: {
        summary: 'Revoke the reset link of a member',
        description:
          'Revokes the live link of the member, so it stops working. Needs `members:reset-access` in the organisation, and only that. A member with no live link, whether none was made, it was used, revoked or has expired, or the member is not in this organisation, gives the same 404.',
        params: memberParams,
        response: {
          204: z.null().describe('The link is revoked.'),
          400: badRequest,
          401: notSignedIn,
          403: accessDenied,
          404: problemResponse(
            'The member has no live reset link in this organisation.',
          ),
          429: tooManyRequests,
        },
      },
    },
    async (request, reply) => {
      const { user } = requireAuthenticated(request);
      await app.db.db.transaction((tx) =>
        revokeAccessReset(
          tx,
          { userId: user.id },
          request.params.organisationId,
          request.params.userId,
          new Date(),
        ),
      );
      return reply.code(204).send(null);
    },
  );

  return Promise.resolve();
};
