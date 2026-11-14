import { boolean, foreignKey, text, unique, uuid } from 'drizzle-orm/pg-core';
import { standardColumns, tenantTable } from '../columns.js';
import { project } from './project.js';
import { organisation } from './organisation.js';
import { user } from './user.js';

/** A role. `project_id` NULL means an organisation-wide template. */
export const role = tenantTable(
  'role',
  () => organisation.id,
  {
    ...standardColumns(() => user.id),
    projectId: uuid('project_id'),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    isDefault: boolean('is_default').notNull().default(false),
  },
  (t) => [
    foreignKey({
      name: 'role_project_fk',
      columns: [t.organisationId, t.projectId],
      foreignColumns: [project.organisationId, project.id],
    }),
    unique('role_organisation_project_key_unique')
      .on(t.organisationId, t.projectId, t.key)
      .nullsNotDistinct(),
    unique('role_organisation_id_id_unique').on(t.organisationId, t.id),
  ],
);
