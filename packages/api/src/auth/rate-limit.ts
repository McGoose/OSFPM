/**
 * How often one address may call the auth routes: at most `max` requests in
 * `timeWindowMs`, counted together across every route that sets the
 * `authRateLimit` option (all of `/api/v1/auth/`). Kept here, in one place,
 * until the limits can be changed in the organisation's settings.
 *
 * The count is held in this process's memory. Several API instances each keep
 * their own, so the limit per address is `max` times the number of instances
 * until the instances share a store.
 */
export const AUTH_RATE_LIMIT = { max: 10, timeWindowMs: 60_000 } as const;
