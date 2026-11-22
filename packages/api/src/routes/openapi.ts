import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

/**
 * `GET /openapi.json`: the OpenAPI 3.1 document, generated from the Zod
 * schemas of every route by `@fastify/swagger` (registered in `buildApp`).
 * There is no documentation page. The document is the same for every caller.
 */
export const openapiRoutes: FastifyPluginAsyncZod = (app) => {
  app.get(
    '/openapi.json',
    {
      config: { auth: 'none', availableBeforeSetup: true },
      schema: {
        summary: 'OpenAPI document',
        response: { 200: z.looseObject({ openapi: z.string() }) },
      },
    },
    () => {
      const document = app.swagger();
      // `buildApp` sets `openapi: '3.1.0'`, so this only narrows the type.
      if (!('openapi' in document)) {
        throw new Error('The API document is not an OpenAPI 3 document');
      }
      return { ...document };
    },
  );
  return Promise.resolve();
};
