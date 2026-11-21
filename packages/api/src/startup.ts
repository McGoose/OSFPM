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
 * What the server does to its database before it listens, in this order:
 * apply pending migrations (unless `autoMigrate` is false), then sync every
 * list in `PERMISSION_LISTS`, then mark the app ready so `/health/ready` stops
 * answering 503. A step that fails leaves the app not ready and throws what the
 * step threw, so the caller stops the server.
 *
 * The lists are synced in one transaction: all of them or none, so a refused
 * list does not leave the catalogue half updated. Migrations run first because
 * the catalogue table is one of the things they create. With `autoMigrate` off
 * the database must already be migrated, or the sync fails.
 *
 * Only the server entry calls this, once, before it listens.
 *
 * @throws PermissionSyncError when a permission is flagged sensitive while
 * organisation roles hold `all-projects` grants of it. Its message names the
 * permission and the roles, and says how to fix it.
 * @throws The driver's error when a migration or the sync fails. Its message
 * can hold SQL, so the entry prints the class name only.
 */
export async function runStartup(
  app: App,
  options: { readonly autoMigrate: boolean },
  steps: StartupSteps = REAL_STEPS,
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
  app.readiness.markReady();
}
