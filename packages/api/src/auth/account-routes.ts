import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { setPassword } from '@osfpm/core/src/auth/password-service.js';
import { generateRecoveryCodes } from '@osfpm/core/src/auth/recovery.js';
import {
  confirmTotp,
  enrolTotp,
  removeTotp,
} from '@osfpm/core/src/auth/totp.js';
import {
  CurrentPasswordRejectedError,
  PasswordRefusedError,
  problemResponse,
  TotpAlreadyEnrolledError,
  TotpCodeIncorrectError,
  TotpNotSetUpError,
} from '../errors.js';
import { requireAuthenticated } from './plugin.js';

const notSignedIn = problemResponse(
  'No usable session. The answer is the same whether the cookie is missing, unknown, expired or revoked, or the user is disabled.',
);
const wrongOrigin = problemResponse(
  'The request changes data, carries a session cookie and did not come from this server’s own origin.',
);
const badRequest = problemResponse(
  'The request is not shaped as this endpoint accepts. The failing fields are listed, never their values.',
);
const currentPasswordRejected = problemResponse(
  'The current password is missing, wrong, or the account is closed for a while after too many wrong guesses. The answer is the same for all three.',
);
const tooManyRequests = problemResponse(
  'Too many requests on this session. Retry-After says how many seconds to wait.',
);

/**
 * Every route here is for a signed-in user's own account, counts against the
 * limit per session, and may be called by a recovery session: they are how a
 * user who came in with a recovery code secures the account again.
 */
const accountConfig = { sessionRateLimit: true, allowedInRecovery: true };

// A bound, so a body is never a reason to do a lot of work. The password policy
// refuses a new password over its own maximum with a reason; this is far above it.
const password = z.string().max(4096);

/**
 * The routes under `/api/v1/auth` that a signed-in user uses to secure their own
 * account (SC-10, decision D-56): change the password, set up, confirm and
 * remove an authenticator app, and make a new set of recovery codes. Each needs
 * a session and the right `Origin` (see `authPlugin`), counts against the limit
 * per session, and is open to a session a recovery code opened
 * (`allowedInRecovery`), which a new password or a confirmed authenticator then
 * makes a full session.
 *
 * These are self-service routes: each acts on the signed-in user's own account,
 * so there is no permission to lack. Without a session the answer is 401; the
 * 403s are the cross-site check and, for a change that needs the current
 * password, a password that was not accepted. What is shown once, the secret of
 * an authenticator app and the recovery codes, comes in an uncacheable response
 * and is never returned again, logged or audited (CLAUDE.md, Privacy rule).
 * Changing the password or removing the authenticator ends the user's other
 * sessions.
 */
export const accountRoutes: FastifyPluginAsyncZod = (app) => {
  app.put(
    '/password',
    {
      config: accountConfig,
      schema: {
        summary: 'Set or change the password',
        description:
          'Sets the password after the password policy has passed it: 15 to 256 characters, not a common or predictable one, not containing the user’s address or the name of this service. Changing an existing password needs `currentPassword`, unless the user must change it or the session is a recovery session. Ends the user’s other sessions, and makes a recovery session a full one.',
        body: z.object({
          currentPassword: password.optional(),
          newPassword: z.string().min(1).max(4096),
        }),
        response: {
          204: z.null().describe('The password is set.'),
          400: badRequest,
          401: notSignedIn,
          403: currentPasswordRejected,
          422: problemResponse(
            'The new password does not meet the policy. `errors` holds the reason as `code` (`too-short`, `too-long`, `too-common`, `too-predictable`, `contains-email` or `contains-product-name`), and `detail` says what to do.',
          ),
          429: tooManyRequests,
        },
      },
    },
    async (request, reply) => {
      const { user, session, context } = requireAuthenticated(request);
      const { currentPassword, newPassword } = request.body;
      const result = await setPassword(app.db.db, {
        userId: user.id,
        newPassword,
        ...(currentPassword === undefined ? {} : { currentPassword }),
        session: { id: session.id, scope: session.scope },
        now: context.clock(),
      });
      if (!result.ok) {
        // One answer for a missing, a wrong and a throttled current password.
        if (
          result.reason === 'current-password-required' ||
          result.reason === 'current-password-incorrect'
        ) {
          throw new CurrentPasswordRejectedError();
        }
        throw new PasswordRefusedError(result.reason);
      }
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/totp/enrol',
    {
      config: accountConfig,
      schema: {
        summary: 'Start setting up an authenticator app',
        description:
          'Makes a new secret and returns it with the `otpauth://` address for a QR code. They are shown once and never again. The app does not count at sign-in until the first code is confirmed (`POST /auth/totp/confirm`). A secret that was never confirmed is replaced by a new one.',
        response: {
          200: z.object({
            secret: z.string().describe('The secret in base32. Shown once.'),
            otpauthUri: z
              .string()
              .describe(
                'The same secret as an `otpauth://` address. Shown once.',
              ),
          }),
          401: notSignedIn,
          403: wrongOrigin,
          409: problemResponse(
            'An authenticator app is already confirmed. Remove it first.',
          ),
          429: tooManyRequests,
        },
      },
    },
    async (request, reply) => {
      const { user, context } = requireAuthenticated(request);
      const result = await enrolTotp(app.db.db, user.id, {
        now: context.clock(),
        dataKeys: app.serverKeys.get().dataKeys,
      });
      if (!result.ok) throw new TotpAlreadyEnrolledError();
      reply.header('cache-control', 'no-store');
      return { secret: result.secret, otpauthUri: result.otpauthUri };
    },
  );

  app.post(
    '/totp/confirm',
    {
      config: accountConfig,
      schema: {
        summary: 'Finish setting up an authenticator app',
        description:
          'Checks the first code the app shows and turns the app on for sign-in. A recovery session becomes a full one.',
        body: z.object({
          code: z
            .string()
            .min(1)
            .max(32)
            .describe('The six digits the app shows.'),
        }),
        response: {
          204: z.null().describe('The authenticator app is confirmed.'),
          400: badRequest,
          401: notSignedIn,
          403: wrongOrigin,
          409: problemResponse(
            'Nothing is being set up, or the app is already confirmed.',
          ),
          422: problemResponse('The code was not correct.'),
          429: tooManyRequests,
        },
      },
    },
    async (request, reply) => {
      const { user, session, context } = requireAuthenticated(request);
      const result = await confirmTotp(app.db.db, {
        userId: user.id,
        code: request.body.code,
        session: { id: session.id, scope: session.scope },
        now: context.clock(),
        dataKeys: app.serverKeys.get().dataKeys,
      });
      if (!result.ok) {
        if (result.reason === 'already-enrolled') {
          throw new TotpAlreadyEnrolledError();
        }
        if (result.reason === 'no-pending-enrolment') {
          throw new TotpNotSetUpError();
        }
        throw new TotpCodeIncorrectError();
      }
      return reply.code(204).send(null);
    },
  );

  app.delete(
    '/totp',
    {
      config: accountConfig,
      schema: {
        summary: 'Remove the authenticator app',
        description:
          'Removes the authenticator app, confirmed or only being set up, after checking the password. Ends the user’s other sessions.',
        body: z.object({ password }),
        response: {
          204: z.null().describe('The authenticator app is removed.'),
          400: badRequest,
          401: notSignedIn,
          403: currentPasswordRejected,
          409: problemResponse('There is no authenticator app to remove.'),
          429: tooManyRequests,
        },
      },
    },
    async (request, reply) => {
      const { user, session, context } = requireAuthenticated(request);
      const result = await removeTotp(app.db.db, {
        userId: user.id,
        password: request.body.password,
        session: { id: session.id },
        now: context.clock(),
      });
      if (!result.ok) {
        if (result.reason === 'not-enrolled') throw new TotpNotSetUpError();
        throw new CurrentPasswordRejectedError();
      }
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/recovery-codes',
    {
      config: accountConfig,
      schema: {
        summary: 'Make a new set of recovery codes',
        description:
          'Makes ten new single-use recovery codes and returns them once. Any earlier set, used or not, stops working.',
        response: {
          200: z.object({
            codes: z
              .array(z.string())
              .length(10)
              .describe('The codes. Shown once.'),
          }),
          401: notSignedIn,
          403: wrongOrigin,
          429: tooManyRequests,
        },
      },
    },
    async (request, reply) => {
      const { user, context } = requireAuthenticated(request);
      const codes = await generateRecoveryCodes(app.db.db, user.id, {
        now: context.clock(),
      });
      reply.header('cache-control', 'no-store');
      return { codes };
    },
  );

  return Promise.resolve();
};
