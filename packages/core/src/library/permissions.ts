import type { PermissionDefinition } from '../access/permission-sync.js';

/**
 * Permission to read the people of the organisation's library: who they are by name,
 * contact details and department. Held in the organisation. It does not reach crew
 * personal data, which belongs to `person_sensitive` and `sensitive:read:*`, and it does
 * not reach a person's delivery preferences (see `PEOPLE_EDIT_PERMISSION`).
 */
export const PEOPLE_READ_PERMISSION = 'people:read';

/**
 * Permission to create, change and archive the people of the library, and, for a person who
 * has no account, to read and set how they want to receive information (their delivery
 * preferences, decision D-69, P-02l2). Held in the organisation. A person who has an
 * account keeps their preferences on it and only they change them, so this never reaches
 * those. It does not reach crew personal data (`sensitive:edit:*`).
 */
export const PEOPLE_EDIT_PERMISSION = 'people:edit';

/** Permission to read the companies of the library, such as vendors and agencies. Held in the organisation. */
export const COMPANIES_READ_PERMISSION = 'companies:read';

/** Permission to create, change and archive the companies of the library. Held in the organisation. */
export const COMPANIES_EDIT_PERMISSION = 'companies:edit';

/**
 * Permission to read the locations of the library with their access summary: the answers
 * about step-free routes, toilets, parking, a quiet room and seating, and whether anyone
 * has checked them. Held in the organisation.
 */
export const LOCATIONS_READ_PERMISSION = 'locations:read';

/**
 * Permission to create, change and archive the locations of the library, to set the access
 * answers of a location and to verify them. Held in the organisation.
 */
export const LOCATIONS_EDIT_PERMISSION = 'locations:edit';

/**
 * Catalogue rows for the library: people, companies and locations, a read and an edit
 * permission for each, all held in the organisation and none flagged sensitive (maintainer
 * decision, P-02l2, spec card SC-08). The library is the organisation's own shared record,
 * so its permissions are organisation-level, and the crew personal data of a person stays
 * behind `sensitive:*`. Today only the location and preference services check them.
 */
export const LIBRARY_PERMISSIONS: readonly PermissionDefinition[] = [
  {
    key: PEOPLE_READ_PERMISSION,
    module: 'people',
    description: 'Read the people in the library',
    grantsSensitive: false,
    access: 'read',
  },
  {
    key: PEOPLE_EDIT_PERMISSION,
    module: 'people',
    description:
      'Create, change and archive the people in the library, and set the delivery preferences of a person with no account',
    grantsSensitive: false,
    access: 'write',
  },
  {
    key: COMPANIES_READ_PERMISSION,
    module: 'companies',
    description: 'Read the companies in the library',
    grantsSensitive: false,
    access: 'read',
  },
  {
    key: COMPANIES_EDIT_PERMISSION,
    module: 'companies',
    description: 'Create, change and archive the companies in the library',
    grantsSensitive: false,
    access: 'write',
  },
  {
    key: LOCATIONS_READ_PERMISSION,
    module: 'locations',
    description: 'Read the locations in the library, with their access summary',
    grantsSensitive: false,
    access: 'read',
  },
  {
    key: LOCATIONS_EDIT_PERMISSION,
    module: 'locations',
    description:
      'Create, change and archive the locations in the library, set their access answers and verify them',
    grantsSensitive: false,
    access: 'write',
  },
];
