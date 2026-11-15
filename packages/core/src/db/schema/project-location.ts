import { sql } from 'drizzle-orm';
import { check, foreignKey, text, unique, uuid } from 'drizzle-orm/pg-core';
import { sqlList, standardColumns, tenantTable } from '../columns.js';
import { location } from './location.js';
import { organisation } from './organisation.js';
import { project } from './project.js';
import { user } from './user.js';

/**
 * Allowed values of `project_location.status`. The CHECK is built from this
 * list, so a new value needs a new migration.
 */
export const PROJECT_LOCATION_STATUSES = [
  'scouted',
  'proposed',
  'approved',
  'confirmed',
  'rejected',
] as const;
/** One value of `PROJECT_LOCATION_STATUSES`. */
export type ProjectLocationStatus = (typeof PROJECT_LOCATION_STATUSES)[number];

/** A library location considered or used by one project. */
export const projectLocation = tenantTable(
  'project_location',
  () => organisation.id,
  {
    ...standardColumns(() => user.id),
    projectId: uuid('project_id').notNull(),
    locationId: uuid('location_id').notNull(),
    status: text('status').$type<ProjectLocationStatus>().notNull(),
    notes: text('notes'),
  },
  (t) => [
    foreignKey({
      name: 'project_location_project_fk',
      columns: [t.organisationId, t.projectId],
      foreignColumns: [project.organisationId, project.id],
    }),
    foreignKey({
      name: 'project_location_location_fk',
      columns: [t.organisationId, t.locationId],
      foreignColumns: [location.organisationId, location.id],
    }),
    unique('project_location_unique').on(t.projectId, t.locationId),
    // Target for composite tenant foreign keys in later tables.
    unique('project_location_organisation_id_id_unique').on(
      t.organisationId,
      t.id,
    ),
    check(
      'project_location_status_check',
      sql`${t.status} in (${sqlList(PROJECT_LOCATION_STATUSES)})`,
    ),
  ],
);
