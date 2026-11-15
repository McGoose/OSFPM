import { foreignKey, integer, text, unique, uuid } from 'drizzle-orm/pg-core';
import { standardColumns, tenantTable } from '../columns.js';
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
    // Composite, so the project must be in the same organisation. A NULL
    // project (an organisation template) skips the check.
    foreignKey({
      name: 'department_project_fk',
      columns: [t.organisationId, t.projectId],
      foreignColumns: [project.organisationId, project.id],
    }),
    // NULLS NOT DISTINCT: templates have a NULL project, and a plain UNIQUE
    // would let the same key repeat among them.
    unique('department_organisation_project_key_unique')
      .on(t.organisationId, t.projectId, t.key)
      .nullsNotDistinct(),
    // Target for composite tenant foreign keys in later tables.
    unique('department_organisation_id_id_unique').on(t.organisationId, t.id),
  ],
);
