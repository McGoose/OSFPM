import { project, unit } from '../db/schema/index.js';
import {
  insertRecord,
  type InsertValues,
  type Tx,
  type WriteContext,
} from '../db/write.js';

/** Key and name of the unit every project starts with. */
export const MAIN_UNIT = { key: 'main', name: 'Main unit' } as const;

/**
 * Creates a project and its main unit, both through the write helper. A
 * project never exists without a main unit, so every project-creation path
 * must use this function. The main unit takes the project's organisation,
 * owner and visibility.
 *
 * The two writes run in a savepoint of the caller's transaction, so the call
 * succeeds or fails as a whole: if the unit cannot be created, the project, its
 * counter row and its events are rolled back too, even when the caller catches
 * the error and commits.
 *
 * Whether the project may have episodes is not decided here.
 */
export function createProject(
  tx: Tx,
  ctx: WriteContext,
  values: InsertValues<typeof project>,
) {
  return tx.transaction(async (inner) => {
    const created = await insertRecord(inner, project, values, ctx);
    const mainUnit = await insertRecord(
      inner,
      unit,
      {
        organisationId: created.organisationId,
        ownerOrgId: created.ownerOrgId,
        visibility: created.visibility,
        originServer: created.originServer,
        projectId: created.id,
        key: MAIN_UNIT.key,
        name: MAIN_UNIT.name,
        kind: 'main',
      },
      ctx,
    );
    return { project: created, mainUnit };
  });
}
