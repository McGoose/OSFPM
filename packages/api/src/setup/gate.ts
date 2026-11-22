import { isSetupComplete } from '@osfpm/core/src/auth/setup-code.js';
import type { App } from '../app.js';
import { SetupRequiredError } from '../errors.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * The route answers while first-run setup is not complete. Only the two
     * health routes, `/meta`, `/openapi.json` and the setup routes say so; every
     * other route is a 503 problem `setup-required` until the first
     * administrator exists. A route that says nothing is closed, so a new route
     * cannot be open before setup by accident.
     */
    availableBeforeSetup?: boolean;
  }
  interface FastifyInstance {
    /** Whether first-run setup is complete (see `SetupState`). */
    setup: SetupState;
  }
}

/**
 * What the app knows about first-run setup: whether the first administrator has
 * been created, which is when `installation.setup_completed_at` is set.
 */
export type SetupState = {
  /**
   * True once setup is complete. Asks the database each time until it is, because
   * another server on the same database may have finished it; once true it stays
   * true and the database is not asked again, since setup never goes back. Throws
   * when the database cannot answer.
   */
  readonly isComplete: () => Promise<boolean>;
  /**
   * Tells the app setup is complete, so it need not ask. The setup route calls it
   * after the transaction that completed setup has committed, and a test that is
   * not about setup calls it to open the app.
   */
  readonly markComplete: () => void;
};

/**
 * Closes the API until first-run setup is complete, and puts `app.setup` on the
 * app. While setup is incomplete, a request to any route that does not say
 * `config.availableBeforeSetup` is a 503 problem `setup-required`: nobody can
 * hold a session yet, so a route that needs one answers this rather than a 401.
 * An unknown path is still the usual 404, which has nothing to protect.
 *
 * Registered once, in `buildApp`, after the check that start-up has finished
 * (the database must be migrated before it is asked) and before the auth plugin,
 * so a caller with a cookie, a foreign `Origin` or none gets the same answer and
 * no cookie is looked at or cleared. A route that is open before setup is not
 * counted here and costs no database query. Once setup is complete the check is
 * a flag in memory, so it costs nothing.
 */
export function registerSetupGate(app: App): void {
  let complete = false;
  const state: SetupState = {
    isComplete: async () => {
      if (!complete && (await isSetupComplete(app.db.db))) complete = true;
      return complete;
    },
    markComplete: () => {
      complete = true;
    },
  };
  app.decorate('setup', state);

  app.addHook('onRequest', async (request) => {
    if (request.is404) return;
    if (request.routeOptions.config.availableBeforeSetup === true) return;
    if (!(await state.isComplete())) throw new SetupRequiredError();
  });
}
