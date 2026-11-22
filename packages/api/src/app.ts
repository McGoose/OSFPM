import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import Fastify from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Database } from '@osfpm/core/src/db/client.js';
import { newId } from '@osfpm/core/src/db/ids.js';
import { API_PREFIX } from './api-version.js';
import { relyingPartyFor } from '@osfpm/core/src/auth/passkeys.js';
import { accountRoutes } from './auth/account-routes.js';
import { loginRoutes } from './auth/login-routes.js';
import { passkeyRoutes } from './auth/passkey-routes.js';
import { authPlugin } from './auth/plugin.js';
import {
  handleFrameworkError,
  registerErrorHandling,
  StartingError,
} from './errors.js';
import {
  createLogController,
  loggerOptions,
  UNMATCHED_ROUTE,
  type LoggerSettings,
} from './logging.js';
import { PACKAGE_VERSION } from './package-info.js';
import { safeValidatorCompiler } from './validation.js';
import { authRoutes } from './routes/auth.js';
import { healthRoutes } from './routes/health.js';
import { metaRoutes } from './routes/meta.js';
import { openapiRoutes } from './routes/openapi.js';

/**
 * Whether start-up has finished. A new app is not ready; `runStartup` marks it
 * once the migrations and the permission sync are done, and `/health/ready`
 * answers 503 until then.
 */
export type Readiness = {
  readonly isReady: () => boolean;
  readonly markReady: () => void;
};

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * The route answers while the server is still starting. Only the two health
     * routes say so; every other route is a 503 problem `starting` until
     * start-up has finished.
     */
    availableWhileStarting?: boolean;
  }
  interface FastifyInstance {
    /** The database every route plugin works on. The caller of `buildApp` owns it. */
    db: Database;
    /**
     * The origin of `OSFPM_PUBLIC_URL` (see `BuildAppOptions.publicOrigin`). Start-up
     * uses it for the installation's base URL and for the address it prints with
     * the setup code.
     */
    publicOrigin: string;
    /** Whether start-up has finished (see `Readiness`). */
    readiness: Readiness;
  }
}

/** What `buildApp` needs. */
export type BuildAppOptions = {
  /**
   * The database handle, opened with the core's `createDatabase`. The app
   * never closes it: whoever opened it does, after `app.close()`.
   */
  readonly db: Database;
  /**
   * The origin of `OSFPM_PUBLIC_URL` (`Config.publicOrigin`): the only `Origin`
   * a request that changes data and carries a session cookie may have.
   */
  readonly publicOrigin: string;
  /**
   * The reverse proxies whose `X-Forwarded-For` is believed (`Config.trustedProxies`).
   * Leave out, or empty, to believe no header: `request.ip`, which the rate
   * limits count by, is then the address of the connection, so behind a proxy
   * every caller is the proxy.
   */
  readonly trustedProxies?: readonly string[];
  /**
   * The coarse limit per address on every route but the health routes. Leave
   * out for `ADDRESS_RATE_LIMIT`. Only tests pass it, to raise it for an app that
   * is asked far more than a client would.
   */
  readonly addressRateLimit?: {
    readonly max: number;
    readonly timeWindowMs: number;
  };
  /** Leave out for no logging. See `loggerOptions` for what a line holds. */
  readonly logger?: LoggerSettings;
};

/**
 * Builds the API without listening, so a test can use `app.inject()` and the
 * server entry can call `app.listen()`. Routes live under `/api/v1`, one
 * Fastify plugin per area, so a module adds its own plugin and its routes
 * share nothing with the others by accident. CORS is off: the API is same-origin
 * by default. Every route needs a signed-in user unless it says otherwise in
 * `config.auth` (see `authPlugin`). Every error, and every unknown route, is
 * answered as a problem response (see `registerErrorHandling`).
 *
 * The app starts not ready: it does not migrate or sync anything itself (see
 * `runStartup`). Until that has run, `/health/ready` answers 503 and every
 * route but `/health` and `/health/ready` answers a 503 problem `starting`.
 *
 * Every request gets a UUIDv7 from the core's generator. A request ID sent by
 * the caller is ignored, so a caller cannot choose what appears in the logs.
 * The ID is returned in `X-Request-Id` on every response and is on every log
 * line as `requestId`.
 *
 * Logging writes one line when a response is sent: method, route pattern,
 * status code, duration and request ID. Never a body, a header or a URL
 * (CLAUDE.md, Privacy rule).
 */
export function buildApp(options: BuildAppOptions) {
  const app = Fastify({
    logger: loggerOptions(options.logger),
    logController: createLogController(),
    genReqId: () => newId(),
    requestIdHeader: false,
    trustProxy:
      options.trustedProxies !== undefined && options.trustedProxies.length > 0
        ? [...options.trustedProxies]
        : false,
    frameworkErrors: handleFrameworkError,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(safeValidatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('db', options.db);
  app.decorate('publicOrigin', options.publicOrigin);
  // Not ready until `runStartup` says so. A caller that forgets gets 503s from
  // `/health/ready`, which is the safe way to be wrong.
  let ready = false;
  app.decorate('readiness', {
    isReady: () => ready,
    markReady: () => {
      ready = true;
    },
  });
  registerErrorHandling(app);

  // Registered before the routes, so it sees every one of them.
  void app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'OSFPM API', version: PACKAGE_VERSION },
    },
    transform: jsonSchemaTransform,
  });

  app.addHook('onRequest', (request, reply, done) => {
    reply.header('x-request-id', request.id);
    done();
  });

  // Before the auth plugin and the rate limiter, which look in the database,
  // and before any route does: while the server starts, that database may be
  // unmigrated or out of reach. A route that does not say
  // `availableWhileStarting` waits, so a new route cannot be open by accident.
  // An unknown route has nothing to protect and is the usual 404.
  app.addHook('onRequest', (request, _reply, done) => {
    if (
      request.is404 ||
      app.readiness.isReady() ||
      request.routeOptions.config.availableWhileStarting === true
    ) {
      done();
      return;
    }
    done(new StartingError());
  });

  // The cookie parser and the rate limiter first, then the auth plugin that
  // uses both. They register on the whole app, before any route. The limiter
  // limits nothing by itself (`global: false`): the auth plugin calls it for
  // the routes that set `config.authRateLimit`. Its counts are in this
  // process's memory.
  void app.register(cookie);
  void app.register(rateLimit, { global: false });
  void app.register(authPlugin, {
    publicOrigin: options.publicOrigin,
    ...(options.addressRateLimit === undefined
      ? {}
      : { addressRateLimit: options.addressRateLimit }),
  });

  app.addHook('onResponse', (request, reply, done) => {
    request.log.info(
      {
        method: request.method,
        route: request.routeOptions.url ?? UNMATCHED_ROUTE,
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      },
      'request completed',
    );
    done();
  });

  // The site a passkey belongs to: the host name of the public URL is its id, and
  // its origin is the only origin a passkey ceremony may happen on.
  const relyingParty = relyingPartyFor(options.publicOrigin);

  // One plugin per area. A module adds its own line here.
  void app.register(healthRoutes, { prefix: API_PREFIX });
  void app.register(metaRoutes, { prefix: API_PREFIX });
  void app.register(openapiRoutes, { prefix: API_PREFIX });
  void app.register(authRoutes, { prefix: `${API_PREFIX}/auth` });
  void app.register(loginRoutes, {
    prefix: `${API_PREFIX}/auth`,
    relyingParty,
  });
  void app.register(accountRoutes, { prefix: `${API_PREFIX}/auth` });
  void app.register(passkeyRoutes, {
    prefix: `${API_PREFIX}/auth`,
    relyingParty,
  });

  return app;
}

/** The Fastify instance `buildApp` returns, typed for Zod route schemas. */
export type App = ReturnType<typeof buildApp>;
