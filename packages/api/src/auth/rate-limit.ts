/**
 * How often one address may call a route that checks a secret (a password, a
 * passkey, a code, a token): at most `max` requests in `timeWindowMs`, counted
 * together across every route that sets the `authRateLimit` option. It is meant
 * for guessing: the sign-in, setup, recovery and invite routes, which come later,
 * and no route exists yet that sets it. Kept here, in one place, until the
 * limits can be changed in the organisation's settings.
 *
 * The count is held in this process's memory. Several API instances each keep
 * their own, so the limit per address is `max` times the number of instances
 * until the instances share a store.
 */
export const AUTH_RATE_LIMIT = { max: 10, timeWindowMs: 60_000 } as const;

/**
 * How often one signed-in session may call a route that sets the
 * `sessionRateLimit` option: at most `max` requests in `timeWindowMs`, counted
 * together across those routes, per session and not per address. For routes a
 * signed-in client uses as it goes, where nothing is being guessed. A request
 * with no valid session is not counted here: it is a 401, and has no session to
 * count against. In memory, like `AUTH_RATE_LIMIT`.
 */
export const SESSION_RATE_LIMIT = { max: 120, timeWindowMs: 60_000 } as const;
