import type { TokenCredential } from '../access/credential.js';
import {
  ensurePermissions,
  grantOnOrganisation,
  ORIGIN,
  seedOrganisation,
  seedUser,
} from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import {
  LOCATIONS_EDIT_PERMISSION,
  LOCATIONS_READ_PERMISSION,
} from './permissions.js';
import type { LibraryContext } from './locations.js';

/**
 * Helpers for the tests of the library's location services (decision D-69, P-02l2).
 * Fixtures insert straight into the tables, as the other tests do (CLAUDE.md, Data rules);
 * the code under test writes through the write helper. Only tests import this file.
 * Places and people are invented, from the demo production The Last Withdrawal.
 */

/** The moment every context here says it is: a Sunday in the middle of the shoot. */
export const NOW = new Date('2026-11-15T10:00:00.000Z');

/** A context for `userId`, with a clock that stands at `NOW`, or at `at`. */
export function ctxFor(
  userId: string,
  options: { credential?: TokenCredential; at?: Date } = {},
): LibraryContext {
  const at = options.at ?? NOW;
  return {
    userId,
    originServer: ORIGIN,
    clock: () => at,
    ...(options.credential === undefined
      ? {}
      : { credential: options.credential }),
  };
}

/** A personal API token's credential for the whole of `organisationId`, with no sensitive scope. */
export function tokenFor(
  organisationId: string,
  access: 'read' | 'write',
): TokenCredential {
  return {
    kind: 'token',
    tokenId: '0199a3c4-0000-7000-8000-0000000000dd',
    organisationId,
    projectId: null,
    access,
    sensitivePermissions: [],
  };
}

/** Everything the location tests stand on: two organisations, and users who edit, read, or do neither. */
export type LibraryScene = {
  readonly organisationId: string;
  /** Another organisation, which the users of the first have no part in. */
  readonly otherOrganisationId: string;
  readonly users: {
    /** Holds `locations:edit` and `locations:read` in the organisation. */
    readonly editor: string;
    /** Holds `locations:read` in the organisation, and not `locations:edit`. */
    readonly reader: string;
    /** Holds `locations:edit` and `locations:read` in the other organisation only. */
    readonly otherEditor: string;
    /** Signed in, a member of nothing. */
    readonly stranger: string;
  };
};

/** Builds the scene. The permission catalogue gets the two location permissions. Direct inserts, as fixtures do. */
export async function seedLibraryScene(
  database: Database,
): Promise<LibraryScene> {
  const first = await seedOrganisation(database);
  const second = await seedOrganisation(database);
  await ensurePermissions(database, [
    LOCATIONS_READ_PERMISSION,
    LOCATIONS_EDIT_PERMISSION,
  ]);
  const editor = await seedUser(database);
  await grantOnOrganisation(database, first.organisationId, editor, 'admin', [
    LOCATIONS_READ_PERMISSION,
    LOCATIONS_EDIT_PERMISSION,
  ]);
  const reader = await seedUser(database);
  await grantOnOrganisation(database, first.organisationId, reader, 'member', [
    LOCATIONS_READ_PERMISSION,
  ]);
  const otherEditor = await seedUser(database);
  await grantOnOrganisation(
    database,
    second.organisationId,
    otherEditor,
    'admin',
    [LOCATIONS_READ_PERMISSION, LOCATIONS_EDIT_PERMISSION],
  );
  return {
    organisationId: first.organisationId,
    otherOrganisationId: second.organisationId,
    users: {
      editor,
      reader,
      otherEditor,
      stranger: await seedUser(database),
    },
  };
}
