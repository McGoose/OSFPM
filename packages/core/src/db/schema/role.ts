import { boolean, foreignKey, text, unique, uuid } from 'drizzle-orm/pg-core';
import { standardColumns, tenantTable } from '../columns.js';
import { project } from './project.js';
import { organisation } from './organisation.js';
import { user } from './user.js';

/**
 * A role. `project_id` NULL means an organisation-wide template. A `managed` role
 * is one the server makes and keeps, the Administrator role (SC-10, decision
 * D-56): an organisation cannot edit or delete it or its grants. Only the server
 * writes one, with the check switched off for its transaction
 * (`withManagedRoleMaintenance`); a database trigger refuses every other write to
 * a managed role and to its grants. The triggers are hand-written SQL (see
 * `0031_role_managed.sql`).
 */
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
    managed: boolean('managed').notNull().default(false),
  },
  (t) => [
    // Composite, so the project must be in the same organisation. A NULL
    // project (an organisation template) skips the check.
    foreignKey({
      name: 'role_project_fk',
      columns: [t.organisationId, t.projectId],
      foreignColumns: [project.organisationId, project.id],
    }),
    // NULLS NOT DISTINCT: templates have a NULL project, and a plain UNIQUE
    // would let the same key repeat among them.
    unique('role_organisation_project_key_unique')
      .on(t.organisationId, t.projectId, t.key)
      .nullsNotDistinct(),
    // Target for composite tenant foreign keys in later tables.
    unique('role_organisation_id_id_unique').on(t.organisationId, t.id),
  ],
);
