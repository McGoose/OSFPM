import { LogController, type FastifyServerOptions } from 'fastify';
import { SESSION_COOKIE } from './auth/cookie.js';
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
 * Header paths that pino itself masks if a line carries them. This is the
 * second layer, under the scrubbing formatter below: it does not depend on the
 * formatter's code, so a change that breaks one layer does not open the other.
 * It names only the three credential headers, because a path cannot match "any
 * key named like a token"; the formatter does that.
 */
const REDACT_PATHS = [
  'headers.authorization',
  'headers.cookie',
  'headers["set-cookie"]',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];

/** `text` with every character that means something in a regular expression escaped. */
const escapeForRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Keys whose value is never logged, at any depth: credentials, anything named
 * like a token (a header such as `x-auth-token`, a query parameter such as
 * `api_token`), and the session cookie by its name, wherever a parsed cookie
 * object ends up in a line.
 */
const SECRET_KEY = new RegExp(
  `token|${escapeForRegExp(SESSION_COOKIE)}|^(?:authorization|proxy-authorization|cookie|set-cookie)$`,
  'i',
);

/** A query parameter named like a token, inside a URL or a message: `?token=abc`. */
const TOKEN_PARAMETER = /([?&;][^=&;\s"']*token[^=&;\s"']*=)[^&;\s"']*/gi;

/**
 * The session cookie as text, `__Host-osfpm_session=abc`, wherever it sits in a
 * string: a pasted `Cookie` header, a message. It has no `?`, `&` or `;` in front
 * when it comes first, which is why `TOKEN_PARAMETER` does not see it.
 */
const SESSION_COOKIE_PAIR = new RegExp(
  `(${escapeForRegExp(SESSION_COOKIE)}=)[^;&\\s"']*`,
  'gi',
);

/** How deep a logged object is searched. Deeper than this is cut off, which also ends a cycle. */
const MAX_DEPTH = 8;

/** Masks the value of every token-named query parameter and of the session cookie in `text`. */
function maskTokenParameters(text: string): string {
  return text
    .replace(TOKEN_PARAMETER, `$1${REDACTED}`)
    .replace(SESSION_COOKIE_PAIR, `$1${REDACTED}`);
}

/** Top-level keys that the serialisers below already reduce to safe fields. */
const SERIALISED_KEYS: ReadonlySet<string> = new Set(['req', 'res', 'err']);

/**
 * A copy of `value` that is safe to log. Keys matching `SECRET_KEY` are
 * masked, token-named query parameters in strings are masked, and an object
 * that is not a plain one (a Fastify request, a reply, a socket) becomes
 * `[ClassName]`: it is never walked, so nothing inside it can be logged.
 */
function scrub(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return maskTokenParameters(value);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (depth >= MAX_DEPTH) return '[Truncated]';
  if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1));
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return `[${value.constructor?.name ?? 'Object'}]`;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    copy[key] = SECRET_KEY.test(key) ? REDACTED : scrub(item, depth + 1);
  }
  return copy;
}

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
 *   written by hand, two independent layers mask credentials. A scrubbing
 *   formatter masks every key named like a token, and `authorization`,
 *   `cookie` and `set-cookie`, at any depth, whatever key the object sits
 *   under; it also masks a token-named query parameter inside a string, and
 *   logs a request, reply or other class instance as its class name. Under it,
 *   fixed redact paths mask the three credential headers.
 * - A message is never taken from an error. Pino does that when a line has an
 *   error and no message, and Fastify's own warnings do it with a message that
 *   quotes the whole URL; the class name is used instead.
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
    formatters: {
      log: (object) =>
        Object.fromEntries(
          Object.entries(object).map(([key, value]) => [
            key,
            SERIALISED_KEYS.has(key)
              ? value
              : SECRET_KEY.test(key)
                ? REDACTED
                : scrub(value, 1),
          ]),
        ),
    },
    hooks: {
      logMethod(args, method) {
        const [first, ...rest] = args as [unknown, ...unknown[]];
        // `log.error(error)` and `log.error({ err })` with no message: pino
        // would use the error's message, which can quote values or a URL.
        const hasMessage = typeof rest[0] === 'string';
        if (first instanceof Error) {
          method.apply(this, [{ err: first }, errorClassName(first)] as never);
        } else if (
          first !== null &&
          typeof first === 'object' &&
          'err' in first &&
          !hasMessage
        ) {
          method.apply(this, [first, errorClassName(first.err)] as never);
        } else {
          // Fastify writes some warnings as a plain string with the URL in it.
          method.apply(
            this,
            args.map((arg) =>
              typeof arg === 'string' ? maskTokenParameters(arg) : arg,
            ) as never,
          );
        }
      },
    },
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
