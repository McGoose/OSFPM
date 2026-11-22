import { topUpAdministratorRoles } from '@osfpm/core/src/auth/administrator-role.js';
import type { App } from '../app.js';

/**
 * Gives the Administrator role of every organisation the permissions that were
 * added since it was made, and answers how many grants that took in all (SC-10,
 * decision D-56). The role is managed, so no organisation can add them: a release
 * that declares a new permission reaches the administrators only through this
 * step, which the server runs each time it starts, after it has synced the
 * permission catalogue and made sure the `installation` row exists. The work, and
 * the rule for which reach a permission is given, is the core's
 * `topUpAdministratorRoles`; this is the transaction around it.
 *
 * One transaction, so a failure leaves no grant and no event, and start-up fails
 * with it. Two servers that start together take turns on the installation row
 * lock, so the second finds nothing missing. Only server start-up calls this,
 * before any request is served, so it checks no permission.
 *
 * @throws AuthStateError `installation-missing` when the `installation` row is not
 * there yet, which start-up's step before this one makes.
 * @throws RecordWriteError when the database refuses a write; it carries the
 * SQLSTATE and constraint name only.
 */
export function topUpAdministrator(app: App): Promise<number> {
  return app.db.db.transaction((tx) =>
    topUpAdministratorRoles(tx, { now: new Date() }),
  );
}
