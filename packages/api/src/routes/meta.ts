import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { API_VERSION } from '../api-version.js';
import {
  PACKAGE_NAME,
  PACKAGE_VERSION,
  PRODUCT_NAME,
} from '../package-info.js';

/**
 * `GET /meta`: what this server is. The product name (`OSFPM`), the name and
 * version of the API package, the API version, the kind of database
 * (`postgresql` or `pglite`), and whether first-run setup is still to do
 * (`setupRequired`, so a client knows to show its setup screen), and the
 * fingerprint of the server's public identity key (`serverKeyFingerprint`, which
 * is public by design). It answers before setup is complete
 * (`availableBeforeSetup`), for that reason. Nothing secret and nothing about the
 * install: no host names, no paths, no connection details, no key but its
 * fingerprint.
 *
 * It accepts a personal API token (`tokenAccess: 'read'`): it answers the same with or
 * without one, but a token that is sent is checked, so a script can find out cheaply
 * whether its token still works. A bad one is a 401 `invalid-token`.
 */
export const metaRoutes: FastifyPluginAsyncZod = (app) => {
  app.get(
    '/meta',
    {
      config: {
        auth: 'none',
        availableBeforeSetup: true,
        tokenAccess: 'read',
      },
      schema: {
        summary: 'Server information',
        description:
          'Answers without a credential. A personal API token sent as `Authorization: Bearer <token>` is checked, and a token that does not work is a 401 `invalid-token`, so a script can test its token here.',
        response: {
          200: z.object({
            name: z.string().describe('The name of the product.'),
            package: z.string().describe('The name of the API package.'),
            version: z.string().describe('The version of the API package.'),
            apiVersion: z.literal(API_VERSION),
            database: z.enum(['postgresql', 'pglite']),
            serverKeyFingerprint: z
              .string()
              .describe(
                'The fingerprint of the public key that identifies this server (SHA-256 of the raw key, in hex, in groups of four). The key itself is at /.well-known/osfpm/server-key.',
              ),
            setupRequired: z
              .boolean()
              .describe(
                'True until first-run setup is complete: no administrator exists yet, and every route but this one, the health routes, the OpenAPI document and the setup routes answers 503 `setup-required`. A client shows its setup screen while it is true.',
              ),
          }),
        },
      },
    },
    async () => ({
      name: PRODUCT_NAME,
      package: PACKAGE_NAME,
      version: PACKAGE_VERSION,
      apiVersion: API_VERSION,
      database:
        app.db.driver === 'postgres'
          ? ('postgresql' as const)
          : ('pglite' as const),
      serverKeyFingerprint: app.serverKeys.get().identity.fingerprint,
      setupRequired: !(await app.setup.isComplete()),
    }),
  );
  return Promise.resolve();
};
