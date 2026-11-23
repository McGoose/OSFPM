import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  createInvite,
  INVITE_LIFETIME,
  INVITE_MAX_ROLES,
  listInvites,
  revokeInvite,
} from '@osfpm/core/src/auth/invites.js';
import { normaliseEmail } from '@osfpm/core/src/auth/login-user.js';
import { isEmailShaped } from '@osfpm/core/src/auth/users.js';
import {
  INVITE_TIERS,
  ORG_MEMBERSHIP_STATUSES,
  ORG_ROLES,
} from '@osfpm/core/src/db/schema/index.js';
import { listMembers } from '@osfpm/core/src/members/service.js';
import { requireAuthenticated, requireCaller } from '../auth/plugin.js';
import { problemResponse } from '../errors.js';
import {
  accessDenied,
  badRequest,
  inviteBody,
  inviteSchema,
  notSignedIn,
  tooManyRequests,
} from './schemas.js';

const organisationParams = z.object({
  organisationId: z.uuid().describe('The organisation.'),
});

/** One member of the organisation, as the list shows them. No sign-in detail, no crew personal data. */
const memberSchema = z.object({
  userId: z.uuid(),
  displayName: z.string(),
  email: z.string(),
  tier: z
    .enum(ORG_ROLES)
    .describe('The membership tier. It grants nothing by itself.'),
  status: z.enum(ORG_MEMBERSHIP_STATUSES),
  roleKeys: z
    .array(z.string())
    .describe('The keys of the organisation roles the member holds.'),
});

/** What the person making an invite sends. */
const createBody = z.object({
  email: z
    .string()
    .trim()
    .max(320)
    .refine((value) => isEmailShaped(normaliseEmail(value)))
    .optional()
    .describe(
      'The address that may accept the invite. Left out, anyone with the link may. It is kept in lower case and is never logged or audited.',
    ),
  tier: z
    .enum(INVITE_TIERS)
    .describe(
      'The membership tier. Never `owner`: the first administrator is the owner.',
    ),
  roleIds: z
    .array(z.uuid())
    .max(INVITE_MAX_ROLES)
    .describe(
      'The organisation roles the person gets. Each must be a live organisation role of this organisation, and every permission they grant must be one the person making the invite holds in the organisation, at the same reach or wider.',
    ),
  expiresInDays: z
    .number()
    .int()
    .min(INVITE_LIFETIME.minDays)
    .max(INVITE_LIFETIME.maxDays)
    .optional()
    .describe(
      `How many days the invite works, from ${INVITE_LIFETIME.minDays} to ${INVITE_LIFETIME.maxDays}. ${INVITE_LIFETIME.defaultDays} when left out.`,
    ),
});

/**
 * The routes under `/api/v1/organisations/:organisationId` that let an
 * administrator see who belongs to the organisation and bring more people in
 * (SC-10, decision D-57): list the members, make an invite link, list the invites
 * still waiting and revoke one. Each needs a session (a recovery session is
 * refused), counts against the limit per session, and a request that changes data
 * needs the right `Origin` (see `authPlugin`). The permission is checked in the
 * core service, in the organisation: `members:read` for the member list and
 * `members:invite` for the three invite routes. An organisation named in the path
 * is named by id, so a caller who is not allowed, whether they are a member, a
 * stranger, or the organisation does not exist, gets the same 403.
 *
 * The link is in the response that makes it, once: `<OSFPM_PUBLIC_URL>/invite#<token>`.
 * The token is after the `#`, the fragment of the address, which a browser never
 * sends to a server, a proxy or in a `Referer` header, so it reaches OSFPM only
 * when the page that reads it calls `POST /api/v1/invites/inspect` or `/accept`.
 * The response is not cached. No list, and no other response, holds a token or its
 * hash, and neither is ever logged or audited (CLAUDE.md, Privacy rule). OSFPM
 * sends no email: the administrator passes the link on.
 */
export const organisationInviteRoutes: FastifyPluginAsyncZod = (app) => {
  app.get(
    '/:organisationId/members',
    {
      // One of the routes a personal API token may call (`tokenAccess`): it only reads,
      // and `listMembers` takes the token's credential and narrows its check by it.
      config: { sessionRateLimit: true, tokenAccess: 'read' },
      schema: {
        summary: 'List the members of the organisation',
        description:
          'The people who belong to the organisation: user id, display name, email address, tier, whether the membership is active, invited or removed, and the keys of the roles they hold. Needs `members:read` in the organisation. Nothing about how a member signs in, and no crew personal data. A personal API token for the whole of this organisation may call it too, as `Authorization: Bearer <token>`: a token for another organisation, or one that does not work, is a 401 `invalid-token`, and one for a single project is a 403.',
        params: organisationParams,
        response: {
          200: z.array(memberSchema),
          401: notSignedIn,
          403: accessDenied,
          429: tooManyRequests,
        },
      },
    },
    async (request) => {
      // A session or a token, with the credential that narrows the check.
      const { user, credential } = requireCaller(request);
      const members = await app.db.db.transaction((tx) =>
        listMembers(
          tx,
          { userId: user.id, credential },
          request.params.organisationId,
        ),
      );
      return members.map((member) => ({
        ...member,
        roleKeys: [...member.roleKeys],
      }));
    },
  );

  app.post(
    '/:organisationId/invites',
    {
      config: { sessionRateLimit: true },
      schema: {
        summary: 'Make an invite link',
        description:
          'Makes a one-time invite link and shows it once: the `link` is in this response only, and only a hash of its token is kept. Pass it on by any channel; OSFPM sends nothing. Needs `members:invite` in the organisation. The invite can give only what the person making it holds: every permission of every role must be one they hold in the organisation, at the same reach or wider (an `all-projects` grant needs an `all-projects` grant), whatever their tier, or the answer is a 422 `invite-exceeds-own-access` listing the permission keys. The token is after the `#` of the link, which a browser never sends to a server.',
        params: organisationParams,
        body: createBody,
        response: {
          201: z.object({
            invite: inviteSchema,
            link: z
              .string()
              .describe(
                'The link to pass on, `<OSFPM_PUBLIC_URL>/invite#<token>`. Shown once.',
              ),
          }),
          400: badRequest,
          401: notSignedIn,
          403: accessDenied,
          422: problemResponse(
            '`invite-exceeds-own-access`: the roles of the invite hold permissions the person making it does not hold in the organisation, or holds only for the organisation where the role grants them in every production. `errors` lists the permission keys.',
          ),
          429: tooManyRequests,
        },
      },
    },
    async (request, reply) => {
      const { user } = requireAuthenticated(request);
      const made = await app.db.db.transaction((tx) =>
        createInvite(
          tx,
          { userId: user.id },
          request.params.organisationId,
          {
            ...(request.body.email === undefined
              ? {}
              : { email: request.body.email }),
            tier: request.body.tier,
            roleIds: request.body.roleIds,
            ...(request.body.expiresInDays === undefined
              ? {}
              : { expiresInDays: request.body.expiresInDays }),
          },
          new Date(),
        ),
      );
      // The token is in the fragment, so no server, proxy or Referer header ever
      // sees it; the page that opens the link reads it and sends it in a body.
      reply.header('cache-control', 'no-store');
      return reply.code(201).send({
        invite: inviteBody(made.invite),
        link: `${app.publicOrigin}/invite#${made.token}`,
      });
    },
  );

  app.get(
    '/:organisationId/invites',
    {
      config: { sessionRateLimit: true },
      schema: {
        summary: 'List the invites still waiting',
        description:
          'The invites that can still be used: not accepted, not revoked and not expired, newest first. Needs `members:invite` in the organisation. Never a token, a link or a hash: the link was shown once, when the invite was made.',
        params: organisationParams,
        response: {
          200: z.array(inviteSchema),
          401: notSignedIn,
          403: accessDenied,
          429: tooManyRequests,
        },
      },
    },
    async (request) => {
      const { user } = requireAuthenticated(request);
      const live = await app.db.db.transaction((tx) =>
        listInvites(
          tx,
          { userId: user.id },
          request.params.organisationId,
          new Date(),
        ),
      );
      return live.map(inviteBody);
    },
  );

  app.delete(
    '/:organisationId/invites/:inviteId',
    {
      config: { sessionRateLimit: true },
      schema: {
        summary: 'Revoke an invite',
        description:
          'Revokes an invite that can still be used, so its link stops working. Needs `members:invite` in the organisation. An invite that is unknown, another organisation’s, already accepted, already revoked or expired gives the same 404.',
        params: organisationParams.extend({
          inviteId: z.uuid().describe('The invite.'),
        }),
        response: {
          204: z.null().describe('The invite is revoked.'),
          401: notSignedIn,
          403: accessDenied,
          404: problemResponse(
            'No invite of this organisation with this id can still be used.',
          ),
          429: tooManyRequests,
        },
      },
    },
    async (request, reply) => {
      const { user } = requireAuthenticated(request);
      await app.db.db.transaction((tx) =>
        revokeInvite(
          tx,
          { userId: user.id },
          request.params.organisationId,
          request.params.inviteId,
          new Date(),
        ),
      );
      return reply.code(204).send(null);
    },
  );

  return Promise.resolve();
};
