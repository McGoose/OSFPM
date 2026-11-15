import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sqlList, standardColumns, tenantTable } from '../columns.js';
import { block } from './block.js';
import { organisation } from './organisation.js';
import { project } from './project.js';
import { user } from './user.js';

/**
 * Allowed values of `episode.status`. The CHECK is built from this list, so a
 * new value needs a new migration.
 */
export const EPISODE_STATUSES = [
  'planned',
  'in-production',
  'delivered',
] as const;
/** One value of `EPISODE_STATUSES`. */
export type EpisodeStatus = (typeof EPISODE_STATUSES)[number];

/**
 * An episode of one project. `number` is text because numbering schemes vary,
 * for example "101" or "2.05". Whether a project may have episodes at all is a
 * service rule, not a database one.
 */
export const episode = tenantTable(
  'episode',
  () => organisation.id,
  {
    ...standardColumns(() => user.id),
    projectId: uuid('project_id').notNull(),
    blockId: uuid('block_id'),
    number: text('number').notNull(),
    title: text('title'),
    status: text('status').$type<EpisodeStatus>().notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [
    foreignKey({
      name: 'episode_project_fk',
      columns: [t.organisationId, t.projectId],
      foreignColumns: [project.organisationId, project.id],
    }),
    // Includes the project, so a block of another project is refused.
    foreignKey({
      name: 'episode_block_fk',
      columns: [t.organisationId, t.projectId, t.blockId],
      foreignColumns: [block.organisationId, block.projectId, block.id],
    }),
    // Target for composite tenant foreign keys in later tables.
    unique('episode_organisation_id_id_unique').on(t.organisationId, t.id),
    unique('episode_project_number_unique').on(t.projectId, t.number),
    check(
      'episode_status_check',
      sql`${t.status} in (${sqlList(EPISODE_STATUSES)})`,
    ),
  ],
);
