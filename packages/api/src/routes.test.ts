import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createDatabase,
  type Database,
  type SchemaDb,
} from '@osfpm/core/src/db/client.js';
import {
  testTargets,
  type TestTarget,
} from '@osfpm/core/src/db/test-support.js';
import { API_PREFIX } from './api-version.js';
import { buildApp } from './app.js';
import { PACKAGE_NAME, PACKAGE_VERSION } from './package-info.js';
import { createTestApp, UUID_V7 } from './test-support.js';

/** The API package's own `package.json`, read from the file. */
const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { name: string; version: string };

/**
 * A database handle of this target's kind that was opened with the core's
 * `createDatabase` and then closed. It creates nothing on the server, so
 * nothing is left to drop.
 */
async function closedDatabase(target: TestTarget) {
  const database =
    target.name === 'pglite'
      ? createDatabase({ driver: 'pglite' })
      : createDatabase({
          driver: 'postgres',
          url: process.env.DATABASE_URL!,
        });
  await database.close();
  return database;
}

/** The parts of an OpenAPI 3.1 document that every valid one has. */
const operation = z.looseObject({
  responses: z
    .record(
      z.string().regex(/^([1-5]\d\d|default)$/),
      // A Response Object must have a description in 3.1.
      z.looseObject({ description: z.string() }),
    )
    .refine((responses) => Object.keys(responses).length > 0),
});
const openApiDocument = z.looseObject({
  openapi: z.string().regex(/^3\.1\.\d+$/),
  info: z.looseObject({ title: z.string().min(1), version: z.string().min(1) }),
  paths: z.record(
    z.string().startsWith('/'),
    z.looseObject({
      get: operation.optional(),
      post: operation.optional(),
      put: operation.optional(),
      patch: operation.optional(),
      delete: operation.optional(),
    }),
  ),
});

/** The fields the OpenAPI 3.1 specification allows at the top of a document, besides `x-` extensions. */
const TOP_LEVEL_FIELDS = new Set([
  'openapi',
  'info',
  'jsonSchemaDialect',
  'servers',
  'paths',
  'webhooks',
  'components',
  'security',
  'tags',
  'externalDocs',
]);

/**
 * Where `value` uses a keyword that exists only in OpenAPI 3.0: `nullable`, and
 * a boolean `exclusiveMinimum` or `exclusiveMaximum` (a number in 3.1).
 */
function threePointZeroKeywords(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      threePointZeroKeywords(item, `${path}/${index}`),
    );
  }
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) => {
    const here = `${path}/${key}`;
    const old =
      key === 'nullable' ||
      ((key === 'exclusiveMinimum' || key === 'exclusiveMaximum') &&
        typeof item === 'boolean');
    return [
      ...(old ? [`${here} is a 3.0 keyword`] : []),
      ...threePointZeroKeywords(item, here),
    ];
  });
}

/** Every `$ref` in `value`, which must point inside the document. */
function refsIn(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) refsIn(item, found);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === '$ref' && typeof item === 'string') found.push(item);
      else refsIn(item, found);
    }
  }
  return found;
}

function resolves(document: unknown, ref: string): boolean {
  let current: unknown = document;
  for (const part of ref.replace(/^#\//, '').split('/')) {
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
    if (
      current === null ||
      typeof current !== 'object' ||
      !Object.hasOwn(current, key)
    ) {
      return false;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return true;
}

/** What is wrong with `document` as an OpenAPI 3.1 document. Empty when nothing is. */
function openApiProblems(document: unknown): string[] {
  const problems: string[] = [];
  const parsed = openApiDocument.safeParse(document);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      problems.push(`${issue.path.join('/')}: ${issue.message}`);
    }
  }
  if (document !== null && typeof document === 'object') {
    for (const key of Object.keys(document)) {
      if (!TOP_LEVEL_FIELDS.has(key) && !key.startsWith('x-')) {
        problems.push(`${key} is not a field of an OpenAPI document`);
      }
    }
  }
  problems.push(...threePointZeroKeywords(document));
  for (const ref of refsIn(document)) {
    if (!resolves(document, ref)) problems.push(`${ref} does not resolve`);
  }
  return problems;
}

describe.each(testTargets)('the routes on $name', (target) => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeAll(async () => {
    ctx = await createTestApp(target);
  });
  afterAll(async () => {
    await ctx.close();
  });

  const get = (path: string) =>
    ctx.app.inject({ method: 'GET', url: `${API_PREFIX}${path}` });

  describe('GET /api/v1/health', () => {
    it('says the process is alive', async () => {
      const response = await get('/health');
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      expect(response.headers['x-request-id']).toMatch(UUID_V7);
      expect(response.json()).toEqual({ status: 'ok' });
    });

    it('does not need the database', async () => {
      const database = await closedDatabase(target);
      const app = buildApp({ db: database });
      try {
        const response = await app.inject({
          method: 'GET',
          url: `${API_PREFIX}/health`,
        });
        expect(response.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });
  });

  describe('GET /api/v1/health/ready', () => {
    it('is 200 when the database answers', async () => {
      const response = await get('/health/ready');
      expect(response.statusCode).toBe(200);
      expect(response.headers['x-request-id']).toMatch(UUID_V7);
      expect(response.json()).toEqual({ status: 'ready' });
    });

    it('is a 503 problem when the database is closed, and says nothing about why', async () => {
      const database = await closedDatabase(target);
      const app = buildApp({ db: database });
      try {
        const response = await app.inject({
          method: 'GET',
          url: `${API_PREFIX}/health/ready`,
        });
        expect(response.statusCode).toBe(503);
        expect(response.headers['content-type']).toMatch(
          /^application\/problem\+json/,
        );
        const body = response.json<Record<string, unknown>>();
        expect(body).toMatchObject({
          type: '/problems/service-unavailable',
          status: 503,
          code: 'service-unavailable',
          instance: `${API_PREFIX}/health/ready`,
          requestId: response.headers['x-request-id'],
        });
        for (const word of ['pglite', 'pool', 'closed', 'postgres']) {
          expect(response.body.toLowerCase()).not.toContain(word);
        }
      } finally {
        await app.close();
      }
    });
  });

  describe('GET /api/v1/meta', () => {
    it('names the product and the package, the version, the API version and the database kind, and nothing else', async () => {
      const response = await get('/meta');
      expect(response.statusCode).toBe(200);
      expect(response.headers['x-request-id']).toMatch(UUID_V7);
      expect(response.json()).toEqual({
        name: 'OSFPM',
        package: '@osfpm/api',
        version: packageJson.version,
        apiVersion: 'v1',
        database: target.name === 'pglite' ? 'pglite' : 'postgresql',
      });
    });

    it('reads the name and version from the API package.json', () => {
      // The file read here is the one the constants must come from, so a
      // constant that is hard-coded, or read from the wrong package, differs.
      expect(PACKAGE_NAME).toBe(packageJson.name);
      expect(PACKAGE_VERSION).toBe(packageJson.version);
    });

    it('shows no host name and no path', async () => {
      const text = (await get('/meta')).body;
      expect(text).not.toMatch(
        /localhost|127\.0\.0\.1|[A-Za-z]:\\|\/tmp|\/home/,
      );
    });
  });

  describe('GET /api/v1/openapi.json', () => {
    it('is an OpenAPI 3.1 document that lists the four routes', async () => {
      const response = await get('/openapi.json');
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      expect(response.headers['x-request-id']).toMatch(UUID_V7);

      const document = response.json<unknown>();
      expect(openApiProblems(document)).toEqual([]);
      const { paths, info, openapi } = document as {
        openapi: string;
        info: { version: string };
        paths: Record<string, Record<string, unknown>>;
      };
      expect(openapi.startsWith('3.1.')).toBe(true);
      expect(info.version).toBe(packageJson.version);

      expect(Object.keys(paths).sort()).toEqual([
        `${API_PREFIX}/health`,
        `${API_PREFIX}/health/ready`,
        `${API_PREFIX}/meta`,
        `${API_PREFIX}/openapi.json`,
      ]);
      for (const item of Object.values(paths)) {
        expect(Object.keys(item)).toEqual(['get']);
      }
    });

    // The check above is hand-written, because no OpenAPI validator is among
    // the dependencies. These make sure it can fail.
    describe('the check for a valid 3.1 document', () => {
      type Doc = {
        paths: Record<
          string,
          {
            get: {
              responses: Record<
                string,
                {
                  description?: string;
                  content: Record<string, { schema: Record<string, unknown> }>;
                }
              >;
            };
          }
        >;
      } & Record<string, unknown>;

      const broken = async (change: (document: Doc) => void) => {
        const document = (await get('/openapi.json')).json<Doc>();
        change(document);
        return openApiProblems(document);
      };
      const meta = (document: Doc) =>
        document.paths[`${API_PREFIX}/meta`]!.get.responses['200']!;

      it.each([
        [
          'a response with no description',
          (document: Doc) => delete meta(document).description,
        ],
        [
          'the 3.0 keyword nullable',
          (document: Doc) => {
            meta(document).content['application/json']!.schema.nullable = true;
          },
        ],
        [
          'a boolean exclusiveMinimum, which is 3.0',
          (document: Doc) => {
            meta(document).content[
              'application/json'
            ]!.schema.exclusiveMinimum = true;
          },
        ],
        [
          'an unknown top-level field',
          (document: Doc) => {
            document.surprise = 1;
          },
        ],
        [
          'version 3.0',
          (document: Doc) => {
            document.openapi = '3.0.3';
          },
        ],
        [
          'a $ref that points nowhere',
          (document: Doc) => {
            meta(document).content['application/json']!.schema = {
              $ref: '#/components/schemas/Missing',
            };
          },
        ],
        [
          'a path that does not start with a slash',
          (document: Doc) => {
            document.paths.health = document.paths[`${API_PREFIX}/health`]!;
          },
        ],
        [
          'an operation with no responses',
          (document: Doc) => {
            document.paths[`${API_PREFIX}/health`]!.get.responses = {};
          },
        ],
      ])('rejects %s', async (_label, change) => {
        expect(await broken(change)).not.toEqual([]);
      });
    });

    it('describes the readiness failure as a problem response', async () => {
      const document = (await get('/openapi.json')).json<{
        paths: Record<
          string,
          {
            get: {
              responses: Record<
                string,
                { content?: Record<string, { schema: { $ref?: string } }> }
              >;
            };
          }
        >;
      }>();
      const failure =
        document.paths[`${API_PREFIX}/health/ready`]!.get.responses['503'];
      expect(failure?.content).toHaveProperty(['application/problem+json']);
    });

    it('has no documentation page and no server list', async () => {
      const document = (await get('/openapi.json')).json<
        Record<string, unknown>
      >();
      expect(document.servers).toBeUndefined();
      const page = await ctx.app.inject({
        method: 'GET',
        url: '/documentation',
      });
      expect(page.statusCode).toBe(404);
    });
  });
});

/**
 * A database whose queries the test settles by hand, counting how many were
 * started. It stands in for a server that hangs, which a real one cannot be
 * made to do on demand.
 */
function controlledDatabase() {
  const pending: { resolve: () => void; reject: (error: Error) => void }[] = [];
  const database: Database = {
    driver: 'pglite',
    db: {
      execute: () =>
        new Promise<void>((resolve, reject) => {
          pending.push({ resolve, reject });
        }),
    } as unknown as SchemaDb,
    close: () => Promise.resolve(),
  };
  return { database, pending };
}

describe('the readiness check when the database is slow', () => {
  const ready = (app: ReturnType<typeof buildApp>) =>
    app.inject({ method: 'GET', url: `${API_PREFIX}/health/ready` });

  it('answers 503 after two seconds, and starts one query however many probes arrive', async () => {
    const { database, pending } = controlledDatabase();
    const app = buildApp({ db: database });
    await app.ready();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const probes = [ready(app), ready(app), ready(app)];
      await vi.advanceTimersByTimeAsync(2_500);
      for (const response of await Promise.all(probes)) {
        expect(response.statusCode).toBe(503);
      }
      // A load balancer probing every few seconds must not pile up queries,
      // each holding a connection, behind one that hangs.
      const later = ready(app);
      await vi.advanceTimersByTimeAsync(2_500);
      expect((await later).statusCode).toBe(503);
      expect(pending).toHaveLength(1);

      // When the stuck query finally fails, nothing is left unhandled and the
      // next probe starts a new one.
      pending[0]!.reject(new Error('connection terminated'));
      await vi.advanceTimersByTimeAsync(0);
      const afterwards = ready(app);
      await vi.advanceTimersByTimeAsync(0);
      expect(pending).toHaveLength(2);
      pending[1]!.resolve();
      expect((await afterwards).statusCode).toBe(200);
    } finally {
      vi.useRealTimers();
      await app.close();
    }
  });

  it('answers 200 when the database answers within the limit', async () => {
    const { database, pending } = controlledDatabase();
    const app = buildApp({ db: database });
    await app.ready();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const probe = ready(app);
      await vi.advanceTimersByTimeAsync(1_000);
      pending[0]!.resolve();
      expect((await probe).statusCode).toBe(200);
    } finally {
      vi.useRealTimers();
      await app.close();
    }
  });
});
