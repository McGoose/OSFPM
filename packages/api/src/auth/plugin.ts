import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import {
  SESSION_CREDENTIAL,
  type SessionCredential,
  type TokenCredential,
} from '@osfpm/core/src/access/credential.js';
import { ApiTokenInvalidError } from '@osfpm/core/src/auth/api-token-errors.js';
import {
  API_TOKEN_PREFIX,
  authenticateApiToken,
  recordApiTokenCall,
} from '@osfpm/core/src/auth/api-tokens.js';
import {
  validateSession,
  type SessionUser,
  type SessionView,
} from '@osfpm/core/src/auth/sessions.js';
import type { WriteContext } from '@osfpm/core/src/db/write.js';
import { getServerId } from '@osfpm/core/src/installation/server-id.js';
import {
  AmbiguousCredentialsError,
  AuthenticationRequiredError,
  OriginMismatchError,
  RateLimitedError,
  RecoveryRequiredError,
  TokenNotAcceptedError,
  TokenReadOnlyError,
} from '../errors.js';
import { UNMATCHED_ROUTE } from '../logging.js';
import { clearSessionCookie, SESSION_COOKIE } from './cookie.js';
import {
  ADDRESS_RATE_LIMIT,
  AUTH_RATE_LIMIT,
  SESSION_RATE_LIMIT,
} from './rate-limit.js';

/**
 * What a route may say about sessions, in its `config.auth`:
 *
 * - `required` (the default for a route that says nothing): a valid session, or
 *   a 401.
 * - `optional`: a valid session is used if there is one; none is not an error.
 * - `none`: the route does not use the session at all. Cookies are ignored: no
 *   lookup, no clearing, no origin check of the cookie. Health, meta and the
 *   OpenAPI document, and the routes that make a session, which are `none`
 *   because nobody is signed in yet and which say `requireOrigin` instead.
 */
export const AUTH_MODES = ['required', 'optional', 'none'] as const;

/** One value of `AUTH_MODES`. */
export type AuthMode = (typeof AUTH_MODES)[number];

/**
 * The core's `WriteContext` for a signed-in user: the actor is that user. Pass
 * it to the core services and the write helper as it is.
 */
export type ActingUserContext = WriteContext & {
  readonly actor: { readonly type: 'user'; readonly id: string };
};

/**
 * The core's `WriteContext` for a request made with a personal API token: the actor is
 * the token, and the user it acts for is its owner (`onBehalfOfUserId`), as the write
 * helper has it. Pass it to the core's write helper and services as it is.
 */
export type ActingTokenContext = WriteContext & {
  readonly actor: { readonly type: 'token'; readonly id: string };
  readonly onBehalfOfUserId: string;
};

/** The signed-in user of a request, put there by the auth plugin. */
export type Authenticated = {
  /** For the core's write helper and services. */
  readonly context: ActingUserContext;
  /** Only what a signed-in client needs; never a token or a hash. */
  readonly user: SessionUser;
  /** The session this request came in on; never its token or hash. */
  readonly session: SessionView;
  /** What the request came in with: a session, which is not narrowed. */
  readonly credential: SessionCredential;
};

/**
 * The owner of a personal API token that a request came in with, put there by the auth
 * plugin on a route that accepts tokens. It is a separate field from `request.auth`, so
 * code that reads a session (`requireAuthenticated`, `request.auth`) can never be
 * handed a token by mistake.
 */
export type TokenAuthenticated = {
  /** For the core's write helper and services: the token acts for its owner. */
  readonly context: ActingTokenContext;
  /** The owner, as a session's user is shown. Never a token or a hash. */
  readonly user: SessionUser;
  /** What the token may do. Pass it to every service that takes one. */
  readonly credential: TokenCredential;
};

/** Whoever made the request, by a session or by a token. See `requireCaller`. */
export type Caller = Authenticated | TokenAuthenticated;

/** What a route that accepts tokens says: `read` for the routes that only read, `write` for the rest. */
export type TokenAccess = 'read' | 'write';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** How the route treats a session. Defaults to `required` (see `AUTH_MODES`). */
    auth?: AuthMode;
    /**
     * The route is not counted against the coarse limit per address (see
     * `ADDRESS_RATE_LIMIT`), which every other route is. Only `/health` and
     * `/health/ready` say so: a supervisor must always be able to probe.
     */
    exemptFromAddressRateLimit?: boolean;
    /**
     * Counts the request against the strict limit per address (see
     * `AUTH_RATE_LIMIT`). For a route that checks a secret, where a caller may
     * be guessing: sign-in, setup, recovery, invites. Counted before anything
     * else, so a caller with no session is limited too.
     */
    authRateLimit?: boolean;
    /**
     * Counts the request against the limit per session (see
     * `SESSION_RATE_LIMIT`). For a route a signed-in client uses as it goes. A
     * request with no valid session is not counted.
     */
    sessionRateLimit?: boolean;
    /**
     * A session with the recovery scope (a recovery code, first-run setup, an
     * invite or an admin reset link opened it) may call the
     * route. Without it a recovery session gets a 403
     * `account-recovery-required`, whatever the route's `auth` mode, so a new
     * route is closed to such a session unless it says otherwise. Only the
     * routes by which a user sets a new way to sign in, reads who they are or
     * signs out say so.
     */
    allowedInRecovery?: boolean;
    /**
     * A request that changes data must carry an `Origin` equal to the public
     * origin, whether or not it has a session cookie, or it is a 403
     * `origin-mismatch`. For the routes that make a session (a sign-in step,
     * first-run setup): a forged request from a page on another site has no cookie
     * to borrow, but it could still sign the visitor in as someone else, and a
     * browser always sends the `Origin` of the page, so the check costs a browser
     * nothing. A script has to send the header itself. Counted against the strict
     * limit first, like every route with `authRateLimit`, and checked before the
     * body is read. A route that makes a session calls `assertOriginRequired`, so
     * it cannot forget to say so.
     */
    requireOrigin?: boolean;
    /**
     * The route accepts a personal API token (SC-10, decision D-68), in an
     * `Authorization: Bearer <token>` header. Routes refuse tokens unless they say so
     * (CLAUDE.md, Code rules): a request with a token to a route that says nothing is a
     * 403 `token-not-accepted`, before the token is looked up. `read` is for a route
     * that only reads, and must be a safe method (`GET`, `HEAD` or `OPTIONS`); a token
     * that can only read may call it. `write` is for any other route, and a token that
     * can only read is refused (403 `token-read-only`). A route may say it only when
     * every service it calls takes the credential and passes it on to its permission
     * checks (`MemberActor`, `SensitiveContext`), because that is what narrows the
     * token to its organisation, project, access and sensitive scope. The routes that
     * sign people in, secure an account or hand out access, and the routes that manage
     * tokens and their switches, never say it. A route that accepts a token and says
     * `auth: 'none'` (`/meta`) answers the same with or without one, but checks a token
     * that is sent: a bad one is a 401.
     */
    tokenAccess?: TokenAccess;
  }
  interface FastifyRequest {
    /**
     * The signed-in user, or `null` when the request has no valid session.
     * Always set on a `required` route; read it through `requireAuthenticated`. Never
     * set by a token: see `tokenAuth`.
     */
    auth: Authenticated | null;
    /**
     * The owner of the personal API token the request came in with, or `null` when it
     * came in with none. Only set on a route that says `tokenAccess`; read it through
     * `requireCaller`. Never set at the same time as `auth`.
     */
    tokenAuth: TokenAuthenticated | null;
  }
}

/** What `authPlugin` is registered with. */
export type AuthPluginOptions = {
  /**
   * The origin of `OSFPM_PUBLIC_URL`, written as a browser writes it (see
   * `Config.publicOrigin`). The only `Origin` a request that changes data may
   * have when it carries a session cookie, or when its route says `requireOrigin`.
   */
  readonly publicOrigin: string;
  /** The coarse limit per address. Defaults to `ADDRESS_RATE_LIMIT`; tests raise it. */
  readonly addressRateLimit?: {
    readonly max: number;
    readonly timeWindowMs: number;
  };
};

/** The methods that change data. Safe methods carry no origin check. */
const ORIGIN_CHECKED_METHODS: ReadonlySet<string> = new Set([
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
]);

/** The methods a route that says `tokenAccess: 'read'` may have: the safe ones. */
const TOKEN_READ_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'HEAD',
  'OPTIONS',
]);

/**
 * The token in an `Authorization: Bearer <token>` header, or `null` when there is no such
 * header or the header is not ours. The scheme is matched without regard to case
 * (RFC 7235); any other scheme (`Basic`, which a reverse proxy may use for its own
 * purposes) is not ours and is left alone. So is a `Bearer` value that does not start with
 * `osfpm_pat_`, the start of every token OSFPM makes: an authenticating proxy may forward
 * its own `Authorization: Bearer <jwt>` to every request, and reading that as a token would
 * make every browser request behind it a 400 (a cookie as well) or a 403. A `Bearer`
 * header with nothing after it is a token that is empty, which no token is, so it is
 * ours and is refused as a token, not ignored.
 */
function bearerTokenOf(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer(?:[ \t]+(.*))?$/i.exec(header.trim());
  if (match === null) return null;
  const value = (match[1] ?? '').trim();
  return value === '' || value.startsWith(API_TOKEN_PREFIX) ? value : null;
}

/**
 * Refuses a route that declares `config.tokenAccess` wrongly: the value must be `read` or
 * `write`, and `read` is for a route that only reads, so every method the route has must be
 * a safe one (`GET`, `HEAD` or `OPTIONS`). A route that says nothing passes. The plugin
 * calls it for every route as the route is made, so a mistake stops the server from
 * starting; it is also what a test calls to show the rule. Checks nothing else, and reads
 * nothing but the route's own options.
 *
 * @throws Error naming the route's pattern, never a value from a request. That is a bug in
 * the server, not in a request.
 */
export function assertTokenAccessDeclaration(route: {
  readonly url: string;
  readonly method: string | readonly string[];
  readonly config?: { readonly tokenAccess?: unknown } | undefined;
}): void {
  const access: unknown = route.config?.tokenAccess;
  if (access === undefined) return;
  if (access !== 'read' && access !== 'write') {
    throw new Error(
      `Route ${route.url} says tokenAccess with a value that is neither 'read' nor 'write'`,
    );
  }
  const methods =
    typeof route.method === 'string' ? [route.method] : route.method;
  if (
    access === 'read' &&
    !methods.every((method) => TOKEN_READ_METHODS.has(method))
  ) {
    throw new Error(
      `Route ${route.url} says tokenAccess 'read' for a method that changes data`,
    );
  }
}

/** What a route's `tokenAccess` says, or `undefined` for none and for any value that is not one of the two. */
function tokenAccessOf(configured: unknown): TokenAccess | undefined {
  return configured === 'read' || configured === 'write'
    ? configured
    : undefined;
}

/** One of the two limiters `createRateLimit` made. */
type Limiter = ReturnType<FastifyInstance['createRateLimit']>;

/**
 * Counts the request in `limiter`, and refuses it with a 429 and `Retry-After`
 * (whole seconds, at least one) when the count is past the limit.
 */
async function enforce(
  limiter: Limiter,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const used = await limiter(request);
  if (!used.isAllowed && used.isExceeded) {
    reply.header('retry-after', String(Math.max(1, used.ttlInSeconds)));
    throw new RateLimitedError();
  }
}

const implementation: FastifyPluginAsync<AuthPluginOptions> = (
  app,
  options,
) => {
  const { publicOrigin } = options;

  // The id of this server never changes, so it is read once. A failed read is
  // not kept, so the next request tries again.
  let originServer: Promise<string> | undefined;
  const thisServer = () =>
    (originServer ??= getServerId(app.db.db).catch((error: unknown) => {
      originServer = undefined;
      throw error;
    }));

  // Every route but the health routes is counted here, per address, before
  // anything else. Its own limiter, so its count is its own.
  const addressRateLimit = options.addressRateLimit ?? ADDRESS_RATE_LIMIT;
  const addressLimit = app.createRateLimit({
    max: addressRateLimit.max,
    timeWindow: addressRateLimit.timeWindowMs,
  });

  // One limiter for every route that asks, so they share one count per address.
  // It is called from the hook below rather than left to the rate-limit plugin's
  // own route hook, because a route hook runs after the app's hooks: the session
  // check would answer first and an unauthenticated caller would never be counted.
  const authLimit = app.createRateLimit({
    max: AUTH_RATE_LIMIT.max,
    timeWindow: AUTH_RATE_LIMIT.timeWindowMs,
  });
  // The same for the routes of a signed-in client, but counted per session, so
  // a session behind a shared address does not use up its neighbour's requests.
  // It is only called once there is a session or a token, so the key is always one.
  // A personal API token gets the same limit as a session, counted per token (the
  // ids of the two are never the same), on every route that accepts one.
  const sessionLimit = app.createRateLimit({
    max: SESSION_RATE_LIMIT.max,
    timeWindow: SESSION_RATE_LIMIT.timeWindowMs,
    keyGenerator: (request) =>
      request.auth?.session.id ?? request.tokenAuth?.credential.tokenId ?? '',
  });

  app.decorateRequest('auth', null);
  app.decorateRequest('tokenAuth', null);

  // Refused when the route is made, so a mistake fails the first start and not a request.
  app.addHook('onRoute', (route) => {
    assertTokenAccessDeclaration(route);
  });

  /**
   * The request came in with `Authorization: Bearer <bearer>` on a route that is not
   * `auth: 'none'`, or that says `tokenAccess`. Refuses it, or puts the owner of the
   * token on `request.tokenAuth`. The order matters and is the contract:
   *
   * 1. A session cookie as well: 400, before anything is looked up. Which credential is
   *    meant is not for the server to guess.
   * 2. A route that does not say `tokenAccess`: 403, before the token is looked up, so
   *    the answer says nothing about the token.
   * 3. The strict limit per address is looked at before the token is, without counting
   *    (`increment: false`). It decides only what a token that fails is told, and whether
   *    that failure is written down. A token that works is answered whatever its address
   *    has done, and is not counted: the limit is for guessing, a token that works has
   *    guessed nothing, and one broken script behind a shared address must not stop the
   *    others.
   * 4. The token is looked up in a transaction that commits whatever the answer, so
   *    the audit event of a failure is kept (CLAUDE.md, Data rules). A token that does not
   *    work is one 401 for every cause, and counts against the strict limit. From an
   *    address that is already over the limit it is a 429 instead, and is not written to
   *    the audit trail, so a flood of bad tokens writes no more rows than the limit allows
   *    (the 429s are in the request log).
   * 5. A token that works is counted against its own limit, and a token that can only
   *    read is refused on a route that says `write`.
   *
   * There is no `Origin` check: a token is not a cookie, so there is nothing a
   * cross-site page could borrow.
   */
  async function acceptToken(
    request: FastifyRequest,
    reply: FastifyReply,
    bearer: string,
    access: TokenAccess | undefined,
  ): Promise<void> {
    if (request.cookies[SESSION_COOKIE] !== undefined) {
      throw new AmbiguousCredentialsError();
    }
    if (access === undefined) throw new TokenNotAcceptedError();
    const looked = await authLimit(request, { increment: false });
    const overTheLimit = !looked.isAllowed && looked.isExceeded;
    // A route under `/organisations/:organisationId` names the organisation it is for,
    // and a token works in its own only: asked about another, it is the same 401 as a
    // token that does not work, so a token says nothing about organisations that are not
    // its own. The core narrows every permission check by it as well.
    const params = request.params as { organisationId?: unknown } | undefined;
    const organisationId =
      typeof params?.organisationId === 'string'
        ? params.organisationId
        : undefined;
    const outcome = await app.db.db.transaction(async (tx) => {
      try {
        return {
          ok: true,
          found: await authenticateApiToken(tx, bearer, new Date(), {
            ...(organisationId === undefined ? {} : { organisationId }),
            auditFailure: !overTheLimit,
          }),
        } as const;
      } catch (error) {
        // Committed with its audit event, and thrown after.
        if (error instanceof ApiTokenInvalidError) {
          return { ok: false, error } as const;
        }
        throw error;
      }
    });
    if (!outcome.ok) {
      if (overTheLimit) {
        reply.header('retry-after', String(Math.max(1, looked.ttlInSeconds)));
        throw new RateLimitedError();
      }
      await enforce(authLimit, request, reply);
      throw outcome.error;
    }
    const { credential, user } = outcome.found;
    request.tokenAuth = {
      user,
      credential,
      context: {
        actor: { type: 'token', id: credential.tokenId },
        onBehalfOfUserId: user.id,
        originServer: await thisServer(),
        requestId: request.id,
        clock: () => new Date(),
      },
    };
    await enforce(sessionLimit, request, reply);
    if (credential.access === 'read' && access === 'write') {
      throw new TokenReadOnlyError();
    }
  }

  // One audit event for every request a token made, after the response, whatever the
  // answer (SC-10, decision D-68: every outside call is written to the audit log): the
  // token, its owner, the method, the route pattern and the status. A request whose token
  // was refused has none of these (it has its own event), and a failure here cannot
  // change the answer that has gone, so it is logged by class name and nothing more.
  app.addHook('onResponse', async (request, reply) => {
    const caller = request.tokenAuth;
    if (caller === null) return;
    try {
      await app.db.db.transaction((tx) =>
        recordApiTokenCall(
          tx,
          caller.credential,
          {
            userId: caller.user.id,
            method: request.method,
            route: request.routeOptions.url ?? UNMATCHED_ROUTE,
            status: reply.statusCode,
            requestId: request.id,
          },
          new Date(),
        ),
      );
    } catch (error) {
      request.log.error({ err: error }, 'api call audit failed');
    }
  });

  app.addHook('onRequest', async (request, reply) => {
    // First of all, before the session, the Origin or the strict limit: a flood
    // costs a count and nothing more. A path that is no route counts too, since
    // it still costs a request and a log line; it has no route config to read.
    if (
      request.is404 ||
      request.routeOptions.config.exemptFromAddressRateLimit !== true
    ) {
      await enforce(addressLimit, request, reply);
    }

    // No route matched, so there is nothing here to protect, and the answer is
    // the 404 problem whoever asks.
    if (request.is404) return;

    // Next, whatever the route would have answered, so a caller with no
    // session, a wrong one or a foreign Origin is counted as well.
    if (request.routeOptions.config.authRateLimit === true) {
      await enforce(authLimit, request, reply);
    }

    // A route that makes a session needs the Origin with a cookie or without
    // one, and whether or not it uses the session, so this comes before the mode.
    // After the strict limit, so a flood of forged requests costs a count and
    // nothing more; before the body is read, so a refused request spends no code.
    if (
      request.routeOptions.config.requireOrigin === true &&
      ORIGIN_CHECKED_METHODS.has(request.method) &&
      request.headers.origin !== publicOrigin
    ) {
      throw new OriginMismatchError();
    }

    // Anything but the two looser modes is `required`, including a value this
    // plugin does not know: a typo in a cast must not open a route.
    const configured: unknown = request.routeOptions.config.auth;
    const mode: AuthMode =
      configured === 'optional' || configured === 'none'
        ? configured
        : 'required';

    // A bearer token is read before the mode, because a route that accepts tokens can
    // be `auth: 'none'` (`/meta`). A route that is `none` and says nothing about
    // tokens uses no credential at all, so a header it does not read is no business of
    // its own; any other route that is not told to take a token refuses one.
    const bearer = bearerTokenOf(request);
    const tokenAccess = tokenAccessOf(request.routeOptions.config.tokenAccess);
    if (bearer !== null && !(mode === 'none' && tokenAccess === undefined)) {
      await acceptToken(request, reply, bearer, tokenAccess);
      // A request that came in with a token never goes on to the session.
      return;
    }
    if (mode === 'none') return;

    const token = request.cookies[SESSION_COOKIE];
    const hasCookie = token !== undefined;

    // Checked on the presence of the cookie, before it is looked up, so a
    // cross-site request learns nothing about whether its cookie was good. A
    // request with no session cookie has nothing a forger could borrow.
    if (
      hasCookie &&
      ORIGIN_CHECKED_METHODS.has(request.method) &&
      request.headers.origin !== publicOrigin
    ) {
      throw new OriginMismatchError();
    }

    const found = hasCookie
      ? await validateSession(app.db.db, token, new Date())
      : null;
    if (found === null) {
      // A cookie that is no good is dropped, whatever the route.
      if (hasCookie) clearSessionCookie(reply);
      // The same error for no cookie, an unknown token, an expired or revoked
      // session and a disabled user: the answer never says which.
      if (mode === 'required') throw new AuthenticationRequiredError();
      return;
    }

    request.auth = {
      user: found.user,
      session: found.session,
      credential: SESSION_CREDENTIAL,
      context: {
        actor: { type: 'user', id: found.user.id },
        originServer: await thisServer(),
        requestId: request.id,
        clock: () => new Date(),
      },
    };

    // Only now is there a session to count. It comes after the Origin check, so
    // a forged request, which is refused above, does not spend the session's own.
    if (request.routeOptions.config.sessionRateLimit === true) {
      await enforce(sessionLimit, request, reply);
    }

    // A session a recovery code opened may do only what lets its user secure the
    // account (SC-10). Closed unless the route says otherwise, so a new route
    // cannot be open to it by accident, and checked on `optional` routes too,
    // which also use the session.
    if (
      found.session.scope === 'recovery' &&
      request.routeOptions.config.allowedInRecovery !== true
    ) {
      throw new RecoveryRequiredError();
    }
  });

  return Promise.resolve();
};

/**
 * Turns the session cookie into the acting user, for every route of the app.
 *
 * On each request to a route that does not say `auth: 'none'` it reads
 * `__Host-osfpm_session`, asks the core's `validateSession`, and puts the result
 * on `request.auth`, with a `WriteContext` whose actor is the user. A cookie
 * that is invalid, expired or revoked, or belongs to a disabled user, is treated
 * as no session, and the response clears the cookie. A `required` route then
 * answers 401 `authentication-required`, with the same text whatever the
 * reason.
 *
 * Every request, a path that is no route included, is counted against
 * `ADDRESS_RATE_LIMIT`, per address, before anything else, unless its route says
 * `config.exemptFromAddressRateLimit` (only the two health routes do). A route
 * with `config.authRateLimit` is counted against `AUTH_RATE_LIMIT`, per address,
 * next. A route with `config.sessionRateLimit` is counted
 * against `SESSION_RATE_LIMIT`, per session, once the session is known; a
 * request with no valid session is not counted. Past either limit it is a 429
 * `rate-limited` with `Retry-After`.
 *
 * A session with the `recovery` scope, which a recovery code, first-run setup, an
 * invite or an admin reset link opens, may only
 * call a route that says `config.allowedInRecovery`; any other route is a 403
 * `account-recovery-required`, whatever its `auth` mode but `none`. The check
 * comes after the origin check and the limit per session.
 *
 * A request that changes data (`POST`, `PUT`, `PATCH`, `DELETE`) with a session
 * cookie must carry an `Origin` equal to `publicOrigin`, or it is a 403
 * `origin-mismatch`. That is the defence against cross-site requests, and it
 * runs before the session is looked up. A request with no session cookie is not
 * checked: a personal API token authenticates it another way, and has no
 * `Origin` check, because it is not a cookie and there is nothing for a cross-site
 * page to borrow. The
 * exception is a route that says `config.requireOrigin`, which every route that
 * makes a session does: its request must carry the right `Origin` whether or not
 * it has a cookie, whatever the route's `auth` mode, because a page on another
 * site could otherwise sign the visitor in as someone else. That check comes
 * right after the strict limit and before anything else about the request.
 *
 * It runs as an `onRequest` hook, so before the body is read or validated. A
 * route declares its mode in `config.auth` (see `AUTH_MODES`); a value the
 * plugin does not know counts as `required`. An unknown route is not touched.
 *
 * A request with `Authorization: Bearer <token>` is a request made with a personal
 * API token (SC-10, decision D-68), and the plugin handles it before it reads the
 * mode. Routes refuse tokens unless they say `config.tokenAccess` (`read` or
 * `write`): a token on a route that does not is a 403 `token-not-accepted`, a
 * session cookie as well is a 400 `ambiguous-credentials`, a token that does not
 * work is one 401 `invalid-token` for every cause and counts against the strict
 * limit per address, a token that works is counted against the limit per token
 * (`SESSION_RATE_LIMIT`, on every route that accepts tokens), and a token that can only
 * read is refused on a `write` route (403 `token-read-only`). The owner is put on
 * `request.tokenAuth`, never on `request.auth`, and every request made with a token is
 * written to the audit log after the response (`recordApiTokenCall`). A route that is
 * `auth: 'none'` and does not say `tokenAccess` ignores an `Authorization` header, as
 * it ignores cookies.
 *
 * Registered once, in `buildApp`, after `@fastify/cookie`, which parses the
 * cookie. It sets the marker `fastify-plugin` would set, so its hooks apply to
 * every route of the app and not only to plugins registered inside it;
 * `fastify-plugin` is not a direct dependency of this package.
 *
 * The raw token or cookie value is never logged, returned or stored by this plugin:
 * it goes from the header or the cookie to the core's `authenticateApiToken` or
 * `validateSession` and nowhere else.
 */
export const authPlugin: FastifyPluginAsync<AuthPluginOptions> = Object.assign(
  implementation,
  {
    [Symbol.for('skip-override')]: true,
    [Symbol.for('fastify.display-name')]: 'osfpm-auth',
  },
);

/**
 * Refuses to go on when the route of `request` has not said `config.requireOrigin`.
 * A route that makes a session calls it before it does, so a new sign-in route
 * cannot forget the `Origin` check: the plugin enforces `requireOrigin`, and this
 * makes sure the route declares it. It checks the route's declaration, not the
 * request, because the plugin has already refused a request with the wrong
 * `Origin`.
 *
 * @throws Error when the route does not say it. That is a bug in the server, not
 * in the request, so it becomes a generic 500.
 */
export function assertOriginRequired(request: FastifyRequest): void {
  if (request.routeOptions.config.requireOrigin !== true) {
    throw new Error(
      'A route that makes a session must say config.requireOrigin',
    );
  }
}

/**
 * The signed-in user of `request`, by a session. For a handler of a `required` route,
 * where the plugin has already answered 401 if there was none. It never answers for a
 * personal API token: a route that accepts tokens reads who is calling with
 * `requireCaller`, and every other route refuses a token before its handler runs.
 *
 * @throws Error when there is no signed-in user. The route is `optional` or
 * `none` and still asked for one, which is a bug in the server, so it becomes a
 * generic 500.
 */
export function requireAuthenticated(request: FastifyRequest): Authenticated {
  if (request.auth === null) {
    throw new Error(
      'A route that reads the acting user must not be auth: none',
    );
  }
  return request.auth;
}

/**
 * Whoever made `request`: the signed-in user of a session, or the owner of a personal API
 * token, with the credential to hand to every core service that takes one. For a handler
 * of a route that says `tokenAccess`, where the plugin has already refused a request that
 * had neither. A session's credential narrows nothing, a token's narrows what the owner
 * may do to the token's organisation, project, access and sensitive scope, in the
 * permission checks of the services that are given it.
 *
 * @throws Error when the request has neither. The route is `none` and still asked, which
 * is a bug in the server, so it becomes a generic 500.
 */
export function requireCaller(request: FastifyRequest): Caller {
  const caller = request.auth ?? request.tokenAuth;
  if (caller === null) {
    throw new Error('A route that reads the caller must not be auth: none');
  }
  return caller;
}
