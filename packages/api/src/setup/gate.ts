import { isSetupComplete } from '@osfpm/core/src/auth/setup-code.js';
import type { App } from '../app.js';
import { RouteNotFoundError, SetupRequiredError } from '../errors.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * The route answers while first-run setup is not complete. Only the two
     * health routes, `/meta`, `/openapi.json`, the server key route
     * (`/.well-known/osfpm/server-key`) and the setup routes say so; every
     * other route is a 503 problem `setup-required` until the first
     * administrator exists. A route that says nothing is closed, so a new route
     * cannot be open before setup by accident.
     */
    availableBeforeSetup?: boolean;
    /**
     * The route answers only while first-run setup is to do. Once it is complete
     * the route is a 404 problem, the same as a path that is no route, so a
     * finished install shows no sign that it ever existed. Only the two setup
     * routes say so, and they also say `availableBeforeSetup`.
     */
    closedAfterSetup?: boolean;
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
 * Once it is complete, a route that says `config.closedAfterSetup` (the setup
 * routes) is a 404 problem `route-not-found`, as a path that is no route is. An
 * unknown path is still the usual 404, which has nothing to protect.
 *
 * Registered once, in `buildApp`, after the check that start-up has finished
 * (the database must be migrated before it is asked) and before the auth plugin,
 * so a caller with a cookie, a foreign `Origin` or none gets the same answer and
 * no cookie is looked at or cleared. A route that is open both before and after
 * setup costs no database query. Once setup is complete the check is a flag in
 * memory, so it costs nothing.
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
    const { availableBeforeSetup, closedAfterSetup } =
      request.routeOptions.config;
    // Open whatever the state: no need to ask.
    if (availableBeforeSetup === true && closedAfterSetup !== true) return;
    if (await state.isComplete()) {
      if (closedAfterSetup === true) throw new RouteNotFoundError();
      return;
    }
    if (availableBeforeSetup !== true) throw new SetupRequiredError();
  });
}
