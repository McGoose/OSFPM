import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDatabase } from '@osfpm/core/src/db/client.js';
import {
  testTargets,
  type TestTarget,
} from '@osfpm/core/src/db/test-support.js';
import { API_PREFIX } from './api-version.js';
import { buildApp } from './app.js';
import { PACKAGE_NAME, PACKAGE_VERSION } from './package-info.js';
import { createTestApp, UUID_V7 } from './test-support.js';

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
    it('names the package, its version, the API version and the database kind, and nothing else', async () => {
      const response = await get('/meta');
      expect(response.statusCode).toBe(200);
      expect(response.headers['x-request-id']).toMatch(UUID_V7);
      expect(response.json()).toEqual({
        name: PACKAGE_NAME,
        version: PACKAGE_VERSION,
        apiVersion: 'v1',
        database: target.name === 'pglite' ? 'pglite' : 'postgresql',
      });
    });

    it('reads the version from the API package', () => {
      expect(PACKAGE_NAME).toBe('@osfpm/api');
      expect(PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    });

    it('shows no host name and no path', async () => {
      const text = (await get('/meta')).body;
      expect(text).not.toMatch(
        /localhost|127\.0\.0\.1|[A-Za-z]:\\|\/tmp|\/home/,
      );
    });
  });

  describe('GET /api/v1/openapi.json', () => {
    /** The parts of an OpenAPI 3.1 document that every valid one has. */
    const operation = z.looseObject({
      responses: z
        .record(z.string().regex(/^([1-5]\d\d|default)$/), z.looseObject({}))
        .refine((responses) => Object.keys(responses).length > 0),
    });
    const openApiDocument = z.looseObject({
      openapi: z.string().regex(/^3\.1\.\d+$/),
      info: z.looseObject({
        title: z.string().min(1),
        version: z.string().min(1),
      }),
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

    it('is an OpenAPI 3.1 document that lists the four routes', async () => {
      const response = await get('/openapi.json');
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      expect(response.headers['x-request-id']).toMatch(UUID_V7);

      const document = response.json<unknown>();
      const parsed = openApiDocument.safeParse(document);
      expect(parsed.error?.issues).toBeUndefined();
      const { paths, info, openapi } = parsed.data!;
      expect(openapi.startsWith('3.1.')).toBe(true);
      expect(info.version).toBe(PACKAGE_VERSION);

      expect(Object.keys(paths).sort()).toEqual([
        `${API_PREFIX}/health`,
        `${API_PREFIX}/health/ready`,
        `${API_PREFIX}/meta`,
        `${API_PREFIX}/openapi.json`,
      ]);
      for (const item of Object.values(paths)) {
        expect(Object.keys(item)).toEqual(['get']);
      }

      for (const ref of refsIn(document)) {
        expect(resolves(document, ref), `${ref} does not resolve`).toBe(true);
      }
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
