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
import { handleFrameworkError, registerErrorHandling } from './errors.js';
import {
  createLogController,
  loggerOptions,
  UNMATCHED_ROUTE,
  type LoggerSettings,
} from './logging.js';
import { PACKAGE_VERSION } from './package-info.js';
import { safeValidatorCompiler } from './validation.js';
import { healthRoutes } from './routes/health.js';
import { metaRoutes } from './routes/meta.js';
import { openapiRoutes } from './routes/openapi.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** The database every route plugin works on. The caller of `buildApp` owns it. */
    db: Database;
  }
}

/** What `buildApp` needs. */
export type BuildAppOptions = {
  /**
   * The database handle, opened with the core's `createDatabase`. The app
   * never closes it: whoever opened it does, after `app.close()`.
   */
  readonly db: Database;
  /** Leave out for no logging. See `loggerOptions` for what a line holds. */
  readonly logger?: LoggerSettings;
};

/**
 * Builds the API without listening, so a test can use `app.inject()` and the
 * server entry can call `app.listen()`. Routes live under `/api/v1`, one
 * Fastify plugin per area, so a module adds its own plugin and its routes
 * share nothing with the others by accident. CORS is off: the API is same-origin
 * by default. Authentication is not added yet. Every error, and every unknown
 * route, is answered as a problem response (see `registerErrorHandling`).
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
    frameworkErrors: handleFrameworkError,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(safeValidatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('db', options.db);
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

  // One plugin per area. A module adds its own line here.
  void app.register(healthRoutes, { prefix: API_PREFIX });
  void app.register(metaRoutes, { prefix: API_PREFIX });
  void app.register(openapiRoutes, { prefix: API_PREFIX });

  return app;
}

/** The Fastify instance `buildApp` returns, typed for Zod route schemas. */
export type App = ReturnType<typeof buildApp>;
