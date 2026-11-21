import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { API_VERSION } from '../api-version.js';
import { PACKAGE_NAME, PACKAGE_VERSION } from '../package-info.js';

/**
 * `GET /meta`: what this server is. The package name and version, the API
 * version, and the kind of database (`postgresql` or `pglite`). Nothing
 * secret and nothing about the install: no host names, no paths, no
 * connection details.
 */
export const metaRoutes: FastifyPluginAsyncZod = (app) => {
  app.get(
    '/meta',
    {
      schema: {
        summary: 'Server information',
        response: {
          200: z.object({
            name: z.string().describe('The name of the API package.'),
            version: z.string().describe('The version of the API package.'),
            apiVersion: z.literal(API_VERSION),
            database: z.enum(['postgresql', 'pglite']),
          }),
        },
      },
    },
    () => ({
      name: PACKAGE_NAME,
      version: PACKAGE_VERSION,
      apiVersion: API_VERSION,
      database:
        app.db.driver === 'postgres'
          ? ('postgresql' as const)
          : ('pglite' as const),
    }),
  );
  return Promise.resolve();
};
