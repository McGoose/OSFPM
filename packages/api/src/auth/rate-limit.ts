/**
 * How often one address may call a route that checks a secret (a password, a
 * passkey, a code, a token): at most `max` requests in `timeWindowMs`, counted
 * together across every route that sets the `authRateLimit` option. It is meant
 * for guessing: the three login routes (password, authenticator code and
 * recovery code) set it now, and the setup, passkey and invite routes will.
 * Kept here, in one place, until the limits can be changed in the
 * organisation's settings.
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

/**
 * How often one address may call the API at all: at most `max` requests in
 * `timeWindowMs`, counted together across every route except `/health` and
 * `/health/ready`, which say `exemptFromAddressRateLimit`. A request for a path
 * that is no route counts too. It is a coarse guard against floods, counted
 * before the session is looked up, so a caller with no session, or a wrong one,
 * costs the server a count and nothing more. It is far above what a client
 * needs: the limits for guessing (`AUTH_RATE_LIMIT`) and per session
 * (`SESSION_RATE_LIMIT`) are the ones that shape use. In memory, like those.
 *
 * Behind a reverse proxy the address is the proxy's, unless
 * `OSFPM_TRUSTED_PROXIES` lists it (see `Config.trustedProxies`).
 */
export const ADDRESS_RATE_LIMIT = { max: 300, timeWindowMs: 60_000 } as const;
