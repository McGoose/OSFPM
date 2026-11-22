import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AuthStateError } from '@osfpm/core/src/auth/errors.js';
import {
  consumeLoginChallenge,
  createLoginChallenge,
} from '@osfpm/core/src/auth/login-challenge.js';
import { verifyPasswordLogin } from '@osfpm/core/src/auth/password-service.js';
import { verifyRecoveryLogin } from '@osfpm/core/src/auth/recovery.js';
import {
  createSession,
  type SessionUser,
} from '@osfpm/core/src/auth/sessions.js';
import type { SessionMethod } from '@osfpm/core/src/db/schema/index.js';
import type { Tx } from '@osfpm/core/src/db/write.js';
import type { App } from '../app.js';
import { problemResponse, SignInFailedError } from '../errors.js';
import { meSchema } from '../routes/auth.js';
import { setSessionCookie } from './cookie.js';

const signInFailed = problemResponse(
  'The sign-in was not accepted. The answer is the same for every cause: an address no one has, no password, a wrong password or code, a challenge that is unknown, used or over, a disabled user, or an account closed for a while after too many wrong guesses.',
);
const badRequest = problemResponse(
  'The request is not shaped as this endpoint accepts. The failing fields are listed, never their values.',
);
const tooManyRequests = problemResponse(
  'Too many requests from this address. Retry-After says how many seconds to wait.',
);

// Bounds, so a body is never a reason to do a lot of work. A password longer
// than the policy allows can match nothing and is still hashed, so its limit
// is far above the policy's but not unbounded.
const email = z
  .string()
  .min(1)
  .max(320)
  .describe('The address of the account.');
const password = z.string().min(1).max(4096);
const challengeToken = z
  .string()
  .min(1)
  .max(256)
  .describe('The challenge the password step returned.');
const authenticatorCode = z
  .string()
  .min(1)
  .max(32)
  .describe('The six digits the authenticator app shows.');
const recoveryCode = z
  .string()
  .min(1)
  .max(64)
  .describe('One of the account’s recovery codes.');

/** The user of a sign-in as the response shows it: their own details, none of them sensitive. */
function userView(found: SessionUser) {
  return {
    id: found.id,
    displayName: found.displayName,
    email: found.email,
    status: found.status,
  };
}

/**
 * Runs one step of a sign-in in a single transaction and turns every failure
 * into the one `SignInFailedError`. `work` returns `null` for a refusal and
 * returns, never throws, so the transaction commits and the failure event the
 * core wrote is kept; the error is thrown after it. An `AuthStateError`, such
 * as a user disabled at the very moment, is the same failure. The user row the
 * core locks stays locked to the end of the transaction, so the session is made
 * while it is.
 */
async function signInStep<T>(
  app: App,
  work: (tx: Tx) => Promise<T | null>,
): Promise<T> {
  let result: T | null;
  try {
    result = await app.db.db.transaction((tx) => work(tx));
  } catch (error) {
    if (error instanceof AuthStateError) throw new SignInFailedError();
    throw error;
  }
  if (result === null) throw new SignInFailedError();
  return result;
}

/** The browser the request came from, for the user's list of where they are signed in. */
function deviceOf(request: FastifyRequest): { userAgentSummary?: string } {
  const header = request.headers['user-agent'];
  return typeof header === 'string' && header.length > 0
    ? { userAgentSummary: header }
    : {};
}

/**
 * Makes the session for a finished sign-in and puts its cookie on the reply.
 * The raw token goes only into the cookie. The response is marked uncacheable,
 * because it holds a session or a challenge.
 */
async function startSession(
  tx: Tx,
  request: FastifyRequest,
  userId: string,
  method: SessionMethod,
  now: Date,
) {
  return createSession(tx, { userId, method, now, ...deviceOf(request) });
}

/** Sets the cookie of a session just made, and marks the response not to be stored. */
function sendSession(
  reply: FastifyReply,
  created: Awaited<ReturnType<typeof startSession>>,
): void {
  setSessionCookie(reply, created.token, created.session.absoluteExpiresAt);
  reply.header('cache-control', 'no-store');
}

/**
 * The sign-in routes under `/api/v1/auth/login` (SC-10, decision D-56):
 * password, then the authenticator code if the user has one, and a recovery
 * code. None needs a session (`auth: 'none'`), and all count against the strict
 * limit per address (`AUTH_RATE_LIMIT`), together.
 *
 * Every failure answers the same 401 `sign-in-failed`, with one body, for every
 * cause: nothing in the answer says which part failed or whether an address has
 * an account. The cause, a reason class and never what was typed, is in the
 * audit trail, written by the core before the answer is built. A request that is
 * not shaped right stays a 400. A success sets the session cookie
 * (`setSessionCookie`) and returns the user; the raw token is never in a body,
 * a log line or an audit event.
 *
 * The routes check no permission: signing in is how a person gets one.
 */
export const loginRoutes: FastifyPluginAsyncZod = (app) => {
  app.post(
    '/login/password',
    {
      config: { auth: 'none', authRateLimit: true },
      schema: {
        summary: 'Sign in with a password',
        description:
          'Checks the address and the password. Without a confirmed authenticator app it signs the user in: a session cookie and the user. With one it makes no session yet and returns `{ next: "totp", challenge }`; finish with `POST /auth/login/totp`.',
        body: z.object({ email, password }),
        response: {
          200: z.union([
            z.object({ user: meSchema }),
            z.object({
              next: z.literal('totp'),
              challenge: challengeToken,
            }),
          ]),
          400: badRequest,
          401: signInFailed,
          429: tooManyRequests,
        },
      },
    },
    async (request, reply) => {
      const now = new Date();
      const outcome = await signInStep(app, async (tx) => {
        const checked = await verifyPasswordLogin(tx, {
          email: request.body.email,
          password: request.body.password,
          now,
        });
        if (!checked.ok) return null;
        if (checked.totpRequired) {
          const { challenge } = await createLoginChallenge(
            tx,
            checked.user.id,
            {
              kind: 'totp',
              now,
            },
          );
          return { next: 'totp' as const, challenge };
        }
        const created = await startSession(
          tx,
          request,
          checked.user.id,
          'password',
          now,
        );
        return { user: checked.user, created };
      });
      reply.header('cache-control', 'no-store');
      if ('next' in outcome) return outcome;
      sendSession(reply, outcome.created);
      return { user: userView(outcome.user) };
    },
  );

  app.post(
    '/login/totp',
    {
      config: { auth: 'none', authRateLimit: true },
      schema: {
        summary: 'Finish a sign-in with an authenticator code',
        description:
          'The second step, after `POST /auth/login/password` returned a challenge. The challenge works once, for five minutes and five code attempts. A right code signs the user in.',
        body: z.object({ challenge: challengeToken, code: authenticatorCode }),
        response: {
          200: z.object({ user: meSchema }),
          400: badRequest,
          401: signInFailed,
          429: tooManyRequests,
        },
      },
    },
    async (request, reply) => {
      const now = new Date();
      const outcome = await signInStep(app, async (tx) => {
        const checked = await consumeLoginChallenge(tx, {
          challenge: request.body.challenge,
          code: request.body.code,
          now,
        });
        if (!checked.ok) return null;
        const created = await startSession(
          tx,
          request,
          checked.user.id,
          'password+totp',
          now,
        );
        return { user: checked.user, created };
      });
      sendSession(reply, outcome.created);
      return { user: userView(outcome.user) };
    },
  );

  app.post(
    '/login/recovery',
    {
      config: { auth: 'none', authRateLimit: true },
      schema: {
        summary: 'Sign in with a recovery code',
        description:
          'For a user who lost their password or their authenticator. A right code is used up and opens a session that may only set a new way to sign in: it answers `mustSecureAccount: true`, and any other route answers 403 `account-recovery-required` until the user sets a new password or confirms an authenticator app.',
        body: z.object({ email, code: recoveryCode }),
        response: {
          200: z.object({ user: meSchema, mustSecureAccount: z.literal(true) }),
          400: badRequest,
          401: signInFailed,
          429: tooManyRequests,
        },
      },
    },
    async (request, reply) => {
      const now = new Date();
      const outcome = await signInStep(app, async (tx) => {
        const checked = await verifyRecoveryLogin(tx, {
          email: request.body.email,
          code: request.body.code,
          now,
        });
        if (!checked.ok) return null;
        // The core makes a session of method `recovery` a `recovery`-scope one.
        const created = await startSession(
          tx,
          request,
          checked.user.id,
          'recovery',
          now,
        );
        return { user: checked.user, created };
      });
      sendSession(reply, outcome.created);
      return { user: userView(outcome.user), mustSecureAccount: true as const };
    },
  );

  return Promise.resolve();
};
