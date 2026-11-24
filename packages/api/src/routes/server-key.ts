import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getServerId } from '@osfpm/core/src/installation/server-id.js';

/**
 * `GET /.well-known/osfpm/server-key`: the public half of this server's identity
 * key, for the servers that will federate with it (spec, section Cryptography
 * and keys). The answer is the server's id (the id of its `installation` row,
 * the `origin_server` of its records), the algorithm (`Ed25519`), the raw 32-byte
 * public key in base64url, and its fingerprint: the SHA-256 of those 32 bytes in
 * hex, in groups of four characters, so people can compare keys by eye.
 *
 * Public: no session, and an `Authorization` header is ignored. It sits outside
 * the versioned API prefix because a well-known address is fixed by convention,
 * and it answers during first-run setup (`availableBeforeSetup`), so a server
 * can be recognised before it has an administrator. It is not answered while
 * start-up is running (503 `starting`), because the key is bound at start-up.
 * Only public values leave this route: never the private key, a data key or a
 * path (CLAUDE.md, Data rules).
 */
export const serverKeyRoutes: FastifyPluginAsyncZod = (app) => {
  app.get(
    '/.well-known/osfpm/server-key',
    {
      config: { auth: 'none' },
      schema: {
        summary: 'The public key of this server',
        description:
          'The public half of the Ed25519 key that identifies this server, and its fingerprint. Public: no credential is needed.',
        response: {
          200: z.object({
            serverId: z
              .string()
              .describe(
                'The id of this server, the origin_server of its records.',
              ),
            algorithm: z.literal('Ed25519'),
            publicKey: z
              .string()
              .describe('The raw 32-byte public key, in base64url.'),
            fingerprint: z
              .string()
              .describe(
                'The SHA-256 of the raw public key, in hex, in groups of four characters.',
              ),
          }),
        },
      },
    },
    async () => {
      const { identity } = app.serverKeys.get();
      return {
        serverId: await getServerId(app.db.db),
        algorithm: 'Ed25519' as const,
        publicKey: identity.publicKey,
        fingerprint: identity.fingerprint,
      };
    },
  );
  return Promise.resolve();
};
