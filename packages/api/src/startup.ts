import {
  syncPermissions,
  type PermissionDefinition,
} from '@osfpm/core/src/access/permission-sync.js';
import { ACCOUNT_PERMISSIONS } from '@osfpm/core/src/accounts/permissions.js';
import { CONTRACT_PERMISSIONS } from '@osfpm/core/src/contracts/permissions.js';
import { COST_PERMISSIONS } from '@osfpm/core/src/costs/permissions.js';
import type { Database } from '@osfpm/core/src/db/client.js';
import { migrate } from '@osfpm/core/src/db/migrate.js';
import type { Tx } from '@osfpm/core/src/db/write.js';
import { LEGAL_HOLD_PERMISSIONS } from '@osfpm/core/src/legal-hold/permissions.js';
import { SENSITIVE_PERMISSIONS } from '@osfpm/core/src/sensitive/permissions.js';
import type { App } from './app.js';
import { errorClassName } from './logging.js';

/**
 * Every permission list a module of the core declares, in the order they are
 * synced. The catalogue (`permission` table) is filled from these when the
 * server starts, so a module's keys exist before any role is granted them.
 *
 * A module that adds a `*_PERMISSIONS` list adds it here too. `startup.test.ts`
 * scans the core for declared lists and fails when one is missing.
 */
export const PERMISSION_LISTS: readonly (readonly PermissionDefinition[])[] = [
  ACCOUNT_PERMISSIONS,
  CONTRACT_PERMISSIONS,
  COST_PERMISSIONS,
  LEGAL_HOLD_PERMISSIONS,
  SENSITIVE_PERMISSIONS,
];

/** The two things start-up does to the database. Tests swap them to watch the order. */
export type StartupSteps = {
  /** Applies pending migrations (the core's `migrate`). */
  readonly migrate: (database: Database) => Promise<void>;
  /** Upserts one permission list (the core's `syncPermissions`). */
  readonly syncPermissions: (
    tx: Tx,
    list: readonly PermissionDefinition[],
  ) => Promise<void>;
};

const REAL_STEPS: StartupSteps = { migrate, syncPermissions };

/**
 * How long start-up waits between attempts while the database cannot be
 * reached: `initialMs` after the first failure, doubling after each one, never
 * more than `maxMs`. Kept here, in one place. It is not a limit on the number
 * of attempts: the server waits for as long as it takes, because a database
 * that is starting up (a container, a restart) is the usual cause.
 */
export const STARTUP_RETRY = { initialMs: 1_000, maxMs: 30_000 } as const;

/** What `runStartup` waits with. Tests pass a `sleep` that does not wait. */
export type StartupRetry = {
  readonly initialMs: number;
  readonly maxMs: number;
  /** Waits `ms` milliseconds. Defaults to a timer that `signal` can cut short. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

/**
 * Start-up was told to stop (the server is shutting down) before it finished.
 * It is not a failure: nothing is wrong, so nothing is logged as fatal.
 */
export class StartupAbortedError extends Error {
  constructor() {
    super('Start-up was stopped before it finished');
    this.name = 'StartupAbortedError';
  }
}

/** Waits `ms`, or throws `StartupAbortedError` as soon as `signal` says stop. */
function sleepUnlessStopped(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new StartupAbortedError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new StartupAbortedError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** System codes of a connection that failed, or is not possible right now. */
const UNREACHABLE_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  // PostgreSQL: the server is shutting down (57P01), crashed (57P02), is still
  // starting up (57P03), or has no connection left to give (53300).
  '57P01',
  '57P02',
  '57P03',
  '53300',
]);

/** What `pg` says when a connection drops or cannot be made, which it gives no code for. */
const UNREACHABLE_MESSAGE =
  /^(?:Connection terminated|timeout exceeded when trying to connect)/;

/** How far down a chain of causes `isDatabaseUnreachable` looks. */
const MAX_CAUSE_DEPTH = 8;

/**
 * True when `error`, or something it was caused by, says the database could not
 * be reached: the connection was refused, reset or timed out, the host is not
 * found, or PostgreSQL is starting up or shutting down (SQLSTATE class 08 and a
 * few more). Waiting can cure these. It is false for a wrong password, a
 * database that does not exist, a failed migration and a `PermissionSyncError`:
 * waiting cures none of them, so they stop start-up.
 *
 * Looks through `cause` and an `AggregateError`'s members, because the driver
 * and Drizzle wrap what the network gave them, and Node gives an
 * `AggregateError` for a host with an IPv4 and an IPv6 address. Only an `Error`
 * counts: a thrown plain object is not trusted to say what it is.
 */
export function isDatabaseUnreachable(error: unknown): boolean {
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): boolean => {
    if (
      !(value instanceof Error) ||
      seen.has(value) ||
      depth > MAX_CAUSE_DEPTH
    ) {
      return false;
    }
    seen.add(value);
    const { code } = value as { code?: unknown };
    if (typeof code === 'string') {
      if (UNREACHABLE_CODES.has(code) || code.startsWith('08')) return true;
    } else if (UNREACHABLE_MESSAGE.test(value.message)) {
      return true;
    }
    if (visit(value.cause, depth + 1)) return true;
    return (
      value instanceof AggregateError &&
      value.errors.some((member: unknown) => visit(member, depth + 1))
    );
  };
  return visit(error, 0);
}

/** The system code in `error` or its causes, if it has one that is short and plain enough to log. */
function codeOf(error: unknown): string | undefined {
  for (
    let current: unknown = error, depth = 0;
    current instanceof Error && depth <= MAX_CAUSE_DEPTH;
    current = current.cause, depth += 1
  ) {
    const { code } = current as { code?: unknown };
    if (typeof code === 'string' && /^[A-Za-z0-9_]{1,20}$/.test(code)) {
      return code;
    }
    if (current instanceof AggregateError) {
      for (const member of current.errors as unknown[]) {
        const inner = codeOf(member);
        if (inner !== undefined) return inner;
      }
    }
  }
  return undefined;
}

/** What `runStartup` can be told besides its steps. */
export type StartupControl = {
  /** Defaults to `STARTUP_RETRY`. */
  readonly retry?: StartupRetry;
  /** Aborted when the server is stopped, so a wait or a retry ends at once. */
  readonly signal?: AbortSignal;
};

/**
 * What the server does to its database once it is listening, in this order:
 * apply pending migrations (unless `autoMigrate` is false), then sync every
 * list in `PERMISSION_LISTS`, then mark the app ready so `/health/ready` stops
 * answering 503 and the other routes stop answering a 503 problem `starting`.
 *
 * The lists are synced in one transaction: all of them or none, so a refused
 * list does not leave the catalogue half updated. Migrations run first because
 * the catalogue table is one of the things they create. With `autoMigrate` off
 * the database must already be migrated, or the sync fails.
 *
 * If the database cannot be reached (see `isDatabaseUnreachable`) the whole
 * sequence is tried again after a wait that doubles from `STARTUP_RETRY` up to
 * its cap, for as long as it takes, with one warning line per attempt: the
 * attempt, the wait, the error's class and its short system code, and nothing
 * of the connection (CLAUDE.md, Privacy rule: a driver message holds the host
 * and sometimes the password). The app stays not ready meanwhile. Migrations are
 * safe to run again.
 *
 * Only the server entry calls this, once, after it listens.
 *
 * @throws PermissionSyncError when a permission is flagged sensitive while
 * organisation roles hold `all-projects` grants of it. Its message names the
 * permission and the roles, and says how to fix it.
 * @throws The driver's error when a migration or the sync fails for a reason
 * that waiting does not cure. Its message can hold SQL, so the entry prints the
 * class name only.
 * @throws StartupAbortedError when `signal` is aborted before start-up ends.
 */
export async function runStartup(
  app: App,
  options: { readonly autoMigrate: boolean },
  steps: StartupSteps = REAL_STEPS,
  control: StartupControl = {},
): Promise<void> {
  const { signal } = control;
  const retry: StartupRetry = control.retry ?? STARTUP_RETRY;
  const sleep = retry.sleep ?? sleepUnlessStopped;

  for (let attempt = 1; ; attempt += 1) {
    if (signal?.aborted) throw new StartupAbortedError();
    try {
      await attemptOnce(app, options, steps);
      break;
    } catch (error) {
      // The shutdown closes the database under a step, which then fails: that
      // is the server stopping, not start-up failing.
      if (signal?.aborted) throw new StartupAbortedError();
      if (!isDatabaseUnreachable(error)) throw error;
      const retryInMs = Math.min(
        retry.initialMs * 2 ** (attempt - 1),
        retry.maxMs,
      );
      const code = codeOf(error);
      app.log.warn(
        {
          attempt,
          retryInMs,
          cause: errorClassName(error),
          ...(code === undefined ? {} : { code }),
        },
        'the database is not reachable, retrying',
      );
      await sleep(retryInMs, signal);
    }
  }
  app.readiness.markReady();
}

/** One go at the migrations and the permission sync. */
async function attemptOnce(
  app: App,
  options: { readonly autoMigrate: boolean },
  steps: StartupSteps,
): Promise<void> {
  if (options.autoMigrate) {
    await steps.migrate(app.db);
    app.log.info('migrations are up to date');
  } else {
    app.log.info('migrations skipped: OSFPM_AUTO_MIGRATE is false');
  }
  await app.db.db.transaction(async (tx) => {
    for (const list of PERMISSION_LISTS) {
      await steps.syncPermissions(tx, list);
    }
  });
  app.log.info('the permission catalogue is up to date');
}
