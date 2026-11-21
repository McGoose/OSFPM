/**
 * The version of the public HTTP API, as it appears in the URL and in
 * `GET /api/v1/meta`. It changes only for a breaking change to the API, never
 * with the package version.
 */
export const API_VERSION = 'v1' as const;

/** The path every route lives under, so a later `v2` can run beside it. */
export const API_PREFIX = `/api/${API_VERSION}`;
