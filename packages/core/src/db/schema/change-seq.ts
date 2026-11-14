import { bigint, foreignKey, pgTable, unique, uuid } from 'drizzle-orm/pg-core';
import { organisation } from './organisation.js';
import { project } from './project.js';

/**
 * Counter behind `change_event.seq`: one row per project, plus one per
 * organisation (`project_id` NULL) for organisation-level changes. Helper
 * table, so it carries no standard columns. Only the write helper touches it.
 */
export const changeSeq = pgTable(
  'change_seq',
  {
    organisationId: uuid('organisation_id').notNull(),
    projectId: uuid('project_id'),
    lastSeq: bigint('last_seq', { mode: 'number' }).notNull(),
  },
  (t) => [
    foreignKey({
      name: 'change_seq_organisation_fk',
      columns: [t.organisationId],
      foreignColumns: [organisation.id],
    }),
    foreignKey({
      name: 'change_seq_project_fk',
      columns: [t.organisationId, t.projectId],
      foreignColumns: [project.organisationId, project.id],
    }),
    unique('change_seq_organisation_project_unique')
      .on(t.organisationId, t.projectId)
      .nullsNotDistinct(),
  ],
);
