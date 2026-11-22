import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  listUserSessions,
  revokeSession,
} from '@osfpm/core/src/auth/sessions.js';
import {
  SESSION_METHODS,
  USER_STATUSES,
} from '@osfpm/core/src/db/schema/index.js';
import { RecordNotFoundError } from '@osfpm/core/src/db/write.js';
import { clearSessionCookie } from '../auth/cookie.js';
import { requireAuthenticated } from '../auth/plugin.js';
import { problemResponse } from '../errors.js';

const notSignedIn = problemResponse(
  'No usable session. The answer is the same whether the cookie is missing, unknown, expired or revoked, or the user is disabled.',
);
const tooManyRequests = problemResponse(
  'Too many requests from this address. Retry-After says how many seconds to wait.',
);
const wrongOrigin = problemResponse(
  'The request changes data, carries a session cookie and did not come from this server’s own origin.',
);

/**
 * The user that is signed in. Their own details only, and none of them
 * sensitive. Also what the login routes return for the user who just signed in.
 */
export const meSchema = z.object({
  id: z.uuid(),
  displayName: z.string(),
  email: z.string(),
  status: z.enum(USER_STATUSES),
});

/** One live session of the signed-in user. Never the token or its hash. */
const sessionSchema = z.object({
  id: z.uuid(),
  method: z.enum(SESSION_METHODS).describe('How the user signed in.'),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  idleExpiresAt: z.iso
    .datetime()
    .describe('The session ends here unless it is used first.'),
  absoluteExpiresAt: z.iso
    .datetime()
    .describe('The session ends here however much it is used.'),
  userAgentSummary: z
    .string()
    .nullable()
    .describe('A short description of the browser or device, if known.'),
  current: z.boolean().describe('True for the session that made this request.'),
});

/**
 * The routes under `/api/v1/auth` that a signed-in user uses: who am I, where am
 * I signed in, end a session, sign out. Every route needs a session and counts
 * against the limit per session (`SESSION_RATE_LIMIT`); `POST` and `DELETE` also
 * need the right `Origin` (see `authPlugin`). `me` and `logout` are also open to a
 * session a recovery code opened (`allowedInRecovery`); the session list is not.
 * Signing in is in `auth/login-routes.ts` (password, authenticator code and
 * recovery code), and securing the account in `auth/account-routes.ts`. Passkeys
 * come later.
 *
 * These are self-service routes: every one acts on the signed-in user's own
 * account and sessions, so there is no permission to lack. Without a session the
 * answer is 401, and for another user's session it is the 404 of a session that
 * is not there. No response holds a sensitive field: the user table carries
 * none (CLAUDE.md, Privacy rule).
 *
 * Revoking is done by the core's `revokeSession`, which audits it. Raw tokens
 * and their hashes are never returned, logged or audited.
 */
export const authRoutes: FastifyPluginAsyncZod = (app) => {
  app.get(
    '/me',
    {
      config: { sessionRateLimit: true, allowedInRecovery: true },
      schema: {
        summary: 'The signed-in user',
        description: 'The acting user of the session in the cookie.',
        response: { 200: meSchema, 401: notSignedIn, 429: tooManyRequests },
      },
    },
    (request) => {
      const { user } = requireAuthenticated(request);
      return {
        id: user.id,
        displayName: user.displayName,
        email: user.email,
        status: user.status,
      };
    },
  );

  app.get(
    '/sessions',
    {
      config: { sessionRateLimit: true },
      schema: {
        summary: 'Where the user is signed in',
        description:
          'The live sessions of the signed-in user, most recently seen first. A revoked or expired session is not listed.',
        response: {
          200: z.array(sessionSchema),
          401: notSignedIn,
          429: tooManyRequests,
        },
      },
    },
    async (request) => {
      const { user, session, context } = requireAuthenticated(request);
      const live = await listUserSessions(app.db.db, user.id, context.clock());
      return live.map((item) => ({
        id: item.id,
        method: item.method,
        createdAt: item.createdAt.toISOString(),
        lastSeenAt: item.lastSeenAt.toISOString(),
        idleExpiresAt: item.idleExpiresAt.toISOString(),
        absoluteExpiresAt: item.absoluteExpiresAt.toISOString(),
        userAgentSummary: item.userAgentSummary,
        current: item.id === session.id,
      }));
    },
  );

  app.delete(
    '/sessions/:id',
    {
      config: { sessionRateLimit: true },
      schema: {
        summary: 'End one of the user’s sessions',
        description:
          'Revokes a live session of the signed-in user, which may be the one making the request. Another user’s session, one that is already over and one that never existed all give the same 404.',
        params: z.object({ id: z.uuid() }),
        response: {
          204: z.null().describe('The session is ended.'),
          401: notSignedIn,
          403: wrongOrigin,
          404: problemResponse(
            'There is no live session of yours with this id.',
          ),
          429: tooManyRequests,
        },
      },
    },
    async (request, reply) => {
      const { user, context } = requireAuthenticated(request);
      const { id } = request.params;
      const now = context.clock();
      // The core's `revokeSession` revokes by id and checks no owner, so the id
      // must be one of this user's live sessions first. Anything else, whoever
      // it belongs to, is the same 404.
      const mine = await listUserSessions(app.db.db, user.id, now);
      if (!mine.some((item) => item.id === id)) {
        throw new RecordNotFoundError('session', id);
      }
      const revoked = await revokeSession(app.db.db, id, {
        reason: 'user-revoked',
        now,
      });
      // False when it ended between the list and the revoke: still not there.
      if (!revoked) throw new RecordNotFoundError('session', id);
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/logout',
    {
      config: { sessionRateLimit: true, allowedInRecovery: true },
      schema: {
        summary: 'Sign out',
        description:
          'Revokes the session in the cookie and clears the cookie. Other sessions of the user stay.',
        response: {
          204: z.null().describe('Signed out.'),
          401: notSignedIn,
          403: wrongOrigin,
          429: tooManyRequests,
        },
      },
    },
    async (request, reply) => {
      const { session, context } = requireAuthenticated(request);
      // False when a second request got there first: signed out either way.
      await revokeSession(app.db.db, session.id, {
        reason: 'logout',
        now: context.clock(),
      });
      clearSessionCookie(reply);
      return reply.code(204).send(null);
    },
  );

  return Promise.resolve();
};
