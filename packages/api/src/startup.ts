import { PERMISSION_LISTS } from '@osfpm/core/src/access/permission-lists.js';
import { narrowManagedSensitiveGrants } from '@osfpm/core/src/auth/administrator-role.js';
import {
  syncPermissions,
  type PermissionDefinition,
} from '@osfpm/core/src/access/permission-sync.js';
import type { Database } from '@osfpm/core/src/db/client.js';
import {
  DatabaseInUseError,
  type InUseMarker,
} from '@osfpm/core/src/db/in-use.js';
import { migrate } from '@osfpm/core/src/db/migrate.js';
import type { Tx } from '@osfpm/core/src/db/write.js';
import type { App } from './app.js';
import { errorClassName } from './logging.js';
import { topUpAdministrator } from './setup/administrator.js';
import { issueFirstRunCode, setupCodeBlock } from './setup/first-run.js';
import { bindServerKeysAtStartup } from './server-keys.js';

/** What start-up does to the database. Tests swap the steps to watch the order. */
export type StartupSteps = {
  /** Applies pending migrations (the core's `migrate`). */
  readonly migrate: (database: Database) => Promise<void>;
  /**
   * Narrows the `all-projects` grants of managed roles to a permission the lists
   * now flag sensitive, and answers how many it narrowed
   * (`narrowManagedSensitiveGrants`). Runs in the transaction of the sync, before
   * any list is synced, so a refused sync takes it back. Left out, nothing is
   * done, for the reason `issueSetupCode` gives.
   */
  readonly narrowManagedGrants?: (tx: Tx) => Promise<number>;
  /** Upserts one permission list (the core's `syncPermissions`). */
  readonly syncPermissions: (
    tx: Tx,
    list: readonly PermissionDefinition[],
  ) => Promise<void>;
  /**
   * Makes the `installation` row and, until first-run setup is complete, issues a
   * setup code and answers it (`issueFirstRunCode`). Answers null when there is
   * none to print. Left out, nothing is done: a test that swaps `migrate` and
   * `syncPermissions` gets only those two, so it needs no installation.
   */
  readonly issueSetupCode?: (app: App) => Promise<string | null>;
  /**
   * Loads the server's keys from the key directory, binds the identity key to the
   * installation, and puts the keys in the app (`bindServerKeysAtStartup`). Runs
   * after `issueSetupCode`, which makes the `installation` row it needs, and before
   * anything that serves a request. Left out, nothing is done, for the reason
   * `issueSetupCode` gives: a test that swaps the steps needs no keys, and gives
   * the app its keys through `buildApp`.
   */
  readonly bindServerKeys?: (
    app: App,
    keysDir: string,
  ) => Promise<{
    readonly identityBound: boolean;
    readonly secretsSealed: number;
  }>;
  /**
   * Gives every organisation's Administrator role the permissions added since it
   * was made, and answers how many grants it made (`topUpAdministrator`). Runs
   * after `issueSetupCode`, which makes the `installation` row it needs. Left out,
   * nothing is done, for the reason `issueSetupCode` gives.
   */
  readonly topUpAdministrator?: (app: App) => Promise<number>;
};

const REAL_STEPS: StartupSteps = {
  migrate,
  narrowManagedGrants: (tx) =>
    narrowManagedSensitiveGrants(tx, { now: new Date() }),
  syncPermissions,
  issueSetupCode: issueFirstRunCode,
  bindServerKeys: bindServerKeysAtStartup,
  topUpAdministrator,
};

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

/**
 * The system code in `error` or its causes, such as `ECONNREFUSED` or a SQLSTATE,
 * if it has one that is short and plain enough to log. The admin command line
 * prints it too, as the whole of what it says about a failure besides the error's
 * class name.
 */
export function codeOf(error: unknown): string | undefined {
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

/** What `runStartup` is told about the server, besides its steps. */
export type StartupOptions = {
  /** Whether to apply pending migrations (`OSFPM_AUTO_MIGRATE`). */
  readonly autoMigrate: boolean;
  /**
   * The key directory (`OSFPM_KEYS_DIR`), which the key step reads. Always given, so
   * no start-up can skip the keys by leaving it out; a test passes the key directory
   * of its own file (`TEST_KEYS_DIR`), even when it swaps the steps.
   */
  readonly keysDir: string;
  /**
   * The server's in-use marker (`markDatabaseInUse`). Taken first in every attempt,
   * before the migrations, so that a command which needs every server stopped never
   * runs while this one migrates or serves. Left out, the server marks nothing: only
   * a test that has no use for the guard does that, and `startServer` always passes it.
   */
  readonly inUse?: InUseMarker;
};

/** What `runStartup` can be told besides its steps. */
export type StartupControl = {
  /** Defaults to `STARTUP_RETRY`. */
  readonly retry?: StartupRetry;
  /** Aborted when the server is stopped, so a wait or a retry ends at once. */
  readonly signal?: AbortSignal;
  /**
   * Where the setup code is written. Defaults to the process's standard error.
   * Tests pass a sink to read it, or to keep it off the test output.
   */
  readonly stderr?: { write(text: string): unknown };
};

/**
 * What the server does to its database once it is listening, in this order:
 * apply pending migrations (unless `autoMigrate` is false), then narrow the
 * managed roles' grants of any permission that is now flagged sensitive and sync
 * every list in the core's `PERMISSION_LISTS`, then make sure the `installation`
 * row exists and, until first-run setup is complete, issue a setup code, then give the
 * Administrator role of every organisation the permissions added since it was
 * made, then mark the app ready so `/health/ready` stops answering 503 and the
 * other routes stop answering a 503 problem `starting`.
 *
 * The narrowing and the lists are in one transaction: all of it or none, so a
 * refused list does not leave the catalogue half updated or a grant narrowed for a
 * flag that was not set. The narrowing comes first and holds the `installation`
 * row lock, which the server takes before everything else (nothing is narrowed on
 * a database with no such row yet, where no managed role exists). A release that
 * flags an existing permission sensitive thus starts: the Administrator role's own
 * `all-projects` grant of it becomes `own-scope`, audited as
 * `role.grant-reach-reduced`. Migrations run first because
 * the catalogue table is one of the things they create. With `autoMigrate` off
 * the database must already be migrated, or the sync fails. The Administrator
 * role is topped up after the sync, which makes the catalogue rows its grants
 * point to, and after the `installation` row exists, which the top-up locks.
 *
 * **The setup code is printed here, once, to standard error** (`control.stderr`),
 * in a marked block (`setupCodeBlock`), and only after the transaction that saved
 * it has committed. It never goes through the logger: it is the only secret
 * OSFPM prints, so it is written by hand to the one place a person reads it, and
 * the logger's masking is left as it is. A restart prints a new code and revokes
 * the old one; once setup is complete nothing is printed. If an attempt fails
 * and is tried again, only the attempt that succeeded prints.
 *
 * If the database cannot be reached (see `isDatabaseUnreachable`) the whole
 * sequence is tried again after a wait that doubles from `STARTUP_RETRY` up to
 * its cap, for as long as it takes, with one warning line per attempt: the
 * attempt, the wait, the error's class and its short system code, and nothing
 * of the connection (CLAUDE.md, Privacy rule: a driver message holds the host
 * and sometimes the password). The app stays not ready meanwhile. Migrations are
 * safe to run again.
 *
 * The first thing every attempt does is mark the database as in use
 * (`options.inUse`, the core's `markDatabaseInUse`). On PostgreSQL that is a
 * shared advisory lock, which an admin command that needs every server stopped
 * holds exclusively while it runs. The attempt then throws `DatabaseInUseError`,
 * which is not a failure: start-up waits as it does for an unreachable database,
 * with one warning line per attempt that names no more than the attempt and the
 * wait, and goes on when the command has finished. A stop signal ends that wait
 * too.
 *
 * Only the server entry calls this, once, after it listens.
 *
 * @throws PermissionSyncError when a permission is flagged sensitive while
 * roles an organisation made hold `all-projects` grants of it. Its message names
 * the permission and the roles, and says the release must ship a migration that
 * narrows them.
 * @throws The driver's error when a migration or the sync fails for a reason
 * that waiting does not cure. Its message can hold SQL, so the entry prints the
 * class name only.
 * @throws StartupAbortedError when `signal` is aborted before start-up ends.
 */
export async function runStartup(
  app: App,
  options: StartupOptions,
  steps: StartupSteps = REAL_STEPS,
  control: StartupControl = {},
): Promise<void> {
  const { signal } = control;
  const retry: StartupRetry = control.retry ?? STARTUP_RETRY;
  const sleep = retry.sleep ?? sleepUnlessStopped;

  // Set by the attempt that succeeds: the loop ends only by that, or by throwing.
  let setupCode: string | null;
  for (let attempt = 1; ; attempt += 1) {
    if (signal?.aborted) throw new StartupAbortedError();
    try {
      setupCode = await attemptOnce(app, options, steps);
      break;
    } catch (error) {
      // The shutdown closes the database under a step, which then fails: that
      // is the server stopping, not start-up failing.
      if (signal?.aborted) throw new StartupAbortedError();
      // An admin command has the database to itself: the server is early, not
      // failing, and waits as it does for a database that is not there yet.
      const busy = error instanceof DatabaseInUseError && attempt < 0;
      if (!busy && !isDatabaseUnreachable(error)) throw error;
      const retryInMs = Math.min(
        retry.initialMs * 2 ** (attempt - 1),
        retry.maxMs,
      );
      if (busy) {
        app.log.warn(
          { attempt, retryInMs },
          'an admin command is using the database, waiting',
        );
      } else {
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
      }
      await sleep(retryInMs, signal);
    }
  }
  // Written by hand, not logged: see the note on `runStartup`. After the
  // transaction that saved the code has committed, and before the routes open.
  if (setupCode !== null) {
    (control.stderr ?? process.stderr).write(
      setupCodeBlock(setupCode, app.publicOrigin),
    );
  }
  app.readiness.markReady();
}

/**
 * One go at the migrations, the permission sync and the installation. Answers
 * the setup code to print, or null when there is none.
 */
async function attemptOnce(
  app: App,
  options: StartupOptions,
  steps: StartupSteps,
): Promise<string | null> {
  // First, before any step touches the database: an admin command that needs
  // every server stopped holds the lock exclusively while it runs, and this
  // throws until it has finished (see `runStartup`). Nothing is taken twice when
  // a later step fails and the attempt is repeated.
  await options.inUse?.attach(app.db);
  if (options.autoMigrate) {
    await steps.migrate(app.db);
    app.log.info('migrations are up to date');
  } else {
    app.log.info('migrations skipped: OSFPM_AUTO_MIGRATE is false');
  }
  const narrowed = await app.db.db.transaction(async (tx) => {
    // Before the sync, which would refuse to flag a permission while a managed
    // role still reaches every project with it.
    const count = (await steps.narrowManagedGrants?.(tx)) ?? 0;
    for (const list of PERMISSION_LISTS) {
      await steps.syncPermissions(tx, list);
    }
    return count;
  });
  // After the commit, so the line is never about a change that was taken back.
  // A count only: each grant is in the audit trail and the change log.
  if (narrowed > 0) {
    app.log.info(
      { narrowed },
      'managed roles lost the all-projects reach of permissions that are now sensitive',
    );
  }
  app.log.info('the permission catalogue is up to date');
  const setupCode = (await steps.issueSetupCode?.(app)) ?? null;
  // The line says where to look, never what the code is.
  if (setupCode !== null) {
    app.log.info(
      'first-run setup is not complete: a setup code was written to standard error',
    );
  }
  const keys = await steps.bindServerKeys?.(app, options.keysDir);
  // Whether, never what: the key is public but the line says nothing of it.
  if (keys?.identityBound === true) {
    app.log.info('the server identity key was bound to this installation');
  }
  if (keys !== undefined && keys.secretsSealed > 0) {
    // A count only: the audit trail has the same, and no name.
    app.log.info(
      { sealed: keys.secretsSealed },
      'authenticator secrets that were stored in plain text are now encrypted',
    );
  }
  const added = (await steps.topUpAdministrator?.(app)) ?? 0;
  // A count only, as the audit event has: each grant itself is in the change log.
  if (added > 0) {
    app.log.info(
      { added },
      'the Administrator role was given the permissions added since it was made',
    );
  }
  return setupCode;
}
