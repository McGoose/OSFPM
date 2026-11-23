import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AuthStateError } from '@osfpm/core/src/auth/errors.js';
import {
  finishPasskeyRegistration,
  listPasskeys,
  renamePasskey,
  revokePasskey,
  startPasskeyRegistration,
  type RelyingParty,
} from '@osfpm/core/src/auth/passkeys.js';
import { RecordNotFoundError } from '@osfpm/core/src/db/write.js';
import {
  LastSignInMethodError,
  PasskeyRegistrationRefusedError,
  problemResponse,
} from '../errors.js';
import { requireAuthenticated } from './plugin.js';
import {
  creationOptionsSchema,
  deviceNameField,
  passkeyChallenge,
  passkeySchema,
  passkeyView,
  registrationResponseSchema,
} from './passkey-schemas.js';

const notSignedIn = problemResponse(
  'No usable session. The answer is the same whether the cookie is missing, unknown, expired or revoked, or the user is disabled.',
);
const wrongOrigin = problemResponse(
  'The request changes data, carries a session cookie and did not come from this server’s own origin.',
);
const badRequest = problemResponse(
  'The request is not shaped as this endpoint accepts. The failing fields are listed, never their values.',
);
const tooManyRequests = problemResponse(
  'Too many requests on this session. Retry-After says how many seconds to wait.',
);
const passkeyNotFound = problemResponse(
  'The signed-in user has no live passkey with this id. The answer is the same for another user’s passkey, one that never existed and one already revoked.',
);

/**
 * The two routes by which a user adds a passkey. They count against the limit
 * per session, and a recovery session may call them: adding a passkey is how a
 * user who came in with a recovery code sets a new way to sign in.
 */
const registrationConfig = { sessionRateLimit: true, allowedInRecovery: true };

/**
 * The routes that list and revoke passkeys. A recovery session may call them: a
 * person who came in with a recovery code or an admin reset link because a device
 * was lost must be able to see which passkeys are theirs and remove the lost one
 * (SC-10, decisions D-56 and D-57). Revoking a passkey that is the person's last
 * way to sign in is still refused (`last-sign-in-method`), so it cannot lock them
 * out, and what a recovery session may do to its own account is no more than it
 * could already do by adding one.
 */
const listAndRevokeConfig = { sessionRateLimit: true, allowedInRecovery: true };

/** The route that renames a passkey: a recovery session may not call it. */
const renameConfig = { sessionRateLimit: true };

const passkeyParams = z.object({ id: z.uuid() });

/** What `passkeyRoutes` is registered with. */
export type PasskeyRoutesOptions = {
  /** The site a passkey belongs to, from `OSFPM_PUBLIC_URL` (see `relyingPartyFor`). */
  readonly relyingParty: RelyingParty;
};

/**
 * The routes under `/api/v1/auth` by which a signed-in user manages their own
 * passkeys (SC-10, decision D-56): add one (`POST /passkeys/register/options`,
 * then `POST /passkeys/register/verify`), list them, rename one and revoke one.
 * Signing in with a passkey is in `auth/login-routes.ts`. Each needs a session
 * and the right `Origin` (see `authPlugin`) and counts against the limit per
 * session. The two that add a passkey, the one that lists them and the one that
 * revokes one are open to a recovery session (the first passkey added makes it a
 * full one); renaming is not.
 *
 * These are self-service routes: each acts on the signed-in user's own passkeys,
 * so there is no permission to lack. Without a session the answer is 401. The id
 * of another user's passkey, one that is not there and one already revoked give
 * the same 404, because the service checks the owner in the statement that
 * writes. The only secret in any response is the challenge, shown once in an
 * uncacheable response and never again, logged or audited. No response holds a
 * credential id, a public key or a sign count (CLAUDE.md, Privacy rule). Revoking
 * a user's last way to sign in is a 409.
 */
export const passkeyRoutes: FastifyPluginAsyncZod<PasskeyRoutesOptions> = (
  app,
  options,
) => {
  app.post(
    '/passkeys/register/options',
    {
      config: registrationConfig,
      schema: {
        summary: 'Start adding a passkey',
        description:
          'Returns a challenge and the options for `navigator.credentials.create()`: a discoverable credential (so a later sign-in needs no address), verified on the device by a PIN, fingerprint or face, with no attestation, and with ES256 or RS256 keys. The user’s live passkeys are excluded, so one device is not added twice. The challenge works once, for five minutes. The answer is not to be cached. Finish with `POST /auth/passkeys/register/verify`.',
        response: {
          200: z.object({
            challenge: passkeyChallenge,
            options: creationOptionsSchema,
          }),
          401: notSignedIn,
          403: wrongOrigin,
          429: tooManyRequests,
        },
      },
    },
    async (request, reply) => {
      const { user, context } = requireAuthenticated(request);
      const started = await startPasskeyRegistration(app.db.db, {
        userId: user.id,
        relyingParty: options.relyingParty,
        now: context.clock(),
      });
      reply.header('cache-control', 'no-store');
      return { challenge: started.challenge, options: started.options };
    },
  );

  app.post(
    '/passkeys/register/verify',
    {
      config: registrationConfig,
      schema: {
        summary: 'Finish adding a passkey',
        description:
          'Checks what the browser answered to the options and stores the passkey. 201 with the passkey. Every refusal is the same 422 `passkey-registration-failed`: a challenge that is unknown, used, over or made for another user, a wrong origin, relying party, challenge or key type, no user verification, or a credential that is already registered. The first answer that reaches a challenge uses it up. A recovery session becomes a full one.',
        body: z.object({
          challenge: passkeyChallenge,
          response: registrationResponseSchema,
          deviceName: deviceNameField.optional(),
        }),
        response: {
          201: passkeySchema,
          400: badRequest,
          401: notSignedIn,
          403: wrongOrigin,
          422: problemResponse(
            'The passkey could not be registered. The answer is the same for every cause.',
          ),
          429: tooManyRequests,
        },
      },
    },
    async (request, reply) => {
      const { user, session, context } = requireAuthenticated(request);
      const { challenge, response, deviceName } = request.body;
      const result = await finishPasskeyRegistration(app.db.db, {
        userId: user.id,
        relyingParty: options.relyingParty,
        challenge,
        response,
        ...(deviceName === undefined ? {} : { deviceName }),
        session: { id: session.id, scope: session.scope },
        now: context.clock(),
      });
      // Returned by the core, not thrown, so its transaction committed and the
      // challenge stays used. One answer for every cause.
      if (!result.ok) throw new PasskeyRegistrationRefusedError();
      return reply.code(201).send(passkeyView(result.passkey));
    },
  );

  app.get(
    '/passkeys',
    {
      config: listAndRevokeConfig,
      schema: {
        summary: 'The user’s passkeys',
        description:
          'The live passkeys of the signed-in user, in the order they were added. A revoked passkey is not listed. Never a credential id, a public key or a sign count. A recovery session may call it.',
        response: {
          200: z.array(passkeySchema),
          401: notSignedIn,
          429: tooManyRequests,
        },
      },
    },
    async (request) => {
      const { user } = requireAuthenticated(request);
      const found = await listPasskeys(app.db.db, user.id);
      return found.map(passkeyView);
    },
  );

  app.patch(
    '/passkeys/:id',
    {
      config: renameConfig,
      schema: {
        summary: 'Rename a passkey',
        description:
          'Gives one of the user’s live passkeys a new name. Another user’s passkey, an id that is not there and a revoked passkey all give the same 404.',
        params: passkeyParams,
        body: z.object({ deviceName: deviceNameField.min(1) }),
        response: {
          200: passkeySchema,
          400: badRequest,
          401: notSignedIn,
          403: problemResponse(
            'The request carries a session cookie and did not come from this server’s own origin, or the session has the recovery scope, which may not call this route.',
          ),
          404: passkeyNotFound,
          429: tooManyRequests,
        },
      },
    },
    async (request) => {
      const { user, context } = requireAuthenticated(request);
      const { id } = request.params;
      const renamed = await renamePasskey(app.db.db, {
        userId: user.id,
        passkeyId: id,
        deviceName: request.body.deviceName,
        now: context.clock(),
      });
      if (renamed === null) throw new RecordNotFoundError('passkey', id);
      return passkeyView(renamed);
    },
  );

  app.delete(
    '/passkeys/:id',
    {
      config: listAndRevokeConfig,
      schema: {
        summary: 'Revoke a passkey',
        description:
          'Revokes one of the user’s live passkeys: it is kept, marked, and never signs anyone in again. Another user’s passkey, an id that is not there and one already revoked all give the same 404. A user who has no password and no other live passkey cannot revoke their last one: 409 `last-sign-in-method`. A recovery session may call it, so a person who lost a device can remove its passkey before they secure the account.',
        params: passkeyParams,
        response: {
          204: z.null().describe('The passkey is revoked.'),
          400: badRequest,
          401: notSignedIn,
          403: wrongOrigin,
          404: passkeyNotFound,
          409: problemResponse(
            'The passkey is the only way the user can sign in. Set a password or add another passkey first.',
          ),
          429: tooManyRequests,
        },
      },
    },
    async (request, reply) => {
      const { user, context } = requireAuthenticated(request);
      const { id } = request.params;
      let revoked: boolean;
      try {
        revoked = await revokePasskey(app.db.db, {
          userId: user.id,
          passkeyId: id,
          now: context.clock(),
        });
      } catch (error) {
        // The one state of the core's that has its own answer; any other is the
        // error table's.
        if (
          error instanceof AuthStateError &&
          error.reason === 'last-sign-in-method'
        ) {
          throw new LastSignInMethodError();
        }
        throw error;
      }
      if (!revoked) throw new RecordNotFoundError('passkey', id);
      return reply.code(204).send(null);
    },
  );

  return Promise.resolve();
};
