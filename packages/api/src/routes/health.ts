import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { problemSchema, ServiceUnavailableError } from '../errors.js';
import { errorClassName } from '../logging.js';

/**
 * How long the readiness check waits for the database. A database that hangs
 * must make the check fail, not hang with it.
 */
const READINESS_TIMEOUT_MS = 2_000;

/** Rejects after `ms`, and clears its timer when `work` settles first. */
async function within<T>(work: PromiseLike<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve(work),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `GET /health` and `GET /health/ready`. No authentication, and nothing in
 * either answer but a status word.
 *
 * `/health` says the process is alive and does not touch the database.
 * `/health/ready` runs a trivial query. It is a 200 when the database answers,
 * and a 503 problem response when it does not or takes longer than two
 * seconds. The cause is logged by class name only: the response never says
 * why.
 */
export const healthRoutes: FastifyPluginAsyncZod = (app) => {
  app.get(
    '/health',
    {
      schema: {
        summary: 'Liveness',
        description: 'The process is alive. It does not check the database.',
        response: { 200: z.object({ status: z.literal('ok') }) },
      },
    },
    () => ({ status: 'ok' as const }),
  );

  app.get(
    '/health/ready',
    {
      schema: {
        summary: 'Readiness',
        description:
          'The database answers a trivial query. A 503 problem response if it does not.',
        response: {
          200: z.object({ status: z.literal('ready') }),
          503: {
            description: 'The database does not answer.',
            content: { 'application/problem+json': { schema: problemSchema } },
          },
        },
      },
    },
    async (request) => {
      try {
        await within(app.db.db.execute('select 1'), READINESS_TIMEOUT_MS);
      } catch (error) {
        request.log.warn(
          { cause: errorClassName(error) },
          'the database check failed',
        );
        throw new ServiceUnavailableError('The database did not answer');
      }
      return { status: 'ready' as const };
    },
  );
  return Promise.resolve();
};
