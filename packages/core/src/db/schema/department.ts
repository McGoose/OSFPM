import { foreignKey, integer, text, unique, uuid } from 'drizzle-orm/pg-core';
import { standardColumns, tenantTable, visibilityCheck } from '../columns.js';
import { project } from './project.js';
import { organisation } from './organisation.js';
import { user } from './user.js';

/** A department. `project_id` NULL means an organisation-wide template. */
export const department = tenantTable(
  'department',
  () => organisation.id,
  {
    ...standardColumns(() => user.id),
    projectId: uuid('project_id'),
    key: text('key').notNull(),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [
    foreignKey({
      name: 'department_project_fk',
      columns: [t.organisationId, t.projectId],
      foreignColumns: [project.organisationId, project.id],
    }),
    unique('department_organisation_project_key_unique')
      .on(t.organisationId, t.projectId, t.key)
      .nullsNotDistinct(),
    unique('department_organisation_id_id_unique').on(t.organisationId, t.id),
    visibilityCheck('department', t.visibility),
  ],
);
