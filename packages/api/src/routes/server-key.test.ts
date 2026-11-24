import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedInstallation } from '@osfpm/core/src/auth/test-support.js';
import { migrate } from '@osfpm/core/src/db/migrate.js';
import {
  testTargets,
  type TestTarget,
} from '@osfpm/core/src/db/test-support.js';
import { SERVER_KEY_FILES } from '@osfpm/core/src/keys/server-keys.js';
import { API_PREFIX } from '../api-version.js';
import { buildApp } from '../app.js';
import {
  createTestApp,
  TEST_KEYS_DIR,
  TEST_PUBLIC_ORIGIN,
  TEST_SERVER_KEYS,
} from '../test-support.js';

const WELL_KNOWN = '/.well-known/osfpm/server-key';

/** The body of the private key file, which no response or log may hold. */
const PRIVATE_KEY_BODY = readFileSync(
  join(TEST_KEYS_DIR, SERVER_KEY_FILES.identity),
  'utf8',
)
  .split('\n')
  .filter((line) => line.length > 0 && !line.startsWith('-----'))
  .join('');

describe.each(testTargets)(
  'GET /.well-known/osfpm/server-key on $name',
  (target: TestTarget) => {
    let ctx: Awaited<ReturnType<typeof createTestApp>>;
    let installationId: string;

    beforeEach(async () => {
      ctx = await createTestApp(target, { logLevel: 'trace' });
      await migrate(ctx.database);
      installationId = await seedInstallation(ctx.database);
    });
    afterEach(async () => {
      await ctx.close();
    });

    const get = (url = WELL_KNOWN, headers: Record<string, string> = {}) =>
      ctx.app.inject({ method: 'GET', url, headers });

    it('answers the server id, the algorithm, the public key and its fingerprint, with no credential', async () => {
      const response = await get();

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        serverId: installationId,
        algorithm: 'Ed25519',
        publicKey: TEST_SERVER_KEYS.identity.publicKey,
        fingerprint: TEST_SERVER_KEYS.identity.fingerprint,
      });
    });

    it('publishes the raw 32-byte key in base64url and the SHA-256 of it in hex, in groups of four', async () => {
      const body = (await get()).json<{
        publicKey: string;
        fingerprint: string;
      }>();

      const raw = Buffer.from(body.publicKey, 'base64url');
      expect(raw).toHaveLength(32);
      expect(raw.toString('base64url')).toBe(body.publicKey);
      const digest = createHash('sha256').update(raw).digest('hex');
      expect(body.fingerprint.split(' ')).toEqual(digest.match(/.{4}/g));
    });

    it('works while first-run setup is not complete, when other routes are closed', async () => {
      await ctx.close();
      ctx = await createTestApp(target, { setupComplete: false });
      await migrate(ctx.database);
      installationId = await seedInstallation(ctx.database);

      const closed = await get(`${API_PREFIX}/auth/me`);
      expect(closed.statusCode).toBe(503);
      expect(closed.json<{ code: string }>().code).toBe('setup-required');

      const response = await get();
      expect(response.statusCode).toBe(200);
      expect(response.json<{ serverId: string }>().serverId).toBe(
        installationId,
      );
    });

    it('ignores a bearer token and a session cookie: it is public', async () => {
      const response = await get(WELL_KNOWN, {
        authorization: 'Bearer osfpm_pat_not-a-token',
        cookie: '__Host-osfpm_session=not-a-session',
      });
      expect(response.statusCode).toBe(200);
    });

    it('is in the OpenAPI document, with no token access', async () => {
      const document = (await get(`${API_PREFIX}/openapi.json`)).json<{
        paths: Record<string, Record<string, { security?: unknown }>>;
      }>();
      expect(Object.keys(document.paths)).toContain(WELL_KNOWN);
      expect(Object.keys(document.paths[WELL_KNOWN]!)).toEqual(['get']);
    });

    it('holds no private material in the response, the headers or the log', async () => {
      ctx.lines.length = 0;
      const response = await get();
      const written = [
        response.body,
        JSON.stringify(response.headers),
        ctx.lines.join(''),
      ].join('\n');

      expect(written).not.toContain('PRIVATE KEY');
      expect(written).not.toContain(PRIVATE_KEY_BODY);
      expect(written).not.toContain(TEST_SERVER_KEYS.dataKeys.currentKeyId);
      expect(written).not.toContain(TEST_KEYS_DIR);
      expect(ctx.lines.length).toBeGreaterThan(0);
    });
  },
);

describe.each(testTargets)(
  'the server key route while the server starts, on $name',
  (target: TestTarget) => {
    it('answers 503 starting until start-up has finished', async () => {
      const { database, cleanup } = await target.create();
      const app = buildApp({
        db: database,
        publicOrigin: TEST_PUBLIC_ORIGIN,
        serverKeys: TEST_SERVER_KEYS,
      });
      try {
        const response = await app.inject({ method: 'GET', url: WELL_KNOWN });
        expect(response.statusCode).toBe(503);
        expect(response.json<{ code: string }>().code).toBe('starting');
      } finally {
        await app.close();
        await cleanup();
      }
    });
  },
);

describe.each(testTargets)(
  'GET /meta and the server key on $name',
  (target: TestTarget) => {
    let ctx: Awaited<ReturnType<typeof createTestApp>>;
    beforeEach(async () => {
      ctx = await createTestApp(target);
      await migrate(ctx.database);
      await seedInstallation(ctx.database);
    });
    afterEach(async () => {
      await ctx.close();
    });

    it('gains the fingerprint of the server key and nothing else of it', async () => {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `${API_PREFIX}/meta`,
      });

      const body = response.json<Record<string, unknown>>();
      expect(body.serverKeyFingerprint).toBe(
        TEST_SERVER_KEYS.identity.fingerprint,
      );
      expect(Object.keys(body).sort()).toEqual(
        [
          'apiVersion',
          'database',
          'name',
          'package',
          'serverKeyFingerprint',
          'setupRequired',
          'version',
        ].sort(),
      );
      expect(response.body).not.toContain(TEST_SERVER_KEYS.identity.publicKey);
    });
  },
);
