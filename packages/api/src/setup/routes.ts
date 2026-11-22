import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  completeFirstRunSetup,
  normaliseLocale,
  normaliseTimeZone,
} from '@osfpm/core/src/auth/first-run-setup.js';
import { normaliseEmail } from '@osfpm/core/src/auth/login-user.js';
import { createSession } from '@osfpm/core/src/auth/sessions.js';
import { checkSetupCode } from '@osfpm/core/src/auth/setup-code.js';
import { isEmailShaped } from '@osfpm/core/src/auth/users.js';
import { setSessionCookie } from '../auth/cookie.js';
import { deviceOf } from '../auth/login-routes.js';
import {
  OriginMismatchError,
  problemResponse,
  SetupCodeInvalidError,
  SetupPasswordRefusedError,
} from '../errors.js';
import { meSchema } from '../routes/auth.js';

const setupCodeInvalid = problemResponse(
  'The setup code was not accepted. The answer is the same whether the code is unknown, expired, replaced by a newer one, already used or not shaped like a code, or setup completed a moment before this request.',
);
const badRequest = problemResponse(
  'The request is not shaped as this endpoint accepts. The failing fields are listed, never their values.',
);
const wrongOrigin = problemResponse(
  'The request has an `Origin` that is not this server’s own origin.',
);
const gone = problemResponse(
  'Setup is complete, so this route no longer exists: the answer is the one for a path that is no route.',
);
const tooManyRequests = problemResponse(
  'Too many requests from this address. Retry-After says how many seconds to wait.',
);

/**
 * What both setup routes say about themselves. `auth: 'none'`: nobody can be
 * signed in before the first administrator exists. They count against the strict
 * limit per address, because a caller may be guessing the code. They answer
 * before setup is complete and are a 404 after (see `registerSetupGate`).
 */
const setupConfig = {
  auth: 'none',
  authRateLimit: true,
  availableBeforeSetup: true,
  closedAfterSetup: true,
} as const;

// Bounds, so a body is never a reason to do a lot of work. A code is 16
// characters and the password policy has its own maximum; these are above both.
const setupCode = z
  .string()
  .min(1)
  .max(64)
  .describe(
    'The setup code the server printed when it started. Case, spaces and hyphens do not matter.',
  );

/** The organisation to create. The same rules as the database's own checks, so a bad value is a 400 and not a 500. */
const organisationInput = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe('The name of the organisation.'),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .describe('ISO 3166-1 alpha-2, in capitals, such as `GB`.'),
  baseCurrency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .describe('ISO 4217, in capitals, such as `GBP`.'),
  locale: z
    .string()
    .max(35)
    .refine((value) => normaliseLocale(value) !== null)
    .optional()
    .describe('A BCP 47 language tag, such as `en-GB`. `en` when left out.'),
  timeZone: z
    .string()
    .max(64)
    .refine((value) => normaliseTimeZone(value) !== null)
    .optional()
    .describe(
      'An IANA time zone, such as `Europe/London`. `UTC` when left out.',
    ),
});

/** The first administrator. */
const adminInput = z.object({
  email: z
    .string()
    .trim()
    .max(320)
    .refine((value) => isEmailShaped(normaliseEmail(value)))
    .describe('The address of the account. It is kept in lower case.'),
  displayName: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe('The name shown for the user.'),
  password: z
    .string()
    .min(1)
    .max(4096)
    .optional()
    .describe(
      'The password, which the password policy must accept (15 to 256 characters, not a common or predictable one, not containing the address or the name of this service). Left out, the account has no password and the session may only add a passkey or set one: the answer says `mustSecureAccount`.',
    ),
});

/** The organisation setup made, as the response shows it. */
const organisationView = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  country: z.string(),
  baseCurrency: z.string(),
  locale: z.string(),
  timeZone: z.string(),
});

/** What `setupRoutes` is registered with. */
export type SetupRoutesOptions = {
  /**
   * The origin of `OSFPM_PUBLIC_URL`, written as a browser writes it (see
   * `Config.publicOrigin`). A `POST` whose `Origin` is another is refused.
   */
  readonly publicOrigin: string;
};

/**
 * The first-run setup routes, `POST /api/v1/setup/check` and
 * `POST /api/v1/setup` (SC-10, decision D-56, Q1). They are how a fresh install
 * gets its first administrator: whoever holds the setup code the server printed at
 * start-up creates the first organisation, its Administrator role and the first
 * administrator account. Neither needs a session (`auth: 'none'`), both count
 * against the strict limit per address (`AUTH_RATE_LIMIT`), and both are a 404
 * once setup is complete (`closedAfterSetup`, see `registerSetupGate`).
 *
 * A `POST` with an `Origin` that is not the public origin is a 403
 * `origin-mismatch`. These routes read no cookie, so the plugin's check, which is
 * for requests that carry a session, does not apply; this is the same defence
 * against a page on another site posting to the server, for a route that makes a
 * session. A request with no `Origin`, which a browser never sends for a `POST`,
 * is not refused: a script or a command line has none.
 *
 * Every refusal of the code is the same 401 `setup-code-invalid`, with one body
 * for every cause. The code, the password and the session token are never logged,
 * never in an error body and never in an audit event; the token goes only into
 * the cookie. These routes check no permission: nobody holds one yet.
 */
export const setupRoutes: FastifyPluginAsyncZod<SetupRoutesOptions> = (
  app,
  options,
) => {
  // After the global hooks, so the limits count a request first.
  app.addHook('onRequest', (request, _reply, done) => {
    const { origin } = request.headers;
    if (
      request.method === 'POST' &&
      origin !== undefined &&
      origin !== options.publicOrigin
    ) {
      done(new OriginMismatchError());
      return;
    }
    done();
  });

  app.post(
    '/setup/check',
    {
      config: setupConfig,
      schema: {
        summary: 'Check the setup code',
        description:
          'Says whether the setup code is live, so a setup screen can check it before it asks for details. It does not use the code up. 204 for the live code; for any other, whatever the reason, the same 401 `setup-code-invalid`. After setup is complete the route is a 404.',
        body: z.object({ code: setupCode }),
        response: {
          204: z.null().describe('The code is live.'),
          400: badRequest,
          401: setupCodeInvalid,
          403: wrongOrigin,
          404: gone,
          429: tooManyRequests,
        },
      },
    },
    async (request, reply) => {
      // One transaction, which the core's refusal leaves to commit: the audit
      // event of a code that does not work is kept.
      const live = await app.db.db.transaction((tx) =>
        checkSetupCode(tx, request.body.code, new Date()),
      );
      if (!live) throw new SetupCodeInvalidError();
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/setup',
    {
      config: setupConfig,
      schema: {
        summary: 'Complete first-run setup',
        description:
          'With the setup code, creates the first organisation, its Administrator role, the first administrator and their owner membership, marks setup complete and signs the administrator in (session method `setup`, cookie set), all in one transaction: a failure at any step leaves nothing, and the code stays usable. The Administrator role holds every permission in the organisation and, for every permission that is not sensitive, in every production of it; sensitive crew data, contract and cost amounts still need membership of the production. With no `admin.password` the session has the recovery scope: the answer says `mustSecureAccount: true`, and any route but `me`, `logout`, `PUT /auth/password` and the passkey registration answers 403 `account-recovery-required` until the administrator sets a password or adds a passkey. A password the policy refuses is a 422 `password-refused` with the reason, as on every route that sets a password. A code that does not work is the same 401 `setup-code-invalid` for every cause, and so is the loser of two requests at once with the same code. After setup is complete the route is a 404.',
        body: z.object({
          code: setupCode,
          organisation: organisationInput,
          admin: adminInput,
        }),
        response: {
          201: z.object({
            user: meSchema,
            organisation: organisationView,
            mustSecureAccount: z
              .boolean()
              .describe(
                'True when no password was given: the session may only set a password or add a passkey first.',
              ),
          }),
          400: badRequest,
          401: setupCodeInvalid,
          403: wrongOrigin,
          404: gone,
          422: problemResponse(
            'The password does not meet the password policy. `errors` holds the reason as `code` (`too-short`, `too-long`, `too-common`, `too-predictable`, `contains-email` or `contains-product-name`) at `admin.password`, and `detail` says what to do. Nothing was made, and the code can be used again.',
          ),
          429: tooManyRequests,
        },
      },
    },
    async (request, reply) => {
      const now = new Date();
      const { code, organisation, admin } = request.body;
      // One transaction for the whole setup and the session: the user row lock
      // the core takes is held until the session exists, and a failure of the
      // session undoes the setup. A refusal is returned, so the transaction
      // commits and the audit event of a bad code is kept; the error is thrown
      // after it.
      const outcome = await app.db.db.transaction(async (tx) => {
        const result = await completeFirstRunSetup(
          tx,
          {
            code,
            organisation,
            admin: {
              email: admin.email,
              displayName: admin.displayName,
              ...(admin.password === undefined
                ? {}
                : { password: admin.password }),
            },
          },
          now,
        );
        if (!result.ok) return { done: false, refusal: result } as const;
        const created = await createSession(tx, {
          userId: result.user.id,
          method: 'setup',
          // No password, so the first session may only secure the account
          // (the recovery scope the plugin already enforces).
          scope: result.mustSecureAccount ? 'recovery' : 'full',
          now,
          ...deviceOf(request),
        });
        return { done: true, result, created } as const;
      });
      if (!outcome.done) {
        if (outcome.refusal.reason === 'password-refused') {
          throw new SetupPasswordRefusedError(outcome.refusal.refusal);
        }
        throw new SetupCodeInvalidError();
      }
      const { result, created } = outcome;
      // Committed: tell the app, so the gate opens and these routes close.
      app.setup.markComplete();
      setSessionCookie(reply, created.token, created.session.absoluteExpiresAt);
      reply.header('cache-control', 'no-store');
      return reply.code(201).send({
        user: {
          id: result.user.id,
          displayName: result.user.displayName,
          email: result.user.email,
          status: result.user.status,
        },
        organisation: result.organisation,
        mustSecureAccount: result.mustSecureAccount,
      });
    },
  );

  return Promise.resolve();
};
