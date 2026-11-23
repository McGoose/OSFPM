import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { preferencesSchema } from '@osfpm/core/src/preferences/schemas.js';
import {
  readOwnPreferences,
  saveOwnPreferences,
  type PreferencesContext,
} from '@osfpm/core/src/preferences/service.js';
import { requireAuthenticated, type Authenticated } from '../auth/plugin.js';
import { problemResponse } from '../errors.js';
import {
  badRequest,
  notSignedIn,
  tooManyRequests,
} from '../invites/schemas.js';
import { preferencesViewSchema } from './schemas.js';

const forbidden = problemResponse(
  'The session is a recovery session, which can only secure the account (`account-recovery-required`); or, for a request that changes data, the cookie came with no `Origin` or a foreign one (`origin-mismatch`); or the request came with a personal API token, which this route does not take (`token-not-accepted`).',
);

/** What the core's preferences service needs of the signed-in user. */
function contextOf({ user, context }: Authenticated): PreferencesContext {
  return {
    userId: user.id,
    originServer: context.originServer,
    clock: context.clock,
    requestId: context.requestId ?? null,
  };
}

/**
 * The routes under `/api/v1/me` for the signed-in person's own delivery preferences
 * (decision D-69, P-02l2): `GET` and `PUT /preferences`. How a person wants to receive
 * information (plain text or HTML email, easy-read or large print, text size, channel,
 * digest, quiet hours) is an ordinary setting and not sensitive data, so nobody has to
 * disclose anything to get an accessible format; but only the person reads it here, and the
 * answer is not cached.
 *
 * These are self-service routes: each acts on the signed-in user's own preferences, so there
 * is no permission to lack. They need a session and the right `Origin` on a request that
 * changes data (see `authPlugin`), and count against the limit per session. **They take a
 * session only:** they do not say `tokenAccess`, so a personal API token is a 403
 * `token-not-accepted`, and a recovery session, which may only secure the account, is a 403
 * `account-recovery-required`. A body with a field the schema does not know, or a value it
 * does not allow, is a 400 that lists the fields and never the values. The preferences of
 * another person have no route here: staff set those of a person with no account through
 * the core service.
 */
export const preferencesRoutes: FastifyPluginAsyncZod = (app) => {
  app.get(
    '/preferences',
    {
      config: { sessionRateLimit: true, tokenAccess: 'read' },
      schema: {
        summary: 'Read my delivery preferences',
        description:
          'The values the signed-in person chose for how they want to receive information, and the values that apply with the defaults filled in. A person who chose nothing gets `stored` empty and the defaults in `effective`. Not cached.',
        response: {
          200: preferencesViewSchema,
          401: notSignedIn,
          403: forbidden,
          429: tooManyRequests,
        },
      },
    },
    async (request, reply) => {
      const view = await app.db.db.transaction((tx) =>
        readOwnPreferences(tx, contextOf(requireAuthenticated(request))),
      );
      reply.header('cache-control', 'no-store');
      return view;
    },
  );

  app.put(
    '/preferences',
    {
      config: { sessionRateLimit: true },
      schema: {
        summary: 'Set my delivery preferences',
        description:
          'Replaces what the signed-in person chose: a field left out is a choice cleared, and `{}` clears them all. Every field is optional. The body is checked strictly: a field the schema does not know, or a value it does not allow, is a 400 that lists the fields and never the values. Quiet hours are `HH:MM` in the person’s own time zone, may cross midnight, and may not start and end at the same time. Answers the same as `GET`. Not cached.',
        body: preferencesSchema,
        response: {
          200: preferencesViewSchema,
          400: badRequest,
          401: notSignedIn,
          403: forbidden,
          429: tooManyRequests,
        },
      },
    },
    async (request, reply) => {
      const view = await app.db.db.transaction((tx) =>
        saveOwnPreferences(
          tx,
          contextOf(requireAuthenticated(request)),
          request.body,
        ),
      );
      reply.header('cache-control', 'no-store');
      return view;
    },
  );

  return Promise.resolve();
};
