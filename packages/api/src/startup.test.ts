import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PermissionSyncError,
  syncPermissions,
} from '@osfpm/core/src/access/permission-sync.js';
import {
  grantOnOrganisation,
  seedOrganisation,
  seedUser,
} from '@osfpm/core/src/access/test-fixtures.js';
import type { Database } from '@osfpm/core/src/db/client.js';
import { migrate } from '@osfpm/core/src/db/migrate.js';
import { permission } from '@osfpm/core/src/db/schema/index.js';
import {
  testTargets,
  type TestTarget,
} from '@osfpm/core/src/db/test-support.js';
import { API_PREFIX } from './api-version.js';
import { buildApp } from './app.js';
import { PERMISSION_LISTS, runStartup, type StartupSteps } from './startup.js';

/** A promise that is settled from outside, to hold a step half way. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** The real steps, with each call noted in `calls` in the order it started. */
function recordingSteps(calls: string[]): StartupSteps {
  return {
    migrate: async (database) => {
      calls.push('migrate');
      await migrate(database);
    },
    syncPermissions: async (tx, list) => {
      calls.push('sync');
      await syncPermissions(tx, list);
    },
  };
}

/** Every permission key in `PERMISSION_LISTS`. */
const declaredKeys = () =>
  PERMISSION_LISTS.flatMap((list) => list.map((entry) => entry.key));

describe('PERMISSION_LISTS', () => {
  /** The export names of every permission list that a file in the core declares, by file. */
  function declaredLists(): { file: string; name: string }[] {
    const coreSrc = fileURLToPath(new URL('../../core/src/', import.meta.url));
    return readdirSync(coreSrc, { recursive: true, withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith('.ts') &&
          !entry.name.endsWith('.test.ts'),
      )
      .flatMap((entry) => {
        const file = join(entry.parentPath, entry.name);
        const text = readFileSync(file, 'utf8');
        return [
          ...text.matchAll(
            /^export const (\w+): readonly PermissionDefinition\[\]/gm,
          ),
        ].map((match) => ({ file, name: match[1]! }));
      });
  }

  it('holds every permission list a module of the core declares', async () => {
    const declared = declaredLists();
    // Guards against scanning the wrong folder and passing for nothing.
    expect(declared.length).toBeGreaterThan(3);
    for (const { file, name } of declared) {
      const exported = (await import(pathToFileURL(file).href)) as Record<
        string,
        unknown
      >;
      expect(
        PERMISSION_LISTS,
        `${name} is declared but not synced at start-up: add it to PERMISSION_LISTS`,
      ).toContain(exported[name]);
    }
    expect(PERMISSION_LISTS).toHaveLength(declared.length);
  });

  it('declares no key twice, because two lists would take turns at flagging it on every start', () => {
    const keys = declaredKeys();
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe.each(testTargets)('start-up on $name', (target: TestTarget) => {
  let created: Awaited<ReturnType<TestTarget['create']>>;
  let app: ReturnType<typeof buildApp>;
  let database: Database;

  beforeEach(async () => {
    created = await target.create();
    database = created.database;
    app = buildApp({ db: database });
  });
  afterEach(async () => {
    await app.close();
    await created.cleanup();
  });

  const ready = () =>
    app.inject({ method: 'GET', url: `${API_PREFIX}/health/ready` });

  const storedKeys = async () => {
    const rows = await database.db
      .select({ key: permission.key })
      .from(permission);
    return rows.map((row) => row.key).sort();
  };

  it('migrates, then syncs every permission list, then reports ready', async () => {
    const calls: string[] = [];
    await runStartup(app, { autoMigrate: true }, recordingSteps(calls));

    expect(calls).toEqual(['migrate', ...PERMISSION_LISTS.map(() => 'sync')]);
    expect(await storedKeys()).toEqual(declaredKeys().sort());
    const response = await ready();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready' });
  });

  it('answers 503 until the migrations and the sync have both finished', async () => {
    const migrated = deferred();
    const releaseMigrate = deferred();
    const releaseSync = deferred();
    const steps: StartupSteps = {
      migrate: async (db) => {
        await releaseMigrate.promise;
        await migrate(db);
        migrated.resolve();
      },
      syncPermissions: async (tx, list) => {
        await releaseSync.promise;
        await syncPermissions(tx, list);
      },
    };
    const running = runStartup(app, { autoMigrate: true }, steps);

    // Nothing has run: the database is not even migrated.
    expect((await ready()).statusCode).toBe(503);

    releaseMigrate.resolve();
    await migrated.promise;
    // Migrated, but the permission catalogue is not synced yet.
    const between = await ready();
    expect(between.statusCode).toBe(503);
    expect(between.headers['content-type']).toMatch(
      /^application\/problem\+json/,
    );
    expect(between.json<{ code: string }>().code).toBe('service-unavailable');

    releaseSync.resolve();
    await running;
    expect((await ready()).statusCode).toBe(200);
  });

  it('stays not ready, and does not sync, when a migration fails', async () => {
    const sync = vi.fn(syncPermissions);
    const failure = new Error('migration 9999 failed');
    await expect(
      runStartup(
        app,
        { autoMigrate: true },
        { migrate: () => Promise.reject(failure), syncPermissions: sync },
      ),
    ).rejects.toBe(failure);
    expect(sync).not.toHaveBeenCalled();
    expect((await ready()).statusCode).toBe(503);
  });

  it('runs no migration when OSFPM_AUTO_MIGRATE is false, and syncs a database that is already migrated', async () => {
    await migrate(database);
    const calls: string[] = [];
    await runStartup(app, { autoMigrate: false }, recordingSteps(calls));

    expect(calls).not.toContain('migrate');
    expect(calls).toHaveLength(PERMISSION_LISTS.length);
    expect(await storedKeys()).toEqual(declaredKeys().sort());
    expect((await ready()).statusCode).toBe(200);
  });

  it('leaves an unmigrated database alone when OSFPM_AUTO_MIGRATE is false, and fails', async () => {
    await expect(
      runStartup(app, { autoMigrate: false }, recordingSteps([])),
    ).rejects.toThrow();
    // Both drivers answer `{ rows }`, but the shared base type leaves it unknown.
    const result = (await database.db.execute(
      "select to_regclass('public.permission')::text as found",
    )) as { rows: { found: string | null }[] };
    expect(result.rows[0]!.found).toBeNull();
    expect((await ready()).statusCode).toBe(503);
  });

  it('syncs the same lists again on the next start without changing anything', async () => {
    await runStartup(app, { autoMigrate: true }, recordingSteps([]));
    const first = await storedKeys();
    await runStartup(app, { autoMigrate: true }, recordingSteps([]));
    expect(await storedKeys()).toEqual(first);
  });

  describe('a permission that is sensitive in the lists but still held by an all-projects grant', () => {
    /** A catalogue row not yet flagged sensitive, held by an organisation role that reaches every project. */
    async function wideGrantOfASensitiveKey(key: string) {
      await migrate(database);
      await database.db.insert(permission).values({
        key,
        module: 'sensitive',
        description: 'Before it was flagged',
        grantsSensitive: false,
      });
      const { organisationId } = await seedOrganisation(database);
      const userId = await seedUser(database);
      await grantOnOrganisation(
        database,
        organisationId,
        userId,
        'admin',
        [key],
        {
          reach: 'all-projects',
        },
      );
      return organisationId;
    }

    it('stops with the PermissionSyncError and its clear message', async () => {
      const key = 'sensitive:read:medical';
      const organisationId = await wideGrantOfASensitiveKey(key);

      const error = await runStartup(
        app,
        { autoMigrate: false },
        recordingSteps([]),
      ).then(
        () => undefined,
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(PermissionSyncError);
      const { message } = error as PermissionSyncError;
      expect(message).toContain(key);
      expect(message).toContain(`role admin in organisation ${organisationId}`);
      expect(message).toContain('Remove those grants, then restart');
      expect((await ready()).statusCode).toBe(503);
    });

    it('writes none of the lists, not even the ones that came first', async () => {
      await wideGrantOfASensitiveKey('sensitive:read:medical');
      await expect(
        runStartup(app, { autoMigrate: false }, recordingSteps([])),
      ).rejects.toBeInstanceOf(PermissionSyncError);
      // Only the row the test inserted is there: the lists share one transaction.
      expect(await storedKeys()).toEqual(['sensitive:read:medical']);
    });
  });
});
