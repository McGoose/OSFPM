import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AccessDeniedError } from '@osfpm/core/src/access/access-denied-error.js';
import { PermissionSyncError } from '@osfpm/core/src/access/permission-sync.js';
import { AccountInputError } from '@osfpm/core/src/accounts/service.js';
import { AuthInputError, AuthStateError } from '@osfpm/core/src/auth/errors.js';
import { ContractInputError } from '@osfpm/core/src/contracts/service.js';
import { CostLineInputError } from '@osfpm/core/src/costs/service.js';
import {
  MissingActingUserError,
  RecordNotFoundError,
  RecordStateError,
  RecordWriteError,
  VersionConflictError,
} from '@osfpm/core/src/db/write.js';
import { LegalHoldInputError } from '@osfpm/core/src/legal-hold/service.js';
import {
  ComplianceReportDeniedError,
  SensitiveAccessDeniedError,
  SensitivePayloadInvalidError,
} from '@osfpm/core/src/sensitive/service.js';
import type { App } from './app.js';

/** An error class, abstract or not, as `instanceof` takes it. */
type ErrorClass = abstract new (...args: never[]) => Error;

/**
 * The service cannot answer right now, for example because the database does
 * not. Maps to a 503. Routes throw it with a message for the log; the response
 * carries fixed text.
 */
export class ServiceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceUnavailableError';
  }
}

/**
 * The route needs a signed-in user and the request has none. Maps to a 401.
 * The message is the same whatever the reason (no cookie, an unknown token, an
 * expired or revoked session, a disabled user), so a caller learns nothing
 * about which it was.
 */
export class AuthenticationRequiredError extends Error {
  constructor() {
    super('The request has no valid session');
    this.name = 'AuthenticationRequiredError';
  }
}

/**
 * A request that changes data, with a session cookie, did not come from this
 * server's own origin (cross-site request forgery defence). Maps to a 403. The
 * message names neither the expected origin nor the one that was sent.
 */
export class OriginMismatchError extends Error {
  constructor() {
    super('The Origin header is not the public origin');
    this.name = 'OriginMismatchError';
  }
}

/** One row of `PROBLEM_TABLE`. */
export type ProblemRule = {
  /** Matched with `instanceof`, so a subclass takes its parent's row. */
  readonly errorClass: ErrorClass;
  readonly status: number;
  /** Stable machine-readable code. It is the last part of the problem `type` URI. */
  readonly code: string;
  readonly title: string;
  /**
   * The `detail` of the response. `null` passes on the error's own message,
   * and only a class whose documentation says its message carries no ids and
   * no values may use it. Every other row states its text here, so what a
   * client reads never depends on what a service put in a message.
   */
  readonly detail: string | null;
};

/**
 * Every core error the API tells the caller about, and what it becomes
 * (RFC 9457 problem details). One row per class: the first row an error is an
 * `instanceof` wins. A new module adds one line.
 *
 * A row that does not pass on the error's message states its own `detail`,
 * which never names an id, a permission or a value: a caller who may not see a
 * record learns nothing from the refusal (see `AccessDeniedError`).
 */
export const PROBLEM_TABLE: readonly ProblemRule[] = [
  {
    errorClass: AuthenticationRequiredError,
    status: 401,
    code: 'authentication-required',
    title: 'Authentication required',
    detail: 'Sign in to use this.',
  },
  {
    errorClass: OriginMismatchError,
    status: 403,
    code: 'origin-mismatch',
    title: 'Origin mismatch',
    detail:
      'This request did not come from the address this server is used at.',
  },
  {
    errorClass: AccessDeniedError,
    status: 403,
    code: 'access-denied',
    title: 'Access denied',
    detail: 'You do not have access to this.',
  },
  {
    errorClass: SensitiveAccessDeniedError,
    status: 403,
    code: 'access-denied',
    title: 'Access denied',
    detail: 'You do not have access to this.',
  },
  {
    errorClass: ComplianceReportDeniedError,
    status: 403,
    code: 'access-denied',
    title: 'Access denied',
    detail: 'You do not have access to this.',
  },
  {
    errorClass: RecordNotFoundError,
    status: 404,
    code: 'not-found',
    title: 'Not found',
    detail: 'The record was not found.',
  },
  {
    errorClass: VersionConflictError,
    status: 409,
    code: 'version-conflict',
    title: 'Version conflict',
    detail: 'The record has changed since you read it. Read it again.',
  },
  {
    // Also takes AccountHasChildrenError and AccountInUseError.
    errorClass: RecordStateError,
    status: 409,
    code: 'record-state',
    title: 'Record in the wrong state',
    detail: 'The record is in the wrong state for this operation.',
  },
  // The three input errors below document that they carry no ids and no
  // values, so their own message is safe to show. A test checks that every row
  // with `detail: null` is such a class.
  {
    errorClass: ContractInputError,
    status: 422,
    code: 'invalid-input',
    title: 'Invalid input',
    detail: null,
  },
  {
    errorClass: AccountInputError,
    status: 422,
    code: 'invalid-input',
    title: 'Invalid input',
    detail: null,
  },
  {
    errorClass: CostLineInputError,
    status: 422,
    code: 'invalid-input',
    title: 'Invalid input',
    detail: null,
  },
  {
    // Its JSDoc does not say its message is free of ids and values, so the
    // response has fixed text. The class says: a reason is missing, or a scope
    // is half set.
    errorClass: LegalHoldInputError,
    status: 422,
    code: 'invalid-input',
    title: 'Invalid input',
    detail: 'The legal hold needs a reason, and its scope must be complete.',
  },
  {
    // Its message lists where the payload is wrong and never what is in it.
    errorClass: SensitivePayloadInvalidError,
    status: 422,
    code: 'invalid-input',
    title: 'Invalid input',
    detail: null,
  },
  {
    errorClass: ServiceUnavailableError,
    status: 503,
    code: 'service-unavailable',
    title: 'Service unavailable',
    detail: 'The service is not ready. Try again shortly.',
  },
];

/**
 * Core errors that are deliberately left to become a generic 500, each with
 * the reason. A test requires every error class the core exports to be in
 * `PROBLEM_TABLE` (or a subclass of a row there) or in this list, so a new
 * class cannot be forgotten.
 */
export const INTERNAL_ERRORS: readonly {
  readonly errorClass: ErrorClass;
  readonly reason: string;
}[] = [
  {
    errorClass: RecordWriteError,
    reason:
      'Carries a SQLSTATE and a constraint name, which a caller must not see. A service checks what a caller can get wrong before it writes.',
  },
  {
    errorClass: MissingActingUserError,
    reason:
      'The types forbid it, so it is a bug in the server, not the request.',
  },
  {
    errorClass: PermissionSyncError,
    reason: 'Raised when the server starts, never while it serves a request.',
  },
  {
    errorClass: AuthInputError,
    reason:
      'Thrown by the auth services for a value the server chose (a session method or a revoke reason), not one a client sent. No route calls them yet; the login routes map it, or validate first, when they land.',
  },
  {
    errorClass: AuthStateError,
    reason:
      'Thrown by the auth services for a state the caller has to handle, such as a disabled user. No route calls them yet; the login routes decide what each reason means to a client, and must not tell them apart where that would say whether an account exists.',
  },
];

/** The shape of every error response (RFC 9457), as `application/problem+json`. */
export const problemSchema = z.object({
  type: z.string().describe('A URI reference that names the kind of problem.'),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().describe('Safe text. It never holds a submitted value.'),
  instance: z.string().describe('The path of the request, without its query.'),
  requestId: z.string().describe('The value of the X-Request-Id header.'),
  code: z.string().describe('Stable machine-readable code.'),
  errors: z
    .array(
      z.object({
        in: z
          .string()
          .describe(
            'Which part of the request: body, querystring, params or headers.',
          ),
        path: z.string().describe('The field, with dots between levels.'),
        code: z.string().describe('The kind of failure, such as too_small.'),
      }),
    )
    .optional()
    .describe(
      'The failing fields of a validation error. Paths only, never values.',
    ),
});

/** A problem response body. */
export type Problem = z.infer<typeof problemSchema>;

/** The media type of every error response. */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json; charset=utf-8';

type ProblemParts = {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail: string;
  readonly errors?: Problem['errors'];
};

/** What Fastify's own client errors become, by status. Anything else is `request-error`. */
const CLIENT_ERRORS: ReadonlyMap<
  number,
  Omit<ProblemParts, 'status'>
> = new Map([
  [
    400,
    {
      code: 'bad-request',
      title: 'Bad request',
      detail: 'The request could not be understood.',
    },
  ],
  [
    413,
    {
      code: 'payload-too-large',
      title: 'Payload too large',
      detail: 'The request body is larger than the server accepts.',
    },
  ],
  [
    415,
    {
      code: 'unsupported-media-type',
      title: 'Unsupported media type',
      detail: 'The content type of the request is not supported.',
    },
  ],
]);

const INTERNAL: ProblemParts = {
  status: 500,
  code: 'internal-error',
  title: 'Internal server error',
  detail:
    'An unexpected error occurred. Quote the request ID when you report it.',
};

/** The path of the request without its query string, which may hold a token. */
function pathOf(request: FastifyRequest): string {
  return request.url.split('?', 1)[0] ?? '';
}

/** Sends `parts` as the problem response for `request`. */
function sendProblem(
  request: FastifyRequest,
  reply: FastifyReply,
  parts: ProblemParts,
): FastifyReply {
  const problem: Problem = {
    type: `/problems/${parts.code}`,
    title: parts.title,
    status: parts.status,
    detail: parts.detail,
    instance: pathOf(request),
    requestId: request.id,
    code: parts.code,
    ...(parts.errors ? { errors: parts.errors } : {}),
  };
  return reply
    .code(parts.status)
    .header('x-request-id', request.id)
    .type(PROBLEM_CONTENT_TYPE)
    .send(problem);
}

/** The problem for something thrown while handling a request. Never throws. */
function problemFor(error: unknown): ProblemParts {
  if (hasZodFastifySchemaValidationErrors(error)) {
    // Which part of the request failed: body, querystring, params or headers.
    const context = (error as { validationContext?: unknown })
      .validationContext;
    const part = typeof context === 'string' ? context : 'request';
    return {
      status: 400,
      code: 'validation-failed',
      title: 'Validation failed',
      detail:
        'The request did not match what the endpoint accepts. The fields that failed are listed in errors.',
      // The field paths and the kind of failure only. Zod's message can quote
      // what was submitted, so it is not passed on.
      errors: error.validation.map((issue) => ({
        in: part,
        path: issue.instancePath.replace(/^\//, '').split('/').join('.'),
        code: issue.keyword,
      })),
    };
  }
  for (const rule of PROBLEM_TABLE) {
    if (error instanceof rule.errorClass) {
      return {
        status: rule.status,
        code: rule.code,
        title: rule.title,
        detail: rule.detail ?? error.message,
      };
    }
  }
  // Fastify's own refusals of a malformed request: bad JSON, a body over the
  // limit, a media type it cannot read. Their messages can quote the body
  // (Node's JSON error does), so only the status is used.
  const { statusCode, code } = (error ?? {}) as {
    statusCode?: unknown;
    code?: unknown;
  };
  if (
    typeof statusCode === 'number' &&
    statusCode >= 400 &&
    statusCode < 500 &&
    typeof code === 'string' &&
    code.startsWith('FST_ERR_')
  ) {
    const known = CLIENT_ERRORS.get(statusCode);
    return {
      status: statusCode,
      ...(known ?? {
        code: 'request-error',
        title: 'Request error',
        detail: 'The request could not be processed.',
      }),
    };
  }
  return INTERNAL;
}

/**
 * Answers `error` with its problem response and logs it: a warning with the
 * class name for a client error, an error for a 500. Only the class name and
 * the request ID are logged, never the message or the stack, which can quote
 * SQL parameters (CLAUDE.md, Data rules).
 */
export function handleError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  const parts = problemFor(error);
  if (parts.status >= 500) {
    request.log.error({ err: error }, 'request failed');
  } else {
    request.log.warn({ err: error }, 'request refused');
  }
  return sendProblem(request, reply, parts);
}

/**
 * Fastify's `frameworkErrors` hook: errors raised before a route is found,
 * such as a malformed URL, go through the same mapping.
 */
export function handleFrameworkError(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  void handleError(error, request, reply);
}

/**
 * Makes `app` answer every error, and every unknown route, with a problem
 * response (RFC 9457, `application/problem+json`): `type`, `title`, `status`,
 * `detail`, `instance`, `requestId` and `code`.
 *
 * Mapping is by class through `PROBLEM_TABLE`. A validation failure is a 400
 * that lists field paths and no values. Anything not in the table, including
 * `RecordWriteError`, is a 500 with fixed text and the request ID, so no
 * message, stack or SQL reaches the caller. Routes never return core errors
 * themselves: they throw them and this handler maps them.
 */
export function registerErrorHandling(app: App): void {
  app.setErrorHandler((error, request, reply) =>
    handleError(error, request, reply),
  );
  app.setNotFoundHandler((request, reply) =>
    sendProblem(request, reply, {
      status: 404,
      code: 'route-not-found',
      title: 'Route not found',
      detail: 'There is no endpoint at this path and method.',
    }),
  );
}
