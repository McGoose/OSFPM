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
 * `/health/ready` is a 200 once start-up has finished (the migrations and the
 * permission sync, see `runStartup`) and a trivial query is answered. It is a
 * 503 problem response before that, and when the database does not answer or
 * takes longer than two seconds. The cause is logged by class name only: the
 * response never says why. Only one check query is ever in flight.
 */
export const healthRoutes: FastifyPluginAsyncZod = (app) => {
  // The query in flight, if any. The timeout below only stops a probe waiting:
  // it cannot cancel the query, which keeps its connection until the database
  // answers. So a new probe joins the query already running instead of
  // starting another. Probes arriving every few seconds at a hung database
  // would otherwise take one connection each, until real requests find none.
  let probe: Promise<unknown> | undefined;
  const checkDatabase = () => {
    probe ??= Promise.resolve(app.db.db.execute('select 1')).finally(() => {
      probe = undefined;
    });
    return probe;
  };

  app.get(
    '/health',
    {
      config: { auth: 'none', availableWhileStarting: true },
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
      config: { auth: 'none', availableWhileStarting: true },
      schema: {
        summary: 'Readiness',
        description:
          'Start-up has finished and the database answers a trivial query. A 503 problem response if either is not so.',
        response: {
          200: z.object({ status: z.literal('ready') }),
          503: {
            description:
              'The server is still starting, or the database does not answer.',
            content: { 'application/problem+json': { schema: problemSchema } },
          },
        },
      },
    },
    async (request) => {
      // Checked first, so a probe during a migration does not queue a query.
      if (!app.readiness.isReady()) {
        throw new ServiceUnavailableError('Start-up has not finished');
      }
      try {
        await within(checkDatabase(), READINESS_TIMEOUT_MS);
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
