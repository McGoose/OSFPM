import { describe, expect, it, vi } from 'vitest';
import { PERMISSION_LISTS } from '@osfpm/core/src/access/permission-lists.js';
import { PermissionSyncError } from '@osfpm/core/src/access/permission-sync.js';
import { createDatabase, type Database } from '@osfpm/core/src/db/client.js';
import { API_PREFIX } from './api-version.js';
import { buildApp } from './app.js';
import { TEST_KEYS_DIR, TEST_PUBLIC_ORIGIN } from './test-support.js';
import {
  isDatabaseUnreachable,
  runStartup,
  StartupAbortedError,
  STARTUP_RETRY,
  type StartupSteps,
} from './startup.js';

/**
 * What a caller must never find in a log line about an unreachable database. The
 * port is looked for as part of the address, `:5432`, and not as the bare number:
 * a request id or a timestamp in the line can contain 5432 by chance, which once
 * failed a CI run.
 */
const DETAILS = [
  'hunter2',
  'db.internal',
  '10.1.2.3',
  ':5432',
  'postgres://',
  'osfpm:',
];

/** The error Node gives for a database that refuses the connection, with the details a driver puts in its message. */
const refused = () =>
  Object.assign(
    new Error(
      'connect ECONNREFUSED 10.1.2.3:5432 postgres://osfpm:hunter2-not-a-real-password@db.internal/osfpm',
    ),
    { code: 'ECONNREFUSED' },
  );

/** An app over `database` (an in-memory PGlite by default) that writes its log lines to `lines`. */
function makeApp(database: Database = createDatabase({ driver: 'pglite' })) {
  const lines: string[] = [];
  const app = buildApp({
    db: database,
    publicOrigin: TEST_PUBLIC_ORIGIN,
    logger: {
      level: 'info',
      stream: { write: (line) => void lines.push(line) },
    },
  });
  const records = () =>
    lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  /** The "will retry" lines: warnings with an attempt number. */
  const retryLines = () =>
    records().filter((record) => record.level === 40 && 'attempt' in record);
  const ready = () =>
    app.inject({ method: 'GET', url: `${API_PREFIX}/health/ready` });
  return {
    app,
    database,
    lines,
    records,
    retryLines,
    ready,
    close: async () => {
      await app.close();
      await database.close();
    },
  };
}

/** A sleep that does not wait, and notes how long it was asked to. */
function noteDelays(delays: number[], during?: () => Promise<void>) {
  return async (ms: number) => {
    delays.push(ms);
    await during?.();
  };
}

const nothing: StartupSteps['syncPermissions'] = () => Promise.resolve();

describe('isDatabaseUnreachable', () => {
  const withCode = (code: string) => Object.assign(new Error('x'), { code });

  it.each([
    'ECONNREFUSED',
    'ECONNRESET',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETUNREACH',
    // SQLSTATE class 08: connection exception.
    '08000',
    '08001',
    '08003',
    '08004',
    '08006',
    // The server is shutting down, crashed, or is still starting; or is full.
    '57P01',
    '57P02',
    '57P03',
    '53300',
  ])('is true for the code %s', (code) => {
    expect(isDatabaseUnreachable(withCode(code))).toBe(true);
  });

  it.each([
    // Wrong password or user, no such database, a missing table, a broken
    // statement: waiting does not cure any of them.
    '28P01',
    '28000',
    '3D000',
    '42P01',
    '42601',
    '23505',
    '22P02',
    'EACCES',
    'ENOENT',
  ])('is false for the code %s', (code) => {
    expect(isDatabaseUnreachable(withCode(code))).toBe(false);
  });

  it('finds the code in the cause chain, and in an AggregateError', () => {
    expect(
      isDatabaseUnreachable(new Error('wrapped', { cause: refused() })),
    ).toBe(true);
    expect(
      isDatabaseUnreachable(
        new Error('outer', { cause: new Error('inner', { cause: refused() }) }),
      ),
    ).toBe(true);
    // Node gives one of these for a host that resolves to IPv4 and IPv6.
    expect(
      isDatabaseUnreachable(new AggregateError([refused(), refused()], 'both')),
    ).toBe(true);
    expect(
      isDatabaseUnreachable(new Error('wrapped', { cause: withCode('28P01') })),
    ).toBe(false);
  });

  it.each([
    'Connection terminated unexpectedly',
    'Connection terminated due to connection timeout',
    'timeout exceeded when trying to connect',
  ])('is true for the driver message "%s", which has no code', (message) => {
    expect(isDatabaseUnreachable(new Error(message))).toBe(true);
  });

  it('is false for anything else, and does not loop on a cycle', () => {
    expect(isDatabaseUnreachable(new Error('migration 12 failed'))).toBe(false);
    expect(isDatabaseUnreachable(new PermissionSyncError([]))).toBe(false);
    for (const value of [null, undefined, 'ECONNREFUSED', 42, {}]) {
      expect(isDatabaseUnreachable(value)).toBe(false);
    }
    // Not an error, so not trusted to be one.
    expect(isDatabaseUnreachable({ code: 'ECONNREFUSED' })).toBe(false);
    const loop = new Error('loop');
    (loop as { cause?: unknown }).cause = loop;
    expect(isDatabaseUnreachable(loop)).toBe(false);
  });
});

describe('start-up when the database cannot be reached', () => {
  it('retries with a doubling delay up to a cap, logs one line per attempt, and goes ready when it answers', async () => {
    const ctx = makeApp();
    try {
      const delays: number[] = [];
      const statuses: number[] = [];
      let failures = 5;
      const steps: StartupSteps = {
        migrate: () =>
          failures-- > 0 ? Promise.reject(refused()) : Promise.resolve(),
        syncPermissions: nothing,
      };
      await runStartup(
        ctx.app,
        { autoMigrate: true, keysDir: TEST_KEYS_DIR },
        steps,
        {
          retry: {
            initialMs: 1_000,
            maxMs: 4_000,
            // Readiness is asked about while the server waits.
            sleep: noteDelays(delays, async () => {
              statuses.push((await ctx.ready()).statusCode);
            }),
          },
        },
      );

      expect(delays).toEqual([1_000, 2_000, 4_000, 4_000, 4_000]);
      expect(statuses).toEqual([503, 503, 503, 503, 503]);
      expect((await ctx.ready()).statusCode).toBe(200);

      // One line per attempt, with the attempt, the wait, and nothing of the connection.
      const lines = ctx.retryLines();
      expect(lines).toHaveLength(5);
      lines.forEach((line, index) => {
        expect(line).toMatchObject({
          msg: 'the database is not reachable, retrying',
          attempt: index + 1,
          retryInMs: delays[index],
          cause: 'Error',
          code: 'ECONNREFUSED',
        });
        expect(line).not.toHaveProperty('requestId');
      });
      for (const detail of DETAILS) {
        expect(ctx.lines.join(''), detail).not.toContain(detail);
      }
    } finally {
      await ctx.close();
    }
  });

  it('retries from the migration each time, and a sync that cannot reach the database is retried too', async () => {
    const ctx = makeApp();
    try {
      const calls: string[] = [];
      let syncFailures = 1;
      const steps: StartupSteps = {
        migrate: () => {
          calls.push('migrate');
          return Promise.resolve();
        },
        syncPermissions: () => {
          calls.push('sync');
          return syncFailures-- > 0
            ? Promise.reject(refused())
            : Promise.resolve();
        },
      };
      const delays: number[] = [];
      await runStartup(
        ctx.app,
        { autoMigrate: false, keysDir: TEST_KEYS_DIR },
        steps,
        {
          retry: { initialMs: 10, maxMs: 10, sleep: noteDelays(delays) },
        },
      );
      expect(delays).toEqual([10]);
      // The first sync failed on the first list; the second attempt did them all.
      expect(calls).toEqual(['sync', ...PERMISSION_LISTS.map(() => 'sync')]);
      expect((await ctx.ready()).statusCode).toBe(200);
    } finally {
      await ctx.close();
    }
  });

  it.each([
    ['a PermissionSyncError', () => new PermissionSyncError([])],
    ['a failed migration', () => new Error('migration 12 failed')],
    [
      'a wrong password',
      () => Object.assign(new Error('x'), { code: '28P01' }),
    ],
    [
      'a database that does not exist',
      () => Object.assign(new Error('x'), { code: '3D000' }),
    ],
  ])(
    'does not retry %s: it stops, with the error, and no delay',
    async (_label, make) => {
      const ctx = makeApp();
      try {
        const failure = make();
        const delays: number[] = [];
        await expect(
          runStartup(
            ctx.app,
            { autoMigrate: true, keysDir: TEST_KEYS_DIR },
            {
              migrate: () => Promise.reject(failure),
              syncPermissions: nothing,
            },
            { retry: { initialMs: 10, maxMs: 10, sleep: noteDelays(delays) } },
          ),
        ).rejects.toBe(failure);
        expect(delays).toEqual([]);
        expect(ctx.retryLines()).toEqual([]);
        expect((await ctx.ready()).statusCode).toBe(503);
      } finally {
        await ctx.close();
      }
    },
  );

  it('keeps waiting for as long as it takes: many failures in a row are not a reason to give up', async () => {
    const ctx = makeApp();
    try {
      const delays: number[] = [];
      let failures = 40;
      await runStartup(
        ctx.app,
        { autoMigrate: true, keysDir: TEST_KEYS_DIR },
        {
          migrate: () =>
            failures-- > 0 ? Promise.reject(refused()) : Promise.resolve(),
          syncPermissions: nothing,
        },
        {
          retry: { initialMs: 1_000, maxMs: 30_000, sleep: noteDelays(delays) },
        },
      );
      expect(delays).toHaveLength(40);
      // Capped, and no overflow however many attempts there were.
      expect(Math.max(...delays)).toBe(30_000);
      expect(delays.slice(0, 6)).toEqual(
        [1, 2, 4, 8, 16, 30].map((s) => s * 1_000),
      );
    } finally {
      await ctx.close();
    }
  });

  it('stops waiting when it is told to stop: the sleep ends at once, and the error says why', async () => {
    const ctx = makeApp();
    try {
      const abort = new AbortController();
      let attempts = 0;
      const running = runStartup(
        ctx.app,
        { autoMigrate: true, keysDir: TEST_KEYS_DIR },
        {
          migrate: () => {
            attempts += 1;
            return Promise.reject(refused());
          },
          syncPermissions: nothing,
        },
        // A minute, with the real timer: only the abort can end it in time.
        { retry: { initialMs: 60_000, maxMs: 60_000 }, signal: abort.signal },
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.waitFor(() => expect(ctx.retryLines()).toHaveLength(1));
      abort.abort();
      expect(await running).toBeInstanceOf(StartupAbortedError);
      expect(attempts).toBe(1);
      expect((await ctx.ready()).statusCode).toBe(503);
    } finally {
      await ctx.close();
    }
  });

  it('does not start at all when it is told to stop first', async () => {
    const ctx = makeApp();
    try {
      const abort = new AbortController();
      abort.abort();
      let attempts = 0;
      await expect(
        runStartup(
          ctx.app,
          { autoMigrate: true, keysDir: TEST_KEYS_DIR },
          {
            migrate: () => {
              attempts += 1;
              return Promise.resolve();
            },
            syncPermissions: nothing,
          },
          { signal: abort.signal },
        ),
      ).rejects.toBeInstanceOf(StartupAbortedError);
      expect(attempts).toBe(0);
    } finally {
      await ctx.close();
    }
  });

  it('reports a step that failed because the server was stopping as stopped, not as its own failure', async () => {
    const ctx = makeApp();
    try {
      const abort = new AbortController();
      await expect(
        runStartup(
          ctx.app,
          { autoMigrate: true, keysDir: TEST_KEYS_DIR },
          {
            // The database is closed under the step by the shutdown.
            migrate: () => {
              abort.abort();
              return Promise.reject(new Error('the client was closed'));
            },
            syncPermissions: nothing,
          },
          { signal: abort.signal },
        ),
      ).rejects.toBeInstanceOf(StartupAbortedError);
    } finally {
      await ctx.close();
    }
  });

  it('classifies what the real driver throws for a database that refuses the connection, and logs none of the URL', async () => {
    // Nothing listens on port 1, so the real `pg` driver fails the way it does
    // for a database that is down. No PostgreSQL server is needed.
    const database = createDatabase({
      driver: 'postgres',
      url: 'postgres://osfpm:hunter2-not-a-real-password@127.0.0.1:1/osfpm',
    });
    const ctx = makeApp(database);
    try {
      const abort = new AbortController();
      const delays: number[] = [];
      await expect(
        runStartup(
          ctx.app,
          { autoMigrate: true, keysDir: TEST_KEYS_DIR },
          undefined,
          {
            signal: abort.signal,
            retry: {
              initialMs: STARTUP_RETRY.initialMs,
              maxMs: STARTUP_RETRY.maxMs,
              // One wait is proof that the error was taken for "unreachable".
              sleep: (ms) => {
                delays.push(ms);
                abort.abort();
                return Promise.resolve();
              },
            },
          },
        ),
      ).rejects.toBeInstanceOf(StartupAbortedError);
      expect(delays).toEqual([STARTUP_RETRY.initialMs]);
      const [line] = ctx.retryLines();
      expect(line).toMatchObject({ attempt: 1, code: 'ECONNREFUSED' });
      for (const detail of ['hunter2', '127.0.0.1', 'postgres://', 'osfpm:']) {
        expect(ctx.lines.join(''), detail).not.toContain(detail);
      }
    } finally {
      await ctx.close();
    }
  }, 60_000);

  it('has a first delay of a second and a cap of half a minute', () => {
    expect(STARTUP_RETRY).toEqual({ initialMs: 1_000, maxMs: 30_000 });
  });
});
