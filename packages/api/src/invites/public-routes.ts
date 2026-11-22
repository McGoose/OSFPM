import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AuthInputError } from '@osfpm/core/src/auth/errors.js';
import { acceptInvite, inspectInvite } from '@osfpm/core/src/auth/invites.js';
import { normaliseEmail } from '@osfpm/core/src/auth/login-user.js';
import { createSession } from '@osfpm/core/src/auth/sessions.js';
import { isEmailShaped } from '@osfpm/core/src/auth/users.js';
import { setSessionCookie, SESSION_COOKIE } from '../auth/cookie.js';
import { deviceOf } from '../auth/login-routes.js';
import { assertOriginRequired } from '../auth/plugin.js';
import { AuthenticationRequiredError, problemResponse } from '../errors.js';
import { meSchema } from '../routes/auth.js';
import { withRefusalsCommitted } from './refusals.js';
import { badRequest, tooManyFromAddress, wrongOrigin } from './schemas.js';

const inviteInvalid = problemResponse(
  'The invite link does not work. The answer is the same whether the token is unknown, expired, revoked or already used, so it never says which.',
);

/**
 * The invite token: 43 characters from a real link. A bound, above that, so a body
 * is never a reason to do a lot of work.
 */
const tokenSchema = z
  .string()
  .min(1)
  .max(256)
  .describe(
    'The token from the fragment of the invite link, the part after `#`.',
  );

/** The details of a new account, as the first administrator's are in setup. */
const accountInput = z.object({
  email: z
    .string()
    .trim()
    .max(320)
    .refine((value) => isEmailShaped(normaliseEmail(value)))
    .describe(
      'The address of the account. It is kept in lower case. When the invite names an address, it must be that one.',
    ),
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

/**
 * What both invite routes say about themselves. They count against the strict
 * limit per address, because a caller may be guessing a token, and they say
 * `requireOrigin`: accepting makes a session, and inspecting is its first step, so
 * a request from another site, or with no `Origin` at all, is refused whether or
 * not it carries a cookie (see `FastifyContextConfig.requireOrigin`).
 */
const publicConfig = {
  authRateLimit: true,
  requireOrigin: true,
} as const;

/**
 * The routes under `/api/v1/invites` that the holder of an invite link uses: look
 * at the invite, and accept it (SC-10, decision D-57). The web app, which comes
 * later, reads the token from the fragment of the link and sends it in a body, so
 * the token never travels in an address. Both count against the strict limit per
 * address (`AUTH_RATE_LIMIT`) and need the right `Origin` with a cookie or without
 * one.
 *
 * `inspect` takes no session (`auth: 'none'`): the token is the capability. Every
 * failure is the same 401 `invite-invalid`, with one body for every cause. `accept`
 * reads the session if there is one (`auth: 'optional'`): a signed-in user with a
 * full session joins as themselves, and someone with no cookie needs a new
 * account, which the route makes with a session (method `invite`, scope `recovery`
 * when there is no password, as in setup). A recovery session cannot accept, a
 * cookie that is invalid or expired is a 401 as on every other route, and an
 * account in the body with a session is a 400.
 *
 * A refusal is committed before it is answered, so its audit event is kept. The
 * token, the password and the session token are never logged, never in an error
 * body and never in an audit event; the session token goes only into the cookie.
 * These routes check no permission: the token is the capability.
 */
export const publicInviteRoutes: FastifyPluginAsyncZod = (app) => {
  app.post(
    '/inspect',
    {
      config: { ...publicConfig, auth: 'none' },
      schema: {
        summary: 'Look at an invite',
        description:
          'Says what a live invite token is for: the name of the organisation, when the invite ends and whether it names an email address (not which). Uses nothing up. A token that is unknown, expired, revoked or already used is the same 401 `invite-invalid`, whatever the reason.',
        body: z.object({ token: tokenSchema }),
        response: {
          200: z.object({
            organisationName: z.string(),
            expiresAt: z.iso.datetime(),
            emailRequired: z
              .boolean()
              .describe(
                'True when the invite names an address: the person must use that one.',
              ),
          }),
          400: badRequest,
          401: inviteInvalid,
          403: wrongOrigin,
          429: tooManyFromAddress,
        },
      },
    },
    async (request, reply) => {
      const inspection = await withRefusalsCommitted(app, (tx) =>
        inspectInvite(tx, request.body.token, new Date()),
      );
      reply.header('cache-control', 'no-store');
      return {
        organisationName: inspection.organisationName,
        expiresAt: inspection.expiresAt.toISOString(),
        emailRequired: inspection.emailRequired,
      };
    },
  );

  app.post(
    '/accept',
    {
      config: { ...publicConfig, auth: 'optional' },
      schema: {
        summary: 'Accept an invite',
        description:
          'Joins the organisation the invite is for, with its tier and roles, in one transaction: a failure at any step leaves nothing, and the invite stays usable. With a full session cookie the signed-in user joins, and `account` must be left out (a 400 otherwise); a user who already belongs gets a 409 `already-member`, and an invite for another address a 422 `invite-email-mismatch`, and neither uses the invite up. With no cookie `account` is required: the route makes the account and signs it in (session method `invite`, cookie set). With no `account.password` that session has the recovery scope: the answer says `mustSecureAccount: true`, and any route but `me`, `logout`, `PUT /auth/password` and the passkey registration answers 403 `account-recovery-required` until a password is set or a passkey added. An address that already has an account is a 409 `account-exists`: sign in, then open the link again. A password the policy refuses is a 422 `password-refused`. A token that does not work is the same 401 `invite-invalid` for every cause, and so is the loser of two accepts of one token at once. A recovery session cannot accept (403 `account-recovery-required`), and a cookie that is no good is a 401.',
        body: z.object({
          token: tokenSchema,
          account: accountInput
            .optional()
            .describe(
              'The details of a new account. Required with no session cookie, and refused with one.',
            ),
        }),
        response: {
          201: z.object({
            user: meSchema,
            organisation: z.object({ id: z.uuid(), name: z.string() }),
            mustSecureAccount: z
              .boolean()
              .describe(
                'True when a new account has no password: its session may only set a password or add a passkey first.',
              ),
          }),
          400: badRequest,
          401: inviteInvalid,
          403: wrongOrigin,
          409: problemResponse(
            '`already-member`: the signed-in user already belongs to the organisation. `account-exists`: an account with the address exists, so sign in and open the link again. Neither uses the invite up.',
          ),
          422: problemResponse(
            '`invite-email-mismatch`: the invite is for another address. `password-refused`: the password does not meet the policy; `errors` holds the reason as `code` at `account.password`. Nothing was made, and the invite can be used again.',
          ),
          429: tooManyFromAddress,
        },
      },
    },
    async (request, reply) => {
      // This route makes a session, so it must say so (`requireOrigin`).
      assertOriginRequired(request);
      // `optional` lets a cookie that is no good through as no session; here it is
      // a 401, as on a route that needs a session. The plugin has already cleared it.
      if (
        request.cookies[SESSION_COOKIE] !== undefined &&
        request.auth === null
      ) {
        throw new AuthenticationRequiredError();
      }
      const { token, account } = request.body;
      const signedIn = request.auth;
      // Checked before anything is read or written, so a refused request spends
      // nothing. A signed-in user joins as themselves, and a stranger needs details.
      if ((signedIn === null) === (account === undefined)) {
        throw new AuthInputError('account');
      }
      const now = new Date();
      const { accepted, created } = await withRefusalsCommitted(
        app,
        async (tx) => {
          const done = await acceptInvite(
            tx,
            token,
            signedIn !== null
              ? { kind: 'signed-in', userId: signedIn.user.id }
              : {
                  kind: 'new-account',
                  account: {
                    email: account!.email,
                    displayName: account!.displayName,
                    ...(account!.password === undefined
                      ? {}
                      : { password: account!.password }),
                  },
                },
            now,
          );
          // The session is made in the same transaction, so a failure of it undoes
          // the account and the membership, and the invite stays usable.
          const session = done.newUser
            ? await createSession(tx, {
                userId: done.user.id,
                method: 'invite',
                // No password, so the first session may only secure the account
                // (the recovery scope the plugin already enforces).
                scope: done.mustSecureAccount ? 'recovery' : 'full',
                now,
                ...deviceOf(request),
              })
            : null;
          return { accepted: done, created: session };
        },
      );
      if (created !== null) {
        setSessionCookie(
          reply,
          created.token,
          created.session.absoluteExpiresAt,
        );
      }
      reply.header('cache-control', 'no-store');
      return reply.code(201).send({
        user: {
          id: accepted.user.id,
          displayName: accepted.user.displayName,
          email: accepted.user.email,
          status: accepted.user.status,
        },
        organisation: accepted.organisation,
        mustSecureAccount: accepted.mustSecureAccount,
      });
    },
  );

  return Promise.resolve();
};
