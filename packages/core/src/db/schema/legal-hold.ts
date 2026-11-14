import { sql } from 'drizzle-orm';
import { check, foreignKey, text, uuid } from 'drizzle-orm/pg-core';
import { standardColumns, tenantTable, timestamptz } from '../columns.js';
import { organisation } from './organisation.js';
import { project } from './project.js';
import { user } from './user.js';

/**
 * A legal hold: while it is unreleased, the records it covers must not be
 * purged or erased. Scope: no project and no entity covers the whole
 * organisation; a project alone covers that project; an entity covers that one
 * record, with or without a project.
 *
 * Holds are released, never deleted, so the table keeps its own history and
 * the CHECK `deleted_at IS NULL` refuses soft deletes. Rows use retention
 * class `standard`, the column default.
 *
 * `reason` is free text written by staff. It must not copy sensitive values.
 */
export const legalHold = tenantTable(
  'legal_hold',
  () => organisation.id,
  {
    ...standardColumns(() => user.id),
    projectId: uuid('project_id'),
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    reason: text('reason').notNull(),
    placedAt: timestamptz('placed_at').notNull(),
    releasedAt: timestamptz('released_at'),
    releasedBy: uuid('released_by'),
    releaseReason: text('release_reason'),
  },
  (t) => [
    foreignKey({
      name: 'legal_hold_project_fk',
      columns: [t.organisationId, t.projectId],
      foreignColumns: [project.organisationId, project.id],
    }),
    foreignKey({
      name: 'legal_hold_released_by_fk',
      columns: [t.releasedBy],
      foreignColumns: [user.id],
    }),
    check(
      'legal_hold_entity_check',
      sql`(${t.entityType} is null) = (${t.entityId} is null)`,
    ),
    check(
      'legal_hold_release_check',
      sql`(${t.releasedAt} is null) = (${t.releasedBy} is null) and (${t.releasedAt} is null) = (${t.releaseReason} is null)`,
    ),
    check(
      'legal_hold_released_after_placed_check',
      sql`${t.releasedAt} is null or ${t.releasedAt} >= ${t.placedAt}`,
    ),
    check('legal_hold_not_deleted_check', sql`${t.deletedAt} is null`),
  ],
);
