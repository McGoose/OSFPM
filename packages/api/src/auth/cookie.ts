import type { FastifyReply } from 'fastify';

/**
 * The name of the session cookie. The `__Host-` prefix makes a browser refuse
 * the cookie unless it is `Secure`, has `Path=/` and has no `Domain`, so a
 * sibling sub-domain cannot set or overwrite it. The value is the raw session
 * token: it is never logged (see `loggerOptions`), never in a response body and
 * never in an audit event.
 */
export const SESSION_COOKIE = '__Host-osfpm_session';

/**
 * The attributes every write of the session cookie carries. `Secure` is always
 * on: a browser treats `http://localhost` as secure, and the configuration
 * refuses plain `http` anywhere else. `SameSite=Lax` keeps the cookie off
 * cross-site sub-requests; the `Origin` check covers the rest.
 */
const COOKIE_ATTRIBUTES = {
  path: '/',
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
} as const;

/**
 * Sets the session cookie on `reply`. `expiresAt` is the session's absolute
 * expiry, which never moves, so the browser keeps the cookie as long as the
 * server would honour it; the idle end is the server's to enforce. There is no
 * `Domain` and no `Max-Age`.
 *
 * Called by the login routes with the raw token that `createSession` returned
 * once. Nothing else may hold that token.
 */
export function setSessionCookie(
  reply: FastifyReply,
  token: string,
  expiresAt: Date,
): void {
  reply.setCookie(SESSION_COOKIE, token, {
    ...COOKIE_ATTRIBUTES,
    expires: expiresAt,
  });
}

/**
 * Tells the browser to drop the session cookie. A `__Host-` cookie is only
 * replaced by a header with the same attributes, so they are repeated here.
 */
export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, COOKIE_ATTRIBUTES);
}
