import { z } from 'zod';
import type { InviteView } from '@osfpm/core/src/auth/invites.js';
import { INVITE_TIERS } from '@osfpm/core/src/db/schema/index.js';
import { problemResponse } from '../errors.js';

/** Answers shared by the member and invite routes, for each route's `response` map. */
export const notSignedIn = problemResponse(
  'No usable session. The answer is the same whether the cookie is missing, unknown, expired or revoked, or the user is disabled.',
);
/** The 400 every route here may answer. */
export const badRequest = problemResponse(
  'The request is not shaped as this endpoint accepts. The failing fields are listed, never their values.',
);
/** The 403 of a session that is not allowed, or of a session in recovery. */
export const accessDenied = problemResponse(
  'The user may not do this in this organisation, or the session is a recovery session (`account-recovery-required`). The answer is the same for an organisation that does not exist, one the user is not a member of and one where they lack the permission, so it never says which. A request that changes data with a cookie and a foreign `Origin` is a 403 `origin-mismatch`.',
);
/** The 403 of a request with the wrong `Origin`. */
export const wrongOrigin = problemResponse(
  'The request has no `Origin` header, or one that is not this server’s own origin. A browser always sends it; a script must send it, with the origin of the address people open.',
);
/** The 429 of a route counted per session. */
export const tooManyRequests = problemResponse(
  'Too many requests on this session. Retry-After says how many seconds to wait.',
);
/** The 429 of a route counted per address. */
export const tooManyFromAddress = problemResponse(
  'Too many requests from this address. Retry-After says how many seconds to wait.',
);

/** An invite as a response shows it: never the token or its hash. */
export const inviteSchema = z.object({
  id: z.uuid(),
  organisationId: z.uuid(),
  email: z
    .string()
    .nullable()
    .describe(
      'The address the invite is for, or null when anyone with the link may accept it.',
    ),
  tier: z.enum(INVITE_TIERS).describe('The membership tier the person gets.'),
  roleIds: z
    .array(z.uuid())
    .describe('The organisation roles the person gets.'),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  createdBy: z.uuid().nullable(),
});

/** The JSON form of an `InviteView`: dates as ISO strings, and nothing else added. */
export function inviteBody(view: InviteView): z.infer<typeof inviteSchema> {
  return {
    id: view.id,
    organisationId: view.organisationId,
    email: view.email,
    tier: view.tier,
    roleIds: [...view.roleIds],
    expiresAt: view.expiresAt.toISOString(),
    createdAt: view.createdAt.toISOString(),
    createdBy: view.createdBy,
  };
}
