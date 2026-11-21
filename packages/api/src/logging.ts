import { LogController, type FastifyServerOptions } from 'fastify';
import type { LogLevel } from './config.js';

/**
 * Where logging goes. The caller picks the level and the destination and
 * nothing else: what a line may hold is fixed here (see `loggerOptions`).
 */
export type LoggerSettings = {
  /** Defaults to `info`. */
  readonly level?: LogLevel;
  /** Defaults to standard output. Tests pass a stream to read the lines. */
  readonly stream?: { write(line: string): void };
};

/** What a log line says about a request whose route did not match. */
export const UNMATCHED_ROUTE = '(unmatched)';

/** What replaces a value that must not be logged. */
export const REDACTED = '[Redacted]';

/**
 * The class name of whatever was thrown, for logs. The message and the
 * properties of an error are never logged: a database driver puts the values
 * of the failed statement in its messages (CLAUDE.md, Data rules).
 */
export function errorClassName(error: unknown): string {
  if (error instanceof Error) return error.constructor.name || error.name;
  return 'NonError';
}

/**
 * Header paths the logger masks if a line ever carries them. The serialisers
 * below already keep headers out, so this is a second layer, for a line a
 * future change writes by hand.
 */
const REDACT_PATHS = [
  'headers.authorization',
  'headers.cookie',
  'headers["set-cookie"]',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];

/**
 * Fastify's logger options for a server that logs no personal data (CLAUDE.md,
 * Privacy rule). The rules, which no caller can switch off:
 *
 * - A request is described by its method and its route pattern only. The URL
 *   is left out whole, so a path parameter or a query value such as a `token`
 *   never reaches a log. An unmatched route logs `(unmatched)`.
 * - A response is described by its status code only.
 * - An error is described by its class name only.
 * - No request or response body, and no header, is ever logged. If a line is
 *   written by hand with `authorization`, `cookie` or `set-cookie` headers,
 *   their values are masked.
 *
 * Returns `false` for no settings: logging off.
 */
export function loggerOptions(
  settings: LoggerSettings | undefined,
): FastifyServerOptions['logger'] {
  if (settings === undefined) return false;
  const serializers = {
    req: (request: { method?: string; routeOptions?: { url?: string } }) => ({
      method: request.method,
      route: request.routeOptions?.url ?? UNMATCHED_ROUTE,
    }),
    res: (reply: { statusCode?: number }) => ({
      statusCode: reply.statusCode,
    }),
    err: (error: unknown) => ({ type: errorClassName(error) }),
  };
  return {
    level: settings.level ?? 'info',
    ...(settings.stream ? { stream: settings.stream } : {}),
    redact: { paths: REDACT_PATHS, censor: REDACTED },
    // Fastify types `err` as a full error with message and stack. It is
    // deliberately smaller here, so the type is widened.
    serializers: serializers as unknown as NonNullable<
      Exclude<
        FastifyServerOptions['logger'],
        boolean | undefined
      >['serializers']
    >,
  };
}

/**
 * Turns off Fastify's own per-request log lines, which carry the full URL
 * including its query, and labels the request ID `requestId`. The app writes
 * its own single line per request instead (see `buildApp`).
 */
export function createLogController(): LogController {
  return new LogController({
    disableRequestLogging: true,
    requestIdLogLabel: 'requestId',
  });
}
