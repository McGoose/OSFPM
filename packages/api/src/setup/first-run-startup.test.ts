import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withManagedRoleMaintenance } from '@osfpm/core/src/access/managed-role.js';
import { PERMISSION_LISTS } from '@osfpm/core/src/access/permission-lists.js';
import { completeFirstRunSetup } from '@osfpm/core/src/auth/first-run-setup.js';
import { AUTH_AUDIT } from '@osfpm/core/src/auth/shared.js';
import { consumeSetupCode } from '@osfpm/core/src/auth/setup-code.js';
import {
  demoSetupInput,
  markSetupComplete,
} from '@osfpm/core/src/auth/test-support.js';
import { normaliseHumanCode } from '@osfpm/core/src/auth/tokens.js';
import {
  auditEvent,
  installation,
  rolePermission,
  setupCode,
} from '@osfpm/core/src/db/schema/index.js';
import {
  testTargets,
  type TestTarget,
} from '@osfpm/core/src/db/test-support.js';
import { API_PREFIX } from '../api-version.js';
import { buildApp, type App } from '../app.js';
import type { Config } from '../config.js';
import { startServer } from '../server.js';
import { runStartup, type StartupSteps } from '../startup.js';
import { TEST_PUBLIC_ORIGIN, UUID_V7 } from '../test-support.js';
import { issueFirstRunCode, setupCodeBlock } from './first-run.js';

/** The code a printed block holds, or undefined when there is none. */
function printedCode(text: string): string | undefined {
  return /^Setup code: (\S+)$/m.exec(text)?.[1];
}

describe.each(testTargets)('first-run start-up on $name', (target) => {
  let created: Awaited<ReturnType<TestTarget['create']>>;
  let apps: App[];

  beforeEach(async () => {
    created = await target.create();
    apps = [];
  });
  afterEach(async () => {
    for (const app of apps) await app.close();
    await created.cleanup();
  });

  /**
   * One start of the server on the shared database, as a restart is: a new app
   * over the same data, running the real start-up steps. Answers what it wrote
   * to standard error and to the log.
   */
  async function start(steps?: StartupSteps) {
    const written: string[] = [];
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
    await runStartup(app, { autoMigrate: true }, steps, {
      stderr: { write: (text) => void written.push(text) },
      retry: { initialMs: 1, maxMs: 1 },
    });
    const stderr = written.join('');
    return { stderr, lines: lines.join(''), code: printedCode(stderr) };
  }

  const rows = () => created.database.db.select().from(installation);

  it('makes the installation row, with a new UUIDv7 id and the public origin, and makes it once', async () => {
    await start();
    const [first] = await rows();
    expect(first!.id).toMatch(UUID_V7);
    expect(first!.baseUrl).toBe(TEST_PUBLIC_ORIGIN);
    expect(first!.setupCompletedAt).toBeNull();

    await start();
    await start();
    const after = await rows();
    // The same row, never replaced: its id is what every record carries.
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(first!.id);
    expect(after[0]!.createdAt).toEqual(first!.createdAt);
    const made = (await created.database.db.select().from(auditEvent)).filter(
      (event) => event.category === AUTH_AUDIT.installationCreated,
    );
    expect(made).toHaveLength(1);
    expect(made[0]!.targetId).toBe(first!.id);
  });

  it('prints the setup code once, to standard error, in a marked block', async () => {
    const { stderr, code } = await start();
    expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
    expect(stderr).toBe(setupCodeBlock(code!, TEST_PUBLIC_ORIGIN));
    expect(stderr.split('\n')).toEqual([
      '=== OSFPM first-run setup ===',
      `Setup code: ${code}`,
      `Open ${TEST_PUBLIC_ORIGIN} and enter this code within 24 hours.`,
      'A new code is printed on every restart until setup is complete.',
      '=============================',
      '',
    ]);
    expect(stderr.match(/Setup code:/g)).toHaveLength(1);
  });

  it('saves the code it prints: it works once, and only its hash is stored', async () => {
    const { code } = await start();
    const stored = await created.database.db.select().from(setupCode);
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(code!);
    expect(JSON.stringify(stored)).not.toContain(normaliseHumanCode(code!)!);
    expect(await consumeSetupCode(created.database.db, code!, new Date())).toBe(
      true,
    );
    expect(await consumeSetupCode(created.database.db, code!, new Date())).toBe(
      false,
    );
  });

  it('never puts the code in the JSON log, at any level, in any spelling', async () => {
    const { lines, code } = await start();
    // The log was read at all: a log that said nothing would pass for nothing.
    expect(lines).toContain('the permission catalogue is up to date');
    expect(lines).toContain('a setup code was written to standard error');
    expect(lines).not.toContain(code!);
    expect(lines).not.toContain(normaliseHumanCode(code!)!);
    expect(lines).not.toContain(code!.replaceAll('-', ''));
  });

  it('prints a new code on a restart and revokes the old one', async () => {
    const first = await start();
    const second = await start();
    expect(second.code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
    expect(second.code).not.toBe(first.code);
    expect(second.stderr.match(/Setup code:/g)).toHaveLength(1);
    // Two codes were issued and one is live.
    const stored = await created.database.db.select().from(setupCode);
    expect(stored).toHaveLength(2);
    expect(stored.filter((row) => row.revokedAt === null)).toHaveLength(1);

    const now = new Date();
    expect(await consumeSetupCode(created.database.db, first.code!, now)).toBe(
      false,
    );
    expect(await consumeSetupCode(created.database.db, second.code!, now)).toBe(
      true,
    );
  });

  it('prints nothing, and issues no code, once setup is complete', async () => {
    const first = await start();
    await markSetupComplete(created.database);
    const second = await start();
    expect(second.stderr).toBe('');
    expect(second.code).toBeUndefined();
    expect(second.lines).not.toContain('setup code');
    // No new code, and the old one no longer works.
    expect(await created.database.db.select().from(setupCode)).toHaveLength(1);
    expect(
      await consumeSetupCode(created.database.db, first.code!, new Date()),
    ).toBe(false);
  });

  it('prints nothing when start-up fails: only a code that was saved is shown', async () => {
    const steps: StartupSteps = {
      migrate: () => Promise.resolve(),
      syncPermissions: () => Promise.resolve(),
      issueSetupCode: async (app) => {
        await issueFirstRunCode(app);
        throw new Error('the connection broke after the commit');
      },
    };
    const written: string[] = [];
    const app = buildApp({
      db: created.database,
      publicOrigin: TEST_PUBLIC_ORIGIN,
    });
    apps.push(app);
    // The database is migrated by the real start-up of an earlier server.
    await start();
    await expect(
      runStartup(app, { autoMigrate: false }, steps, {
        stderr: { write: (text) => void written.push(text) },
      }),
    ).rejects.toThrow('the connection broke');
    expect(written).toEqual([]);
  });

  it('prints nothing when the top-up fails after the code was saved: start-up failed, so no route opens on it', async () => {
    const steps: StartupSteps = {
      migrate: () => Promise.resolve(),
      syncPermissions: () => Promise.resolve(),
      issueSetupCode: issueFirstRunCode,
      topUpAdministrator: () => Promise.reject(new Error('the top-up failed')),
    };
    const written: string[] = [];
    const app = buildApp({
      db: created.database,
      publicOrigin: TEST_PUBLIC_ORIGIN,
    });
    apps.push(app);
    await start(); // migrates the database
    await expect(
      runStartup(app, { autoMigrate: false }, steps, {
        stderr: { write: (text) => void written.push(text) },
      }),
    ).rejects.toThrow('the top-up failed');
    expect(written).toEqual([]);
    expect(
      (await app.inject({ method: 'GET', url: `${API_PREFIX}/health/ready` }))
        .statusCode,
    ).toBe(503);
  });

  it('prints once when the first attempt cannot reach the database and the next can', async () => {
    let attempts = 0;
    const steps: StartupSteps = {
      migrate: () => Promise.resolve(),
      syncPermissions: () => Promise.resolve(),
      issueSetupCode: (app) => {
        attempts += 1;
        if (attempts === 1) {
          return Promise.reject(
            Object.assign(new Error('connect ECONNREFUSED'), {
              code: 'ECONNREFUSED',
            }),
          );
        }
        return issueFirstRunCode(app);
      },
    };
    await start(); // migrates the database
    const { stderr } = await start(steps);
    expect(attempts).toBe(2);
    expect(stderr.match(/Setup code:/g)).toHaveLength(1);
  });

  describe('the Administrator role', () => {
    /** Every permission key the core declares. */
    const declared = PERMISSION_LISTS.flatMap((list) =>
      list.map((entry) => entry.key),
    );

    /** A server that was set up, from its first start's code, as a person would. */
    async function installed() {
      const first = await start();
      const done = await completeFirstRunSetup(
        created.database.db,
        demoSetupInput(first.code!),
        new Date(),
      );
      if (!done.ok) throw new Error('the setup was refused');
    }

    const toppedUp = async () =>
      (await created.database.db.select().from(auditEvent)).filter(
        (event) => event.category === AUTH_AUDIT.administratorRoleToppedUp,
      );

    it('is given the permissions it lacks when the server starts, and the log and the audit trail say how many and no more', async () => {
      await installed();
      // As if a release declared these two after the role was made. The role is
      // managed, so the test switches the guard off to remove them, as the server
      // does to add them.
      const missing = declared.slice(0, 2);
      await withManagedRoleMaintenance(created.database.db, (tx) =>
        tx.execute(
          `delete from role_permission where permission_key in (${missing
            .map((key) => `'${key}'`)
            .join(', ')})`,
        ),
      );
      const { lines, stderr } = await start();
      expect(stderr).toBe('');
      expect(lines).toContain(
        'the Administrator role was given the permissions added since it was made',
      );
      expect(lines).toContain('"added":2');
      const grants = await created.database.db.select().from(rolePermission);
      expect(grants.map((grant) => grant.permissionKey).sort()).toEqual(
        [...declared].sort(),
      );
      const events = await toppedUp();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: 'top-up',
        actorType: 'system',
        details: { added: 2 },
      });
      for (const key of missing) {
        expect(lines).not.toContain(key);
        expect(JSON.stringify(events)).not.toContain(key);
      }
    });

    it('is left alone, with nothing logged and no event, when it already holds every permission', async () => {
      await installed();
      const { lines } = await start();
      expect(lines).not.toContain('given the permissions added');
      expect(await toppedUp()).toEqual([]);
    });

    it('is not looked for before the setup: a fresh install starts with no role to top up', async () => {
      const { lines } = await start();
      expect(lines).not.toContain('given the permissions added');
      expect(await toppedUp()).toEqual([]);
    });
  });
});

describe('setupCodeBlock', () => {
  it('says how long the code works from the lifetime the core uses', () => {
    expect(
      setupCodeBlock('AAAA-BBBB-CCCC-DDDD', 'https://films.example.test'),
    ).toContain(
      'Open https://films.example.test and enter this code within 24 hours.',
    );
  });
});

describe('startServer', () => {
  const config: Config = {
    database: { driver: 'pglite', dataDir: 'memory://' },
    host: '127.0.0.1',
    port: 0,
    logLevel: 'info',
    publicOrigin: 'http://localhost:3000',
    autoMigrate: true,
    trustedProxies: [],
  };

  it('prints the setup code to the stream it is given, and not to its log', async () => {
    const written: string[] = [];
    const lines: string[] = [];
    const server = await startServer(config, {
      signals: new EventEmitter(),
      stderr: { write: (text) => void written.push(text) },
      logStream: { write: (line) => void lines.push(line) },
    });
    try {
      await server.ready;
      const code = printedCode(written.join(''));
      expect(code).toBeDefined();
      expect(written.join('')).toContain('Open http://localhost:3000 and');
      expect(lines.join('')).not.toContain(code!);
      // Ready, so the code is saved before any route answers.
      expect(await server.database.db.select().from(setupCode)).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });
});
