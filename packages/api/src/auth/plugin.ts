import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import {
  validateSession,
  type SessionUser,
  type SessionView,
} from '@osfpm/core/src/auth/sessions.js';
import type { WriteContext } from '@osfpm/core/src/db/write.js';
import { getServerId } from '@osfpm/core/src/installation/server-id.js';
import {
  AuthenticationRequiredError,
  OriginMismatchError,
  RateLimitedError,
} from '../errors.js';
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
 *   lookup, no clearing, no origin check. Health, meta and the OpenAPI document.
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

/** The signed-in user of a request, put there by the auth plugin. */
export type Authenticated = {
  /** For the core's write helper and services. */
  readonly context: ActingUserContext;
  /** Only what a signed-in client needs; never a token or a hash. */
  readonly user: SessionUser;
  /** The session this request came in on; never its token or hash. */
  readonly session: SessionView;
};

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
  }
  interface FastifyRequest {
    /**
     * The signed-in user, or `null` when the request has no valid session.
     * Always set on a `required` route; read it through `requireAuthenticated`.
     */
    auth: Authenticated | null;
  }
}

/** What `authPlugin` is registered with. */
export type AuthPluginOptions = {
  /**
   * The origin of `OSFPM_PUBLIC_URL`, written as a browser writes it (see
   * `Config.publicOrigin`). The only `Origin` a request that changes data and
   * carries a session cookie may have.
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
  // It is only called once there is a session, so the key is always one.
  const sessionLimit = app.createRateLimit({
    max: SESSION_RATE_LIMIT.max,
    timeWindow: SESSION_RATE_LIMIT.timeWindowMs,
    keyGenerator: (request) => request.auth?.session.id ?? '',
  });

  app.decorateRequest('auth', null);

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

    // Anything but the two looser modes is `required`, including a value this
    // plugin does not know: a typo in a cast must not open a route.
    const configured: unknown = request.routeOptions.config.auth;
    const mode: AuthMode =
      configured === 'optional' || configured === 'none'
        ? configured
        : 'required';
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
 * A request that changes data (`POST`, `PUT`, `PATCH`, `DELETE`) with a session
 * cookie must carry an `Origin` equal to `publicOrigin`, or it is a 403
 * `origin-mismatch`. That is the defence against cross-site requests, and it
 * runs before the session is looked up. A request with no session cookie is not
 * checked: API tokens, which come later, authenticate it another way.
 *
 * It runs as an `onRequest` hook, so before the body is read or validated. A
 * route declares its mode in `config.auth` (see `AUTH_MODES`); a value the
 * plugin does not know counts as `required`. An unknown route is not touched.
 *
 * Registered once, in `buildApp`, after `@fastify/cookie`, which parses the
 * cookie. It sets the marker `fastify-plugin` would set, so its hooks apply to
 * every route of the app and not only to plugins registered inside it;
 * `fastify-plugin` is not a direct dependency of this package.
 *
 * The raw token is never logged, returned or stored by this plugin: it goes
 * from the cookie to `validateSession` and nowhere else.
 */
export const authPlugin: FastifyPluginAsync<AuthPluginOptions> = Object.assign(
  implementation,
  {
    [Symbol.for('skip-override')]: true,
    [Symbol.for('fastify.display-name')]: 'osfpm-auth',
  },
);

/**
 * The signed-in user of `request`. For a handler of a `required` route, where
 * the plugin has already answered 401 if there was none.
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
