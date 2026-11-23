import type { TokenCredential } from '../access/credential.js';
import {
  ensurePermissions,
  grantOnOrganisation,
  ORIGIN,
  seedOrganisation,
  seedPerson,
  seedUser,
} from '../access/test-fixtures.js';
import type { Database } from '../db/client.js';
import {
  PEOPLE_EDIT_PERMISSION,
  PEOPLE_READ_PERMISSION,
} from '../library/permissions.js';
import type { PreferencesContext } from './service.js';

/**
 * Helpers for the tests of delivery preferences (decision D-69, P-02l2). Fixtures insert
 * straight into the tables, as the other tests do (CLAUDE.md, Data rules); the code under
 * test writes through the preferences service. Only tests import this file. People are
 * invented, from the demo production The Last Withdrawal.
 */

/** The moment every context here says it is: a Sunday in the middle of the shoot. */
export const NOW = new Date('2026-11-15T10:00:00.000Z');

/** A context for `userId`, with a clock that stands at `NOW`, or at `at`. */
export function ctxFor(
  userId: string,
  options: { credential?: TokenCredential; at?: Date } = {},
): PreferencesContext {
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
    tokenId: '0199a3c4-0000-7000-8000-0000000000bb',
    organisationId,
    projectId: null,
    access,
    sensitivePermissions: [],
  };
}

/** Everything the preferences tests stand on: two organisations, staff and readers, and people with and without an account. */
export type PreferencesScene = {
  readonly organisationId: string;
  /** Another organisation, which the people and users of the first have no part in. */
  readonly otherOrganisationId: string;
  readonly users: {
    /** Holds `people:edit` in the organisation. */
    readonly staff: string;
    /** Holds `people:read` in the organisation, and not `people:edit`. */
    readonly reader: string;
    /** Holds `people:edit` in the other organisation only. */
    readonly otherStaff: string;
    /** Signed in, a member of nothing. */
    readonly stranger: string;
  };
  readonly people: {
    /** A person with no account, in the organisation: staff keep their preferences. */
    readonly crew: string;
    /** A second person with no account, so a test can change one and leave the other. */
    readonly crewToo: string;
    /** A person with an account, in the organisation. */
    readonly holder: { readonly userId: string; readonly personId: string };
    /** A person with no account, in the other organisation. */
    readonly elsewhere: string;
  };
};

/** Builds the scene. The permission catalogue gets the two people permissions. Direct inserts, as fixtures do. */
export async function seedPreferencesScene(
  database: Database,
): Promise<PreferencesScene> {
  const first = await seedOrganisation(database);
  const second = await seedOrganisation(database);
  await ensurePermissions(database, [
    PEOPLE_READ_PERMISSION,
    PEOPLE_EDIT_PERMISSION,
  ]);
  const staff = await seedUser(database);
  await grantOnOrganisation(
    database,
    first.organisationId,
    staff,
    'admin',
    [PEOPLE_EDIT_PERMISSION],
    { reach: 'all-projects' },
  );
  const reader = await seedUser(database);
  await grantOnOrganisation(database, first.organisationId, reader, 'member', [
    PEOPLE_READ_PERMISSION,
  ]);
  const otherStaff = await seedUser(database);
  await grantOnOrganisation(
    database,
    second.organisationId,
    otherStaff,
    'admin',
    [PEOPLE_EDIT_PERMISSION],
  );
  const holderUser = await seedUser(database);
  return {
    organisationId: first.organisationId,
    otherOrganisationId: second.organisationId,
    users: {
      staff,
      reader,
      otherStaff,
      stranger: await seedUser(database),
    },
    people: {
      crew: await seedPerson(database, first.organisationId, {
        displayName: 'Tomas Berg',
      }),
      crewToo: await seedPerson(database, first.organisationId, {
        displayName: 'Ines Kovac',
      }),
      holder: {
        userId: holderUser,
        personId: await seedPerson(database, first.organisationId, {
          userId: holderUser,
          displayName: 'Mira Vukovic',
        }),
      },
      elsewhere: await seedPerson(database, second.organisationId, {
        displayName: 'Jo Example',
      }),
    },
  };
}
