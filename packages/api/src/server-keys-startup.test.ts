import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditEvent, installation } from '@osfpm/core/src/db/schema/index.js';
import {
  testTargets,
  type TestTarget,
} from '@osfpm/core/src/db/test-support.js';
import { ServerKeysError } from '@osfpm/core/src/keys/errors.js';
import {
  loadServerKeys,
  SERVER_KEY_FILES,
} from '@osfpm/core/src/keys/server-keys.js';
import {
  createTestKeyDirectory,
  type TestKeyDirectory,
} from '@osfpm/core/src/keys/test-support.js';
import { AUTH_AUDIT } from '@osfpm/core/src/auth/shared.js';
import {
  everyRowAsText,
  seedActiveUser,
  seedTotp,
} from '@osfpm/core/src/auth/test-support.js';
import { API_PREFIX } from './api-version.js';
import { buildApp, type App } from './app.js';
import type { Config } from './config.js';
import { describeStartupFailure, startServer } from './server.js';
import { runStartup } from './startup.js';
import { TEST_PUBLIC_ORIGIN } from './test-support.js';

const WELL_KNOWN = '/.well-known/osfpm/server-key';

describe.each(testTargets)(
  'the server keys at start-up on $name',
  (target: TestTarget) => {
    let created: Awaited<ReturnType<TestTarget['create']>>;
    let apps: App[];
    let scratch: TestKeyDirectory;

    beforeEach(async () => {
      created = await target.create();
      apps = [];
      scratch = createTestKeyDirectory();
    });
    afterEach(async () => {
      for (const app of apps) await app.close();
      await created.cleanup();
      scratch.remove();
    });

    /** One start of the server on the shared database, as a restart is. */
    function appOnTheDatabase() {
      const lines: string[] = [];
      const app = buildApp({
        db: created.database,
        publicOrigin: TEST_PUBLIC_ORIGIN,
        logger: {
          level: 'trace',
          stream: { write: (line) => void lines.push(line) },
        },
      });
      apps.push(app);
      return { app, lines };
    }
    const start = async (keysDir: string = scratch.dir) => {
      const running = appOnTheDatabase();
      await runStartup(running.app, { autoMigrate: true, keysDir }, undefined, {
        stderr: { write: () => true },
        retry: { initialMs: 1, maxMs: 1 },
      });
      return running;
    };
    const storedKey = async () =>
      (await created.database.db.select().from(installation))[0]
        ?.serverPublicKey;
    const boundEvents = async () =>
      (await created.database.db.select().from(auditEvent)).filter(
        (event) => event.category === AUTH_AUDIT.serverKeyBound,
      );

    it('loads the keys, binds the public key to the installation and publishes it', async () => {
      const { app, lines } = await start();

      const keys = app.serverKeys.get();
      expect(await storedKey()).toBe(keys.identity.publicKey);
      expect(await boundEvents()).toHaveLength(1);
      const response = await app.inject({ method: 'GET', url: WELL_KNOWN });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ publicKey: string }>().publicKey).toBe(
        keys.identity.publicKey,
      );
      // Says that it happened, and nothing of the key.
      const text = lines.join('');
      expect(text).toContain('the server identity key was bound');
      expect(text).not.toContain(keys.identity.publicKey);
      expect(text).not.toContain(keys.dataKeys.currentKeyId);
      expect(text).not.toContain(scratch.dir);
    });

    it('keeps the same key and writes no second event when it starts again', async () => {
      const first = (await start()).app.serverKeys.get();

      const second = await start();

      expect(second.app.serverKeys.get().identity.publicKey).toBe(
        first.identity.publicKey,
      );
      expect(await storedKey()).toBe(first.identity.publicKey);
      expect(await boundEvents()).toHaveLength(1);
      expect(second.lines.join('')).not.toContain('was bound');
      expect(
        (await second.app.inject({ method: 'GET', url: WELL_KNOWN }))
          .statusCode,
      ).toBe(200);
    });

    it('stops, not ready, when the key directory is another install’s, and keeps the stored key', async () => {
      const first = (await start()).app.serverKeys.get();
      const stranger = createTestKeyDirectory();
      loadServerKeys(stranger.dir);
      try {
        const { app } = appOnTheDatabase();
        const error = await runStartup(
          app,
          { autoMigrate: true, keysDir: stranger.dir },
          undefined,
          { stderr: { write: () => true } },
        ).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(ServerKeysError);
        expect((error as ServerKeysError).reason).toBe('identity-mismatch');
        expect(app.readiness.isReady()).toBe(false);
        expect(
          (
            await app.inject({
              method: 'GET',
              url: `${API_PREFIX}/health/ready`,
            })
          ).statusCode,
        ).toBe(503);
        expect(
          (await app.inject({ method: 'GET', url: WELL_KNOWN })).json<{
            code: string;
          }>().code,
        ).toBe('starting');
      } finally {
        stranger.remove();
      }
      expect(await storedKey()).toBe(first.identity.publicKey);
    });

    it('stops when the identity file is gone and the database has a key, and makes no new file', async () => {
      await start();
      rmSync(join(scratch.dir, SERVER_KEY_FILES.identity));

      const { app } = appOnTheDatabase();
      const error = await runStartup(
        app,
        { autoMigrate: true, keysDir: scratch.dir },
        undefined,
        { stderr: { write: () => true } },
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ServerKeysError);
      expect((error as ServerKeysError).reason).toBe('identity-missing');
      expect(existsSync(join(scratch.dir, SERVER_KEY_FILES.identity))).toBe(
        false,
      );
    });

    it('keeps every key, the plain secret and the key files out of every table, every log line and every answer', async () => {
      const first = await start();
      // An install made before secrets were sealed: one plain secret, which the
      // next start seals.
      const userId = await seedActiveUser(created.database);
      const secret = await seedTotp(created.database, userId, {
        dataKeys: first.app.serverKeys.get().dataKeys,
        plain: true,
      });
      const second = await start();
      const keys = second.app.serverKeys.get();

      // What must never be anywhere: the private key, every data key, the plain secret.
      const pemBody = readFileSync(
        join(scratch.dir, SERVER_KEY_FILES.identity),
        'utf8',
      )
        .split('\n')
        .filter((line) => line.length > 0 && !line.startsWith('-----'))
        .join('');
      const keyFileTexts = [
        readFileSync(
          join(
            scratch.dir,
            SERVER_KEY_FILES.dataKeysDirectory,
            `${keys.dataKeys.currentKeyId}.key`,
          ),
          'utf8',
        ).trim(),
      ];
      const needles = [pemBody, secret, ...keyFileTexts];
      expect(pemBody.length).toBeGreaterThan(40);

      const answers = [
        (await second.app.inject({ method: 'GET', url: WELL_KNOWN })).body,
        (await second.app.inject({ method: 'GET', url: `${API_PREFIX}/meta` }))
          .body,
      ].join('\n');
      const written = [
        await everyRowAsText(created.database),
        first.lines.join(''),
        second.lines.join(''),
        answers,
      ].join('\n');
      for (const needle of needles) expect(written).not.toContain(needle);
      // Nor the key directory or the names of its files.
      expect(written).not.toContain(scratch.dir);
      expect(written).not.toContain(SERVER_KEY_FILES.identity);
      // The plain secret was sealed in place, and said so as a count.
      expect(written).toContain('v1.');
      expect(second.lines.join('')).toContain('now encrypted');
    });
  },
);

describe('describeStartupFailure', () => {
  it('prints the message of a key refusal, which is fixed text for the operator', () => {
    const error = new ServerKeysError('identity-mismatch');
    expect(describeStartupFailure(error)).toBe(error.message);
    expect(describeStartupFailure(error)).toContain('OSFPM_KEYS_DIR');
    expect(describeStartupFailure(error)).toContain('backup');
  });
});

describe('startServer with a key directory', () => {
  const directories: TestKeyDirectory[] = [];
  afterAll(() => directories.forEach((directory) => directory.remove()));
  const config = (keysDir: string): Config => ({
    database: { driver: 'pglite', dataDir: 'memory://' },
    keysDir,
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    publicOrigin: 'http://localhost:3000',
    autoMigrate: true,
    trustedProxies: [],
  });
  const baseUrl = (server: Awaited<ReturnType<typeof startServer>>) => {
    const address = server.app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('The server is not listening on a port');
    }
    return `http://127.0.0.1:${address.port}`;
  };

  it('makes the key directory on a first start and answers the public key over HTTP', async () => {
    const directory = createTestKeyDirectory();
    directories.push(directory);
    const keysDir = join(directory.dir, 'keys', 'inside');
    const server = await startServer(config(keysDir), {
      signals: new EventEmitter(),
      stderr: { write: () => true },
    });
    try {
      await server.ready;
      const response = await fetch(`${baseUrl(server)}${WELL_KNOWN}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { publicKey: string };
      expect(body.publicKey).toBe(loadServerKeys(keysDir).identity.publicKey);
    } finally {
      await server.stop();
    }
  });

  it('rejects ready with the key refusal and keeps answering 503 starting', async () => {
    const directory = createTestKeyDirectory();
    directories.push(directory);
    // A directory whose identity file is not a key at all.
    const keysDir = directory.dir;
    writeFileSync(join(keysDir, SERVER_KEY_FILES.identity), 'not a key\n', {
      mode: 0o600,
    });
    const server = await startServer(config(keysDir), {
      signals: new EventEmitter(),
      stderr: { write: () => true },
    });
    try {
      const error = await server.ready.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ServerKeysError);
      expect((error as ServerKeysError).reason).toBe('invalid');
      const response = await fetch(`${baseUrl(server)}${WELL_KNOWN}`);
      expect(response.status).toBe(503);
    } finally {
      await server.stop();
    }
  });
});
