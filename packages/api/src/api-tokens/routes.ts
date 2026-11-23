import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  createApiToken,
  getApiTokenSwitches,
  listOrganisationApiTokens,
  listOwnApiTokens,
  revokeApiToken,
  setApiTokenSwitches,
  type CreateApiTokenInput,
} from '@osfpm/core/src/auth/api-tokens.js';
import { requireAuthenticated } from '../auth/plugin.js';
import { problemResponse } from '../errors.js';
import {
  accessDenied,
  badRequest,
  notSignedIn,
  tooManyRequests,
} from '../invites/schemas.js';
import {
  apiSettingsBody,
  apiSettingsSchema,
  apiTokenBody,
  apiTokenSchema,
  createTokenBody,
} from './schemas.js';

const organisationParams = z.object({
  organisationId: z.uuid().describe('The organisation.'),
});

const tokenParams = organisationParams.extend({
  tokenId: z.uuid().describe('The token.'),
});

/**
 * The routes under `/api/v1/organisations/:organisationId` that switch personal API
 * tokens on and off for the organisation, and make, list and revoke them (SC-10,
 * decisions D-17 and D-68): `GET` and `PUT` on `api-settings`, and `POST`, `GET` and
 * `DELETE` on `api-tokens`. Each needs a session (a recovery session is refused), counts
 * against the limit per session, and a request that changes data needs the right
 * `Origin` (see `authPlugin`). **None of them accepts a token**: they do not say
 * `tokenAccess`, so a token on one is a 403 `token-not-accepted`, and a token never
 * manages tokens or their switches. The permission is checked in the core, in the
 * organisation: `api:manage` for the switches and for the list and revocation of anyone's
 * tokens, and `api:tokens` for making one. Listing and revoking your own needs none (a
 * person who lost `api:tokens` can still see and end the tokens they made), so those two
 * are self-service: someone else's token is a 404, and a list with nothing of yours is
 * empty, whoever asks. For the routes that need a permission, whoever is not allowed,
 * whether they are a member without the permission, a stranger, or the organisation does
 * not exist, gets the same 403.
 *
 * The token is in the response that makes it, once. No list, and no other response,
 * holds a token or its hash, and neither is ever logged or audited (CLAUDE.md, Privacy
 * rule). The response that makes a token is not cached.
 */
export const apiTokenRoutes: FastifyPluginAsyncZod = (app) => {
  app.get(
    '/:organisationId/api-settings',
    {
      config: { sessionRateLimit: true },
      schema: {
        summary: 'Read the settings for personal API tokens',
        description:
          'The organisation’s two switches for personal API tokens, both off until an administrator turns them on. Needs `api:manage` in the organisation. The sensitive switch reads off while tokens are off.',
        params: organisationParams,
        response: {
          200: apiSettingsSchema,
          401: notSignedIn,
          403: accessDenied,
          429: tooManyRequests,
        },
      },
    },
    async (request) => {
      const { user } = requireAuthenticated(request);
      const switches = await app.db.db.transaction((tx) =>
        getApiTokenSwitches(
          tx,
          { userId: user.id },
          request.params.organisationId,
        ),
      );
      return {
        personalTokens: switches.personalTokens,
        sensitive: switches.sensitive,
      };
    },
  );

  app.put(
    '/:organisationId/api-settings',
    {
      config: { sessionRateLimit: true },
      schema: {
        summary: 'Change the settings for personal API tokens',
        description:
          'Sets both switches. Turning one **off** takes effect at once: `personalTokens` off ends every live token of the organisation and turns `sensitive` off too, and `sensitive` off ends every live token that has a sensitive scope. Turning one on restores nothing. The answer says how many tokens it ended in `revoked`. `sensitive` can only be on while `personalTokens` is, or the answer is a 400. Needs `api:manage` in the organisation. Each switch that changes is audited once with the number of tokens it ended.',
        params: organisationParams,
        body: apiSettingsBody,
        response: {
          200: apiSettingsSchema.extend({
            revoked: z
              .number()
              .int()
              .describe('How many live tokens turning a switch off ended.'),
          }),
          400: badRequest,
          401: notSignedIn,
          403: accessDenied,
          429: tooManyRequests,
        },
      },
    },
    async (request) => {
      const { user } = requireAuthenticated(request);
      const result = await app.db.db.transaction((tx) =>
        setApiTokenSwitches(
          tx,
          { userId: user.id },
          request.params.organisationId,
          request.body,
          new Date(),
        ),
      );
      return {
        personalTokens: result.personalTokens,
        sensitive: result.sensitive,
        revoked: result.revoked,
      };
    },
  );

  app.post(
    '/:organisationId/api-tokens',
    {
      config: { sessionRateLimit: true },
      schema: {
        summary: 'Make a personal API token',
        description:
          'Makes a personal API token for the person asking, and shows it once: the `token` is in this response only, and only a hash of it is kept. Send it as `Authorization: Bearer <token>`. It starts with `osfpm_pat_`, so secret scanners such as GitHub’s can recognise a leaked one. Needs `api:tokens` in the organisation and the organisation’s switch for personal tokens on (a 422 `api-tokens-disabled` otherwise). A token acts as the person, narrowed to this organisation, to the project if one is given, to read or write, and to its sensitive scope, and never exceeds what the person holds. It works until `expiresInDays` (365 when left out) or, with `noExpiry`, until it is revoked: setting an expiry is advised. A `projectId` must be a project of the organisation that the person can reach, or the answer is a 422 `project-not-available`, the same whether the project does not exist, is another organisation’s or cannot be reached. `sensitivePermissions` needs the sensitive switch on (a 422 `api-sensitive-tokens-disabled`), each key must be a permission that exposes sensitive data (a 422 `not-a-sensitive-permission`, with the places in the list), the person must hold each one where the token works (a 422 `token-exceeds-own-access`, with the keys), and a `read` token may list only read permissions (a 422 `token-read-only-scope`, with the places in the list). A token can use only the routes that say they accept one.',
        params: organisationParams,
        body: createTokenBody,
        response: {
          201: z.object({
            token: z
              .string()
              .describe(
                'The token, `osfpm_pat_` and 43 characters. Shown once. Keep it as a secret.',
              ),
            apiToken: apiTokenSchema,
          }),
          400: badRequest,
          401: notSignedIn,
          403: accessDenied,
          422: problemResponse(
            '`api-tokens-disabled`: the organisation has not allowed personal tokens. `api-sensitive-tokens-disabled`: it has not allowed a sensitive scope. `not-a-sensitive-permission`: a key in `sensitivePermissions` is not a sensitive permission, and `errors` gives its place in the list. `token-exceeds-own-access`: the person does not hold some of the keys where the token would work, and `errors` lists them. `token-read-only-scope`: a `read` token lists a permission that changes data, and `errors` gives its place in the list. `project-not-available`: the project does not exist, is another organisation’s or cannot be reached by the person, with one body for all three. Nothing was made.',
          ),
          429: tooManyRequests,
        },
      },
    },
    async (request, reply) => {
      const { user, session } = requireAuthenticated(request);
      const body = request.body;
      const input: CreateApiTokenInput = {
        name: body.name,
        access: body.access,
        ...(body.projectId === undefined ? {} : { projectId: body.projectId }),
        ...(body.expiresInDays === undefined
          ? {}
          : { expiresInDays: body.expiresInDays }),
        ...(body.noExpiry === undefined ? {} : { noExpiry: body.noExpiry }),
        ...(body.sensitivePermissions === undefined
          ? {}
          : { sensitivePermissions: body.sensitivePermissions }),
      };
      const made = await app.db.db.transaction((tx) =>
        // The session goes with the user: the core reads it again under the lock on the
        // person's row, so a token is never made by a session a reset link just ended.
        createApiToken(
          tx,
          { userId: user.id, sessionId: session.id },
          request.params.organisationId,
          input,
          new Date(),
        ),
      );
      // Shown once: nothing between here and the person may keep it.
      reply.header('cache-control', 'no-store');
      return reply.code(201).send({
        token: made.token,
        apiToken: apiTokenBody(made.apiToken),
      });
    },
  );

  app.get(
    '/:organisationId/api-tokens',
    {
      config: { sessionRateLimit: true },
      schema: {
        summary: 'List personal API tokens',
        description:
          'The tokens that still work, newest first: not revoked and not past their end. `scope=own` (the default) is the person’s own and needs no permission: a person who lost `api:tokens` still sees the tokens they made, which no longer work, and anyone with none gets an empty list. `scope=all` is everyone’s in the organisation, with the owner’s `userId` and `ownerDisplayName`, and needs `api:manage`. Metadata only, which is the prefix, access, sensitive scope and expiry, and `neverExpires`: never a token or a hash.',
        params: organisationParams,
        querystring: z.object({
          scope: z
            .enum(['own', 'all'])
            .default('own')
            .describe(
              '`own`: the person’s own tokens. `all`: every token of the organisation (api:manage).',
            ),
        }),
        response: {
          200: z.array(apiTokenSchema),
          400: badRequest,
          401: notSignedIn,
          403: accessDenied,
          429: tooManyRequests,
        },
      },
    },
    async (request) => {
      const { user } = requireAuthenticated(request);
      const now = new Date();
      const views = await app.db.db.transaction((tx) =>
        request.query.scope === 'all'
          ? listOrganisationApiTokens(
              tx,
              { userId: user.id },
              request.params.organisationId,
              now,
            )
          : listOwnApiTokens(
              tx,
              { userId: user.id },
              request.params.organisationId,
              now,
            ),
      );
      return views.map(apiTokenBody);
    },
  );

  app.delete(
    '/:organisationId/api-tokens/:tokenId',
    {
      config: { sessionRateLimit: true },
      schema: {
        summary: 'Revoke a personal API token',
        description:
          'Revokes a token that still works, so it stops working at once. A person’s own tokens need no permission, because revoking only takes access away; anyone else’s need `api:manage`. A token that is unknown, another organisation’s, already revoked or past its end, and another person’s for anyone without `api:manage`, all give the same 404.',
        params: tokenParams,
        response: {
          204: z.null().describe('The token is revoked.'),
          400: badRequest,
          401: notSignedIn,
          403: accessDenied,
          404: problemResponse(
            'No token of this organisation with this id can still be revoked by the person asking.',
          ),
          429: tooManyRequests,
        },
      },
    },
    async (request, reply) => {
      const { user } = requireAuthenticated(request);
      await app.db.db.transaction((tx) =>
        revokeApiToken(
          tx,
          { userId: user.id },
          request.params.organisationId,
          request.params.tokenId,
          new Date(),
        ),
      );
      return reply.code(204).send(null);
    },
  );

  return Promise.resolve();
};
