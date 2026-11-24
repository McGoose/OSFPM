import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSION_LISTS } from '@osfpm/core/src/access/permission-lists.js';
import {
  PermissionSyncError,
  syncPermissions,
} from '@osfpm/core/src/access/permission-sync.js';
import { withManagedRoleMaintenance } from '@osfpm/core/src/access/managed-role.js';
import {
  grantOnOrganisation,
  seedOrganisation,
  seedUser,
} from '@osfpm/core/src/access/test-fixtures.js';
import { completeFirstRunSetup } from '@osfpm/core/src/auth/first-run-setup.js';
import { AUTH_AUDIT } from '@osfpm/core/src/auth/shared.js';
import {
  demoSetupInput,
  seedFirstRun,
} from '@osfpm/core/src/auth/test-support.js';
import type { Database } from '@osfpm/core/src/db/client.js';
import { migrate } from '@osfpm/core/src/db/migrate.js';
import {
  auditEvent,
  changeEvent,
  permission,
  rolePermission,
} from '@osfpm/core/src/db/schema/index.js';
import {
  testTargets,
  type TestTarget,
} from '@osfpm/core/src/db/test-support.js';
import { API_PREFIX } from './api-version.js';
import { buildApp } from './app.js';
import { TEST_KEYS_DIR, TEST_PUBLIC_ORIGIN } from './test-support.js';
import { runStartup, type StartupSteps } from './startup.js';

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

describe.each(testTargets)('start-up on $name', (target: TestTarget) => {
  let created: Awaited<ReturnType<TestTarget['create']>>;
  let app: ReturnType<typeof buildApp>;
  let database: Database;

  beforeEach(async () => {
    created = await target.create();
    database = created.database;
    app = buildApp({ db: database, publicOrigin: TEST_PUBLIC_ORIGIN });
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
    await runStartup(
      app,
      { autoMigrate: true, keysDir: TEST_KEYS_DIR },
      recordingSteps(calls),
    );

    expect(calls).toEqual(['migrate', ...PERMISSION_LISTS.map(() => 'sync')]);
    expect(await storedKeys()).toEqual(declaredKeys().sort());
    const response = await ready();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready' });
  });

  it('narrows managed grants first, in the transaction of the sync, then syncs every list', async () => {
    const calls: string[] = [];
    const steps: StartupSteps = {
      ...recordingSteps(calls),
      narrowManagedGrants: () => {
        calls.push('narrow');
        return Promise.resolve(0);
      },
    };
    await runStartup(app, { autoMigrate: true, keysDir: TEST_KEYS_DIR }, steps);

    // The sync refuses to flag a permission while a managed role holds it
    // everywhere, so the narrowing cannot come after it.
    expect(calls).toEqual([
      'migrate',
      'narrow',
      ...PERMISSION_LISTS.map(() => 'sync'),
    ]);
  });

  it('makes the installation after the sync, then tops up the Administrator role, then reports ready', async () => {
    const calls: string[] = [];
    const steps: StartupSteps = {
      ...recordingSteps(calls),
      issueSetupCode: () => {
        calls.push('installation');
        return Promise.resolve(null);
      },
      topUpAdministrator: () => {
        calls.push('top-up');
        return Promise.resolve(0);
      },
    };
    await runStartup(app, { autoMigrate: true, keysDir: TEST_KEYS_DIR }, steps);

    // The top-up locks the installation row and grants what the sync made rows
    // for, so it can neither come before the installation nor before the sync.
    expect(calls).toEqual([
      'migrate',
      ...PERMISSION_LISTS.map(() => 'sync'),
      'installation',
      'top-up',
    ]);
    expect((await ready()).statusCode).toBe(200);
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
    const running = runStartup(
      app,
      { autoMigrate: true, keysDir: TEST_KEYS_DIR },
      steps,
    );

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
        { autoMigrate: true, keysDir: TEST_KEYS_DIR },
        { migrate: () => Promise.reject(failure), syncPermissions: sync },
      ),
    ).rejects.toBe(failure);
    expect(sync).not.toHaveBeenCalled();
    expect((await ready()).statusCode).toBe(503);
  });

  it('runs no migration when OSFPM_AUTO_MIGRATE is false, and syncs a database that is already migrated', async () => {
    await migrate(database);
    const calls: string[] = [];
    await runStartup(
      app,
      { autoMigrate: false, keysDir: TEST_KEYS_DIR },
      recordingSteps(calls),
    );

    expect(calls).not.toContain('migrate');
    expect(calls).toHaveLength(PERMISSION_LISTS.length);
    expect(await storedKeys()).toEqual(declaredKeys().sort());
    expect((await ready()).statusCode).toBe(200);
  });

  it('leaves an unmigrated database alone when OSFPM_AUTO_MIGRATE is false, and fails', async () => {
    await expect(
      runStartup(
        app,
        { autoMigrate: false, keysDir: TEST_KEYS_DIR },
        recordingSteps([]),
      ),
    ).rejects.toThrow();
    // Both drivers answer `{ rows }`, but the shared base type leaves it unknown.
    const result = (await database.db.execute(
      "select to_regclass('public.permission')::text as found",
    )) as { rows: { found: string | null }[] };
    expect(result.rows[0]!.found).toBeNull();
    expect((await ready()).statusCode).toBe(503);
  });

  it('syncs the same lists again on the next start without changing anything', async () => {
    await runStartup(
      app,
      { autoMigrate: true, keysDir: TEST_KEYS_DIR },
      recordingSteps([]),
    );
    const first = await storedKeys();
    await runStartup(
      app,
      { autoMigrate: true, keysDir: TEST_KEYS_DIR },
      recordingSteps([]),
    );
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
        { autoMigrate: false, keysDir: TEST_KEYS_DIR },
        recordingSteps([]),
      ).then(
        () => undefined,
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(PermissionSyncError);
      const { message } = error as PermissionSyncError;
      expect(message).toContain(key);
      expect(message).toContain(`role admin in organisation ${organisationId}`);
      expect(message).toContain('ship a migration that narrows');
      expect((await ready()).statusCode).toBe(503);
    });

    it('writes none of the lists, not even the ones that came first', async () => {
      await wideGrantOfASensitiveKey('sensitive:read:medical');
      await expect(
        runStartup(
          app,
          { autoMigrate: false, keysDir: TEST_KEYS_DIR },
          recordingSteps([]),
        ),
      ).rejects.toBeInstanceOf(PermissionSyncError);
      // Only the row the test inserted is there: the lists share one transaction.
      expect(await storedKeys()).toEqual(['sensitive:read:medical']);
    });
  });

  describe('a permission that a release newly flags sensitive, while the Administrator role holds it in every project', () => {
    const KEY = 'sensitive:read:medical';

    /**
     * A server as the release before left it: first-run setup is done, and the
     * Administrator role holds `KEY` with `all-projects` reach, because it was an
     * ordinary permission then. The test writes the rows directly, as fixtures do,
     * with the managed-role triggers off as only the server's own code switches
     * them off.
     */
    async function installedBeforeTheFlag() {
      await migrate(database);
      const now = new Date();
      const code = await seedFirstRun(database, now);
      const done = await completeFirstRunSetup(
        database.db,
        demoSetupInput(code),
        now,
      );
      if (!done.ok) throw new Error('the setup was refused');
      await database.db.execute(
        "update permission set grants_sensitive = false where key = 'sensitive:read:medical'",
      );
      await withManagedRoleMaintenance(database.db, (tx) =>
        tx.execute(
          "update role_permission set reach = 'all-projects' where permission_key = 'sensitive:read:medical'",
        ),
      );
      return done.organisation.id;
    }

    const grants = async () =>
      (await database.db.select().from(rolePermission)).filter(
        (grant) => grant.permissionKey === KEY,
      );
    const flagged = async () =>
      (await database.db.select().from(permission)).find(
        (row) => row.key === KEY,
      )!.grantsSensitive;
    const reductions = async () =>
      (await database.db.select().from(auditEvent)).filter(
        (event) => event.category === AUTH_AUDIT.grantReachReduced,
      );

    it('narrows the managed role’s grant to own-scope and starts', async () => {
      const organisationId = await installedBeforeTheFlag();
      expect((await grants()).map((grant) => grant.reach)).toEqual([
        'all-projects',
      ]);

      await runStartup(app, { autoMigrate: false, keysDir: TEST_KEYS_DIR });

      expect((await grants()).map((grant) => grant.reach)).toEqual([
        'own-scope',
      ]);
      expect(await flagged()).toBe(true);
      expect((await ready()).statusCode).toBe(200);
      const events = await reductions();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actorType: 'system',
        organisationId,
        details: { permissionKey: KEY, from: 'all-projects', to: 'own-scope' },
      });
    });

    it('does nothing at the next start: no further event, no further change', async () => {
      await installedBeforeTheFlag();
      await runStartup(app, { autoMigrate: false, keysDir: TEST_KEYS_DIR });
      const events = (await database.db.select().from(auditEvent)).length;
      const changes = (await database.db.select().from(changeEvent)).length;

      await runStartup(app, { autoMigrate: false, keysDir: TEST_KEYS_DIR });

      expect((await database.db.select().from(auditEvent)).length).toBe(events);
      expect((await database.db.select().from(changeEvent)).length).toBe(
        changes,
      );
      expect(await reductions()).toHaveLength(1);
    });

    it('still stops for a role an organisation made, names it, and takes the narrowing back with the sync', async () => {
      await installedBeforeTheFlag();
      const other = await seedOrganisation(database);
      const owner = await seedUser(database);
      await grantOnOrganisation(
        database,
        other.organisationId,
        owner,
        'admin',
        [KEY],
        { reach: 'all-projects' },
      );

      const error = await runStartup(app, {
        autoMigrate: false,
        keysDir: TEST_KEYS_DIR,
      }).then(
        () => undefined,
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(PermissionSyncError);
      const { message } = error as PermissionSyncError;
      expect(message).toContain(
        `role admin in organisation ${other.organisationId}`,
      );
      expect(message).toContain('ship a migration that narrows');
      // One transaction: the managed role’s grant is as it was, and nothing was audited.
      expect((await grants()).map((grant) => grant.reach).sort()).toEqual([
        'all-projects',
        'all-projects',
      ]);
      expect(await flagged()).toBe(false);
      expect(await reductions()).toEqual([]);
      expect((await ready()).statusCode).toBe(503);
    });
  });
});
