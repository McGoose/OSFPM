import { PERMISSION_LISTS } from '../access/permission-lists.js';
import { role, rolePermission } from '../db/schema/index.js';
import { insertRecord, type Tx, type WriteContext } from '../db/write.js';

/**
 * The Administrator role of a new organisation, made by first-run setup (SC-10,
 * decision D-56, Q1). A role belongs to the organisation and holds permissions;
 * the owner tier of a membership grants nothing by itself, so this role is what
 * makes the first administrator able to do anything.
 */

/** The key of the Administrator role in its organisation. */
export const ADMINISTRATOR_ROLE_KEY = 'administrator';

/** The name the Administrator role is shown with. */
export const ADMINISTRATOR_ROLE_NAME = 'Administrator';

/** What the Administrator role is for, in the words a role list shows. */
const ADMINISTRATOR_ROLE_DESCRIPTION =
  'Holds every permission in the organisation, and the ordinary data of every production. Sensitive crew data, contract amounts and cost amounts still need membership of the production.';

/**
 * Creates the Administrator organisation role (key `administrator`, no project)
 * and grants it every permission in `PERMISSION_LISTS`, and answers its id and
 * how many permissions it was given. Every grant is one row, which is the most a
 * role can hold of one permission without a department:
 *
 * - A permission that is not flagged `grants_sensitive` is granted with the reach
 *   `all-projects`, which counts in the organisation and in every project of it,
 *   so the administrator sees and edits every production's ordinary data without
 *   being a member of each (maintainer decision of 22 Nov, task P-03b4a).
 * - A sensitive permission is granted `own-scope`, which counts in the
 *   organisation and nowhere else. A sensitive permission can never reach all
 *   projects, whoever holds it: the database refuses such a grant, and
 *   `hasProjectPermission` ignores one (CLAUDE.md, Privacy rule; decision D-55;
 *   maintainer decision of 21 Nov, task P-02k). Sensitive crew data, contract and
 *   cost amounts still need membership of the project.
 *
 * Every row goes through the write helper, with `ctx` as the writer, so each is a
 * change event in the organisation's sequence. The organisation must exist and
 * the permission catalogue must hold every key of the lists (the server syncs it
 * when it starts); a missing key is refused by the database and nothing is left
 * behind when the caller's transaction ends. Checks no permission: only first-run
 * setup calls it, for an organisation that was made a moment ago.
 *
 * @throws RecordWriteError when the database refuses a row; it carries the
 * SQLSTATE and constraint name only.
 * @throws MissingActingUserError for a `token` or `email` context without
 * `onBehalfOfUserId`.
 */
export async function createAdministratorRole(
  tx: Tx,
  ctx: WriteContext,
  organisationId: string,
): Promise<{ id: string; permissions: number }> {
  const created = await insertRecord(
    tx,
    role,
    {
      organisationId,
      ownerOrgId: organisationId,
      projectId: null,
      key: ADMINISTRATOR_ROLE_KEY,
      name: ADMINISTRATOR_ROLE_NAME,
      description: ADMINISTRATOR_ROLE_DESCRIPTION,
      isDefault: false,
    },
    ctx,
  );
  let permissions = 0;
  for (const list of PERMISSION_LISTS) {
    for (const permission of list) {
      await insertRecord(
        tx,
        rolePermission,
        {
          organisationId,
          ownerOrgId: organisationId,
          roleId: created.id,
          permissionKey: permission.key,
          departmentId: null,
          reach:
            permission.grantsSensitive === true ? 'own-scope' : 'all-projects',
        },
        ctx,
      );
      permissions += 1;
    }
  }
  return { id: created.id, permissions };
}
