import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AccessDeniedError } from '@osfpm/core/src/access/access-denied-error.js';
import { PermissionSyncError } from '@osfpm/core/src/access/permission-sync.js';
import {
  AccountHasChildrenError,
  AccountInUseError,
  AccountInputError,
} from '@osfpm/core/src/accounts/service.js';
import { ContractInputError } from '@osfpm/core/src/contracts/service.js';
import { CostLineInputError } from '@osfpm/core/src/costs/service.js';
import {
  MissingActingUserError,
  RecordNotFoundError,
  RecordStateError,
  RecordWriteError,
  VersionConflictError,
} from '@osfpm/core/src/db/write.js';
import { testTargets } from '@osfpm/core/src/db/test-support.js';
import { LegalHoldInputError } from '@osfpm/core/src/legal-hold/service.js';
import {
  ComplianceReportDeniedError,
  SensitiveAccessDeniedError,
  SensitivePayloadInvalidError,
} from '@osfpm/core/src/sensitive/service.js';
import { API_PREFIX } from './api-version.js';
import {
  INTERNAL_ERRORS,
  PROBLEM_TABLE,
  ServiceUnavailableError,
} from './errors.js';
import { createTestApp, UUID_V7 } from './test-support.js';

const ID = '01900000-0000-7000-8000-000000000001';
const SCOPE = { organisationId: ID, projectId: ID };

/** A value the tests look for in output. It must never appear in a response or a log. */
const SECRET = 'secret-marker-4f9c';

/** One error of each class in the table, built the way the core builds it. */
const fixtures = new Map<abstract new (...args: never[]) => Error, () => Error>(
  [
    [AccessDeniedError, () => new AccessDeniedError('costs:read', SCOPE)],
    [
      SensitiveAccessDeniedError,
      () => new SensitiveAccessDeniedError('medical', 'read'),
    ],
    [ComplianceReportDeniedError, () => new ComplianceReportDeniedError()],
    [RecordNotFoundError, () => new RecordNotFoundError('project', ID)],
    [VersionConflictError, () => new VersionConflictError('project', ID, 1, 2)],
    [RecordStateError, () => new RecordStateError('project', ID, 'delete')],
    [
      ContractInputError,
      () => new ContractInputError('A party needs a person or a company'),
    ],
    [
      AccountInputError,
      () => new AccountInputError('The parent is not a live account'),
    ],
    [
      CostLineInputError,
      () => new CostLineInputError('The amount is not a decimal'),
    ],
    [
      LegalHoldInputError,
      () => new LegalHoldInputError('A hold needs a reason'),
    ],
    [
      ServiceUnavailableError,
      () => new ServiceUnavailableError(`the database at db.internal is down`),
    ],
    [
      SensitivePayloadInvalidError,
      () =>
        new SensitivePayloadInvalidError('medical', [
          { path: 'allergies.0', code: 'invalid_type' },
        ]),
    ],
  ],
);

/** An error of each class that is deliberately a 500, with a message that holds a secret. */
const internalFixtures = new Map<
  abstract new (...args: never[]) => Error,
  () => Error
>([
  [
    RecordWriteError,
    () =>
      new RecordWriteError('person', 'insert', '23505', `person_${SECRET}_key`),
  ],
  [MissingActingUserError, () => new MissingActingUserError('token')],
  [PermissionSyncError, () => new PermissionSyncError([])],
]);

/** Everything a test route can throw, by name: the fixtures, the subclasses, and a few odd ones. */
const thrown = new Map<string, () => unknown>([
  ...[...fixtures, ...internalFixtures].map(
    ([errorClass, make]) => [errorClass.name, make] as const,
  ),
  ['AccountHasChildrenError', () => new AccountHasChildrenError(ID)],
  ['AccountInUseError', () => new AccountInUseError('account', ID)],
  [
    'AccountInUseError-stop-posting',
    () => new AccountInUseError('account', ID, 'stop-posting'),
  ],
  [
    'PlainError',
    () =>
      new Error(
        `insert into person (name) values ('${SECRET}') failed at db.internal`,
      ),
  ],
  ['NotAnError', () => `a thrown string with ${SECRET}`],
]);

/** Routes that exist only in these tests: one throws what it is told to, one validates input. */
const testRoutes: FastifyPluginAsync = (app) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get(
    '/test/throw/:name',
    { schema: { params: z.object({ name: z.string() }) } },
    (request) => {
      const make = thrown.get(request.params.name);
      if (make === undefined) throw new Error('no such test error');
      throw make();
    },
  );
  typed.post(
    '/test/validate',
    {
      schema: {
        querystring: z.object({ page: z.coerce.number().int() }),
        body: z.object({
          title: z.string().min(80),
          nested: z.object({ count: z.number() }),
          list: z.array(z.object({ id: z.uuid() })),
        }),
      },
    },
    () => ({ ok: true }),
  );
  return Promise.resolve();
};

describe.each(testTargets)('problem responses on $name', (target) => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeAll(async () => {
    ctx = await createTestApp(target);
    await ctx.app.register(testRoutes, { prefix: API_PREFIX });
  });
  afterAll(async () => {
    await ctx.close();
  });

  const throwing = (name: string, query = '') =>
    ctx.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/test/throw/${name}${query}`,
    });

  /** Checks the shape every problem response shares. */
  function expectProblem(
    response: Awaited<ReturnType<typeof throwing>>,
    expected: { status: number; code: string; instance: string },
  ) {
    expect(response.statusCode).toBe(expected.status);
    expect(response.headers['content-type']).toMatch(
      /^application\/problem\+json/,
    );
    expect(response.headers['x-request-id']).toMatch(UUID_V7);
    const body = response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      type: `/problems/${expected.code}`,
      status: expected.status,
      instance: expected.instance,
      requestId: response.headers['x-request-id'],
      code: expected.code,
    });
    expect(typeof body.title).toBe('string');
    expect(typeof body.detail).toBe('string');
    return body;
  }

  describe('the error table', () => {
    it('has a fixture for every row', () => {
      for (const row of PROBLEM_TABLE) {
        expect(
          fixtures.has(row.errorClass),
          `${row.errorClass.name} has no fixture in this test`,
        ).toBe(true);
      }
    });

    it.each(PROBLEM_TABLE.map((row) => [row.errorClass.name, row] as const))(
      '%s becomes its row',
      async (name, row) => {
        const error = fixtures.get(row.errorClass)!();
        const response = await throwing(name);
        const body = expectProblem(response, {
          status: row.status,
          code: row.code,
          instance: `${API_PREFIX}/test/throw/${name}`,
        });
        expect(body.title).toBe(row.title);
        // A row either states its detail or passes on the error's own message,
        // which its class documents as free of ids and values.
        expect(body.detail).toBe(row.detail ?? error.message);
      },
    );

    it('keeps the message, the ids and the permission names of a fixed-text row out of the response', async () => {
      for (const row of PROBLEM_TABLE.filter((r) => r.detail !== null)) {
        const response = await throwing(row.errorClass.name);
        const error = fixtures.get(row.errorClass)!();
        expect(response.body).not.toContain(error.message);
        expect(response.body).not.toContain(ID);
        expect(response.body).not.toContain('costs:read');
      }
    });

    it('maps the subclasses of a row to that row', async () => {
      for (const name of [
        'AccountHasChildrenError',
        'AccountInUseError',
        'AccountInUseError-stop-posting',
      ]) {
        const response = await throwing(name);
        const body = expectProblem(response, {
          status: 409,
          code: 'record-state',
          instance: `${API_PREFIX}/test/throw/${name}`,
        });
        // The subclasses word their own message; the response does not repeat it.
        expect(body.detail).not.toContain(ID);
      }
    });

    it('lists the error classes that are deliberately a 500', () => {
      expect(INTERNAL_ERRORS.map((entry) => entry.errorClass)).toEqual(
        expect.arrayContaining([...internalFixtures.keys()]),
      );
      for (const entry of INTERNAL_ERRORS) {
        expect(
          internalFixtures.has(entry.errorClass),
          `${entry.errorClass.name} has no fixture in this test`,
        ).toBe(true);
        expect(entry.reason.length).toBeGreaterThan(0);
      }
    });

    it('covers every error class the core exports: mapped, a subclass of a mapped one, or listed as a 500', () => {
      const coreSrc = fileURLToPath(
        new URL('../../core/src/', import.meta.url),
      );
      const parents = new Map<string, string>();
      for (const entry of readdirSync(coreSrc, {
        recursive: true,
        withFileTypes: true,
      })) {
        if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
        if (entry.name.endsWith('.test.ts')) continue;
        const text = readFileSync(join(entry.parentPath, entry.name), 'utf8');
        for (const match of text.matchAll(
          /^export class (\w+) extends (\w+)/gm,
        )) {
          parents.set(match[1]!, match[2]!);
        }
      }
      // Guards against scanning the wrong folder and passing for nothing.
      expect(parents.get('AccessDeniedError')).toBe('Error');
      expect(parents.size).toBeGreaterThan(10);

      const decided = new Set([
        ...PROBLEM_TABLE.map((row) => row.errorClass.name),
        ...INTERNAL_ERRORS.map((entry) => entry.errorClass.name),
      ]);
      const covered = (name: string): boolean => {
        const parent = parents.get(name);
        return decided.has(name) || (parent !== undefined && covered(parent));
      };
      const undecided = [...parents.keys()].filter((name) => !covered(name));
      expect(
        undecided,
        'Add each of these to PROBLEM_TABLE, or to INTERNAL_ERRORS with a reason',
      ).toEqual([]);
    });
  });

  describe('anything else', () => {
    it.each([
      ...[...internalFixtures.keys()].map((errorClass) => errorClass.name),
      'PlainError',
      'NotAnError',
    ])('%s is a generic 500 with the request ID only', async (name) => {
      ctx.lines.length = 0;
      const response = await throwing(name);
      const body = expectProblem(response, {
        status: 500,
        code: 'internal-error',
        instance: `${API_PREFIX}/test/throw/${name}`,
      });
      expect(Object.keys(body).sort()).toEqual(
        [
          'code',
          'detail',
          'instance',
          'requestId',
          'status',
          'title',
          'type',
        ].sort(),
      );
      // No message, no stack, no SQL, no constraint name, no class name. The
      // `instance` is left out of this check: it repeats the path the caller
      // sent, and these test paths are named after the class.
      const text = JSON.stringify(
        Object.fromEntries(
          Object.entries(body).filter(([key]) => key !== 'instance'),
        ),
      );
      for (const forbidden of [
        SECRET,
        'insert',
        'SQLSTATE',
        '23505',
        'person_',
        'db.internal',
        'Error:',
        ' at ',
        name,
      ]) {
        expect(text, forbidden).not.toContain(forbidden);
      }
      // The log has the class name and the request ID, and no message.
      const failure = ctx
        .records()
        .find((record) => record.msg === 'request failed');
      expect(failure).toMatchObject({
        level: 50,
        requestId: response.headers['x-request-id'],
      });
      expect(ctx.lines.join('')).not.toContain(SECRET);
      expect(ctx.lines.join('')).not.toContain('SQLSTATE');
      if (name !== 'NotAnError') {
        // `PlainError` is a bare `Error`, so its class name is `Error`.
        expect(failure).toMatchObject({
          err: { type: name === 'PlainError' ? 'Error' : name },
        });
      }
    });
  });

  describe('validation', () => {
    const post = (query: string, payload: unknown) =>
      ctx.app.inject({
        method: 'POST',
        url: `${API_PREFIX}/test/validate${query}`,
        payload: payload as object,
      });

    const valid = {
      title: 'a title that is long enough to pass the minimum length: '.repeat(
        2,
      ),
      nested: { count: 1 },
      list: [],
    };

    it('is a 400 that lists the failing field paths and none of the submitted values', async () => {
      // Fastify validates each part of a request in turn and stops at the
      // first part that fails, so each part is checked on its own.
      const badQuery = await post(`?page=not-a-number-${SECRET}`, valid);
      const queryProblem = expectProblem(badQuery, {
        status: 400,
        code: 'validation-failed',
        instance: `${API_PREFIX}/test/validate`,
      });
      expect(queryProblem.errors).toEqual([
        { in: 'querystring', path: 'page', code: 'invalid_type' },
      ]);

      const badBody = await post('?page=1', {
        title: `short ${SECRET}`,
        nested: { count: `not a number ${SECRET}` },
        list: [{ id: `not a uuid ${SECRET}` }],
      });
      const bodyProblem = expectProblem(badBody, {
        status: 400,
        code: 'validation-failed',
        instance: `${API_PREFIX}/test/validate`,
      });
      const errors = bodyProblem.errors as {
        in: string;
        path: string;
        code: string;
      }[];
      expect(errors).toEqual(
        expect.arrayContaining([
          { in: 'body', path: 'title', code: 'too_small' },
          { in: 'body', path: 'nested.count', code: 'invalid_type' },
          { in: 'body', path: 'list.0.id', code: 'invalid_format' },
        ]),
      );
      for (const text of [badQuery.body, badBody.body]) {
        expect(text).not.toContain(SECRET);
        expect(text).not.toContain('short');
        expect(text).not.toContain('not a number');
        expect(text).not.toContain('not-a-number');
      }
    });

    it('does not log the submitted values either', async () => {
      ctx.lines.length = 0;
      await post('?page=1', { title: `short ${SECRET}` });
      expect(ctx.lines.join('')).not.toContain(SECRET);
    });
  });

  describe("Fastify's own client errors", () => {
    it('turns a malformed JSON body into a 400 problem that does not repeat it', async () => {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `${API_PREFIX}/test/validate?page=1`,
        headers: { 'content-type': 'application/json' },
        payload: `{"title": "${SECRET}`,
      });
      expectProblem(response, {
        status: 400,
        code: 'bad-request',
        instance: `${API_PREFIX}/test/validate`,
      });
      expect(response.body).not.toContain(SECRET);
    });

    it('turns an unsupported content type into a 415 problem', async () => {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `${API_PREFIX}/test/validate?page=1`,
        headers: { 'content-type': 'application/x-secret' },
        payload: SECRET,
      });
      expectProblem(response, {
        status: 415,
        code: 'unsupported-media-type',
        instance: `${API_PREFIX}/test/validate`,
      });
      expect(response.body).not.toContain(SECRET);
    });

    it('turns a body over the limit into a 413 problem', async () => {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `${API_PREFIX}/test/validate?page=1`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ title: 'x'.repeat(2 * 1024 * 1024) }),
      });
      expectProblem(response, {
        status: 413,
        code: 'payload-too-large',
        instance: `${API_PREFIX}/test/validate`,
      });
    });

    it('turns a malformed URL into a 400 problem', async () => {
      const response = await ctx.app.inject({
        method: 'GET',
        url: '/%zz',
      });
      expect(response.statusCode).toBe(400);
      expect(response.headers['content-type']).toMatch(
        /^application\/problem\+json/,
      );
      expect(response.headers['x-request-id']).toMatch(UUID_V7);
      expect(response.json<{ code: string }>().code).toBe('bad-request');
    });
  });

  describe('an unknown route', () => {
    it('is a 404 problem, and its instance has no query string', async () => {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `${API_PREFIX}/nowhere?token=${SECRET}`,
      });
      const body = expectProblem(response, {
        status: 404,
        code: 'route-not-found',
        instance: `${API_PREFIX}/nowhere`,
      });
      expect(JSON.stringify(body)).not.toContain(SECRET);
    });
  });
});
