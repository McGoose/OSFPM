import { foreignKey, integer, text, unique, uuid } from 'drizzle-orm/pg-core';
import { standardColumns, tenantTable } from '../columns.js';
import { organisation } from './organisation.js';
import { project } from './project.js';
import { user } from './user.js';

/** A group of episodes of one project that are shot together. */
export const block = tenantTable(
  'block',
  () => organisation.id,
  {
    ...standardColumns(() => user.id),
    projectId: uuid('project_id').notNull(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [
    foreignKey({
      name: 'block_project_fk',
      columns: [t.organisationId, t.projectId],
      foreignColumns: [project.organisationId, project.id],
    }),
    // Target for composite tenant foreign keys in later tables.
    unique('block_organisation_id_id_unique').on(t.organisationId, t.id),
    // Target for the episode foreign key, which keeps an episode in the same
    // project as its block.
    unique('block_organisation_project_id_unique').on(
      t.organisationId,
      t.projectId,
      t.id,
    ),
    unique('block_project_key_unique').on(t.projectId, t.key),
  ],
);
